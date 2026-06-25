//! Phase 2c-iii — desktop Run/Chat through the hosted Gateway with "local hands".
//!
//! The hosted Gateway runs the managed-billing inference loop; the DESKTOP
//! supplies tool execution ("local hands"). This module owns the long-lived,
//! bidirectional bridge to the Node `gateway-run.mjs` driver and the
//! SECURITY-CRITICAL local tool executor.
//!
//! Streaming + consent design (the bridge is request/RESPONSE everywhere else;
//! a run must STREAM):
//!   1. Rust spawns the Node bridge and keeps stdin/stdout pipes open.
//!   2. Rust writes the START envelope (session + params) on stdin.
//!   3. A reader thread parses the bridge's JSONL stdout. Each line is forwarded
//!      to the frontend via a Tauri event (`gateway://event/<runId>`), so the UI
//!      can render the streaming transcript live.
//!   4. On a `tool_use` line, Rust performs the guarded local op — reads inside
//!      the kit workspace are auto-allowed; writes and `run_command` require an
//!      explicit per-call native confirmation dialog — then writes a
//!      `tool_result` line back on stdin to resume the loop.
//!   5. `rotated` lines re-persist a refreshed WorkOS session to secure storage;
//!      `done` ends the run.
//!
//! SECURITY POSTURE (conservative on purpose):
//!   - The trust boundary is Rust. The frontend never decides whether a tool
//!     runs; it only displays what happened.
//!   - All filesystem tools are confined to the kit's own workspace directory,
//!     canonicalized and prefix-checked (no traversal, no symlink escape).
//!   - `run_command` is DISABLED by default. When enabled it requires a native
//!     confirm dialog showing the EXACT command before each execution. Arbitrary
//!     shell is never run without per-call consent.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Runtime};

use crate::account_auth;
use crate::{
    resolve_command_working_directory, resolve_node_command, BackendNodeCommand,
};

/// Tunable safety bounds for the local-hands filesystem tools.
const MAX_READ_FILE_BYTES: u64 = 256 * 1024;
const MAX_WRITE_FILE_BYTES: usize = 256 * 1024;
const MAX_LIST_DIR_ENTRIES: usize = 2000;

/// Parameters for a desktop Gateway run, sent from the frontend.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRunInput {
    /// Stable id the frontend generated to scope this run's events.
    pub run_id: String,
    /// The kit's workspace root. All local-hands file tools are confined here.
    pub workspace_path: String,
    /// Pre-rendered kit context (system text). Built on the desktop from the kit.
    #[serde(default)]
    pub kit_context: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Managed model id (e.g. "claude-sonnet-4-6").
    pub model: String,
    /// The user's prompt that starts the turn.
    pub input: String,
    /// Enable the workspace-scoped local-hands tool set. Off => conversational.
    #[serde(default)]
    pub enable_local_hands: bool,
    /// Enable the `run_command` tool. Off by default; each call still prompts.
    #[serde(default)]
    pub enable_run_command: bool,
    /// Optional gateway base URL override (defaults to the configured web Forge).
    #[serde(default)]
    pub gateway_base_url: Option<String>,
}

/// Terminal result returned to the frontend once the run completes.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRunResult {
    pub stop_reason: String,
    pub tool_rounds: u32,
}

/// Resolve and canonicalize the workspace root, rejecting non-directories.
fn canonical_workspace(workspace_path: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Err("Select an Agent Kit before running it.".to_string());
    }
    let resolved = Path::new(trimmed)
        .canonicalize()
        .map_err(|error| format!("Unable to access the kit workspace: {error}"))?;
    if !resolved.is_dir() {
        return Err("The kit workspace path is not a folder.".to_string());
    }
    Ok(resolved)
}

