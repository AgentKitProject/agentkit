use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, Runtime, State};
use zip::ZipArchive;

mod account_auth;
mod ai_providers;
mod gateway_run;
mod openai_runtime;
mod secure_storage;
mod security;
mod settings;

use security::redact_user_visible_error;
use tauri_plugin_opener::OpenerExt;

const MAX_ZIP_ENTRIES: usize = 2000;
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ZIP_FILE_UNCOMPRESSED_BYTES: u64 = 25 * 1024 * 1024;
const MAX_ZIP_PATH_DEPTH: usize = 16;
const BACKEND_REQUIRED_DIAGNOSTIC_FILES: [&str; 5] = [
    "generate-agent-kit-draft.mjs",
    "create-agent-kit.mjs",
    "render-agent-kit-draft.mjs",
    "validate-agent-kit.mjs",
    "agent-kit-app-support.mjs",
];

#[derive(Debug, Clone)]
pub(crate) struct BackendNodeCommand {
    executable: PathBuf,
    node_args: Vec<String>,
    packaged: bool,
}

impl BackendNodeCommand {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.node_args);
        command
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackagedRuntimeDiagnostics {
    is_dev: bool,
    os: String,
    current_executable_path: Option<String>,
    resource_directory: Option<String>,
    resolved_node_path: String,
    node_exists: bool,
    resolved_backend_dist_path: String,
    backend_dist_exists: bool,
    required_backend_files: Vec<RuntimeFileDiagnostic>,
    node_version_result: RuntimeCommandDiagnostic,
    node_check_result: RuntimeCommandDiagnostic,
    fetch_smoke_test_result: RuntimeCommandDiagnostic,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFileDiagnostic {
    file_name: String,
    path: String,
    exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCommandDiagnostic {
    attempted: bool,
    success: bool,
    exit_code: Option<i32>,
    stdout_tail: String,
    stderr_tail: String,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ValidationProfile {
    LocalValid,
    Publishable,
    Trusted,
    Verified,
}

impl ValidationProfile {
    fn as_str(&self) -> &'static str {
        match self {
            Self::LocalValid => "local-valid",
            Self::Publishable => "publishable",
            Self::Trusted => "trusted",
            Self::Verified => "verified",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AgentKitTemplate {
    Blank,
    FinancialReview,
}

impl AgentKitTemplate {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Blank => "blank",
            Self::FinancialReview => "financial-review",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentKitFromTemplateInput {
    output_folder: String,
    id: String,
    name: String,
    description: String,
    template: AgentKitTemplate,
    force: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentKitResult {
    root_path: String,
    template: String,
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAgentKitOneFileInput {
    root_path: String,
    output_path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportAgentKitOneFileResult {
    file_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageAgentKitInput {
    root_path: String,
    output_folder: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageAgentKitResult {
    artifact_path: String,
    artifact_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitHostedMarketKitInput {
    root_path: String,
    market_base_url: Option<String>,
    validation_profile: Option<ValidationProfile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitHostedMarketKitResult {
    submission_id: String,
    status: String,
    market_link: String,
    package_path: String,
    package_sha256: String,
    validation_report: ValidationReport,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum KitLibrarySource {
    Built,
    Imported,
    Market,
    #[serde(rename = "local_import")]
    LocalImport,
    Manual,
    Unknown,
}

impl KitLibrarySource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Built => "built",
            Self::Imported => "imported",
            Self::Market => "market",
            Self::LocalImport => "local_import",
            Self::Manual => "manual",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddKitToLibraryInput {
    path: String,
    source: KitLibrarySource,
    package_metadata: Option<PackageImportMetadata>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MyKitEntry {
    id: String,
    name: String,
    version: String,
    description: Option<String>,
    path: String,
    source: String,
    source_label: Option<String>,
    last_validated_at: Option<String>,
    last_validated_profile: Option<String>,
    last_validation_valid: Option<bool>,
    last_used_at: Option<String>,
    imported_at: Option<String>,
    installed_at: Option<String>,
    package_file_name: Option<String>,
    package_size_bytes: Option<u64>,
    sha256: Option<String>,
    market_base_url: Option<String>,
    schema_version: Option<String>,
    source_market_slug: Option<String>,
    source_market_kit_id: Option<String>,
    source_url: Option<String>,
    published_at: Option<String>,
    created_at: String,
    updated_at: String,
    path_exists: bool,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct MyKitsLibrary {
    kits: Vec<MyKitEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveKitFromLibraryResult {
    removed_from_library: bool,
    deleted_local_files: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportAgentKitPackageInput {
    package_path: String,
    destination_root_folder: String,
    force: bool,
    import_as_copy: Option<bool>,
    validation_profile: Option<ValidationProfile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportAgentKitPackageResult {
    extracted_path: String,
    validation_report: ValidationReport,
    metadata: MyKitEntry,
    package_metadata: PackageImportMetadata,
    duplicate_warnings: Vec<ImportDuplicateWarning>,
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportHostedMarketKitInput {
    slug: String,
    kit_id: Option<String>,
    market_base_url: Option<String>,
    force: Option<bool>,
    import_as_copy: Option<bool>,
    validation_profile: Option<ValidationProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedMarketPublisherProfile {
    display_name: Option<String>,
    #[allow(dead_code)]
    handle: Option<String>,
    #[allow(dead_code)]
    avatar_initials: Option<String>,
    #[allow(dead_code)]
    verified: Option<bool>,
}

struct HostedMarketRequestDiagnostics {
    endpoint_path: String,
    authorization_header_present: bool,
    token_length: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageImportMetadata {
    kit_id: Option<String>,
    kit_name: Option<String>,
    version: Option<String>,
    schema_version: Option<String>,
    source: Option<String>,
    source_label: Option<String>,
    imported_at: Option<String>,
    package_file_name: Option<String>,
    package_size_bytes: Option<u64>,
    sha256: Option<String>,
    market_base_url: Option<String>,
    source_market_slug: Option<String>,
    source_market_kit_id: Option<String>,
    source_url: Option<String>,
    published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDuplicateWarning {
    id: String,
    name: String,
    version: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentKitPackagePreview {
    package_path: String,
    package_metadata: PackageImportMetadata,
    duplicate_warnings: Vec<ImportDuplicateWarning>,
    found_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentKitCandidateInspection {
    path: String,
    exists: bool,
    is_directory: bool,
    looks_like_agent_kit: bool,
    missing_required_files: Vec<String>,
    missing_required_folders: Vec<String>,
    found_files: Vec<String>,
    found_skills: Vec<String>,
    recommended_fixes: Vec<String>,
    validation_report: Option<ValidationReport>,
    friendly_summary: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportAgentKitFromGitInput {
    repository_url: String,
    reference: Option<String>,
    destination_root_folder: String,
    validation_profile: Option<ValidationProfile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportAgentKitFromGitResult {
    repository_url: String,
    imported_path: Option<String>,
    validation_report: Option<ValidationReport>,
    metadata: Option<MyKitEntry>,
    inspection: AgentKitCandidateInspection,
    files: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAgentKitToCodexInput {
    kit_path: String,
    destination_skills_dir: String,
    force: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportAgentKitToCodexResult {
    destination_skills_dir: String,
    exported_skill_folders: Vec<String>,
    generated_index_folder: Option<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAgentKitToClaudeCodeInput {
    kit_path: String,
    destination_dir: String,
    force: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportAgentKitToClaudeCodeResult {
    destination_dir: String,
    plugin_folder: String,
    plugin_manifest_path: String,
    exported_skill_folders: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestOpenAIConnectionInput {
    model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestOpenAIConnectionResult {
    ok: bool,
    model: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestAiProviderConnectionInput {
    provider_id: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentKitStarterHint {
    source_file: String,
    excerpt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMarkdownFileInput {
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveMarkdownFileResult {
    file_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPreparedPromptInput {
    root_path: String,
    prompt_id: String,
    input_values: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedPromptValidationReport {
    valid: bool,
    issues: Vec<ValidationIssue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPreparedPromptResult {
    prompt: serde_json::Value,
    validation_report: PreparedPromptValidationReport,
    rendered_prompt: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KitMetadata {
    id: String,
    name: String,
    version: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderAgentKitDraftInput {
    draft_file_path: String,
    output_folder: String,
    force: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderAgentKitDraftResult {
    root_path: String,
    files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateAgentKitDraftInput {
    user_request: String,
    target_users: Option<String>,
    domain: Option<String>,
    desired_validation_level: ValidationProfile,
    constraints: Option<String>,
    source_notes: Option<String>,
    requested_sections: Option<Vec<String>>,
    excluded_sections: Option<Vec<String>>,
    example_input_documents: Option<Vec<serde_json::Value>>,
    provider_id: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviseAgentKitDraftInput {
    session: serde_json::Value,
    change_request: String,
    desired_validation_level: ValidationProfile,
    constraints: Option<String>,
    source_notes: Option<String>,
    requested_sections: Option<Vec<String>>,
    excluded_sections: Option<Vec<String>>,
    example_input_documents: Option<Vec<serde_json::Value>>,
    provider_id: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateAgentKitDraftResult {
    draft_json: serde_json::Value,
    draft_json_pretty: String,
    warnings: Vec<String>,
    provider_id: String,
    provider_name: String,
    model: String,
    raw_response: Option<String>,
    session: Option<serde_json::Value>,
    current_revision: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAgentKitDraftJsonInput {
    draft_json: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderGeneratedAgentKitDraftInput {
    draft_json: serde_json::Value,
    output_folder: String,
    force: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectExampleInputDocumentsInput {
    allow_multiple: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAgentKitDraftJsonResult {
    file_path: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct ValidationIssue {
    severity: String,
    code: String,
    message: String,
    path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationReport {
    valid: bool,
    profile: String,
    root_path: String,
    issues: Vec<ValidationIssue>,
}

#[tauri::command]
fn select_agent_kit_folder() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select Agent Kit Folder")
        .pick_folder();

    Ok(folder.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_onefile_output_path() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .set_title("Export Agent Kit Markdown")
        .add_filter("Markdown", &["md"])
        .set_file_name("agent-kit.md")
        .save_file();

    Ok(file.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_forge_response_output_path(file_name: Option<String>) -> Result<Option<String>, String> {
    let file_name = file_name
        .map(|name| sanitize_folder_name(name.trim_end_matches(".md")))
        .filter(|name| !name.trim().is_empty())
        .map(|name| format!("{name}.md"))
        .unwrap_or_else(|| "forge-response.md".to_string());
    let file = rfd::FileDialog::new()
        .set_title("Save Forge Response")
        .add_filter("Markdown", &["md"])
        .set_file_name(&file_name)
        .save_file();

    Ok(file.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_forge_response_text_output_path(
    file_name: Option<String>,
) -> Result<Option<String>, String> {
    let file_name = file_name
        .map(|name| sanitize_folder_name(name.trim_end_matches(".txt").trim_end_matches(".md")))
        .filter(|name| !name.trim().is_empty())
        .map(|name| format!("{name}.txt"))
        .unwrap_or_else(|| "agent-kit-output.txt".to_string());
    let file = rfd::FileDialog::new()
        .set_title("Download Forge Response as Text")
        .add_filter("Text", &["txt"])
        .set_file_name(&file_name)
        .save_file();

    Ok(file.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_json_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .set_title("Select AgentKitDraft JSON")
        .add_filter("JSON", &["json"])
        .pick_file();

    Ok(file.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_json_output_path() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .set_title("Save AgentKitDraft JSON")
        .add_filter("JSON", &["json"])
        .set_file_name("agent-kit-draft.json")
        .save_file();

    Ok(file.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_agent_kit_package_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .set_title("Select Agent Kit Package")
        .add_filter("Agent Kit Package", &["zip"])
        .pick_file();

    Ok(file.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn select_example_input_documents(
    input: Option<SelectExampleInputDocumentsInput>,
) -> Result<Vec<String>, String> {
    let dialog = rfd::FileDialog::new()
        .set_title("Select Example Input Document")
        .add_filter("Example documents", &["txt", "md", "csv", "xlsx", "xls"]);
    let allow_multiple = input.map(|value| value.allow_multiple).unwrap_or(true);

    let paths = if allow_multiple {
        dialog.pick_files().unwrap_or_default()
    } else {
        dialog.pick_file().into_iter().collect()
    };

    Ok(paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
fn validate_agent_kit<R: Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
    profile: ValidationProfile,
) -> Result<ValidationReport, String> {
    let root_path = canonicalize_directory(&root_path)?;
    let bridge_script = resolve_validation_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(&root_path)
        .arg(profile.as_str())
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run agentkitforge-core validation: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "agentkitforge-core validation failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse validation report: {error}"))
}

#[tauri::command]
fn list_prepared_prompts<R: Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
) -> Result<serde_json::Value, String> {
    let root_path = canonicalize_directory(&root_path)?;
    let bridge_script = resolve_prepared_prompts_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("list")
        .arg(&root_path)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to list prepared prompts: {error}"))?;

    parse_node_json_output(output, "Prepared prompt listing")
}

#[tauri::command]
fn render_prepared_prompt<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: RenderPreparedPromptInput,
) -> Result<RenderPreparedPromptResult, String> {
    let root_path = canonicalize_directory(&input.root_path)?;
    let prompt_id = clean_required_value("Prepared prompt", &input.prompt_id)?;
    let input_json = serde_json::to_string(&input.input_values)
        .map_err(|error| format!("Unable to serialize prepared prompt inputs: {error}"))?;
    let bridge_script = resolve_prepared_prompts_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("render")
        .arg(&root_path)
        .arg(prompt_id)
        .arg(input_json)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to render prepared prompt: {error}"))?;

    parse_node_json_output(output, "Prepared prompt render")
}

#[tauri::command]
fn validate_prepared_prompt_inputs<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: RenderPreparedPromptInput,
) -> Result<RenderPreparedPromptResult, String> {
    let root_path = canonicalize_directory(&input.root_path)?;
    let prompt_id = clean_required_value("Prepared prompt", &input.prompt_id)?;
    let input_json = serde_json::to_string(&input.input_values)
        .map_err(|error| format!("Unable to serialize prepared prompt inputs: {error}"))?;
    let bridge_script = resolve_prepared_prompts_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("validate")
        .arg(&root_path)
        .arg(prompt_id)
        .arg(input_json)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to validate prepared prompt inputs: {error}"))?;

    parse_node_json_output(output, "Prepared prompt input validation")
}

#[tauri::command]
fn create_agent_kit_from_template<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: CreateAgentKitFromTemplateInput,
) -> Result<CreateAgentKitResult, String> {
    let output_folder = resolve_target_directory(&input.output_folder)?;
    let id = clean_required_value("Kit id", &input.id)?;
    let name = clean_required_value("Kit name", &input.name)?;
    let description = clean_required_value("Kit description", &input.description)?;
    validate_kit_id(&id)?;

    let target_path = output_folder.join(&id);
    if !target_path.starts_with(&output_folder) {
        return Err("Kit id must stay inside the selected output folder.".to_string());
    }

    let bridge_script = resolve_create_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(&target_path)
        .arg(input.template.as_str())
        .arg(&id)
        .arg(&name)
        .arg(&description)
        .arg(if input.force { "true" } else { "false" })
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run agentkitforge-core scaffolding: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "agentkitforge-core scaffolding failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse create result: {error}"))
}

#[tauri::command]
fn export_agent_kit_onefile<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ExportAgentKitOneFileInput,
) -> Result<ExportAgentKitOneFileResult, String> {
    let root_path = canonicalize_directory(&input.root_path)?;
    let output_path = resolve_markdown_output_path(&root_path, &input.output_path)?;
    let bridge_script = resolve_export_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(&root_path)
        .arg(&output_path)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run agentkitforge-core one-file export: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "agentkitforge-core one-file export failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse export result: {error}"))
}

#[tauri::command]
fn package_agent_kit<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: PackageAgentKitInput,
) -> Result<PackageAgentKitResult, String> {
    let root_path = canonicalize_directory(&input.root_path)?;
    let output_folder = canonicalize_directory(&input.output_folder)?;
    package_agent_kit_internal(&app, &root_path, &output_folder)
}

fn package_agent_kit_internal<R: Runtime>(
    app: &tauri::AppHandle<R>,
    root_path: &Path,
    output_folder: &Path,
) -> Result<PackageAgentKitResult, String> {
    let out_file = output_folder.join(default_package_file_name(root_path));
    let bridge_script = resolve_package_bridge(app)?;
    let node_command = resolve_node_command(app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(root_path)
        .arg(&out_file)
        .current_dir(resolve_command_working_directory(app))
        .output()
        .map_err(|error| format!("Unable to run agentkitforge-core package export: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "agentkitforge-core package export failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse package result: {error}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentKitVersionChange {
    previous: String,
    next: String,
}

fn run_version_bridge<R: Runtime, T: for<'de> Deserialize<'de>>(
    app: &tauri::AppHandle<R>,
    args: &[&str],
) -> Result<T, String> {
    let bridge_script = resolve_version_bridge(app)?;
    let node_command = resolve_node_command(app)?;

    let mut command = node_command.command();
    command.arg(&bridge_script);
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .current_dir(resolve_command_working_directory(app))
        .output()
        .map_err(|error| format!("Unable to run agentkitforge-core version command: {error}"))?;

    parse_node_json_output(output, "Agent Kit version command")
}

#[tauri::command]
fn get_agent_kit_version<R: Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
) -> Result<String, String> {
    let root_path = canonicalize_directory(&root_path)?;
    let root_path = root_path.to_string_lossy().to_string();
    #[derive(Deserialize)]
    struct VersionResult {
        version: String,
    }
    let result: VersionResult = run_version_bridge(&app, &["get", &root_path])?;
    Ok(result.version)
}

#[tauri::command]
fn set_agent_kit_version<R: Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
    version: String,
) -> Result<AgentKitVersionChange, String> {
    let root_path = canonicalize_directory(&root_path)?;
    let root_path = root_path.to_string_lossy().to_string();
    run_version_bridge(&app, &["set", &root_path, &version])
}

#[tauri::command]
fn next_agent_kit_version<R: Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
) -> Result<AgentKitVersionChange, String> {
    let root_path = canonicalize_directory(&root_path)?;
    let root_path = root_path.to_string_lossy().to_string();
    run_version_bridge(&app, &["next", &root_path])
}

#[tauri::command]
fn submit_hosted_market_kit<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: SubmitHostedMarketKitInput,
) -> Result<SubmitHostedMarketKitResult, String> {
    let root_path = canonicalize_directory(&input.root_path)?;
    let market_base_url = normalize_hosted_market_base_url(input.market_base_url.as_deref())?;
    let validation_profile = input
        .validation_profile
        .unwrap_or(ValidationProfile::Publishable);
    let validation_report = validate_agent_kit(
        app.clone(),
        root_path.to_string_lossy().into_owned(),
        validation_profile,
    )?;
    if !validation_report.valid {
        return Err(format!(
            "Validation failed before Market submission. {}",
            validation_summary(&validation_report)
        ));
    }

    // Delegate to core, which is the SINGLE owner of token refresh for this
    // submit (via the capture store in the bridge). We deliberately do NOT
    // refresh or resolve the display name here: WorkOS refresh tokens are
    // single-use/rotating, so a second refresh path (the old display-name
    // pre-fetch) raced with core's refresh and failed with
    // "Refresh token already exchanged." The Market server resolves the
    // publisher from the authenticated user's profile, so no client-side
    // display-name resolution is needed.
    let params = serde_json::json!({
        "rootPath": root_path.to_string_lossy().into_owned(),
        "marketBaseUrl": market_base_url,
        "clientId": account_auth::market_workos_client_id(),
    });
    let bridge_result: MarketBridgeSubmitResult =
        run_market_operation_bridge(&app, "submit", params, "Market submission")?;

    Ok(SubmitHostedMarketKitResult {
        submission_id: bridge_result.submission_id,
        status: bridge_result.status,
        market_link: bridge_result.market_link,
        package_path: bridge_result.package_path,
        package_sha256: bridge_result.sha256,
        validation_report,
    })
}

/// The `submit` shape returned by the hosted-Market operation bridge (core's
/// `SubmitKitResult`, camelCase). `package_path` points at a temp file core has
/// already removed by the time this returns (matching the prior Rust behavior,
/// which also deleted its temp package directory before returning).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketBridgeSubmitResult {
    submission_id: String,
    status: String,
    market_link: String,
    sha256: String,
    package_path: String,
    #[allow(dead_code)]
    validation_report: serde_json::Value,
}

/// The app drives hosted-Market import via the bridge's `download` op (it keeps
/// its own package-import + library persistence), so the core `import` op result
/// shape is not deserialized here; that op exists for the core/CLI parity path.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketBridgeProvenance {
    #[allow(dead_code)]
    market_slug: Option<String>,
    market_kit_id: Option<String>,
    version: Option<String>,
    source_url: Option<String>,
    #[allow(dead_code)]
    sha256: Option<String>,
    #[allow(dead_code)]
    file_name: Option<String>,
    #[allow(dead_code)]
    package_size_bytes: Option<u64>,
}

/// The `download` shape returned by the hosted-Market operation bridge: the core
/// `MarketProvenance` plus the local output path the kit zip was written to.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketBridgeDownloadResult {
    #[allow(dead_code)]
    output_path: String,
    provenance: MarketBridgeProvenance,
}

/// Read-only, in-memory preview of a licensed (Tier-2 paid) kit. Built by the
/// bridge from the package bytes WITHOUT writing them to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicensedKitPreview {
    files: Vec<String>,
    texts: std::collections::HashMap<String, String>,
}

/// The `licensed-package` shape returned by the hosted-Market operation bridge.
/// For ONLINE-ONLY kits, `content_base64` is intentionally absent — the bridge
/// never returns the bytes, so they can never be persisted. For DOWNLOADABLE
/// paid kits the user is entitled to, `content_base64` carries the WATERMARKED
/// bytes the host may save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketBridgeLicensedResult {
    online_only: bool,
    pricing: String,
    downloadable: bool,
    kit_id: String,
    file_name: String,
    sha256: String,
    #[allow(dead_code)]
    license_version: String,
    #[allow(dead_code)]
    entitlement_id: String,
    preview: LicensedKitPreview,
    /// `Some(path)` ONLY for downloadable paid kits (the temp file the bridge
    /// wrote the watermarked bytes to). Always `None`/absent for online-only.
    saved_path: Option<String>,
}

/// Result surfaced to the UI for a licensed-kit fetch. Online-only kits return
/// a preview with `saved_path: None` (nothing written); downloadable paid kits
/// the user owns are saved+imported and report the My Kits entry.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchLicensedMarketKitResult {
    online_only: bool,
    pricing: String,
    downloadable: bool,
    kit_id: String,
    sha256: String,
    preview: LicensedKitPreview,
    /// `Some(entry)` only when a downloadable paid kit was saved to My Kits.
    /// Always `None` for online-only kits (no-persist enforcement).
    imported: Option<ImportAgentKitPackageResult>,
    /// User-facing message; for online-only kits this explains it cannot be saved.
    message: String,
}

#[derive(Debug, Deserialize)]
struct MarketBridgeEnvelope {
    ok: bool,
    error: Option<String>,
    result: Option<serde_json::Value>,
    rotated_session: Option<serde_json::Value>,
}

/// Spawn the hosted-Market operation bridge, feeding `{op, session, params}` on
/// STDIN (so tokens never appear in argv), parse its `{ok,result,...}` envelope,
/// persist any rotated session core produced, and map failures to the same
/// user-facing reconnect/validation/upload messages as the prior Rust client.
fn run_market_operation_bridge<R: Runtime, T: for<'de> Deserialize<'de>>(
    app: &tauri::AppHandle<R>,
    op: &str,
    params: serde_json::Value,
    label: &str,
) -> Result<T, String> {
    let session_json = account_auth::current_session_json()?
        .ok_or_else(|| account_auth::mark_reconnect_required(app))?;
    let session_value: serde_json::Value = serde_json::from_str(&session_json)
        .map_err(|_| "Stored AgentKitProject session could not be read safely.".to_string())?;

    let request = serde_json::json!({
        "op": op,
        "session": session_value,
        "params": params,
    });
    let request_bytes = serde_json::to_vec(&request)
        .map_err(|error| format!("Unable to prepare {label} request: {error}"))?;

    let bridge_script = resolve_market_operation_bridge(app)?;
    let node_command = resolve_node_command(app)?;
    let working_directory = resolve_command_working_directory(app);

    let output = run_backend_script_with_stdin(
        &node_command,
        &bridge_script,
        working_directory,
        label,
        &request_bytes,
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope: MarketBridgeEnvelope = serde_json::from_str(stdout.trim()).map_err(|_| {
        if is_backend_runtime_execution_failure(&stdout) {
            backend_runtime_failed_error()
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stdout.trim().is_empty() {
                stderr
            } else {
                stdout.trim().to_string()
            };
            if detail.is_empty() {
                format!("{label} failed without output.")
            } else {
                redact_user_visible_error(&detail)
            }
        }
    })?;

    // Persist any session core rotated mid-operation back into secure storage.
    if let Some(rotated) = envelope.rotated_session.as_ref() {
        if let Ok(rotated_json) = serde_json::to_string(rotated) {
            let _ = account_auth::persist_rotated_session_json(app, &rotated_json);
        }
    }

    if !envelope.ok {
        let message = envelope
            .error
            .unwrap_or_else(|| format!("{label} failed."));
        return Err(map_market_bridge_error(app, &message));
    }

    let result = envelope
        .result
        .ok_or_else(|| format!("{label} did not return a result."))?;
    serde_json::from_value(result)
        .map_err(|error| format!("Unable to parse {label} result: {error}"))
}

/// Result of a read-only Market update check (Bridge 5). Mirrors core's
/// `KitUpdateStatus`. Tokenless: no session is involved.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KitUpdateStatus {
    available: bool,
    latest_version: Option<String>,
    update_available: bool,
    reason: Option<String>,
}

/// Run the hosted-Market operation bridge WITHOUT a session. Used only by the
/// tokenless `update-check` op, which is a public catalog read. Never seeds,
/// requires, or rotates a WorkOS session — keeping local update checks usable
/// even when the user's hosted-Market session is expired or absent.
fn run_tokenless_market_operation_bridge<R: Runtime, T: for<'de> Deserialize<'de>>(
    app: &tauri::AppHandle<R>,
    op: &str,
    params: serde_json::Value,
    label: &str,
) -> Result<T, String> {
    let request = serde_json::json!({
        "op": op,
        "params": params,
    });
    let request_bytes = serde_json::to_vec(&request)
        .map_err(|error| format!("Unable to prepare {label} request: {error}"))?;

    let bridge_script = resolve_market_operation_bridge(app)?;
    let node_command = resolve_node_command(app)?;
    let working_directory = resolve_command_working_directory(app);

    let output = run_backend_script_with_stdin(
        &node_command,
        &bridge_script,
        working_directory,
        label,
        &request_bytes,
    )?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope: MarketBridgeEnvelope = serde_json::from_str(stdout.trim()).map_err(|_| {
        if is_backend_runtime_execution_failure(&stdout) {
            backend_runtime_failed_error()
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if stdout.trim().is_empty() {
                stderr
            } else {
                stdout.trim().to_string()
            };
            if detail.is_empty() {
                format!("{label} failed without output.")
            } else {
                redact_user_visible_error(&detail)
            }
        }
    })?;

    if !envelope.ok {
        let message = envelope
            .error
            .unwrap_or_else(|| format!("{label} failed."));
        return Err(redact_user_visible_error(&message));
    }

    let result = envelope
        .result
        .ok_or_else(|| format!("{label} did not return a result."))?;
    serde_json::from_value(result)
        .map_err(|error| format!("Unable to parse {label} result: {error}"))
}

/// Tokenless Bridge 5 update check: ask the public catalog whether a newer
/// published version of an installed Market kit exists. NO automatic updates;
/// this only reports availability. Never requires a session/token.
#[tauri::command]
fn check_kit_update<R: Runtime>(
    app: tauri::AppHandle<R>,
    market_base_url: String,
    slug: String,
    installed_version: String,
) -> Result<KitUpdateStatus, String> {
    let market_base_url = normalize_hosted_market_base_url(Some(&market_base_url))?;
    let slug = normalize_market_slug(&slug)?;
    let installed_version = if installed_version.trim().is_empty() {
        "1".to_string()
    } else {
        installed_version.trim().to_string()
    };
    let params = serde_json::json!({
        "marketBaseUrl": market_base_url,
        "slug": slug,
        "installedVersion": installed_version,
    });
    run_tokenless_market_operation_bridge(&app, "update-check", params, "Market update check")
}

/// A single synced cloud favorite. Mirrors core's `Favorite`. Opt-in: only
/// reachable when an AgentKitProject session exists (token-gated bridge).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudFavorite {
    kit_id: String,
    slug: String,
    added_at: String,
    display_name: Option<String>,
    summary: Option<String>,
    publisher_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudFavoritesResult {
    items: Vec<CloudFavorite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveCloudFavoriteResult {
    kit_id: String,
}

/// List the signed-in user's synced cloud favorites. Token-gated via the
/// session bridge; persists any rotated session. Local-first: callers must only
/// invoke this when the AgentKitProject account is connected.
#[tauri::command]
fn list_cloud_favorites<R: Runtime>(
    app: tauri::AppHandle<R>,
    market_base_url: Option<String>,
) -> Result<CloudFavoritesResult, String> {
    let market_base_url = normalize_hosted_market_base_url(market_base_url.as_deref())?;
    let params = serde_json::json!({
        "marketBaseUrl": market_base_url,
        "clientId": account_auth::market_workos_client_id(),
    });
    run_market_operation_bridge(&app, "list-favorites", params, "Cloud favorites list")
}

/// Add a cloud favorite by slug or kit ID. Token-gated; persists any rotated
/// session. Returns the updated favorites list when the server echoes it.
#[tauri::command]
fn add_cloud_favorite<R: Runtime>(
    app: tauri::AppHandle<R>,
    slug: Option<String>,
    kit_id: Option<String>,
    market_base_url: Option<String>,
) -> Result<CloudFavoritesResult, String> {
    let market_base_url = normalize_hosted_market_base_url(market_base_url.as_deref())?;
    let slug = slug
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(normalize_market_slug)
        .transpose()?;
    let kit_id = kit_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(normalize_market_slug)
        .transpose()?;
    if slug.is_none() && kit_id.is_none() {
        return Err("Enter a Market kit slug or ID to favorite.".to_string());
    }
    let params = serde_json::json!({
        "slug": slug,
        "kitId": kit_id,
        "marketBaseUrl": market_base_url,
        "clientId": account_auth::market_workos_client_id(),
    });
    run_market_operation_bridge(&app, "add-favorite", params, "Cloud favorite add")
}

/// Remove a cloud favorite by kit ID. Token-gated; persists any rotated session.
#[tauri::command]
fn remove_cloud_favorite<R: Runtime>(
    app: tauri::AppHandle<R>,
    kit_id: String,
    market_base_url: Option<String>,
) -> Result<RemoveCloudFavoriteResult, String> {
    let market_base_url = normalize_hosted_market_base_url(market_base_url.as_deref())?;
    let kit_id = normalize_market_slug(&kit_id)?;
    let params = serde_json::json!({
        "kitId": kit_id,
        "marketBaseUrl": market_base_url,
        "clientId": account_auth::market_workos_client_id(),
    });
    run_market_operation_bridge(&app, "remove-favorite", params, "Cloud favorite remove")
}

/// Map a core-emitted error string to the app's user-facing message/behavior.
/// Core raises `RECONNECT_REQUIRED: ...` on unrecoverable auth; the app flags the
/// account as reconnect-required (matching the prior Rust client) so the UI
/// shows the reconnect prompt. Other messages pass through after redaction.
fn map_market_bridge_error<R: Runtime>(app: &tauri::AppHandle<R>, message: &str) -> String {
    if message.contains("RECONNECT_REQUIRED")
        || hosted_market_error_is_auth_failure(message)
    {
        return account_auth::mark_reconnect_required(app);
    }
    redact_user_visible_error(message)
}

#[tauri::command]
fn render_agent_kit_draft<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: RenderAgentKitDraftInput,
) -> Result<RenderAgentKitDraftResult, String> {
    let draft_file_path = canonicalize_json_file(&input.draft_file_path)?;
    let draft_json: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&draft_file_path)
            .map_err(|error| format!("Unable to read AgentKitDraft JSON: {error}"))?,
    )
    .map_err(|error| format!("Unable to parse AgentKitDraft JSON: {error}"))?;
    let output_folder = resolve_render_output_directory(&app, &input.output_folder, &draft_json)?;
    let bridge_script = resolve_render_draft_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(&draft_file_path)
        .arg(&output_folder)
        .arg(if input.force { "true" } else { "false" })
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run agentkitforge-core draft render: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "agentkitforge-core draft render failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse draft render result: {error}"))
}

#[tauri::command]
fn render_generated_agent_kit_draft<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: RenderGeneratedAgentKitDraftInput,
) -> Result<RenderAgentKitDraftResult, String> {
    let output_folder =
        resolve_render_output_directory(&app, &input.output_folder, &input.draft_json)?;
    let bridge_script = resolve_render_generated_draft_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;
    let draft_json = serde_json::to_string(&input.draft_json)
        .map_err(|error| format!("Unable to serialize generated draft JSON: {error}"))?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(draft_json)
        .arg(&output_folder)
        .arg(if input.force { "true" } else { "false" })
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run generated draft render: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Generated draft render failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse generated draft render result: {error}"))
}

#[tauri::command]
async fn generate_agent_kit_draft_with_openai<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: GenerateAgentKitDraftInput,
) -> Result<GenerateAgentKitDraftResult, String> {
    let user_request =
        clean_required_value("Describe the Agent Kit you want", &input.user_request)?;
    let provider = settings::get_ai_provider(&app, input.provider_id.as_deref())?;
    let model = ai_providers::selected_model(&provider, input.model.as_deref())?;
    let bridge_script = resolve_generate_draft_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let request = serde_json::json!({
        "userRequest": user_request,
        "targetUsers": split_lines_or_commas(input.target_users.as_deref()),
        "domain": clean_optional(input.domain.as_deref()),
        "desiredValidationLevel": input.desired_validation_level.as_str(),
        "constraints": split_lines_or_commas(input.constraints.as_deref()),
        "sourceNotes": split_lines_or_commas(input.source_notes.as_deref()),
        "requestedSections": input.requested_sections.unwrap_or_default(),
        "excludedSections": input.excluded_sections.unwrap_or_default(),
        "exampleInputDocuments": input.example_input_documents.unwrap_or_default(),
        "model": model,
    });

    let request_json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let provider_json = serde_json::to_string(&provider).map_err(|error| error.to_string())?;
    run_ai_draft_bridge(
        &app,
        bridge_script,
        node_command,
        provider_json,
        request_json,
        "generate",
        "AI draft generation",
    )
    .await
}

#[tauri::command]
async fn generate_agent_kit_draft_with_ai<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: GenerateAgentKitDraftInput,
) -> Result<GenerateAgentKitDraftResult, String> {
    generate_agent_kit_draft_with_openai(app, input).await
}

#[tauri::command]
async fn revise_agent_kit_draft_with_ai<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ReviseAgentKitDraftInput,
) -> Result<GenerateAgentKitDraftResult, String> {
    let change_request = clean_required_value("Change request", &input.change_request)?;
    let provider = settings::get_ai_provider(&app, input.provider_id.as_deref())?;
    let model = ai_providers::selected_model(&provider, input.model.as_deref())?;
    let bridge_script = resolve_generate_draft_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let request = serde_json::json!({
        "session": input.session,
        "changeRequest": change_request,
        "desiredValidationLevel": input.desired_validation_level.as_str(),
        "constraints": split_lines_or_commas(input.constraints.as_deref()),
        "sourceNotes": split_lines_or_commas(input.source_notes.as_deref()),
        "requestedSections": input.requested_sections.unwrap_or_default(),
        "excludedSections": input.excluded_sections.unwrap_or_default(),
        "exampleInputDocuments": input.example_input_documents.unwrap_or_default(),
        "model": model,
    });

    let request_json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let provider_json = serde_json::to_string(&provider).map_err(|error| error.to_string())?;
    run_ai_draft_bridge(
        &app,
        bridge_script,
        node_command,
        provider_json,
        request_json,
        "revise",
        "AI draft revision",
    )
    .await
}

async fn run_ai_draft_bridge<R: Runtime>(
    app: &tauri::AppHandle<R>,
    bridge_script: PathBuf,
    node_command: BackendNodeCommand,
    provider_json: String,
    request_json: String,
    action: &'static str,
    label: &'static str,
) -> Result<GenerateAgentKitDraftResult, String> {
    let working_directory = resolve_command_working_directory(app);
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_backend_script_with_env(
            &node_command,
            &bridge_script,
            vec![OsString::from(action), OsString::from(request_json)],
            working_directory,
            label,
            vec![("AGENTKITFORGE_AI_PROVIDER_CONFIG", provider_json)],
        )
    })
    .await
    .map_err(|error| format!("{label} task failed: {error}"))?
    .map_err(|error| format!("Unable to run {label}: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!("{label} failed without output")
        } else if is_backend_runtime_execution_failure(&detail) {
            backend_runtime_failed_error()
        } else if is_raw_fetch_failed_error(&detail) {
            "OpenAI network request failed before receiving an HTTP response. See provider diagnostics.".to_string()
        } else {
            redact_user_visible_error(&detail)
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse {label} result: {error}"))
}

#[tauri::command]
fn save_agent_kit_draft_json(
    input: SaveAgentKitDraftJsonInput,
    output_path: String,
) -> Result<SaveAgentKitDraftJsonResult, String> {
    let output_path = resolve_json_output_path(&output_path)?;
    let content = serde_json::to_string_pretty(&input.draft_json)
        .map_err(|error| format!("Unable to serialize draft JSON: {error}"))?;
    fs::write(&output_path, format!("{content}\n"))
        .map_err(|error| format!("Unable to save draft JSON: {error}"))?;

    Ok(SaveAgentKitDraftJsonResult {
        file_path: output_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn save_markdown_file(
    input: SaveMarkdownFileInput,
    output_path: String,
) -> Result<SaveMarkdownFileResult, String> {
    let output_path = resolve_markdown_file_output_path(&output_path, "Markdown output")?;
    fs::write(&output_path, format!("{}\n", input.content.trim_end()))
        .map_err(|error| format!("Unable to save Markdown file: {error}"))?;

    Ok(SaveMarkdownFileResult {
        file_path: output_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn get_agent_kit_starter_hint(root_path: String) -> Result<Option<AgentKitStarterHint>, String> {
    let root_path = canonicalize_directory(&root_path)?;

    for file_name in ["START_HERE.md", "README.md"] {
        let candidate = root_path.join(file_name);
        if candidate.is_file() {
            let content = fs::read_to_string(&candidate)
                .map_err(|error| format!("Unable to read {file_name}: {error}"))?;
            if let Some(excerpt) = starter_excerpt(&content) {
                return Ok(Some(AgentKitStarterHint {
                    source_file: file_name.to_string(),
                    excerpt,
                }));
            }
        }
    }

    Ok(None)
}

#[tauri::command]
fn open_folder<R: Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<(), String> {
    let folder = canonicalize_directory(&path)?;
    let folder = folder.to_string_lossy().into_owned();
    app.opener()
        .open_path(folder, None::<&str>)
        .map_err(|error| format!("Unable to open output folder: {error}"))?;

    Ok(())
}

#[tauri::command]
fn open_external_url<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) {
        return Err("Unsupported external link.".to_string());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Unable to open link: {error}"))?;

    Ok(())
}

/// Allow only HTTPS links to known AgentKitProject hosts. Static pages are
/// matched exactly; dynamic pages (per-submission, per-kit) are matched by
/// host + path prefix so links like `.../submissions/{id}` open, while still
/// rejecting arbitrary hosts (no open-redirect).
fn is_allowed_external_url(url: &str) -> bool {
    const EXACT: &[&str] = &[
        "https://forge.agentkitproject.com/",
        "https://forge.agentkitproject.com/docs/",
        "https://forge.agentkitproject.com/agent-kit-spec/",
        "https://profile.agentkitproject.com/account",
        "https://market.agentkitproject.com",
        "https://market.agentkitproject.com/",
        "https://market.agentkitproject.com/kits",
    ];
    if EXACT.contains(&url) {
        return true;
    }

    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    // Host + path-prefix allowlist for dynamic destinations.
    matches!(
        (parsed.host_str(), parsed.path()),
        (Some("market.agentkitproject.com"), path)
            if path.starts_with("/submissions/") || path.starts_with("/kits/")
    )
}

#[tauri::command]
fn check_packaged_runtime_files<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PackagedRuntimeDiagnostics, String> {
    let is_dev = cfg!(debug_assertions);
    let os = std::env::consts::OS.to_string();
    let current_executable_path = std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    let resource_directory = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());

    let resolved_node_path = diagnostic_node_path(&app);
    let node_exists = resolved_node_path.exists();

    let backend_dist_path = diagnostic_backend_dist_path(&app);
    let backend_dist_exists = backend_dist_path.is_dir();
    let required_backend_files = BACKEND_REQUIRED_DIAGNOSTIC_FILES
        .iter()
        .map(|file_name| {
            let path = backend_dist_path.join(file_name);
            RuntimeFileDiagnostic {
                file_name: (*file_name).to_string(),
                path: path.to_string_lossy().into_owned(),
                exists: path.is_file(),
            }
        })
        .collect();

    let node_version_result = run_runtime_diagnostic_command({
        let mut command = Command::new(&resolved_node_path);
        command.arg("--version");
        command
    });

    let node_check_result = {
        let script_path = backend_dist_path.join("generate-agent-kit-draft.mjs");
        run_runtime_diagnostic_command({
            let mut command = Command::new(&resolved_node_path);
            command.arg("--check").arg(script_path);
            command
        })
    };
    let fetch_smoke_test_result = run_runtime_diagnostic_command({
        let mut command = Command::new(&resolved_node_path);
        command.arg("-e").arg(
            "fetch('https://api.openai.com/v1/models').then((response) => { console.log(JSON.stringify({ ok: true, status: response.status })); }).catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });",
        );
        command
    });

    Ok(PackagedRuntimeDiagnostics {
        is_dev,
        os,
        current_executable_path,
        resource_directory,
        resolved_node_path: resolved_node_path.to_string_lossy().into_owned(),
        node_exists,
        resolved_backend_dist_path: backend_dist_path.to_string_lossy().into_owned(),
        backend_dist_exists,
        required_backend_files,
        node_version_result,
        node_check_result,
        fetch_smoke_test_result,
    })
}

#[tauri::command]
fn list_my_kits<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<MyKitEntry>, String> {
    let mut library = read_my_kits_library(&app)?;
    let changed = merge_discovered_library_kits(&app, &mut library)?;
    for kit in &mut library.kits {
        kit.path_exists = Path::new(&kit.path).is_dir();
    }
    if changed {
        write_my_kits_library(&app, &library)?;
    }
    library
        .kits
        .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(library.kits)
}

#[tauri::command]
fn get_agent_kit_metadata(root_path: String) -> Result<KitMetadata, String> {
    let path = canonicalize_directory(&root_path)?;
    read_kit_metadata(&path)
}

#[tauri::command]
fn add_kit_to_library<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: AddKitToLibraryInput,
) -> Result<MyKitEntry, String> {
    let path = canonicalize_directory(&input.path)?;
    let metadata = read_kit_metadata(&path)?;
    let now = now_timestamp();
    let mut library = read_my_kits_library(&app)?;
    let normalized_path = path.to_string_lossy().into_owned();

    if let Some(existing) = library
        .kits
        .iter_mut()
        .find(|kit| paths_equal(&kit.path, &normalized_path))
    {
        apply_package_metadata_to_entry(existing, input.package_metadata.as_ref());
        existing.id = metadata.id;
        existing.name = metadata.name;
        existing.version = metadata.version;
        existing.description = metadata.description;
        existing.source = input.source.as_str().to_string();
        if existing.installed_at.is_none() {
            existing.installed_at = Some(now.clone());
        }
        existing.updated_at = now;
        existing.path_exists = true;
        let entry = existing.clone();
        write_my_kits_library(&app, &library)?;
        return Ok(entry);
    }

    let entry = MyKitEntry {
        id: metadata.id,
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        path: normalized_path,
        source: input.source.as_str().to_string(),
        source_label: None,
        last_validated_at: None,
        last_validated_profile: None,
        last_validation_valid: None,
        last_used_at: None,
        imported_at: None,
        // The moment this kit was added to the local library (Bridge 5
        // provenance). Distinct from `imported_at` (package import time).
        installed_at: Some(now.clone()),
        package_file_name: None,
        package_size_bytes: None,
        sha256: None,
        market_base_url: None,
        schema_version: None,
        source_market_slug: None,
        source_market_kit_id: None,
        source_url: None,
        published_at: None,
        created_at: now.clone(),
        updated_at: now,
        path_exists: true,
    };
    let mut entry = entry;
    apply_package_metadata_to_entry(&mut entry, input.package_metadata.as_ref());
    library.kits.push(entry.clone());
    write_my_kits_library(&app, &library)?;
    Ok(entry)
}

#[tauri::command]
fn remove_kit_from_library<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<RemoveKitFromLibraryResult, String> {
    let library_root = configured_library_root(&app)?;
    let mut library = read_my_kits_library(&app)?;
    let entry = library
        .kits
        .iter()
        .find(|kit| paths_equal(&kit.path, &path))
        .cloned();
    let Some(entry) = entry else {
        write_my_kits_library(&app, &library)?;
        return Ok(RemoveKitFromLibraryResult {
            removed_from_library: false,
            deleted_local_files: false,
        });
    };

    let deleted_local_files = remove_library_owned_kit_files(&entry, &library_root)?;
    library
        .kits
        .retain(|kit| !paths_equal(&kit.path, &entry.path));
    write_my_kits_library(&app, &library)?;
    Ok(RemoveKitFromLibraryResult {
        removed_from_library: true,
        deleted_local_files,
    })
}

#[tauri::command]
fn refresh_kit_metadata<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<MyKitEntry, String> {
    let resolved_path = canonicalize_directory(&path)?;
    let metadata = read_kit_metadata(&resolved_path)?;
    let normalized_path = resolved_path.to_string_lossy().into_owned();
    let now = now_timestamp();
    let mut library = read_my_kits_library(&app)?;
    let entry = library
        .kits
        .iter_mut()
        .find(|kit| paths_equal(&kit.path, &normalized_path))
        .ok_or_else(|| "Kit is not in My Kits.".to_string())?;

    entry.id = metadata.id;
    entry.name = metadata.name;
    entry.version = metadata.version;
    entry.description = metadata.description;
    entry.updated_at = now;
    entry.path_exists = true;
    let updated = entry.clone();
    write_my_kits_library(&app, &library)?;
    Ok(updated)
}

#[tauri::command]
fn mark_library_kit_used<R: Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<(), String> {
    let mut library = read_my_kits_library(&app)?;
    if let Some(entry) = library
        .kits
        .iter_mut()
        .find(|kit| paths_equal(&kit.path, &path))
    {
        let now = now_timestamp();
        entry.last_used_at = Some(now.clone());
        entry.updated_at = now;
        write_my_kits_library(&app, &library)?;
    }
    Ok(())
}

#[tauri::command]
fn validate_library_kit<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    profile: ValidationProfile,
) -> Result<ValidationReport, String> {
    let report = validate_agent_kit(app.clone(), path.clone(), profile)?;
    let mut library = read_my_kits_library(&app)?;
    if let Some(entry) = library
        .kits
        .iter_mut()
        .find(|kit| paths_equal(&kit.path, &path))
    {
        let now = now_timestamp();
        entry.last_validated_at = Some(now.clone());
        entry.last_validated_profile = Some(report.profile.clone());
        entry.last_validation_valid = Some(report.valid);
        entry.updated_at = now;
        write_my_kits_library(&app, &library)?;
    }
    Ok(report)
}

#[tauri::command]
fn import_agent_kit_package<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ImportAgentKitPackageInput,
) -> Result<ImportAgentKitPackageResult, String> {
    let package_path = canonicalize_agent_kit_package(&input.package_path)?;
    let destination_root = canonicalize_directory(&input.destination_root_folder)?;
    let mut package_metadata = package_import_metadata(&package_path)?;
    let found_files = inspect_agent_kit_zip_structure(&package_path)?;
    validate_agent_kit_zip_structure(&found_files)?;
    let duplicate_warnings = package_duplicate_warnings(&app, &package_metadata)?;
    if !duplicate_warnings.is_empty() && input.import_as_copy != Some(true) && !input.force {
        return Err(
            "This package appears to match a kit already in My Kits. Choose Import as copy to keep both copies, or cancel the import."
                .to_string(),
        );
    }
    let validation_profile = input
        .validation_profile
        .unwrap_or(ValidationProfile::LocalValid);
    let target_folder_name = package_stem(&package_path)?;
    let extraction_folder = unique_or_forced_extraction_folder(
        &destination_root,
        &target_folder_name,
        input.force,
        input.import_as_copy == Some(true),
    )?;

    let files = match extract_agent_kit_zip(&package_path, &destination_root, &extraction_folder) {
        Ok(files) => files,
        Err(error) => {
            let _ = fs::remove_dir_all(&extraction_folder);
            return Err(error);
        }
    };
    let report = validate_agent_kit(
        app,
        extraction_folder.to_string_lossy().into_owned(),
        validation_profile,
    )?;
    if !report.valid {
        let _ = fs::remove_dir_all(&extraction_folder);
        return Err(format!(
            "Imported package did not pass validation: {}",
            validation_summary(&report)
        ));
    }

    package_metadata.imported_at = Some(now_timestamp());
    let mut metadata = metadata_entry_from_path(&extraction_folder, KitLibrarySource::LocalImport)?;
    apply_package_metadata_to_entry(&mut metadata, Some(&package_metadata));

    Ok(ImportAgentKitPackageResult {
        extracted_path: extraction_folder.to_string_lossy().into_owned(),
        validation_report: report,
        metadata,
        package_metadata,
        duplicate_warnings,
        files,
    })
}

#[tauri::command]
fn import_hosted_market_kit<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ImportHostedMarketKitInput,
) -> Result<ImportAgentKitPackageResult, String> {
    let kit_id = input
        .kit_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(normalize_market_slug)
        .transpose()?;
    let slug = if input.slug.trim().is_empty() {
        kit_id
            .clone()
            .ok_or_else(|| "Enter a Market kit slug or ID before importing.".to_string())?
    } else {
        normalize_market_slug(&input.slug)?
    };
    let market_identifier = kit_id.as_deref().unwrap_or(slug.as_str()).to_string();
    let market_base_url = normalize_hosted_market_base_url(input.market_base_url.as_deref())?;
    let temp_root = std::env::temp_dir().join(format!(
        "agentkitforge-market-import-{}",
        now_timestamp().replace(':', "-")
    ));
    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("Unable to prepare temporary Market import folder: {error}"))?;

    // Delegate the authenticated download (download-info → presigned GET →
    // lifecycle/size/checksum verification) to the core `market` module via the
    // operation bridge. Core writes the verified .agentkit.zip to `outputPath`
    // and returns provenance; the app keeps its package-import + library
    // persistence below unchanged.
    let file_name = market_download_file_name(None, &market_identifier)?;
    let package_path = temp_root.join(&file_name);
    let download_params = serde_json::json!({
        "slug": slug,
        "kitId": kit_id,
        "marketBaseUrl": market_base_url,
        "outputPath": package_path.to_string_lossy().into_owned(),
        "clientId": account_auth::market_workos_client_id(),
    });
    let download_outcome: Result<MarketBridgeDownloadResult, String> =
        run_market_operation_bridge(&app, "download", download_params, "Market import");
    let download_info = match download_outcome {
        Ok(outcome) => outcome.provenance,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(error);
        }
    };

    let result = (|| {
        let actual_sha256 = sha256_for_file(&package_path)?;

        let destination_root = configured_library_root(&app)?;
        let mut import_result = import_agent_kit_package(
            app.clone(),
            ImportAgentKitPackageInput {
                package_path: package_path.to_string_lossy().into_owned(),
                destination_root_folder: destination_root.to_string_lossy().into_owned(),
                force: input.force.unwrap_or(false),
                import_as_copy: input.import_as_copy,
                validation_profile: input.validation_profile,
            },
        )?;

        import_result.package_metadata.source = Some("market".to_string());
        import_result.package_metadata.source_label = Some("AgentKitMarket".to_string());
        import_result.package_metadata.market_base_url = Some(market_base_url.clone());
        import_result.package_metadata.source_market_slug = Some(slug.clone());
        if import_result
            .package_metadata
            .source_market_kit_id
            .is_none()
        {
            import_result.package_metadata.source_market_kit_id = download_info
                .market_kit_id
                .clone()
                .or_else(|| kit_id.clone());
        }
        if import_result.package_metadata.version.is_none() {
            import_result.package_metadata.version = download_info.version.clone();
        }
        // Persist the canonical Market source URL from download provenance
        // (Bridge 5). Manifest-derived metadata has none for hosted imports.
        if import_result.package_metadata.source_url.is_none() {
            import_result.package_metadata.source_url = download_info.source_url.clone();
        }
        import_result.package_metadata.package_size_bytes = Some(
            fs::metadata(&package_path)
                .map_err(|error| format!("Unable to inspect imported Market package: {error}"))?
                .len(),
        );
        import_result.package_metadata.sha256 = Some(actual_sha256);
        apply_package_metadata_to_entry(
            &mut import_result.metadata,
            Some(&import_result.package_metadata),
        );
        import_result.metadata.source = KitLibrarySource::Market.as_str().to_string();

        let library_entry = add_kit_to_library(
            app.clone(),
            AddKitToLibraryInput {
                path: import_result.extracted_path.clone(),
                source: KitLibrarySource::Market,
                package_metadata: Some(import_result.package_metadata.clone()),
            },
        )?;
        import_result.metadata = library_entry;
        Ok(import_result)
    })();

    let _ = fs::remove_dir_all(&temp_root);
    result
}

/// Tier-2 paid/licensed kit consumption (online-only enforcement).
///
/// Fetches the entitlement-gated, WATERMARKED package via core's
/// `fetchLicensedKit` (held in memory in the bridge; sha256-verified). The
/// no-persist guarantee for ONLINE-ONLY kits is enforced HERE in two layers:
///   1. The bridge never returns or writes the bytes for online-only kits, so
///      this command has nothing to save and `imported` is always `None`.
///   2. The watermarked bytes — when returned at all (downloadable paid only) —
///      are imported into the standard library path, exactly like a normal
///      Market import. Free kits are unaffected (they use the public
///      `import_hosted_market_kit` path).
///
/// Online-only kits get a read-only in-memory PREVIEW only; the UI must block
/// every save/export with the returned message.
#[tauri::command]
fn fetch_licensed_market_kit<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ImportHostedMarketKitInput,
) -> Result<FetchLicensedMarketKitResult, String> {
    let kit_id = input
        .kit_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(normalize_market_slug)
        .transpose()?;
    let slug = if input.slug.trim().is_empty() {
        kit_id
            .clone()
            .ok_or_else(|| "Enter a Market kit slug or ID before fetching.".to_string())?
    } else {
        normalize_market_slug(&input.slug)?
    };
    let market_identifier = kit_id.as_deref().unwrap_or(slug.as_str()).to_string();
    let market_base_url = normalize_hosted_market_base_url(input.market_base_url.as_deref())?;

    // Temp path is only used by the bridge for DOWNLOADABLE paid kits; the
    // bridge ignores it for online-only kits (and writes nothing).
    let temp_root = std::env::temp_dir().join(format!(
        "agentkitforge-licensed-{}",
        now_timestamp().replace(':', "-")
    ));
    let file_name = market_download_file_name(None, &market_identifier)?;
    let package_path = temp_root.join(&file_name);

    let params = serde_json::json!({
        "slug": slug,
        "kitId": kit_id,
        "marketBaseUrl": market_base_url,
        "outputPath": package_path.to_string_lossy().into_owned(),
        "clientId": account_auth::market_workos_client_id(),
    });

    let licensed: MarketBridgeLicensedResult =
        run_market_operation_bridge(&app, "licensed-package", params, "Licensed Market kit")?;

    if licensed.online_only {
        // NO-PERSIST: the bridge returned no bytes/path. Nothing was written and
        // nothing will be. Return the read-only preview with a clear message.
        let _ = fs::remove_dir_all(&temp_root);
        return Ok(FetchLicensedMarketKitResult {
            online_only: true,
            pricing: licensed.pricing,
            downloadable: licensed.downloadable,
            kit_id: licensed.kit_id,
            sha256: licensed.sha256,
            preview: licensed.preview,
            imported: None,
            message: "This kit is online-only and cannot be saved or exported.".to_string(),
        });
    }

    // DOWNLOADABLE paid kit the user owns: import the WATERMARKED bytes the
    // bridge saved (never the public download), through the standard library
    // path, then clean up the temp file.
    let result = (|| {
        let saved_path = licensed
            .saved_path
            .clone()
            .ok_or_else(|| "Licensed package was not provided for a downloadable kit.".to_string())?;
        let actual_sha256 = sha256_for_file(Path::new(&saved_path))?;
        let destination_root = configured_library_root(&app)?;
        let mut import_result = import_agent_kit_package(
            app.clone(),
            ImportAgentKitPackageInput {
                package_path: saved_path,
                destination_root_folder: destination_root.to_string_lossy().into_owned(),
                force: input.force.unwrap_or(false),
                import_as_copy: input.import_as_copy,
                validation_profile: input.validation_profile,
            },
        )?;

        import_result.package_metadata.source = Some("market".to_string());
        import_result.package_metadata.source_label = Some("AgentKitMarket".to_string());
        import_result.package_metadata.market_base_url = Some(market_base_url.clone());
        import_result.package_metadata.source_market_slug = Some(slug.clone());
        if import_result.package_metadata.source_market_kit_id.is_none() {
            import_result.package_metadata.source_market_kit_id =
                Some(licensed.kit_id.clone()).or_else(|| kit_id.clone());
        }
        import_result.package_metadata.sha256 = Some(actual_sha256);
        apply_package_metadata_to_entry(
            &mut import_result.metadata,
            Some(&import_result.package_metadata),
        );
        import_result.metadata.source = KitLibrarySource::Market.as_str().to_string();

        let library_entry = add_kit_to_library(
            app.clone(),
            AddKitToLibraryInput {
                path: import_result.extracted_path.clone(),
                source: KitLibrarySource::Market,
                package_metadata: Some(import_result.package_metadata.clone()),
            },
        )?;
        import_result.metadata = library_entry;
        Ok::<ImportAgentKitPackageResult, String>(import_result)
    })();

    let _ = fs::remove_dir_all(&temp_root);
    let imported = result?;
    let name = imported.metadata.name.clone();
    Ok(FetchLicensedMarketKitResult {
        online_only: false,
        pricing: licensed.pricing,
        downloadable: licensed.downloadable,
        kit_id: licensed.kit_id,
        sha256: licensed.sha256,
        preview: licensed.preview,
        imported: Some(imported),
        message: format!("Saved your licensed copy of {name} to My Kits."),
    })
}

#[tauri::command]
fn inspect_agent_kit_package<R: Runtime>(
    app: tauri::AppHandle<R>,
    package_path: String,
) -> Result<AgentKitPackagePreview, String> {
    let package_path = canonicalize_agent_kit_package(&package_path)?;
    let package_metadata = package_import_metadata(&package_path)?;
    let found_files = inspect_agent_kit_zip_structure(&package_path)?;
    validate_agent_kit_zip_structure(&found_files)?;
    let duplicate_warnings = package_duplicate_warnings(&app, &package_metadata)?;

    Ok(AgentKitPackagePreview {
        package_path: package_path.to_string_lossy().into_owned(),
        package_metadata,
        duplicate_warnings,
        found_files,
    })
}

#[tauri::command]
fn inspect_agent_kit_candidate<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<AgentKitCandidateInspection, String> {
    inspect_agent_kit_candidate_inner(&app, &path)
}

#[tauri::command]
fn get_agent_kit_summary<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<serde_json::Value, String> {
    let bridge_script = resolve_app_support_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;
    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("summary")
        .arg(path)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to inspect Agent Kit summary: {error}"))?;

    parse_node_json_output(output, "Agent Kit summary")
}

#[tauri::command]
fn load_agent_kit_as_draft<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<serde_json::Value, String> {
    let kit_path = canonicalize_directory(&path)?;
    let bridge_script = resolve_app_support_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;
    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("load-draft")
        .arg(&kit_path)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to load Agent Kit as draft: {error}"))?;

    parse_node_json_output(output, "Agent Kit draft load")
}

#[tauri::command]
fn summarize_example_input_documents<R: Runtime>(
    app: tauri::AppHandle<R>,
    paths: Vec<String>,
) -> Result<serde_json::Value, String> {
    if paths.is_empty() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }

    let bridge_script = resolve_app_support_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;
    let paths_json = serde_json::to_string(&paths)
        .map_err(|error| format!("Unable to serialize example document paths: {error}"))?;
    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("example-documents")
        .arg(paths_json)
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to summarize example input documents: {error}"))?;

    parse_node_json_output(output, "Example input document summary")
}

#[tauri::command]
fn import_agent_kit_from_git<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ImportAgentKitFromGitInput,
) -> Result<ImportAgentKitFromGitResult, String> {
    let repository_url = clean_git_repository_url(&input.repository_url)?;
    let redacted_repository_url = redact_user_visible_error(&repository_url);
    let destination_root = canonicalize_directory(&input.destination_root_folder)?;
    let validation_profile = input
        .validation_profile
        .unwrap_or(ValidationProfile::LocalValid);
    let repo_folder_name = repo_folder_name_from_url(&repository_url);
    let temp_root = std::env::temp_dir().join(format!(
        "agentkitforge-git-import-{}-{}",
        now_timestamp(),
        repo_folder_name
    ));
    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("Unable to prepare temporary Git import folder: {error}"))?;
    let clone_folder = temp_root.join("repo");

    if let Err(error) =
        clone_git_repository(&repository_url, input.reference.as_deref(), &clone_folder)
    {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(error);
    }

    let inspection = inspect_agent_kit_candidate_inner(&app, &clone_folder.to_string_lossy())?;
    if !inspection.looks_like_agent_kit {
        let _ = fs::remove_dir_all(&temp_root);
        return Ok(ImportAgentKitFromGitResult {
            repository_url: redacted_repository_url,
            imported_path: None,
            validation_report: None,
            metadata: None,
            inspection,
            files: Vec::new(),
            warnings: Vec::new(),
        });
    }

    let target_folder_name = metadata_entry_from_path(&clone_folder, KitLibrarySource::Imported)
        .map(|metadata| sanitize_folder_name(&metadata.id))
        .unwrap_or(repo_folder_name);
    let import_folder =
        unique_or_forced_extraction_folder(&destination_root, &target_folder_name, false, false)?;
    let copy_result = match copy_agent_kit_directory(&clone_folder, &import_folder) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_root);
            let _ = fs::remove_dir_all(&import_folder);
            return Err(error);
        }
    };
    let _ = fs::remove_dir_all(&temp_root);

    let report = validate_agent_kit(
        app,
        import_folder.to_string_lossy().into_owned(),
        validation_profile,
    )?;
    let metadata = metadata_entry_from_path(&import_folder, KitLibrarySource::Imported)?;

    Ok(ImportAgentKitFromGitResult {
        repository_url: redacted_repository_url,
        imported_path: Some(import_folder.to_string_lossy().into_owned()),
        validation_report: Some(report),
        metadata: Some(metadata),
        inspection,
        files: copy_result.files,
        warnings: copy_result.warnings,
    })
}

#[tauri::command]
fn export_agent_kit_to_codex<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ExportAgentKitToCodexInput,
) -> Result<ExportAgentKitToCodexResult, String> {
    let kit_path = canonicalize_directory(&input.kit_path)?;
    let destination_skills_dir = canonicalize_directory(&input.destination_skills_dir)?;
    let bridge_script = resolve_codex_export_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(&kit_path)
        .arg(&destination_skills_dir)
        .arg(if input.force { "true" } else { "false" })
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run Codex skills export: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Codex skills export failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse Codex export result: {error}"))
}

#[tauri::command]
fn export_agent_kit_to_claude_code<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ExportAgentKitToClaudeCodeInput,
) -> Result<ExportAgentKitToClaudeCodeResult, String> {
    let kit_path = canonicalize_directory(&input.kit_path)?;
    let destination_dir = canonicalize_directory(&input.destination_dir)?;
    let bridge_script = resolve_claude_code_export_bridge(&app)?;
    let node_command = resolve_node_command(&app)?;

    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg(&kit_path)
        .arg(&destination_dir)
        .arg(if input.force { "true" } else { "false" })
        .current_dir(resolve_command_working_directory(&app))
        .output()
        .map_err(|error| format!("Unable to run Claude Code plugin export: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Claude Code plugin export failed without output".to_string()
        } else {
            detail
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse Claude Code export result: {error}"))
}

#[tauri::command]
fn get_app_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<settings::PublicSettings, String> {
    settings::get_public_settings(&app)
}

#[tauri::command]
fn save_openai_api_key<R: Runtime>(
    app: tauri::AppHandle<R>,
    api_key: String,
) -> Result<settings::PublicSettings, String> {
    settings::save_openai_api_key(&app, api_key)
}

#[tauri::command]
fn clear_openai_api_key<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<settings::PublicSettings, String> {
    settings::clear_openai_api_key(&app)
}

#[tauri::command]
fn save_default_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    model: String,
) -> Result<settings::PublicSettings, String> {
    settings::save_default_model(&app, model)
}

#[tauri::command]
fn save_app_preferences<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: settings::AppPreferencesInput,
) -> Result<settings::PublicSettings, String> {
    settings::save_app_preferences(&app, input)
}

#[tauri::command]
fn save_update_check_timestamp<R: Runtime>(
    app: tauri::AppHandle<R>,
    checked_at: String,
) -> Result<settings::PublicSettings, String> {
    settings::save_update_check_timestamp(&app, checked_at)
}

#[tauri::command]
fn disconnect_agentkitproject_account<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<settings::PublicSettings, String> {
    account_auth::disconnect_account(&app)
}

#[tauri::command]
fn begin_agentkitproject_account_login<R: Runtime>(
    app: tauri::AppHandle<R>,
    login_state: State<'_, account_auth::AccountLoginState>,
) -> Result<account_auth::DeviceLoginStart, String> {
    account_auth::begin_device_login(&app, &login_state)
}

#[tauri::command]
fn complete_agentkitproject_account_login<R: Runtime>(
    app: tauri::AppHandle<R>,
    login_state: State<'_, account_auth::AccountLoginState>,
    input: account_auth::CompleteDeviceLoginInput,
) -> Result<settings::PublicSettings, String> {
    account_auth::complete_device_login(&app, &login_state, input)
}

#[tauri::command]
fn restore_agentkitproject_account<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<settings::PublicSettings, String> {
    account_auth::restore_account_from_secure_storage(&app)
}

#[tauri::command]
fn check_agentkitproject_account_session<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<account_auth::AccountSessionDiagnostics, String> {
    account_auth::account_session_diagnostics(&app)
}

#[tauri::command]
fn check_agentkitproject_auth_config() -> account_auth::AccountAuthConfigDiagnostics {
    account_auth::account_auth_config_diagnostics()
}

#[tauri::command]
fn save_ai_provider<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: ai_providers::AiProviderInput,
) -> Result<settings::PublicSettings, String> {
    settings::save_ai_provider(&app, input)
}

#[tauri::command]
fn remove_ai_provider<R: Runtime>(
    app: tauri::AppHandle<R>,
    provider_id: String,
) -> Result<settings::PublicSettings, String> {
    settings::remove_ai_provider(&app, provider_id)
}

#[tauri::command]
fn set_default_ai_provider<R: Runtime>(
    app: tauri::AppHandle<R>,
    provider_id: String,
) -> Result<settings::PublicSettings, String> {
    settings::set_default_ai_provider(&app, provider_id)
}

#[tauri::command]
async fn test_ai_provider_connection<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: TestAiProviderConnectionInput,
) -> Result<ai_providers::ProviderConnectionTestResult, String> {
    let provider = settings::get_ai_provider(&app, input.provider_id.as_deref())?;
    ai_providers::test_connection(&provider, input.model).await
}

#[tauri::command]
async fn test_openai_connection<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: TestOpenAIConnectionInput,
) -> Result<TestOpenAIConnectionResult, String> {
    let provider = settings::get_ai_provider(&app, None)?;
    let result = ai_providers::test_connection(&provider, input.model).await?;
    Ok(TestOpenAIConnectionResult {
        ok: result.ok,
        model: result.model,
        message: result.message,
    })
}

#[tauri::command]
async fn run_agent_kit_with_openai<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: openai_runtime::RunAgentKitInput,
) -> Result<openai_runtime::RunAgentKitResult, String> {
    let provider = settings::get_ai_provider(&app, input.provider_id.as_deref())?;
    let bridge_script = resolve_context_builder_bridge(&app)?;
    let working_directory = resolve_command_working_directory(&app);
    let node_command = resolve_node_command(&app)?;
    openai_runtime::run_agent_kit_with_openai(
        provider,
        input,
        bridge_script,
        working_directory,
        node_command,
    )
    .await
}

#[tauri::command]
async fn run_agent_kit_with_ai<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: openai_runtime::RunAgentKitInput,
) -> Result<openai_runtime::RunAgentKitResult, String> {
    run_agent_kit_with_openai(app, input).await
}

/// Phase 2c-iii: run an Agent Kit through the hosted Gateway with managed
/// billing and optional desktop "local hands". Streams events to the frontend
/// via Tauri events scoped to `input.run_id`; blocks until the run finishes.
/// Requires a connected AgentKitProject account (device-auth token).
#[tauri::command]
async fn run_agent_kit_with_gateway<R: Runtime>(
    app: tauri::AppHandle<R>,
    input: gateway_run::GatewayRunInput,
) -> Result<gateway_run::GatewayRunResult, String> {
    // The run blocks on a long-lived bridge process; keep the async runtime free.
    tauri::async_runtime::spawn_blocking(move || gateway_run::run_gateway_session(&app, input))
        .await
        .map_err(|error| format!("Run/Chat task failed: {error}"))?
}

fn canonicalize_directory(root_path: &str) -> Result<PathBuf, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err("Select an Agent Kit folder before validating.".to_string());
    }

    let resolved = Path::new(trimmed)
        .canonicalize()
        .map_err(|error| format!("Unable to access selected folder: {error}"))?;

    if !resolved.is_dir() {
        return Err("Selected path is not a folder.".to_string());
    }

    Ok(resolved)
}

fn canonicalize_json_file(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("Select an AgentKitDraft JSON file before rendering.".to_string());
    }

    let resolved = Path::new(trimmed)
        .canonicalize()
        .map_err(|error| format!("Unable to access selected draft file: {error}"))?;

    if !resolved.is_file() {
        return Err("Selected draft path is not a file.".to_string());
    }

    if resolved.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("Selected draft file must be a .json file.".to_string());
    }

    Ok(resolved)
}

fn resolve_target_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Select a target output folder before rendering.".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.exists() {
        let resolved = candidate
            .canonicalize()
            .map_err(|error| format!("Unable to access target output folder: {error}"))?;
        if !resolved.is_dir() {
            return Err("Target output path is not a folder.".to_string());
        }
        return Ok(resolved);
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| "Target output folder must have a parent folder.".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Unable to access target output parent folder: {error}"))?;

    if !canonical_parent.is_dir() {
        return Err("Target output parent path is not a folder.".to_string());
    }

    let folder_name = candidate
        .file_name()
        .ok_or_else(|| "Target output folder must include a folder name.".to_string())?;

    Ok(canonical_parent.join(folder_name))
}

fn resolve_render_output_directory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    output_path: &str,
    draft_json: &serde_json::Value,
) -> Result<PathBuf, String> {
    let target = resolve_target_directory(output_path)?;
    let library_root = configured_library_root(app)?;
    Ok(resolve_render_output_directory_from_paths(
        target,
        library_root,
        draft_json,
    ))
}

fn configured_library_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let settings = settings::get_public_settings(app)?;
    resolve_target_directory(&settings.default_output_folder)
}

fn resolve_render_output_directory_from_paths(
    target: PathBuf,
    library_root: PathBuf,
    draft_json: &serde_json::Value,
) -> PathBuf {
    if paths_equal_path(&target, &library_root) {
        let folder_name = draft_json
            .get("id")
            .and_then(|value| value.as_str())
            .map(sanitize_folder_name)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "agent-kit".to_string());
        library_root.join(folder_name)
    } else {
        target
    }
}

fn paths_equal_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(std::path::MAIN_SEPARATOR)
            .to_string()
    };
    normalize(left) == normalize(right)
}

fn resolve_validation_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "validate-agent-kit.mjs")
}

fn resolve_create_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "create-agent-kit.mjs")
}

fn resolve_export_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "export-agent-kit-onefile.mjs")
}

fn resolve_prepared_prompts_bridge<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    resolve_backend_script(app, "prepared-prompts.mjs")
}

fn resolve_app_support_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "agent-kit-app-support.mjs")
}

fn resolve_package_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "package-agent-kit.mjs")
}