/// Resolve a tool-provided relative path INSIDE the canonical workspace.
///
/// Guards (mirrors the import zip-extraction discipline):
///   - rejects absolute paths and `..` traversal components,
///   - canonicalizes the parent and re-checks the prefix so symlinks can't
///     escape the workspace,
///   - for not-yet-existing files, canonicalizes the deepest existing ancestor.
fn resolve_in_workspace(workspace: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("A file path is required.".to_string());
    }
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err("Only paths inside the kit workspace are allowed.".to_string());
    }
    for component in candidate.components() {
        use std::path::Component;
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err("Path traversal outside the kit workspace is not allowed.".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Only paths inside the kit workspace are allowed.".to_string());
            }
        }
    }

    let joined = workspace.join(candidate);

    // Find the deepest ancestor that exists and canonicalize it; everything
    // beyond it is new path segments we will create.
    let mut existing = joined.as_path();
    while !existing.exists() {
        match existing.parent() {
            Some(parent) => existing = parent,
            None => return Err("Unable to resolve the target path safely.".to_string()),
        }
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|error| format!("Unable to resolve path: {error}"))?;
    if !canonical_existing.starts_with(workspace) {
        return Err("Resolved path escapes the kit workspace.".to_string());
    }

    // Re-append any trailing not-yet-existing segments to the canonical base.
    let suffix = joined
        .strip_prefix(existing)
        .map_err(|_| "Unable to resolve the target path safely.".to_string())?;
    let final_path = canonical_existing.join(suffix);
    if !final_path.starts_with(workspace) {
        return Err("Resolved path escapes the kit workspace.".to_string());
    }
    Ok(final_path)
}

/// The Anthropic-shaped tool definitions the desktop offers the kit. Kept SMALL
/// and SAFE. `run_command` is included only when explicitly enabled.
fn tool_definitions(enable_run_command: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "read_file",
            "description": "Read a UTF-8 text file from the kit's workspace. Paths are relative to the workspace root; traversal outside it is not allowed.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Workspace-relative file path." } },
                "required": ["path"]
            }
        }),
        json!({
            "name": "list_dir",
            "description": "List entries in a directory inside the kit's workspace. Path is relative to the workspace root.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Workspace-relative directory path (\".\" for the root)." } },
                "required": []
            }
        }),
        json!({
            "name": "write_file",
            "description": "Write a UTF-8 text file inside the kit's workspace. Requires explicit user approval. Paths are relative to the workspace root.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path." },
                    "content": { "type": "string", "description": "Full file content to write." }
                },
                "required": ["path", "content"]
            }
        }),
    ];
    if enable_run_command {
        tools.push(json!({
            "name": "run_command",
            "description": "Run a shell command in the kit's workspace. Requires explicit per-call user approval and shows the exact command first.",
            "input_schema": {
                "type": "object",
                "properties": { "command": { "type": "string", "description": "The exact shell command to run." } },
                "required": ["command"]
            }
        }));
    }
    tools
}

/// Outcome of executing one tool_use locally.
struct LocalToolOutcome {
    /// JSON value to send back as the tool result, or None when it errored.
    result: Option<Value>,
    error: Option<String>,
}

impl LocalToolOutcome {
    fn ok(result: Value) -> Self {
        Self { result: Some(result), error: None }
    }
    fn err(message: impl Into<String>) -> Self {
        Self { result: None, error: Some(message.into()) }
    }
}

/// Ask the user to approve a write/run action via a native confirm dialog.
/// Returns true only on explicit approval. Reads never reach this.
fn confirm_action(title: &str, body: &str) -> bool {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title(title)
        .set_description(body)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            "Approve".to_string(),
            "Deny".to_string(),
        ))
        .show()
        == rfd::MessageDialogResult::Custom("Approve".to_string())
}