fn resolve_version_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "agent-kit-version.mjs")
}

fn resolve_codex_export_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "export-agent-kit-codex.mjs")
}

fn resolve_claude_code_export_bridge<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    resolve_backend_script(app, "export-agent-kit-claude-code.mjs")
}

fn resolve_render_draft_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "render-agent-kit-draft.mjs")
}

fn resolve_generate_draft_bridge<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    resolve_backend_script(app, "generate-agent-kit-draft.mjs")
}

fn resolve_context_builder_bridge<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    resolve_backend_script(app, "build-agent-kit-context.mjs")
}

fn resolve_render_generated_draft_bridge<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    resolve_backend_script(app, "render-generated-agent-kit-draft.mjs")
}

fn resolve_market_operation_bridge<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    resolve_backend_script(app, "market-operation.mjs")
}

pub(crate) fn resolve_backend_script<R: Runtime>(
    app: &tauri::AppHandle<R>,
    script_name: &str,
) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("backend")
            .join(script_name);
        if dev_path.exists() {
            eprintln!("AgentKitForge runtime: using development backend bridge {script_name}");
            return Ok(dev_path);
        }
    }

    let resource_path = app
        .path()
        .resolve(
            format!("backend-dist/{script_name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|_| bundled_backend_missing_error())?;

    if resource_path.exists() {
        Ok(resource_path)
    } else {
        Err(bundled_backend_missing_error())
    }
}

pub(crate) fn resolve_node_command<R: Runtime>(
    _app: &tauri::AppHandle<R>,
) -> Result<BackendNodeCommand, String> {
    #[cfg(debug_assertions)]
    {
        if let Ok(node_path) = std::env::var("AGENTKITFORGE_NODE") {
            if !node_path.trim().is_empty() {
                eprintln!("AgentKitForge runtime: using AGENTKITFORGE_NODE override");
                return verify_node_command(build_backend_node_command(
                    PathBuf::from(node_path),
                    false,
                ));
            }
        }

        eprintln!("AgentKitForge runtime: using system Node for development");
        return verify_node_command(build_backend_node_command(PathBuf::from("node"), false));
    }

    #[cfg(not(debug_assertions))]
    {
        let node_path = resolve_packaged_node_path(_app)?;

        if !node_path.exists() {
            return Err(bundled_node_missing_error());
        }

        eprintln!("AgentKitForge runtime: using bundled Node sidecar");
        verify_node_command(build_backend_node_command(node_path, true))
    }
}

fn verify_node_command(node_command: BackendNodeCommand) -> Result<BackendNodeCommand, String> {
    let output = node_command
        .command()
        .arg("--version")
        .output()
        .map_err(|_| {
            if node_command.packaged {
                bundled_node_failed_to_start_error()
            } else {
                runtime_support_error()
            }
        })?;

    if output.status.success() {
        Ok(node_command)
    } else if node_command.packaged {
        log_backend_execution_failure(
            &node_command,
            Path::new("<node --version>"),
            Path::new("."),
            "Bundled Node runtime preflight",
            &output,
        );
        Err(bundled_node_failed_to_start_error())
    } else {
        Err(runtime_support_error())
    }
}

fn build_backend_node_command(executable: PathBuf, packaged: bool) -> BackendNodeCommand {
    BackendNodeCommand {
        executable,
        node_args: Vec::new(),
        packaged,
    }
}

fn diagnostic_node_path<R: Runtime>(_app: &tauri::AppHandle<R>) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Ok(node_path) = std::env::var("AGENTKITFORGE_NODE") {
            if !node_path.trim().is_empty() {
                return PathBuf::from(node_path);
            }
        }
        return PathBuf::from("node");
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(current_exe) = std::env::current_exe() {
            return packaged_macos_node_path_from_executable(&current_exe);
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(path) = _app.path().resolve(
            bundled_node_resource_name(),
            tauri::path::BaseDirectory::Resource,
        ) {
            return path;
        }
    }

    PathBuf::from(bundled_node_resource_name())
}

fn diagnostic_backend_dist_path<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("backend");
        if dev_path.exists() {
            return dev_path;
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        return packaged_backend_dist_path_from_resource_dir(&resource_dir);
    }

    PathBuf::from("backend-dist")
}

fn run_runtime_diagnostic_command(mut command: Command) -> RuntimeCommandDiagnostic {
    match command.output() {
        Ok(output) => RuntimeCommandDiagnostic {
            attempted: true,
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout_tail: tail_for_log(&output.stdout),
            stderr_tail: tail_for_log(&output.stderr),
            error: None,
        },
        Err(error) => RuntimeCommandDiagnostic {
            attempted: true,
            success: false,
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: Some(error.to_string()),
        },
    }
}

#[cfg(not(debug_assertions))]
fn resolve_packaged_node_path<R: Runtime>(_app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let current_exe = std::env::current_exe()
            .map_err(|error| format!("Unable to resolve current app executable: {error}"))?;
        return Ok(packaged_macos_node_path_from_executable(&current_exe));
    }

    #[cfg(not(target_os = "macos"))]
    {
        _app.path()
            .resolve(
                bundled_node_resource_name(),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|_| bundled_node_missing_error())
    }
}

fn packaged_macos_node_path_from_executable(executable_path: &Path) -> PathBuf {
    executable_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("node")
}