/// Execute a single tool_use against the guarded local-hands surface.
fn execute_local_tool(
    workspace: &Path,
    enable_run_command: bool,
    name: &str,
    input: &Value,
) -> LocalToolOutcome {
    match name {
        "read_file" => {
            let Some(rel) = input.get("path").and_then(Value::as_str) else {
                return LocalToolOutcome::err("read_file requires a \"path\".");
            };
            let path = match resolve_in_workspace(workspace, rel) {
                Ok(p) => p,
                Err(e) => return LocalToolOutcome::err(e),
            };
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => {
                    if meta.len() > MAX_READ_FILE_BYTES {
                        return LocalToolOutcome::err(format!(
                            "File is too large to read ({} bytes; limit {}).",
                            meta.len(),
                            MAX_READ_FILE_BYTES
                        ));
                    }
                }
                Ok(_) => return LocalToolOutcome::err("Path is not a file."),
                Err(e) => return LocalToolOutcome::err(format!("Unable to read file: {e}")),
            }
            match std::fs::read_to_string(&path) {
                Ok(content) => LocalToolOutcome::ok(json!({ "path": rel, "content": content })),
                Err(e) => LocalToolOutcome::err(format!("Unable to read file: {e}")),
            }
        }
        "list_dir" => {
            let rel = input.get("path").and_then(Value::as_str).unwrap_or(".");
            let dir = match resolve_in_workspace(workspace, rel) {
                Ok(p) => p,
                Err(e) => return LocalToolOutcome::err(e),
            };
            let read = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(e) => return LocalToolOutcome::err(format!("Unable to list directory: {e}")),
            };
            let mut entries = Vec::new();
            for item in read.take(MAX_LIST_DIR_ENTRIES).flatten() {
                let file_type = item.file_type().ok();
                entries.push(json!({
                    "name": item.file_name().to_string_lossy(),
                    "isDir": file_type.map(|t| t.is_dir()).unwrap_or(false),
                }));
            }
            LocalToolOutcome::ok(json!({ "path": rel, "entries": entries }))
        }
        "write_file" => {
            let Some(rel) = input.get("path").and_then(Value::as_str) else {
                return LocalToolOutcome::err("write_file requires a \"path\".");
            };
            let Some(content) = input.get("content").and_then(Value::as_str) else {
                return LocalToolOutcome::err("write_file requires \"content\".");
            };
            if content.len() > MAX_WRITE_FILE_BYTES {
                return LocalToolOutcome::err(format!(
                    "Content is too large to write ({} bytes; limit {}).",
                    content.len(),
                    MAX_WRITE_FILE_BYTES
                ));
            }
            let path = match resolve_in_workspace(workspace, rel) {
                Ok(p) => p,
                Err(e) => return LocalToolOutcome::err(e),
            };
            let approved = confirm_action(
                "Approve file write",
                &format!(
                    "The kit wants to write {} bytes to:\n\n{}\n\nApprove this write?",
                    content.len(),
                    path.display()
                ),
            );
            if !approved {
                return LocalToolOutcome::err("The user denied this write.");
            }
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return LocalToolOutcome::err(format!("Unable to create parent folder: {e}"));
                }
            }
            match std::fs::write(&path, content) {
                Ok(()) => LocalToolOutcome::ok(json!({ "path": rel, "bytesWritten": content.len() })),
                Err(e) => LocalToolOutcome::err(format!("Unable to write file: {e}")),
            }
        }
        "run_command" => {
            if !enable_run_command {
                return LocalToolOutcome::err("run_command is disabled.");
            }
            let Some(command) = input.get("command").and_then(Value::as_str) else {
                return LocalToolOutcome::err("run_command requires a \"command\".");
            };
            let approved = confirm_action(
                "Approve command",
                &format!(
                    "The kit wants to run this command in {}:\n\n{}\n\nOnly approve commands you fully understand.",
                    workspace.display(),
                    command
                ),
            );
            if !approved {
                return LocalToolOutcome::err("The user denied this command.");
            }
            let shell = if cfg!(target_os = "windows") { "cmd" } else { "sh" };
            let flag = if cfg!(target_os = "windows") { "/C" } else { "-c" };
            match std::process::Command::new(shell)
                .arg(flag)
                .arg(command)
                .current_dir(workspace)
                .output()
            {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    LocalToolOutcome::ok(json!({
                        "exitCode": output.status.code(),
                        "stdout": truncate_output(&stdout),
                        "stderr": truncate_output(&stderr),
                    }))
                }
                Err(e) => LocalToolOutcome::err(format!("Command failed to start: {e}")),
            }
        }
        other => LocalToolOutcome::err(format!("Unknown tool: {other}")),
    }
}

fn truncate_output(text: &str) -> String {
    const MAX: usize = 16 * 1024;
    if text.len() <= MAX {
        text.to_string()
    } else {
        format!("{}\n[output truncated]", &text[..MAX])
    }
}

/// Forward one bridge event to the frontend, scoped to this run id.
fn emit_event<R: Runtime>(app: &tauri::AppHandle<R>, run_id: &str, payload: &Value) {
    let _ = app.emit(&format!("gateway://event/{run_id}"), payload.clone());
}