fn packaged_backend_dist_path_from_resource_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join("backend-dist")
}

pub(crate) fn run_backend_script(
    node_command: &BackendNodeCommand,
    script_path: &Path,
    args: Vec<OsString>,
    cwd: PathBuf,
    label: &str,
) -> Result<Output, String> {
    run_backend_script_with_env(node_command, script_path, args, cwd, label, Vec::new())
}

pub(crate) fn run_backend_script_with_env(
    node_command: &BackendNodeCommand,
    script_path: &Path,
    args: Vec<OsString>,
    cwd: PathBuf,
    label: &str,
    envs: Vec<(&'static str, String)>,
) -> Result<Output, String> {
    let mut command = node_command.command();
    command.arg(script_path).args(args).current_dir(&cwd);
    for (name, value) in envs {
        command.env(name, value);
    }

    let output = command.output().map_err(|error| {
        log_backend_start_failure(node_command, script_path, &cwd, label, &error);
        if node_command.packaged {
            bundled_node_failed_to_start_error()
        } else {
            format!("Unable to run {label}: {error}")
        }
    })?;

    if !output.status.success() {
        log_backend_execution_failure(node_command, script_path, &cwd, label, &output);
    }

    Ok(output)
}

/// Run a backend bridge that reads its request from STDIN instead of argv.
///
/// Used by the hosted-Market operation bridge so that WorkOS tokens never appear
/// in the OS process/argv list. The `stdin_payload` is written to the child's
/// stdin and the child's collected stdout/stderr are returned as an `Output`.
pub(crate) fn run_backend_script_with_stdin(
    node_command: &BackendNodeCommand,
    script_path: &Path,
    cwd: PathBuf,
    label: &str,
    stdin_payload: &[u8],
) -> Result<Output, String> {
    use std::process::Stdio;

    let mut command = node_command.command();
    command
        .arg(script_path)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        log_backend_start_failure(node_command, script_path, &cwd, label, &error);
        if node_command.packaged {
            bundled_node_failed_to_start_error()
        } else {
            format!("Unable to run {label}: {error}")
        }
    })?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Unable to open {label} input stream."))?;
        stdin
            .write_all(stdin_payload)
            .map_err(|error| format!("Unable to send {label} request: {error}"))?;
        // Dropping `stdin` here closes the pipe so the child's stdin reaches EOF.
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Unable to run {label}: {error}"))?;

    if !output.status.success() {
        log_backend_execution_failure(node_command, script_path, &cwd, label, &output);
    }

    Ok(output)
}

fn log_backend_start_failure(
    node_command: &BackendNodeCommand,
    script_path: &Path,
    cwd: &Path,
    label: &str,
    error: &io::Error,
) {
    eprintln!(
        "AgentKitForge backend execution failed to start: label={label}; node={}; script={}; cwd={}; packaged={}; error={}",
        node_command.executable.display(),
        script_path.display(),
        cwd.display(),
        node_command.packaged,
        error
    );
}

fn log_backend_execution_failure(
    node_command: &BackendNodeCommand,
    script_path: &Path,
    cwd: &Path,
    label: &str,
    output: &Output,
) {
    eprintln!(
        "AgentKitForge backend execution failed: label={label}; node={}; script={}; cwd={}; packaged={}; exit_code={:?}; stderr_tail={}; stdout_tail={}",
        node_command.executable.display(),
        script_path.display(),
        cwd.display(),
        node_command.packaged,
        output.status.code(),
        tail_for_log(&output.stderr),
        tail_for_log(&output.stdout)
    );
}

fn tail_for_log(bytes: &[u8]) -> String {
    const MAX_LOG_TAIL_CHARS: usize = 204;
    let text = String::from_utf8_lossy(bytes)
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > MAX_LOG_TAIL_CHARS {
        chars[chars.len() - MAX_LOG_TAIL_CHARS..].iter().collect()
    } else {
        text
    }
}

#[cfg(debug_assertions)]
fn bundled_node_resource_name() -> &'static str {
    "node"
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn bundled_node_resource_name() -> &'static str {
    "node.exe"
}

#[cfg(all(not(debug_assertions), not(target_os = "windows")))]
fn bundled_node_resource_name() -> &'static str {
    "node"
}

fn runtime_support_error() -> String {
    "AgentKitForge runtime support is unavailable. Install Node for development, or reinstall the packaged app.".to_string()
}

#[cfg(any(test, not(debug_assertions)))]
fn bundled_node_missing_error() -> String {
    "Bundled Node runtime was not found.".to_string()
}

fn bundled_backend_missing_error() -> String {
    "Bundled backend runtime files were not found.".to_string()
}

fn bundled_node_failed_to_start_error() -> String {
    "Bundled Node runtime failed to start.".to_string()
}

fn backend_runtime_failed_error() -> String {
    "Backend runtime failed. See diagnostics.".to_string()
}

pub(crate) fn resolve_command_working_directory<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        if repo_root.exists() {
            return repo_root;
        }
    }

    #[cfg(not(debug_assertions))]
    if let Ok(resource_dir) = app.path().resource_dir() {
        return resource_dir;
    }

    app.path()
        .app_local_data_dir()
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn clean_required_value(label: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }

    Ok(trimmed.to_string())
}

fn validate_kit_id(id: &str) -> Result<(), String> {
    if id.contains('/') || id.contains('\\') || id == "." || id == ".." || id.contains("..") {
        return Err(
            "Kit id can contain letters, numbers, dashes, and underscores only.".to_string(),
        );
    }

    if !id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err(
            "Kit id can contain letters, numbers, dashes, and underscores only.".to_string(),
        );
    }

    Ok(())
}

fn resolve_markdown_output_path(root_path: &Path, output_path: &str) -> Result<PathBuf, String> {
    let trimmed = output_path.trim();
    if trimmed.is_empty() {
        return Err("Select an output file path or output folder before exporting.".to_string());
    }

    let candidate = PathBuf::from(trimmed);

    if candidate.exists() {
        let metadata = fs::metadata(&candidate)
            .map_err(|error| format!("Unable to inspect output path: {error}"))?;
        if metadata.is_dir() {
            return Ok(candidate
                .canonicalize()
                .map_err(|error| format!("Unable to access output folder: {error}"))?
                .join(default_markdown_file_name(root_path)));
        }
    }

    let mut file_path = candidate;
    if file_path.extension().is_none() {
        file_path.set_extension("md");
    }

    let parent = file_path
        .parent()
        .ok_or_else(|| "Output file must have a parent folder.".to_string())?;

    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Unable to access output folder: {error}"))?;

    if !canonical_parent.is_dir() {
        return Err("Output parent path is not a folder.".to_string());
    }

    let file_name = file_path
        .file_name()
        .ok_or_else(|| "Output file path must include a file name.".to_string())?;

    Ok(canonical_parent.join(file_name))
}