/// Drive a desktop Gateway run end-to-end (priority 1 text run; priority 2
/// local-hands when `enable_local_hands`). Blocks until the run finishes,
/// streaming events to the frontend as Tauri events along the way.
pub fn run_gateway_session<R: Runtime>(
    app: &tauri::AppHandle<R>,
    input: GatewayRunInput,
) -> Result<GatewayRunResult, String> {
    let workspace = canonical_workspace(&input.workspace_path)?;

    let session_json = account_auth::current_session_json()?
        .ok_or_else(|| account_auth::mark_reconnect_required(app))?;
    let session_value: Value = serde_json::from_str(&session_json)
        .map_err(|_| "Stored AgentKitProject session could not be read safely.".to_string())?;

    let tools = if input.enable_local_hands {
        tool_definitions(input.enable_run_command)
    } else {
        Vec::new()
    };

    let mut params = json!({
        "model": input.model,
        "input": input.input,
        "tools": tools,
        "workspacePath": workspace.to_string_lossy(),
    });
    if let Some(ctx) = input.kit_context.as_ref() {
        params["kitContext"] = json!(ctx);
    }
    if let Some(sp) = input.system_prompt.as_ref() {
        params["systemPrompt"] = json!(sp);
    }
    if let Some(url) = input.gateway_base_url.as_ref().filter(|u| !u.trim().is_empty()) {
        params["gatewayBaseUrl"] = json!(url.trim());
    }

    let start_envelope = json!({
        "op": "start",
        "session": session_value,
        "params": params,
    });

    let bridge_script = crate::resolve_backend_script(app, "gateway-run.mjs")?;
    let node_command: BackendNodeCommand = resolve_node_command(app)?;
    let cwd = resolve_command_working_directory(app);

    let mut command = node_command.command();
    command
        .arg(&bridge_script)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start the Run/Chat runtime: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Unable to open the Run/Chat input stream.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to open the Run/Chat output stream.".to_string())?;

    // Send the start envelope (one JSON line).
    let mut start_line = serde_json::to_vec(&start_envelope)
        .map_err(|error| format!("Unable to prepare the run request: {error}"))?;
    start_line.push(b'\n');
    stdin
        .write_all(&start_line)
        .map_err(|error| format!("Unable to send the run request: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Unable to send the run request: {error}"))?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut result = GatewayRunResult::default();
    let mut run_error: Option<String> = None;

    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Run/Chat stream failed: {error}"))?;
        if read == 0 {
            break; // EOF: bridge exited.
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

        match event_type {
            "text" | "usage" => {
                emit_event(app, &input.run_id, &event);
            }
            "rotated" => {
                if let Some(session) = event.get("session") {
                    if let Ok(rotated_json) = serde_json::to_string(session) {
                        let _ = account_auth::persist_rotated_session_json(app, &rotated_json);
                    }
                }
            }
            "tool_use" => {
                let tool_use_id = event
                    .get("toolUseId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let name = event.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let tool_input = event.get("input").cloned().unwrap_or(Value::Null);

                // Surface the proposed tool call to the UI before executing.
                emit_event(app, &input.run_id, &event);

                let outcome = if input.enable_local_hands {
                    execute_local_tool(&workspace, input.enable_run_command, &name, &tool_input)
                } else {
                    LocalToolOutcome::err("Local tools are not enabled for this run.")
                };

                // Tell the UI the result of the tool call.
                let mut result_event = json!({
                    "type": "tool_result",
                    "toolUseId": tool_use_id,
                    "name": name,
                });
                if let Some(err) = outcome.error.as_ref() {
                    result_event["error"] = json!(err);
                } else if let Some(value) = outcome.result.as_ref() {
                    result_event["result"] = value.clone();
                }
                emit_event(app, &input.run_id, &result_event);

                // Send the result back to the bridge to resume the loop.
                let mut wire = json!({ "type": "tool_result", "toolUseId": tool_use_id });
                if let Some(err) = outcome.error {
                    wire["error"] = json!(err);
                } else if let Some(value) = outcome.result {
                    wire["result"] = value;
                }
                let mut wire_line = serde_json::to_vec(&wire)
                    .map_err(|error| format!("Unable to send tool result: {error}"))?;
                wire_line.push(b'\n');
                if let Err(error) = stdin.write_all(&wire_line).and_then(|_| stdin.flush()) {
                    run_error = Some(format!("Unable to send tool result: {error}"));
                    break;
                }
            }
            "error" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The run failed.")
                    .to_string();
                let code = event.get("code").and_then(Value::as_str).unwrap_or("");
                run_error = Some(if code == "insufficient_credits" {
                    "INSUFFICIENT_CREDITS".to_string()
                } else if code == "reconnect_required" {
                    account_auth::mark_reconnect_required(app)
                } else {
                    redact(&message)
                });
                emit_event(app, &input.run_id, &event);
            }
            "done" => {
                result.stop_reason = event
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn")
                    .to_string();
                result.tool_rounds = event
                    .get("toolRounds")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                emit_event(app, &input.run_id, &event);
            }
            _ => {}
        }
    }

    let _ = child.wait();

    if let Some(error) = run_error {
        return Err(error);
    }
    Ok(result)
}

fn redact(message: &str) -> String {
    crate::security::redact_user_visible_error(message)
}