fn resolve_json_output_path(output_path: &str) -> Result<PathBuf, String> {
    let trimmed = output_path.trim();
    if trimmed.is_empty() {
        return Err("Select a draft JSON output path before saving.".to_string());
    }

    let mut file_path = PathBuf::from(trimmed);
    if file_path.extension().is_none() {
        file_path.set_extension("json");
    }

    let parent = file_path
        .parent()
        .ok_or_else(|| "Draft JSON output path must have a parent folder.".to_string())?;

    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Unable to access draft JSON output folder: {error}"))?;

    if !canonical_parent.is_dir() {
        return Err("Draft JSON output parent path is not a folder.".to_string());
    }

    let file_name = file_path
        .file_name()
        .ok_or_else(|| "Draft JSON output path must include a file name.".to_string())?;

    Ok(canonical_parent.join(file_name))
}

fn resolve_markdown_file_output_path(output_path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = output_path.trim();
    if trimmed.is_empty() {
        return Err(format!("Select a {label} path before saving."));
    }

    let mut file_path = PathBuf::from(trimmed);
    if file_path.extension().is_none() {
        file_path.set_extension("md");
    }

    let parent = file_path
        .parent()
        .ok_or_else(|| format!("{label} path must have a parent folder."))?;

    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Unable to access {label} folder: {error}"))?;

    if !canonical_parent.is_dir() {
        return Err(format!("{label} parent path is not a folder."));
    }

    let file_name = file_path
        .file_name()
        .ok_or_else(|| format!("{label} path must include a file name."))?;

    Ok(canonical_parent.join(file_name))
}

fn starter_excerpt(content: &str) -> Option<String> {
    let mut excerpt = content
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && !line.starts_with("---")
                && !line.starts_with("<!--")
        })
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");

    if excerpt.is_empty() {
        return None;
    }

    const MAX_EXCERPT_LENGTH: usize = 360;
    if excerpt.len() > MAX_EXCERPT_LENGTH {
        excerpt.truncate(MAX_EXCERPT_LENGTH);
        excerpt.push_str("...");
    }

    Some(excerpt)
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn split_lines_or_commas(value: Option<&str>) -> Option<Vec<String>> {
    let values = value?
        .split(|character| character == '\n' || character == ',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn default_markdown_file_name(root_path: &Path) -> String {
    match read_kit_metadata(root_path) {
        Ok(metadata) => format!(
            "{}-{}.onefile.md",
            sanitize_folder_name(&metadata.id),
            sanitize_folder_name(&metadata.version)
        ),
        Err(_) => {
            let stem = root_path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("agent-kit");
            format!("{stem}.onefile.md")
        }
    }
}

fn default_package_file_name(root_path: &Path) -> String {
    match read_kit_metadata(root_path) {
        Ok(metadata) => format!(
            "{}-{}.agentkit.zip",
            sanitize_folder_name(&metadata.id),
            sanitize_folder_name(&metadata.version)
        ),
        Err(_) => format!("{}.agentkit.zip", default_artifact_stem(root_path)),
    }
}

fn default_artifact_stem(root_path: &Path) -> String {
    root_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("agent-kit")
        .to_string()
}

fn read_my_kits_library<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<MyKitsLibrary, String> {
    let path = my_kits_library_path(app)?;
    if !path.exists() {
        return Ok(MyKitsLibrary::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read My Kits library: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse My Kits library: {error}"))
}

fn write_my_kits_library<R: Runtime>(
    app: &tauri::AppHandle<R>,
    library: &MyKitsLibrary,
) -> Result<(), String> {
    let path = my_kits_library_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Unable to resolve My Kits library folder.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create My Kits library folder: {error}"))?;
    let content = serde_json::to_string_pretty(library)
        .map_err(|error| format!("Unable to serialize My Kits library: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Unable to save My Kits library: {error}"))
}

fn merge_discovered_library_kits<R: Runtime>(
    app: &tauri::AppHandle<R>,
    library: &mut MyKitsLibrary,
) -> Result<bool, String> {
    let library_root = configured_library_root(app)?;
    let mut changed = false;

    for kit_path in discover_agent_kit_folders(&library_root)? {
        let normalized_path = kit_path.to_string_lossy().into_owned();
        if library
            .kits
            .iter()
            .any(|kit| paths_equal(&kit.path, &normalized_path))
        {
            continue;
        }

        if let Ok(entry) = metadata_entry_from_path(&kit_path, KitLibrarySource::Built) {
            library.kits.push(entry);
            changed = true;
        }
    }

    Ok(changed)
}

fn discover_agent_kit_folders(library_root: &Path) -> Result<Vec<PathBuf>, String> {
    if !library_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut kits = Vec::new();
    for entry in fs::read_dir(library_root)
        .map_err(|error| format!("Unable to read My Kits folder: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Unable to read My Kits folder entry: {error}"))?;
        let path = entry.path();
        if path.is_dir() && path.join("agentkit.yaml").is_file() {
            kits.push(path);
        }
    }
    kits.sort();
    Ok(kits)
}

fn remove_library_owned_kit_files(entry: &MyKitEntry, library_root: &Path) -> Result<bool, String> {
    let kit_path = Path::new(&entry.path);
    if !kit_path.exists() {
        return Ok(false);
    }
    if !kit_path.is_dir() {
        return Err("My Kits entry is not a folder on disk.".to_string());
    }
    if !kit_path.join("agentkit.yaml").is_file() {
        return Err(
            "Refusing to delete a folder that does not look like an Agent Kit.".to_string(),
        );
    }

    let canonical_kit = kit_path
        .canonicalize()
        .map_err(|error| format!("Unable to access kit folder before removal: {error}"))?;
    let canonical_library_root = library_root
        .canonicalize()
        .map_err(|error| format!("Unable to access My Kits folder before removal: {error}"))?;

    if canonical_kit == canonical_library_root {
        return Err("Refusing to delete the My Kits library root.".to_string());
    }

    let library_owned_source = matches!(
        entry.source.as_str(),
        "built" | "imported" | "local_import" | "market"
    );
    if !canonical_kit.starts_with(&canonical_library_root) && !library_owned_source {
        return Ok(false);
    }

    fs::remove_dir_all(&canonical_kit)
        .map_err(|error| format!("Unable to delete local kit files: {error}"))?;
    Ok(true)
}

fn my_kits_library_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("my-kits.json"))
        .map_err(|error| format!("Unable to resolve My Kits library folder: {error}"))
}

fn read_kit_metadata(root_path: &Path) -> Result<KitMetadata, String> {
    let manifest_path = root_path.join("agentkit.yaml");
    if !manifest_path.exists() {
        return Err("agentkit.yaml is required to add a kit to My Kits.".to_string());
    }

    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Unable to read agentkit.yaml: {error}"))?;
    let id = read_manifest_scalar(&manifest, "id")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_artifact_stem(root_path));
    let name = read_manifest_scalar(&manifest, "name")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    let version = read_manifest_scalar(&manifest, "version")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let description =
        read_manifest_scalar(&manifest, "description").filter(|value| !value.trim().is_empty());

    Ok(KitMetadata {
        id,
        name,
        version,
        description,
    })
}

fn metadata_entry_from_path(
    root_path: &Path,
    source: KitLibrarySource,
) -> Result<MyKitEntry, String> {
    let metadata = read_kit_metadata(root_path)?;
    let now = now_timestamp();
    Ok(MyKitEntry {
        id: metadata.id,
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        path: root_path.to_string_lossy().into_owned(),
        source: source.as_str().to_string(),
        source_label: None,
        last_validated_at: None,
        last_validated_profile: None,
        last_validation_valid: None,
        last_used_at: None,
        imported_at: None,
        installed_at: None,
        package_file_name: None,
        package_size_bytes: None,
        sha256: None,
        market_base_url: None,
        schema_version: None,
        source_market_slug: None,
        source_market_kit_id: None,
        source_url: None,
        published_at: None,
        created_at: now.clone(),
        updated_at: now,
        path_exists: root_path.is_dir(),
    })
}

fn apply_package_metadata_to_entry(
    entry: &mut MyKitEntry,
    package_metadata: Option<&PackageImportMetadata>,
) {
    let Some(package_metadata) = package_metadata else {
        return;
    };

    entry.source_label = package_metadata.source_label.clone();
    entry.imported_at = package_metadata.imported_at.clone();
    entry.package_file_name = package_metadata.package_file_name.clone();
    entry.package_size_bytes = package_metadata.package_size_bytes;
    entry.sha256 = package_metadata.sha256.clone();
    entry.market_base_url = package_metadata.market_base_url.clone();
    entry.schema_version = package_metadata.schema_version.clone();
    entry.source_market_slug = package_metadata.source_market_slug.clone();
    entry.source_market_kit_id = package_metadata.source_market_kit_id.clone();
    if package_metadata.source_url.is_some() {
        entry.source_url = package_metadata.source_url.clone();
    }
    entry.published_at = package_metadata.published_at.clone();
}

fn canonicalize_agent_kit_package(package_path: &str) -> Result<PathBuf, String> {
    let trimmed = package_path.trim();
    if trimmed.is_empty() {
        return Err("Select a .agentkit.zip package before importing.".to_string());
    }

    let resolved = Path::new(trimmed)
        .canonicalize()
        .map_err(|error| format!("Unable to access selected package: {error}"))?;

    if !resolved.is_file() {
        return Err("Selected package path is not a file.".to_string());
    }

    let file_name = resolved
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if !file_name.ends_with(".agentkit.zip") {
        return Err("Selected package must end with .agentkit.zip.".to_string());
    }

    Ok(resolved)
}

fn package_stem(package_path: &Path) -> Result<String, String> {
    let file_name = package_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Package file name is invalid.".to_string())?;
    let stem = file_name
        .strip_suffix(".agentkit.zip")
        .or_else(|| file_name.strip_suffix(".zip"))
        .unwrap_or(file_name);
    Ok(sanitize_folder_name(stem))
}

fn normalize_market_slug(slug: &str) -> Result<String, String> {
    let trimmed = slug.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err("Enter a Market kit slug before importing.".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('\\') || trimmed.chars().any(char::is_whitespace)
    {
        return Err("Market kit slug is invalid.".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_hosted_market_base_url(base_url: Option<&str>) -> Result<String, String> {
    let base_url = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://market.agentkitproject.com");
    let parsed = reqwest::Url::parse(base_url)
        .map_err(|_| "Hosted Market base URL is invalid.".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("market.agentkitproject.com") {
        return Err(
            "Direct hosted Market import only supports https://market.agentkitproject.com."
                .to_string(),
        );
    }
    Ok("https://market.agentkitproject.com".to_string())
}

// NOTE (core-parity migration): the hosted-Market download/submit/upload HTTP
// client (endpoint builders, request_hosted_market_download_info,
// submit_package_to_hosted_market, upload_hosted_market_submission_package,
// download_market_package, and their request/response structs) has moved into
// `@agentkitforge/core/market` and is now driven through the
// `market-operation.mjs` Node bridge. The remaining reqwest helpers below
// (authed-request, publisher-profile fetch, status/lifecycle error mapping) are
// still used by the in-Rust display-name resolution path and the unit tests.

/// Sends an authenticated hosted-Market request, refreshing the WorkOS
/// access token and retrying once when the first attempt returns 401.
/// A second 401 (or a failed refresh) surfaces as a reconnect-required error.
fn hosted_market_authed_request<R: Runtime>(
    app: &tauri::AppHandle<R>,
    access_token: &str,
    send: impl Fn(&str) -> Result<reqwest::blocking::Response, String>,
) -> Result<reqwest::blocking::Response, String> {
    let response = send(access_token)?;
    if response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(response);
    }
    let refreshed_token = account_auth::refresh_access_token(app)?;
    let retried = send(&refreshed_token)?;
    if retried.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(account_auth::mark_reconnect_required(app));
    }
    Ok(retried)
}

/// True when a hosted-Market error string represents an authentication
/// failure (expired/invalid session) rather than a network/availability
/// problem. Auth failures must be surfaced to the user, never silently
/// swallowed by fallbacks.
fn hosted_market_error_is_auth_failure(error: &str) -> bool {
    error.starts_with("RECONNECT_REQUIRED")
        || error.starts_with("AgentKitProject sign-in is required.")
        || error.starts_with("AgentKitProject session expired or is missing.")
        || error.starts_with(
            "Hosted AgentKitMarket submit endpoint does not accept Forge device-auth sessions",
        )
}

fn hosted_market_publisher_profile_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| "Hosted Market base URL is invalid.".to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Hosted Market publisher profile endpoint is invalid.".to_string())?
        .clear()
        .extend(["api", "forge", "publisher-profile"]);
    Ok(url)
}

fn fetch_hosted_market_publisher_profile<R: Runtime>(
    app: &tauri::AppHandle<R>,
    market_base_url: &str,
    access_token: &str,
) -> Result<HostedMarketPublisherProfile, String> {
    let endpoint = hosted_market_publisher_profile_endpoint(market_base_url)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
            format!("Unable to prepare hosted Market publisher profile request: {error}")
        })?;
    let response = hosted_market_authed_request(app, access_token, |token| {
        client
            .get(endpoint.clone())
            .bearer_auth(token)
            .send()
            .map_err(|error| {
                format!(
                    "Unable to fetch hosted Market publisher profile: {}",
                    safe_reqwest_error(error)
                )
            })
    })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(hosted_market_submission_status_error(
            status,
            "fetch publisher profile",
            Some(&body),
            Some(&hosted_market_request_diagnostics(&endpoint, access_token)),
        ));
    }
    response
        .json::<HostedMarketPublisherProfile>()
        .map_err(|error| format!("Hosted Market publisher profile response was invalid: {error}"))
}

fn resolve_market_submission_display_name<R: Runtime>(
    app: &tauri::AppHandle<R>,
    market_base_url: &str,
    access_token: &str,
) -> Result<String, String> {
    match fetch_hosted_market_publisher_profile(app, market_base_url, access_token) {
        Ok(profile) => {
            let display_name = profile
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            match display_name {
                Some(display_name) => {
                    let display_name = display_name.to_string();
                    // Best-effort cache so the UI can show the resolved name.
                    let _ = settings::save_account_display_name(app, &display_name);
                    Ok(display_name)
                }
                None => Err(
                    "Your AgentKitProfile display name is not set. Add a display name at https://profile.agentkitproject.com/account, then try submitting again."
                        .to_string(),
                ),
            }
        }
        // Auth failures (expired session that could not be refreshed) must
        // surface to the user as reconnect errors — never masked by the
        // display-name fallback.
        Err(error) if hosted_market_error_is_auth_failure(&error) => Err(error),
        // Endpoint unreachable or erroring for non-auth reasons (older Market
        // app 404, network failure, 5xx): fall back to the locally cached
        // display name.
        Err(_) => market_submission_profile_display_name(app),
    }
}

fn market_submission_profile_display_name<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<String, String> {
    let settings = settings::get_public_settings(app)?;
    let display_name = settings
        .account_connection
        .user_display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "AgentKitProfile display name is required for Market submission. Update your AgentKitProject profile and reconnect Forge.".to_string()
        })?;
    Ok(display_name.to_string())
}

fn hosted_market_request_diagnostics(
    endpoint: &reqwest::Url,
    access_token: &str,
) -> HostedMarketRequestDiagnostics {
    HostedMarketRequestDiagnostics {
        endpoint_path: endpoint.path().to_string(),
        authorization_header_present: !access_token.trim().is_empty(),
        token_length: access_token.len(),
    }
}

fn market_download_file_name(file_name: Option<&str>, slug: &str) -> Result<String, String> {
    let file_name = file_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}.agentkit.zip", sanitize_folder_name(slug)));
    if file_name.contains('/') || file_name.contains('\\') {
        return Err("Hosted Market returned an unsafe package file name.".to_string());
    }
    if !file_name.ends_with(".agentkit.zip") {
        return Err("Hosted Market package file name must end with .agentkit.zip.".to_string());
    }
    Ok(file_name)
}

// Retained for parity/tests: the download lifecycle/status mapping now lives in
// `@agentkitforge/core/market` (the bridge enforces the same blocking statuses
// and 401/403/404 messages). These helpers document the equivalent user-facing
// behavior on the Rust side and are still covered by unit tests.
#[allow(dead_code)]
fn hosted_market_listing_status_error(
    status: reqwest::StatusCode,
    action: &str,
    body: Option<&str>,
) -> String {
    if let Some(message) = hosted_market_lifecycle_message_from_body(body.unwrap_or_default()) {
        return message;
    }
    match status.as_u16() {
        401 => "AgentKitProject session expired or is missing. Connect your account again to download from hosted AgentKitMarket.".to_string(),
        403 => "You do not have access to this kit.".to_string(),
        404 | 410 => "This Market listing is no longer available.".to_string(),
        500..=599 => format!("Hosted AgentKitMarket could not {action} right now. Try again later."),
        code => format!("Hosted AgentKitMarket could not {action}. Status: {code}."),
    }
}

#[allow(dead_code)]
fn hosted_market_lifecycle_message_from_body(body: &str) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut statuses = Vec::new();
    collect_market_status_values(&value, &mut statuses);
    hosted_market_listing_lifecycle_message(statuses.iter().map(String::as_str))
}

#[allow(dead_code)]
fn collect_market_status_values(value: &serde_json::Value, statuses: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                let normalized_key = normalize_market_status_token(key);
                if matches!(
                    normalized_key.as_str(),
                    "status" | "listing_status" | "lifecycle_status" | "state" | "code"
                ) {
                    if let Some(status) = value.as_str() {
                        statuses.push(status.to_string());
                    }
                }
                collect_market_status_values(value, statuses);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_market_status_values(item, statuses);
            }
        }
        _ => {}
    }
}

#[allow(dead_code)]
fn hosted_market_listing_lifecycle_message<'a>(
    statuses: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    for status in statuses {
        match normalize_market_status_token(status).as_str() {
            "removed" | "withdrawn" | "hidden" => {
                return Some(
                    "This kit listing is no longer available in AgentKitMarket.".to_string(),
                );
            }
            "expired" | "deleted" | "not_found" | "archived" => {
                return Some("This Market listing is no longer available.".to_string());
            }
            _ => {}
        }
    }
    None
}

fn normalize_market_status_token(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['-', ' '], "_")
}

fn hosted_market_submission_status_error(
    status: reqwest::StatusCode,
    action: &str,
    body: Option<&str>,
    diagnostics: Option<&HostedMarketRequestDiagnostics>,
) -> String {
    let body = body.unwrap_or_default();
    if status.as_u16() == 401 && hosted_market_submit_endpoint_requires_browser_session(body) {
        return format!(
            "Hosted AgentKitMarket submit endpoint does not accept Forge device-auth sessions yet. {}",
            format_hosted_market_request_diagnostics(diagnostics)
        );
    }
    if let Some(message) = hosted_market_error_message_from_body(body) {
        if status.as_u16() == 409 {
            return format!("Hosted AgentKitMarket already has an active submission for this kit/version. {message}");
        }
        if status.as_u16() != 401 {
            return message;
        }
    }
    match status.as_u16() {
        401 => format!(
            "AgentKitProject sign-in is required. Connect your account again to submit to hosted AgentKitMarket. {}",
            format_hosted_market_request_diagnostics(diagnostics)
        ),
        403 => "Permission denied. Your AgentKitProject account is not allowed to submit this kit to hosted AgentKitMarket.".to_string(),
        404 => format!("Hosted AgentKitMarket could not {action} because the submission was not found."),
        409 => "Hosted AgentKitMarket already has an active submission for this kit/version.".to_string(),
        413 => "Hosted AgentKitMarket rejected the package because it is too large.".to_string(),
        422 => "Hosted AgentKitMarket rejected the submission package. Review the validation results and try again.".to_string(),
        500..=599 => format!("Hosted AgentKitMarket could not {action} right now. Try again later."),
        code => format!("Hosted AgentKitMarket could not {action}. Status: {code}."),
    }
}

fn format_hosted_market_request_diagnostics(
    diagnostics: Option<&HostedMarketRequestDiagnostics>,
) -> String {
    let Some(diagnostics) = diagnostics else {
        return "Request diagnostics: unavailable.".to_string();
    };
    format!(
        "Request diagnostics: endpointPath={}, authorizationHeaderPresent={}, tokenLength={}.",
        diagnostics.endpoint_path,
        diagnostics.authorization_header_present,
        diagnostics.token_length
    )
}

fn hosted_market_submit_endpoint_requires_browser_session(body: &str) -> bool {
    let Some(value) = parse_json_object(body) else {
        return false;
    };
    let code = value
        .get("code")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("error").and_then(|value| value.as_str()))
        .map(normalize_market_status_token);
    let message = value
        .get("message")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();

    matches!(
        code.as_deref(),
        Some("unauthorized" | "not_signed_in" | "auth_required")
    ) || message == "sign in is required."
        || message == "agentkitproject sign-in is required."
}

fn hosted_market_error_message_from_body(body: &str) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }
    let value = parse_json_object(body)?;
    value
        .get("message")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_json_object(body: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    match serde_json::from_str::<serde_json::Value>(body).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

fn safe_reqwest_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "the request timed out".to_string()
    } else if error.is_connect() {
        "network connection failed".to_string()
    } else if error.is_decode() {
        "response could not be decoded".to_string()
    } else {
        error.to_string()
    }
}

fn sanitize_folder_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        "imported-agent-kit".to_string()
    } else {
        sanitized
    }
}

fn unique_or_forced_extraction_folder(
    destination_root: &Path,
    folder_name: &str,
    force: bool,
    import_as_copy: bool,
) -> Result<PathBuf, String> {
    let base = destination_root.join(folder_name);
    ensure_child_path(destination_root, &base)?;

    if force {
        if base.exists() {
            ensure_child_path(destination_root, &base)?;
            fs::remove_dir_all(&base)
                .map_err(|error| format!("Unable to clean existing import folder: {error}"))?;
        }
        fs::create_dir_all(&base)
            .map_err(|error| format!("Unable to create import folder: {error}"))?;
        return Ok(base);
    }

    if !base.exists() {
        fs::create_dir_all(&base)
            .map_err(|error| format!("Unable to create import folder: {error}"))?;
        return Ok(base);
    }

    if import_as_copy {
        for index in 1..=1000 {
            let candidate_name = if index == 1 {
                format!("{folder_name}-copy")
            } else {
                format!("{folder_name}-copy-{index}")
            };
            let candidate = destination_root.join(candidate_name);
            ensure_child_path(destination_root, &candidate)?;
            if !candidate.exists() {
                fs::create_dir_all(&candidate)
                    .map_err(|error| format!("Unable to create import copy folder: {error}"))?;
                return Ok(candidate);
            }
        }
        return Err("Unable to create a unique import copy folder.".to_string());
    }

    let entries = fs::read_dir(&base)
        .map_err(|error| format!("Unable to inspect existing import folder: {error}"))?
        .count();
    if entries == 0 {
        return Ok(base);
    }

    Err(format!(
        "Import folder already exists and is not empty: {}. Enable force overwrite to replace it.",
        base.to_string_lossy()
    ))
}

fn inspect_agent_kit_zip_structure(package_path: &Path) -> Result<Vec<String>, String> {
    let file = File::open(package_path)
        .map_err(|error| format!("Unable to open package file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Unable to read zip package: {error}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(package_too_large_error());
    }
    let strip_root = detect_archive_root_folder(&mut archive)?;
    let mut files = Vec::new();
    let mut total_uncompressed_bytes = 0_u64;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Unable to inspect zip entry: {error}"))?;
        let enclosed_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip path: {}", entry.name()))?
            .to_path_buf();
        let relative_path = strip_archive_root_component(&enclosed_name, strip_root.as_deref());
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        if path_depth(&relative_path) > MAX_ZIP_PATH_DEPTH {
            return Err(package_too_large_error());
        }
        let entry_size = entry.size();
        if entry_size > MAX_ZIP_FILE_UNCOMPRESSED_BYTES {
            return Err(package_too_large_error());
        }
        total_uncompressed_bytes = total_uncompressed_bytes
            .checked_add(entry_size)
            .ok_or_else(package_too_large_error)?;
        if total_uncompressed_bytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES {
            return Err(package_too_large_error());
        }
        if !entry.is_dir() {
            files.push(relative_path.to_string_lossy().replace('\\', "/"));
        }
    }

    files.sort();
    Ok(files)
}

fn validate_agent_kit_zip_structure(files: &[String]) -> Result<(), String> {
    if !files.iter().any(|file| file == "agentkit.yaml") {
        return Err("Package is missing agentkit.yaml at the Agent Kit root.".to_string());
    }
    if !files.iter().any(|file| file == "AGENTKIT.md") {
        return Err("Package is missing AGENTKIT.md at the Agent Kit root.".to_string());
    }
    if !files.iter().any(|file| file == "START_HERE.md") {
        return Err("Package is missing START_HERE.md at the Agent Kit root.".to_string());
    }
    if files
        .iter()
        .any(|file| file.starts_with("skills/") && file.ends_with("/SKILL.md"))
    {
        return Ok(());
    }
    Err("Package must include at least one skill at skills/<skill-id>/SKILL.md.".to_string())
}

fn package_import_metadata(package_path: &Path) -> Result<PackageImportMetadata, String> {
    let manifest = read_manifest_from_package(package_path).unwrap_or_default();
    let source = read_manifest_scalar(&manifest, "source");
    let source_label = read_manifest_scalar(&manifest, "sourceLabel")
        .or_else(|| read_manifest_scalar(&manifest, "source_label"))
        .or_else(|| {
            source
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case("agentkitmarket"))
                .then(|| "AgentKitMarket".to_string())
        });
    let sha256 = sha256_for_file(package_path)?;

    Ok(PackageImportMetadata {
        kit_id: read_manifest_scalar(&manifest, "id"),
        kit_name: read_manifest_scalar(&manifest, "name"),
        version: read_manifest_scalar(&manifest, "version"),
        schema_version: read_manifest_scalar(&manifest, "schemaVersion")
            .or_else(|| read_manifest_scalar(&manifest, "schema_version")),
        source,
        source_label,
        imported_at: None,
        package_file_name: package_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string),
        package_size_bytes: fs::metadata(package_path)
            .ok()
            .map(|metadata| metadata.len()),
        sha256: Some(sha256),
        market_base_url: read_manifest_scalar(&manifest, "marketBaseUrl")
            .or_else(|| read_manifest_scalar(&manifest, "market_base_url")),
        source_market_slug: read_manifest_scalar(&manifest, "sourceMarketSlug")
            .or_else(|| read_manifest_scalar(&manifest, "source_market_slug")),
        source_market_kit_id: read_manifest_scalar(&manifest, "sourceMarketKitId")
            .or_else(|| read_manifest_scalar(&manifest, "source_market_kit_id")),
        source_url: read_manifest_scalar(&manifest, "sourceUrl")
            .or_else(|| read_manifest_scalar(&manifest, "source_url")),
        published_at: read_manifest_scalar(&manifest, "publishedAt")
            .or_else(|| read_manifest_scalar(&manifest, "published_at")),
    })
}

fn sha256_for_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Unable to open file for checksum: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read file for checksum: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn read_manifest_from_package(package_path: &Path) -> Result<String, String> {
    let file = File::open(package_path)
        .map_err(|error| format!("Unable to open package file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Unable to read zip package: {error}"))?;
    let strip_root = detect_archive_root_folder(&mut archive)?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Unable to inspect zip entry: {error}"))?;
        let enclosed_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip path: {}", entry.name()))?
            .to_path_buf();
        let relative_path = strip_archive_root_component(&enclosed_name, strip_root.as_deref());
        if relative_path == Path::new("agentkit.yaml") {
            let mut manifest = String::new();
            entry
                .read_to_string(&mut manifest)
                .map_err(|error| format!("Unable to read package manifest: {error}"))?;
            return Ok(manifest);
        }
    }

    Err("Package is missing agentkit.yaml at the Agent Kit root.".to_string())
}

fn package_duplicate_warnings<R: Runtime>(
    app: &tauri::AppHandle<R>,
    package_metadata: &PackageImportMetadata,
) -> Result<Vec<ImportDuplicateWarning>, String> {
    let library = read_my_kits_library(app)?;
    let package_id = package_metadata.kit_id.as_deref().unwrap_or("").trim();
    let package_name = package_metadata.kit_name.as_deref().unwrap_or("").trim();
    let package_version = package_metadata.version.as_deref().unwrap_or("").trim();
    if package_id.is_empty() && package_name.is_empty() {
        return Ok(Vec::new());
    }

    Ok(library
        .kits
        .into_iter()
        .filter(|kit| {
            let id_matches = !package_id.is_empty() && kit.id == package_id;
            let name_matches = !package_name.is_empty() && kit.name == package_name;
            let version_matches = package_version.is_empty() || kit.version == package_version;
            (id_matches || name_matches) && version_matches
        })
        .map(|kit| ImportDuplicateWarning {
            id: kit.id,
            name: kit.name,
            version: kit.version,
            path: kit.path,
        })
        .collect())
}

fn validation_summary(report: &ValidationReport) -> String {
    let errors = report
        .issues
        .iter()
        .filter(|issue| issue.severity == "error")
        .take(3)
        .map(|issue| issue.message.clone())
        .collect::<Vec<_>>();
    if errors.is_empty() {
        "The kit needs review before it can be imported.".to_string()
    } else {
        errors.join("; ")
    }
}

fn extract_agent_kit_zip(
    package_path: &Path,
    destination_root: &Path,
    extraction_folder: &Path,
) -> Result<Vec<String>, String> {
    ensure_child_path(destination_root, extraction_folder)?;
    let file = File::open(package_path)
        .map_err(|error| format!("Unable to open package file: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Unable to read zip package: {error}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(package_too_large_error());
    }
    let mut files = Vec::new();
    let strip_root = detect_archive_root_folder(&mut archive)?;
    let mut total_uncompressed_bytes = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Unable to read zip entry: {error}"))?;
        let enclosed_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip path: {}", entry.name()))?
            .to_path_buf();
        let relative_path = strip_archive_root_component(&enclosed_name, strip_root.as_deref());
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        if path_depth(&relative_path) > MAX_ZIP_PATH_DEPTH {
            return Err(package_too_large_error());
        }

        let entry_size = entry.size();
        if entry_size > MAX_ZIP_FILE_UNCOMPRESSED_BYTES {
            return Err(package_too_large_error());
        }
        total_uncompressed_bytes = total_uncompressed_bytes
            .checked_add(entry_size)
            .ok_or_else(package_too_large_error)?;
        if total_uncompressed_bytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES {
            return Err(package_too_large_error());
        }

        let output_path = extraction_folder.join(&relative_path);
        ensure_child_path(extraction_folder, &output_path)?;

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Unable to create imported folder: {error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create imported folder: {error}"))?;
        }

        let mut output_file = File::create(&output_path)
            .map_err(|error| format!("Unable to create imported file: {error}"))?;
        io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("Unable to extract imported file: {error}"))?;
        files.push(relative_path.to_string_lossy().replace('\\', "/"));
    }

    files.sort();
    Ok(files)
}

fn package_too_large_error() -> String {
    format!(
        "This package is too large or contains too many files to import safely. Limits: {MAX_ZIP_ENTRIES} entries, {} MB total uncompressed, {} MB per file, and {MAX_ZIP_PATH_DEPTH} path segments.",
        MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024,
        MAX_ZIP_FILE_UNCOMPRESSED_BYTES / 1024 / 1024
    )
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

fn detect_archive_root_folder(archive: &mut ZipArchive<File>) -> Result<Option<String>, String> {
    let mut common_root: Option<String> = None;
    let mut has_root_manifest = false;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Unable to inspect zip entry: {error}"))?;
        let enclosed_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip path: {}", entry.name()))?
            .to_path_buf();

        if enclosed_name.as_os_str().is_empty() {
            continue;
        }

        if enclosed_name == Path::new("agentkit.yaml") {
            has_root_manifest = true;
        }

        let mut components = enclosed_name.components();
        let Some(first) = components.next() else {
            continue;
        };
        if components.as_path().as_os_str().is_empty() {
            continue;
        }

        let first_component = first.as_os_str().to_string_lossy().to_string();
        match &common_root {
            Some(existing) if existing != &first_component => return Ok(None),
            Some(_) => {}
            None => common_root = Some(first_component),
        }
    }

    if has_root_manifest {
        Ok(None)
    } else {
        Ok(common_root)
    }
}

fn strip_archive_root_component(relative_path: &Path, root: Option<&str>) -> PathBuf {
    let Some(root) = root else {
        return relative_path.to_path_buf();
    };

    let mut components = relative_path.components();
    let Some(first) = components.next() else {
        return PathBuf::new();
    };

    if first.as_os_str().to_string_lossy() == root {
        components.as_path().to_path_buf()
    } else {
        relative_path.to_path_buf()
    }
}

fn ensure_child_path(root: &Path, child: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Unable to resolve destination root: {error}"))?;
    let child_parent = if child.exists() {
        child
            .canonicalize()
            .map_err(|error| format!("Unable to resolve destination path: {error}"))?
    } else {
        child
            .parent()
            .ok_or_else(|| "Destination path must have a parent folder.".to_string())?
            .canonicalize()
            .map_err(|error| format!("Unable to resolve destination parent: {error}"))?
    };

    if !child_parent.starts_with(&root) && child_parent != root {
        return Err(
            "Import destination must stay inside the selected destination folder.".to_string(),
        );
    }

    Ok(())
}

fn inspect_agent_kit_candidate_inner<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
) -> Result<AgentKitCandidateInspection, String> {
    let bridge_script = resolve_app_support_bridge(app)?;
    let node_command = resolve_node_command(&app)?;
    let output = node_command
        .command()
        .arg(&bridge_script)
        .arg("inspect")
        .arg(path)
        .current_dir(resolve_command_working_directory(app))
        .output()
        .map_err(|error| format!("Unable to inspect Agent Kit folder: {error}"))?;

    parse_node_json_output(output, "Agent Kit inspection")
}

fn clean_git_repository_url(url: &str) -> Result<String, String> {
    let repository_url = clean_required_value("Git repository URL", url)?;
    let allowed = repository_url.starts_with("https://")
        || repository_url.starts_with("ssh://")
        || repository_url.starts_with("git@");
    if !allowed {
        return Err(
            "Use an HTTPS or SSH Git repository URL that your local Git installation can clone."
                .to_string(),
        );
    }

    Ok(repository_url)
}

fn repo_folder_name_from_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/').trim_end_matches(".git");
    let name = trimmed
        .rsplit('/')
        .next()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("git-agent-kit");
    sanitize_folder_name(name)
}

fn clone_git_repository(
    url: &str,
    reference: Option<&str>,
    destination: &Path,
) -> Result<(), String> {
    let mut command = Command::new("git");
    command.arg("clone").arg("--depth").arg("1");
    if let Some(reference) = clean_optional(reference) {
        command.arg("--branch").arg(reference);
    }
    command.arg("--").arg(url).arg(destination);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_ASKPASS", "");
    command.env("SSH_ASKPASS", "");

    let output = run_command_with_timeout(command, security::GIT_CLONE_TIMEOUT)
        .map_err(|error| format!("AgentKitForge could not start Git. Make sure Git is installed and available on PATH.\n\nFor private repositories, confirm your SSH agent/keychain is unlocked or your HTTPS credentials are cached in Git Credential Manager.\n\nTechnical details:\n{}", redact_user_visible_error(&error)))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        "Git clone failed without additional output.".to_string()
    } else {
        redact_user_visible_error(&stderr)
    };

    Err(format!("AgentKitForge could not clone this repository. Confirm Git is installed and on PATH, the repository URL and branch/ref are correct, and your local Git credentials can clone it from a terminal. Private SSH repositories require an unlocked SSH agent/keychain; private HTTPS repositories require cached Git credentials.\n\nTechnical details:\n{detail}"))
}

struct CopyAgentKitDirectoryResult {
    files: Vec<String>,
    warnings: Vec<String>,
}

fn copy_agent_kit_directory(
    source: &Path,
    destination: &Path,
) -> Result<CopyAgentKitDirectoryResult, String> {
    if !source.is_dir() {
        return Err("Git repository did not produce a folder to import.".to_string());
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create imported kit folder: {error}"))?;
    let mut files = Vec::new();
    let mut skipped_symlinks = Vec::new();
    copy_agent_kit_directory_inner(
        source,
        source,
        destination,
        &mut files,
        &mut skipped_symlinks,
    )?;
    files.sort();
    skipped_symlinks.sort();
    let warnings = if skipped_symlinks.is_empty() {
        Vec::new()
    } else {
        vec!["Skipped symlinked files for safety.".to_string()]
    };
    Ok(CopyAgentKitDirectoryResult { files, warnings })
}

fn copy_agent_kit_directory_inner(
    root: &Path,
    current: &Path,
    destination: &Path,
    files: &mut Vec<String>,
    skipped_symlinks: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("Unable to read imported repository folder: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Unable to read repository entry: {error}"))?;
        let source_path = entry.path();
        let relative_path = source_path
            .strip_prefix(root)
            .map_err(|error| format!("Unable to resolve repository file path: {error}"))?;

        if relative_path
            .components()
            .any(|component| component.as_os_str().to_string_lossy() == ".git")
        {
            continue;
        }

        let destination_path = destination.join(relative_path);
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect repository entry: {error}"))?;
        if file_type.is_symlink() {
            skipped_symlinks.push(relative_path.to_string_lossy().replace('\\', "/"));
            continue;
        }
        if file_type.is_dir() {
            ensure_child_path(destination, &destination_path)?;
            fs::create_dir_all(&destination_path)
                .map_err(|error| format!("Unable to create imported kit folder: {error}"))?;
            copy_agent_kit_directory_inner(
                root,
                &source_path,
                destination,
                files,
                skipped_symlinks,
            )?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Unable to create imported kit folder: {error}"))?;
            }
            ensure_child_path(destination, &destination_path)?;
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to copy imported kit file: {error}"))?;
            files.push(relative_path.to_string_lossy().replace('\\', "/"));
        }
    }

    Ok(())
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Git clone timed out. Confirm the repository URL, branch/ref, and local credentials, then try again.".to_string());
            }
            None => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn read_manifest_scalar(manifest: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    manifest.lines().find_map(|line| {
        if line.starts_with(' ') || !line.trim_start().starts_with(&prefix) {
            return None;
        }

        let value = line.split_once(':')?.1.trim();
        Some(unquote_yaml_scalar(value))
    })
}

fn unquote_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

fn paths_equal(left: &str, right: &str) -> bool {
    match (
        Path::new(left).canonicalize(),
        Path::new(right).canonicalize(),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left.eq_ignore_ascii_case(right),
    }
}

fn parse_node_json_output<T: for<'de> Deserialize<'de>>(
    output: std::process::Output,
    label: &str,
) -> Result<T, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!("{label} failed without output")
        } else if is_backend_runtime_execution_failure(&detail) {
            backend_runtime_failed_error()
        } else {
            redact_user_visible_error(&detail)
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse {label} result: {error}"))
}

fn now_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub(crate) fn is_backend_runtime_execution_failure(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("fatal process out of memory")
        || detail.contains("failed to reserve virtual memory")
        || detail.contains("coderange")
}

fn is_raw_fetch_failed_error(detail: &str) -> bool {
    detail.trim().eq_ignore_ascii_case("fetch failed")
        || detail
            .lines()
            .last()
            .is_some_and(|line| line.trim().eq_ignore_ascii_case("fetch failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_kit_version_change_deserializes_bridge_output() {
        let change: AgentKitVersionChange =
            serde_json::from_str(r#"{"previous":"1","next":"2"}"#).unwrap();
        assert_eq!(change.previous, "1");
        assert_eq!(change.next, "2");
    }

    #[test]
    fn external_url_allowlist_accepts_market_submission_and_kit_links() {
        // Regression: dynamic submission/kit links must open (button was a no-op).
        assert!(is_allowed_external_url(
            "https://market.agentkitproject.com/submissions/submission_89d29c6d"
        ));
        assert!(is_allowed_external_url(
            "https://market.agentkitproject.com/kits/some-kit-slug"
        ));
        // Static links still allowed.
        assert!(is_allowed_external_url("https://profile.agentkitproject.com/account"));
        // Open-redirect protection: foreign hosts and non-https rejected.
        assert!(!is_allowed_external_url("https://evil.example.com/submissions/x"));
        assert!(!is_allowed_external_url(
            "http://market.agentkitproject.com/submissions/x"
        ));
        assert!(!is_allowed_external_url(
            "https://market.agentkitproject.com.evil.com/submissions/x"
        ));
        assert!(!is_allowed_external_url(
            "https://market.agentkitproject.com/admin/secrets"
        ));
    }

    // NOTE: the empty-`fields:{}` PUT-vs-multipart regression now lives in core
    // (`@agentkitforge/core/market` upload.ts `fieldsRequireMultipart`), since
    // the package upload moved out of the Rust client during the core-parity
    // migration. The Rust-side `json_object_has_string_values` helper was removed
    // with the upload function.

    #[test]
    fn auth_failures_are_classified_as_auth_errors() {
        assert!(hosted_market_error_is_auth_failure(
            account_auth::RECONNECT_REQUIRED_ERROR
        ));
        assert!(hosted_market_error_is_auth_failure(
            "RECONNECT_REQUIRED: Reconnect AgentKitProject account to download directly from hosted AgentKitMarket."
        ));
        assert!(hosted_market_error_is_auth_failure(&hosted_market_submission_status_error(
            reqwest::StatusCode::UNAUTHORIZED,
            "fetch publisher profile",
            None,
            None,
        )));
        assert!(hosted_market_error_is_auth_failure(&hosted_market_listing_status_error(
            reqwest::StatusCode::UNAUTHORIZED,
            "request download information",
            None,
        )));
    }

    #[test]
    fn non_auth_failures_are_not_classified_as_auth_errors() {
        // Network failure: fall back to cached display name.
        assert!(!hosted_market_error_is_auth_failure(
            "Unable to fetch hosted Market publisher profile: network connection failed"
        ));
        // 5xx: fall back.
        assert!(!hosted_market_error_is_auth_failure(&hosted_market_submission_status_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "fetch publisher profile",
            None,
            None,
        )));
        // 404 from older Market deployments without the profile endpoint: fall back.
        assert!(!hosted_market_error_is_auth_failure(&hosted_market_submission_status_error(
            reqwest::StatusCode::NOT_FOUND,
            "fetch publisher profile",
            None,
            None,
        )));
        // 403 is a permission problem, not a stale session.
        assert!(!hosted_market_error_is_auth_failure(&hosted_market_submission_status_error(
            reqwest::StatusCode::FORBIDDEN,
            "fetch publisher profile",
            None,
            None,
        )));
    }

    #[test]
    fn backend_node_command_builder_does_not_add_node_flags() {
        let command = build_backend_node_command(PathBuf::from("node"), true);

        assert!(command.node_args.is_empty());
    }

    #[test]
    fn packaged_macos_resolver_points_to_contents_macos_node() {
        let executable =
            PathBuf::from("/Applications/AgentKitForge.app/Contents/MacOS/AgentKitForge");

        assert_eq!(
            packaged_macos_node_path_from_executable(&executable),
            PathBuf::from("/Applications/AgentKitForge.app/Contents/MacOS/node")
        );
    }

    #[test]
    fn packaged_resource_resolver_points_to_backend_dist() {
        let resource_dir = PathBuf::from("/Applications/AgentKitForge.app/Contents/Resources");

        assert_eq!(
            packaged_backend_dist_path_from_resource_dir(&resource_dir),
            PathBuf::from("/Applications/AgentKitForge.app/Contents/Resources/backend-dist")
        );
    }

    #[test]
    fn missing_file_errors_are_distinct_from_execution_failures() {
        assert_eq!(
            bundled_node_missing_error(),
            "Bundled Node runtime was not found."
        );
        assert_eq!(
            bundled_backend_missing_error(),
            "Bundled backend runtime files were not found."
        );
        assert_eq!(
            bundled_node_failed_to_start_error(),
            "Bundled Node runtime failed to start."
        );
        assert_eq!(
            backend_runtime_failed_error(),
            "Backend runtime failed. See diagnostics."
        );
    }

    #[test]
    fn raw_fetch_failed_errors_are_detected_for_user_friendly_messages() {
        assert!(is_raw_fetch_failed_error("fetch failed"));
        assert!(is_raw_fetch_failed_error(
            "AgentKitForge Build with AI provider config: apiKeyPresent=true\nfetch failed"
        ));
        assert!(!is_raw_fetch_failed_error("OpenAI network request failed."));
    }

    #[test]
    fn render_output_uses_child_folder_when_target_is_library_root() {
        let draft = serde_json::json!({ "id": "weekly-finance-review" });
        let target = resolve_render_output_directory_from_paths(
            PathBuf::from("/Users/example/Documents/AgentKitForge/Kits"),
            PathBuf::from("/Users/example/Documents/AgentKitForge/Kits"),
            &draft,
        );

        assert_eq!(
            target,
            PathBuf::from("/Users/example/Documents/AgentKitForge/Kits/weekly-finance-review")
        );
    }

    #[test]
    fn render_output_keeps_explicit_existing_kit_folder() {
        let draft = serde_json::json!({ "id": "weekly-finance-review" });
        let target = resolve_render_output_directory_from_paths(
            PathBuf::from("/Users/example/Documents/AgentKitForge/Kits/existing-kit"),
            PathBuf::from("/Users/example/Documents/AgentKitForge/Kits"),
            &draft,
        );

        assert_eq!(
            target,
            PathBuf::from("/Users/example/Documents/AgentKitForge/Kits/existing-kit")
        );
    }

    #[test]
    fn discovers_direct_child_kit_folders() {
        let root =
            std::env::temp_dir().join(format!("agentkitforge-discovery-test-{}", now_timestamp()));
        let kit = root.join("sample-kit");
        let nested = kit.join("nested-kit");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            kit.join("agentkit.yaml"),
            "id: sample-kit\nname: Sample Kit\n",
        )
        .unwrap();
        fs::write(
            nested.join("agentkit.yaml"),
            "id: nested-kit\nname: Nested Kit\n",
        )
        .unwrap();

        let discovered = discover_agent_kit_folders(&root).unwrap();

        assert_eq!(discovered, vec![kit]);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(account_auth::AccountLoginState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            select_agent_kit_folder,
            select_onefile_output_path,
            select_forge_response_output_path,
            select_forge_response_text_output_path,
            select_json_file,
            select_json_output_path,
            select_agent_kit_package_file,
            select_example_input_documents,
            validate_agent_kit,
            list_prepared_prompts,
            render_prepared_prompt,
            validate_prepared_prompt_inputs,
            create_agent_kit_from_template,
            export_agent_kit_onefile,
            package_agent_kit,
            get_agent_kit_version,
            set_agent_kit_version,
            next_agent_kit_version,
            submit_hosted_market_kit,
            render_agent_kit_draft,
            render_generated_agent_kit_draft,
            generate_agent_kit_draft_with_openai,
            generate_agent_kit_draft_with_ai,
            revise_agent_kit_draft_with_ai,
            save_agent_kit_draft_json,
            save_markdown_file,
            get_agent_kit_starter_hint,
            get_app_settings,
            save_openai_api_key,
            clear_openai_api_key,
            save_default_model,
            save_app_preferences,
            save_update_check_timestamp,
            begin_agentkitproject_account_login,
            complete_agentkitproject_account_login,
            restore_agentkitproject_account,
            check_agentkitproject_account_session,
            check_agentkitproject_auth_config,
            disconnect_agentkitproject_account,
            save_ai_provider,
            remove_ai_provider,
            set_default_ai_provider,
            test_ai_provider_connection,
            test_openai_connection,
            run_agent_kit_with_openai,
            run_agent_kit_with_ai,
            run_agent_kit_with_gateway,
            open_folder,
            get_agent_kit_metadata,
            add_kit_to_library,
            list_my_kits,
            remove_kit_from_library,
            refresh_kit_metadata,
            validate_library_kit,
            mark_library_kit_used,
            inspect_agent_kit_package,
            import_agent_kit_package,
            import_hosted_market_kit,
            fetch_licensed_market_kit,
            check_kit_update,
            list_cloud_favorites,
            add_cloud_favorite,
            remove_cloud_favorite,
            inspect_agent_kit_candidate,
            get_agent_kit_summary,
            load_agent_kit_as_draft,
            summarize_example_input_documents,
            import_agent_kit_from_git,
            check_packaged_runtime_files,
            open_external_url,
            export_agent_kit_to_codex,
            export_agent_kit_to_claude_code
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

#[cfg(test)]
mod contract_tests {
    //! Consumer contract tests against the shared @agentkitproject/contracts
    //! fixtures. Skipped (with a message) when the contracts repo is not
    //! checked out next to this one, so standalone clones still build.

    use super::*;
    use std::path::PathBuf;

    fn contracts_dir() -> Option<PathBuf> {
        let dir = std::env::var("AGENTKIT_CONTRACTS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../agentkitproject-contracts")
            });
        if dir.is_dir() {
            Some(dir)
        } else {
            eprintln!(
                "skipping contract test: contracts fixtures not found at {} \
                 (set AGENTKIT_CONTRACTS_DIR to override)",
                dir.display()
            );
            None
        }
    }

    fn load_fixture(name: &str) -> Option<serde_json::Value> {
        let path = contracts_dir()?.join("fixtures").join(name);
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("unable to read fixture {}: {error}", path.display()));
        Some(serde_json::from_str(&raw).unwrap_or_else(|error| {
            panic!("fixture {} is not valid JSON: {error}", path.display())
        }))
    }

    fn forge_market_route(routes: &serde_json::Value, key: &str) -> String {
        routes["forgeMarket"][key]
            .as_str()
            .unwrap_or_else(|| panic!("routes.json forgeMarket.{key} missing"))
            .to_string()
    }

    const BASE_URL: &str = "https://market.agentkitproject.com";

    // NOTE: the download / submission-upload-url / submission-validate endpoint
    // builders moved into `@agentkitforge/core/market` (routes.ts
    // `forgeMarketRoutes`) during the core-parity migration, so the app no longer
    // carries Rust contract tests for them — core's own contract tests assert the
    // routes fixture. The publisher-profile endpoint stays in Rust (used by the
    // display-name resolution path) and keeps its contract test below.

    #[test]
    fn contract_publisher_profile_endpoint_matches_routes_fixture() {
        let Some(routes) = load_fixture("routes.json") else {
            return;
        };
        let expected = forge_market_route(&routes, "publisherProfile");
        let url = hosted_market_publisher_profile_endpoint(BASE_URL).expect("endpoint");
        assert_eq!(url.path(), expected);
    }

    #[test]
    fn contract_publisher_profile_fixture_deserializes() {
        let Some(fixture) = load_fixture("public-publisher-profile.json") else {
            return;
        };
        let profile: HostedMarketPublisherProfile =
            serde_json::from_value(fixture).expect("publisher profile fixture deserializes");
        assert_eq!(profile.display_name.as_deref(), Some("Example Publisher"));
    }
}
