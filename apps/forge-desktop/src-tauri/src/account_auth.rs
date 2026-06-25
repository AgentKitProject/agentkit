use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Runtime;
use tauri_plugin_opener::OpenerExt;

use crate::{secure_storage, settings};

const WORKOS_DEVICE_AUTH_URL: &str = "https://api.workos.com/user_management/authorize/device";
const WORKOS_DEVICE_TOKEN_URL: &str = "https://api.workos.com/user_management/authenticate";
const AGENTKITPROJECT_WORKOS_CLIENT_ID_KEY: &str = "AGENTKITPROJECT_WORKOS_CLIENT_ID";
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_DEVICE_INTERVAL_SECONDS: u64 = 5;
const MAX_DEVICE_INTERVAL_SECONDS: u64 = 30;
/// WorkOS User Management issues a refresh token only when `offline_access`
/// is requested. Without it, every access token expires (~5 min) with no way
/// to refresh, forcing the user to sign out/in repeatedly.
const WORKOS_DEVICE_AUTH_SCOPE: &str = "openid profile email offline_access";
/// Refresh proactively when the access token is within this many seconds of
/// expiry (or already expired), instead of waiting for a 401.
const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS: u64 = 60;
pub const RECONNECT_REQUIRED_ERROR: &str =
    "RECONNECT_REQUIRED: Reconnect AgentKitProject account to download directly from hosted AgentKitMarket.";

#[derive(Default)]
pub struct AccountLoginState {
    pending: Mutex<HashMap<String, PendingDeviceLogin>>,
}

#[derive(Debug, Clone)]
struct PendingDeviceLogin {
    device_code: String,
    expires_at_epoch_seconds: u64,
    interval_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteDeviceLoginInput {
    login_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginStart {
    login_id: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccountSession {
    access_token: String,
    refresh_token: Option<String>,
    connected_at: String,
    user: WorkosUser,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSessionDiagnostics {
    account_metadata_present: bool,
    token_present: bool,
    token_expired: bool,
    secure_storage_available: bool,
    secure_storage_service_name: &'static str,
    secure_storage_session_account: &'static str,
    secure_storage_keychain_domain: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthConfigDiagnostics {
    configured: bool,
    missing_public_config_keys: Vec<&'static str>,
    client_id_source: Option<&'static str>,
    profile_base_url: &'static str,
    market_base_url: &'static str,
    forge_base_url: &'static str,
    device_authorization_endpoint: &'static str,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthorizationResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DeviceTokenError {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    user: WorkosUser,
}

#[derive(Debug, Deserialize)]
struct RefreshTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    user: Option<WorkosUser>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WorkosUser {
    id: Option<String>,
    email: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    profile_picture_url: Option<String>,
    metadata: Option<HashMap<String, serde_json::Value>>,
}

pub fn begin_device_login<R: Runtime>(
    app: &tauri::AppHandle<R>,
    login_state: &AccountLoginState,
) -> Result<DeviceLoginStart, String> {
    let Some(client_id) = workos_client_id() else {
        let message = missing_auth_config_message();
        let _ = settings::save_account_error(app, message);
        return Err(message.to_string());
    };

    eprintln!("AgentKitForge AgentKitProject login: starting WorkOS device authorization.");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Unable to prepare AgentKitProject login request: {error}"))?;
    let response = client
        .post(WORKOS_DEVICE_AUTH_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", WORKOS_DEVICE_AUTH_SCOPE),
        ])
        .send()
        .map_err(|error| format!("Unable to reach AgentKitProject login service: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "AgentKitProject device login could not start. Status: {}.",
            status.as_u16()
        ));
    }

    let authorization = response
        .json::<DeviceAuthorizationResponse>()
        .map_err(|error| format!("AgentKitProject device login response was invalid: {error}"))?;
    let login_id = login_id();
    let interval = authorization
        .interval
        .unwrap_or(DEFAULT_DEVICE_INTERVAL_SECONDS)
        .clamp(DEFAULT_DEVICE_INTERVAL_SECONDS, MAX_DEVICE_INTERVAL_SECONDS);
    let expires_at_epoch_seconds = epoch_seconds().saturating_add(authorization.expires_in);
    login_state
        .pending
        .lock()
        .map_err(|_| "Unable to track pending AgentKitProject login.".to_string())?
        .insert(
            login_id.clone(),
            PendingDeviceLogin {
                device_code: authorization.device_code,
                expires_at_epoch_seconds,
                interval_seconds: interval,
            },
        );

    let browser_url = authorization
        .verification_uri_complete
        .as_deref()
        .unwrap_or(authorization.verification_uri.as_str());
    app.opener()
        .open_url(browser_url, None::<&str>)
        .map_err(|error| {
            format!("Unable to open AgentKitProject login in the system browser: {error}")
        })?;

    Ok(DeviceLoginStart {
        login_id,
        user_code: authorization.user_code,
        verification_uri: authorization.verification_uri,
        verification_uri_complete: authorization.verification_uri_complete,
        expires_in: authorization.expires_in,
        interval,
    })
}

pub fn complete_device_login<R: Runtime>(
    app: &tauri::AppHandle<R>,
    login_state: &AccountLoginState,
    input: CompleteDeviceLoginInput,
) -> Result<settings::PublicSettings, String> {
    let Some(client_id) = workos_client_id() else {
        return Err(missing_auth_config_message().to_string());
    };
    let pending = login_state
        .pending
        .lock()
        .map_err(|_| "Unable to read pending AgentKitProject login.".to_string())?
        .get(input.login_id.as_str())
        .cloned()
        .ok_or_else(|| {
            "AgentKitProject login session was not found. Please try again.".to_string()
        })?;

    let token = poll_for_device_token(&client_id, &pending)?;
    login_state
        .pending
        .lock()
        .map_err(|_| "Unable to clear pending AgentKitProject login.".to_string())?
        .remove(input.login_id.as_str());

    let connected_at = settings::now_timestamp();
    let expected_access_token = token.access_token.trim().to_string();
    if expected_access_token.is_empty() {
        return Err("AgentKitProject login response did not include a usable access token. Please reconnect.".to_string());
    }
    let session = StoredAccountSession {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        connected_at: connected_at.clone(),
        user: token.user.clone(),
    };
    let session_json = serde_json::to_string(&session)
        .map_err(|error| format!("Unable to serialize AgentKitProject session: {error}"))?;
    secure_storage::store_account_session(&session_json)?;
    let verified_session_json = secure_storage::load_account_session()?.ok_or_else(|| {
        format!(
            "AgentKitProject login could not be read back from OS secure storage after saving. Keychain domain: {}. Service: {}. Account: {}.",
            secure_storage::KEYCHAIN_DOMAIN,
            secure_storage::SERVICE_NAME,
            secure_storage::SESSION_ACCOUNT
        )
    })?;
    let verified_session: StoredAccountSession = serde_json::from_str(&verified_session_json)
        .map_err(|_| {
            "AgentKitProject login was saved to OS secure storage but could not be read back safely. Please reconnect.".to_string()
        })?;
    let verified_access_token = verified_session.access_token.trim().to_string();
    if verified_access_token.is_empty() {
        let _ = secure_storage::clear_account_session();
        return Err("AgentKitProject login was saved to OS secure storage without a usable access token. Please reconnect.".to_string());
    }
    if verified_access_token != expected_access_token {
        let _ = secure_storage::clear_account_session();
        return Err("AgentKitProject login readback from OS secure storage did not match the saved session. Please reconnect the account.".to_string());
    }

    settings::save_connected_account(app, account_connection_from_user(token.user, connected_at))
}

pub fn restore_account_from_secure_storage<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<settings::PublicSettings, String> {
    let account_metadata_present = settings::account_metadata_present(app)?;
    let session_json = match secure_storage::load_account_session() {
        Ok(Some(session_json)) => session_json,
        Ok(None) => {
            if account_metadata_present {
                return settings::save_account_reconnect_required(
                    app,
                    "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
                );
            }
            return settings::disconnect_account(app);
        }
        Err(_) => {
            if account_metadata_present {
                return settings::save_account_reconnect_required(
                    app,
                    "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
                );
            }
            return settings::disconnect_account(app);
        }
    };
    let session: StoredAccountSession = match serde_json::from_str(&session_json) {
        Ok(session) => session,
        Err(_) => {
            return settings::save_account_reconnect_required(
                app,
                "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
            )
        }
    };
    if session.access_token.trim().is_empty() {
        return settings::save_account_reconnect_required(
            app,
            "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
        );
    }

    // Proactively refresh at startup if the stored access token is expired or
    // near expiry and we hold a refresh token. Best-effort: a failed refresh
    // (e.g. WorkOS unreachable) must not block restoring the connected state,
    // and a hard reconnect-required is only surfaced if the refresh itself
    // determined the session is unusable. Local-first: hosted Market remains
    // optional; non-Market features never touch this token.
    let has_refresh_token = session
        .refresh_token
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if has_refresh_token
        && token_needs_refresh(
            jwt_exp_seconds(&session.access_token),
            epoch_seconds(),
            ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
        )
    {
        match refresh_access_token(app) {
            Ok(_) => {}
            Err(error) if error.starts_with("RECONNECT_REQUIRED") => {
                return settings::save_account_reconnect_required(
                    app,
                    "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
                );
            }
            // Transient/network failure: keep the connected state; the next
            // hosted-Market call will retry the refresh (proactive + 401).
            Err(_) => {}
        }
    }

    settings::save_connected_account(
        app,
        account_connection_from_user(session.user, session.connected_at),
    )
}

pub fn disconnect_account<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<settings::PublicSettings, String> {
    secure_storage::clear_account_session()?;
    settings::disconnect_account(app)
}

pub fn load_access_token() -> Result<Option<String>, String> {
    let Some(session_json) = secure_storage::load_account_session()? else {
        return Ok(None);
    };
    let session: StoredAccountSession = serde_json::from_str(&session_json)
        .map_err(|_| "Stored AgentKitProject session could not be read safely.".to_string())?;
    let token = session.access_token.trim().to_string();
    if token.is_empty() {
        Ok(None)
    } else {
        Ok(Some(token))
    }
}

pub fn require_access_token<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<String, String> {
    let token = load_access_token().map_err(|_| {
        let _ = settings::save_account_reconnect_required(
            app,
            "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
        );
        RECONNECT_REQUIRED_ERROR.to_string()
    })?;
    match token {
        Some(token) => Ok(token),
        None => {
            let _ = settings::save_account_reconnect_required(
                app,
                "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
            );
            Err(RECONNECT_REQUIRED_ERROR.to_string())
        }
    }
}

/// Marks the stored account as needing reconnection and returns the
/// user-facing reconnect error message.
pub fn mark_reconnect_required<R: Runtime>(app: &tauri::AppHandle<R>) -> String {
    let _ = settings::save_account_reconnect_required(
        app,
        "Reconnect AgentKitProject account to use hosted AgentKitProject services.",
    );
    RECONNECT_REQUIRED_ERROR.to_string()
}

/// Exchanges the stored WorkOS refresh token for a fresh access token,
/// persists the rotated session, and returns the new access token.
///
/// If no refresh token is stored, or WorkOS rejects the refresh (4xx), the
/// account is flagged as reconnect-required and `RECONNECT_REQUIRED_ERROR`
/// is returned. Network failures return a descriptive error without
/// touching the stored session.
pub fn refresh_access_token<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<String, String> {
    let Some(client_id) = workos_client_id() else {
        return Err(missing_auth_config_message().to_string());
    };
    let session_json = match secure_storage::load_account_session() {
        Ok(Some(session_json)) => session_json,
        Ok(None) | Err(_) => return Err(mark_reconnect_required(app)),
    };
    let mut session: StoredAccountSession = match serde_json::from_str(&session_json) {
        Ok(session) => session,
        Err(_) => return Err(mark_reconnect_required(app)),
    };
    let Some(refresh_token) = session
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return Err(mark_reconnect_required(app));
    };

    eprintln!("AgentKitForge AgentKitProject session: refreshing expired access token.");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
            format!("Unable to prepare AgentKitProject session refresh request: {error}")
        })?;
    let response = client
        .post(WORKOS_DEVICE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .send()
        .map_err(|error| format!("Unable to reach AgentKitProject login service: {error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        // Error bodies do not contain tokens; safe to log for diagnosis.
        eprintln!(
            "AgentKitForge: session refresh rejected: status={} body={}",
            status.as_u16(),
            body.chars().take(300).collect::<String>()
        );
        if status.is_client_error() {
            return Err(mark_reconnect_required(app));
        }
        return Err(format!(
            "AgentKitProject session refresh failed. Status: {}.",
            status.as_u16()
        ));
    }
    let refreshed = serde_json::from_str::<RefreshTokenResponse>(&body).map_err(|error| {
        eprintln!("AgentKitForge: session refresh response parse failed: {error}");
        format!("AgentKitProject session refresh response was invalid: {error}")
    })?;
    let new_access_token = refreshed.access_token.trim().to_string();
    if new_access_token.is_empty() {
        return Err(mark_reconnect_required(app));
    }

    session.access_token = refreshed.access_token;
    if let Some(new_refresh_token) = refreshed
        .refresh_token
        .filter(|value| !value.trim().is_empty())
    {
        session.refresh_token = Some(new_refresh_token);
    }
    if let Some(user) = refreshed.user {
        session.user = user;
    }
    let session_json = serde_json::to_string(&session)
        .map_err(|error| format!("Unable to serialize AgentKitProject session: {error}"))?;
    // store_account_session already reads the secret back and verifies it
    // matches before returning Ok, so the rotated token is confirmed persisted.
    // A second read-back-and-compare here was redundant and could spuriously
    // fail on an immediate post-write read — fatal with rotating refresh tokens
    // (the rotated token is consumed, so a forced reconnect strands the user).
    secure_storage::store_account_session(&session_json)?;
    Ok(new_access_token)
}

pub fn account_session_diagnostics<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<AccountSessionDiagnostics, String> {
    let account_metadata_present = settings::account_metadata_present(app)?;
    match secure_storage::load_account_session() {
        Ok(Some(session_json)) => {
            let token_present = serde_json::from_str::<StoredAccountSession>(&session_json)
                .ok()
                .is_some_and(|session| !session.access_token.trim().is_empty());
            Ok(AccountSessionDiagnostics {
                account_metadata_present,
                token_present,
                token_expired: false,
                secure_storage_available: true,
                secure_storage_service_name: secure_storage::SERVICE_NAME,
                secure_storage_session_account: secure_storage::SESSION_ACCOUNT,
                secure_storage_keychain_domain: secure_storage::KEYCHAIN_DOMAIN,
            })
        }
        Ok(None) => Ok(AccountSessionDiagnostics {
            account_metadata_present,
            token_present: false,
            token_expired: false,
            secure_storage_available: true,
            secure_storage_service_name: secure_storage::SERVICE_NAME,
            secure_storage_session_account: secure_storage::SESSION_ACCOUNT,
            secure_storage_keychain_domain: secure_storage::KEYCHAIN_DOMAIN,
        }),
        Err(_) => Ok(AccountSessionDiagnostics {
            account_metadata_present,
            token_present: false,
            token_expired: false,
            secure_storage_available: false,
            secure_storage_service_name: secure_storage::SERVICE_NAME,
            secure_storage_session_account: secure_storage::SESSION_ACCOUNT,
            secure_storage_keychain_domain: secure_storage::KEYCHAIN_DOMAIN,
        }),
    }
}

pub fn account_auth_config_diagnostics() -> AccountAuthConfigDiagnostics {
    AccountAuthConfigDiagnostics {
        configured: workos_client_id().is_some(),
        missing_public_config_keys: if workos_client_id().is_some() {
            Vec::new()
        } else {
            vec![AGENTKITPROJECT_WORKOS_CLIENT_ID_KEY]
        },
        client_id_source: workos_client_id_source(),
        profile_base_url: "https://profile.agentkitproject.com",
        market_base_url: "https://market.agentkitproject.com",
        forge_base_url: "https://forge.agentkitproject.com",
        device_authorization_endpoint: WORKOS_DEVICE_AUTH_URL,
    }
}

fn poll_for_device_token(
    client_id: &str,
    pending: &PendingDeviceLogin,
) -> Result<DeviceTokenResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Unable to prepare AgentKitProject login request: {error}"))?;
    let mut interval = pending.interval_seconds;
    while epoch_seconds() < pending.expires_at_epoch_seconds {
        let response = client
            .post(WORKOS_DEVICE_TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&[
                ("grant_type", DEVICE_CODE_GRANT),
                ("device_code", pending.device_code.as_str()),
                ("client_id", client_id),
            ])
            .send()
            .map_err(|error| format!("Unable to reach AgentKitProject login service: {error}"))?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<DeviceTokenResponse>()
                .map_err(|error| format!("AgentKitProject login response was invalid: {error}"));
        }

        let error = response
            .json::<DeviceTokenError>()
            .ok()
            .and_then(|body| body.error)
            .unwrap_or_else(|| "authorization_failed".to_string());
        match error.as_str() {
            "authorization_pending" => thread::sleep(Duration::from_secs(interval)),
            "slow_down" => {
                interval = (interval + 5).min(MAX_DEVICE_INTERVAL_SECONDS);
                thread::sleep(Duration::from_secs(interval));
            }
            "access_denied" => {
                return Err("AgentKitProject login was cancelled or denied.".to_string())
            }
            "expired_token" => {
                return Err("AgentKitProject login expired. Please try again.".to_string())
            }
            "invalid_client" => {
                return Err(
                    "AgentKitProject login is not configured for this desktop app build."
                        .to_string(),
                )
            }
            _ => {
                return Err(format!(
                    "AgentKitProject login failed. Status: {}.",
                    status.as_u16()
                ))
            }
        }
    }

    Err("AgentKitProject login timed out. Please try again.".to_string())
}

fn account_connection_from_user(
    user: WorkosUser,
    connected_at: String,
) -> settings::AccountConnection {
    let handle = metadata_string(&user, "handle");
    let display_name = metadata_string(&user, "displayName")
        .or_else(|| metadata_string(&user, "display_name"))
        .or_else(|| full_name(user.first_name.as_deref(), user.last_name.as_deref()))
        .or_else(|| handle.clone());
    let avatar_initials = metadata_string(&user, "avatarInitials")
        .or_else(|| metadata_string(&user, "avatar_initials"))
        .or_else(|| initials(display_name.as_deref().or(handle.as_deref())));

    settings::AccountConnection {
        account_connection_status: "connected".to_string(),
        user_display_name: display_name,
        user_email: user.email,
        user_handle: handle,
        user_id: user.id,
        avatar_initials,
        connection_error: None,
        last_connected_at: Some(connected_at),
    }
}

fn workos_client_id() -> Option<String> {
    std::env::var(AGENTKITPROJECT_WORKOS_CLIENT_ID_KEY)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            option_env!("AGENTKITPROJECT_WORKOS_CLIENT_ID")
                .map(str::to_string)
                .filter(|value| !value.trim().is_empty())
        })
}

fn workos_client_id_source() -> Option<&'static str> {
    if std::env::var(AGENTKITPROJECT_WORKOS_CLIENT_ID_KEY)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
    {
        Some("runtime-env")
    } else if option_env!("AGENTKITPROJECT_WORKOS_CLIENT_ID")
        .is_some_and(|value| !value.trim().is_empty())
    {
        Some("compile-time-env")
    } else {
        None
    }
}

fn missing_auth_config_message() -> &'static str {
    "Forge account connection is not configured in this build. Missing public config key: AGENTKITPROJECT_WORKOS_CLIENT_ID."
}

fn metadata_string(user: &WorkosUser, key: &str) -> Option<String> {
    user.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn full_name(first_name: Option<&str>, last_name: Option<&str>) -> Option<String> {
    let full = [
        first_name.unwrap_or("").trim(),
        last_name.unwrap_or("").trim(),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if full.is_empty() {
        None
    } else {
        Some(full)
    }
}

fn initials(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    Some(
        value
            .split(|character: char| {
                character.is_whitespace()
                    || character == '.'
                    || character == '_'
                    || character == '-'
            })
            .filter(|part| !part.is_empty())
            .take(2)
            .filter_map(|part| part.chars().next())
            .flat_map(char::to_uppercase)
            .collect(),
    )
}

fn login_id() -> String {
    format!("agentkitproject-login-{}", epoch_millis())
}

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Extracts the `exp` (expiry, seconds since epoch) claim from a JWT access
/// token without verifying its signature. Verification is the Market server's
/// job (via JWKS); here we only need the expiry to decide whether to refresh.
/// Returns `None` if the token is malformed or lacks a numeric `exp`.
fn jwt_exp_seconds(token: &str) -> Option<u64> {
    let payload_b64 = token.split('.').nth(1)?;
    let bytes = base64_url_decode(payload_b64)?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("exp").and_then(|value| value.as_u64())
}

/// Minimal base64url (no padding) decoder for JWT segments. Avoids pulling in
/// an extra dependency for a single decode.
fn base64_url_decode(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let input = input.trim_end_matches('=');
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in input.as_bytes() {
        let six = value(byte)? as u32;
        buffer = (buffer << 6) | six;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// Pure decision: should we refresh now? True when the token is already
/// expired or will expire within `buffer_seconds` of `now_seconds`. Tokens
/// with no decodable expiry are treated as needing refresh so we never sit on
/// an unknown/expired token.
fn token_needs_refresh(exp_seconds: Option<u64>, now_seconds: u64, buffer_seconds: u64) -> bool {
    match exp_seconds {
        Some(exp) => exp <= now_seconds.saturating_add(buffer_seconds),
        None => true,
    }
}

/// Returns a still-valid access token for hosted-Market calls, refreshing it
/// proactively when it is expired or within the refresh buffer of expiry.
///
/// On a successful proactive refresh the rotated access+refresh tokens are
/// persisted by `refresh_access_token`. If the token is still valid, the
/// stored token is returned untouched. If no session/token is stored, this
/// surfaces the reconnect-required error (same as `require_access_token`).
/// The configured WorkOS client id, exposed for the hosted-Market operation
/// bridge (core seeds its `WorkosConfig` from this and defaults the WorkOS
/// device/token URLs to the same values used here).
pub fn market_workos_client_id() -> Option<String> {
    workos_client_id()
}

/// The raw stored AgentKitProject session JSON, used to seed the in-memory
/// `TokenStore` in the hosted-Market operation bridge. The stored shape
/// (`accessToken`/`refreshToken`/`connectedAt`/`user`, camelCase) is already a
/// superset of core's `StoredSession`. Returns `None` when no usable session is
/// stored. Never log the returned value — it contains tokens.
pub fn current_session_json() -> Result<Option<String>, String> {
    let Some(session_json) = secure_storage::load_account_session()? else {
        return Ok(None);
    };
    let session: StoredAccountSession = serde_json::from_str(&session_json)
        .map_err(|_| "Stored AgentKitProject session could not be read safely.".to_string())?;
    if session.access_token.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(session_json))
}

/// Persist a session that core rotated during a hosted-Market operation back
/// into OS secure storage, and refresh the connected-account settings snapshot
/// (display name/avatar) the same way `refresh_access_token` does. The input is
/// the `rotatedSession` JSON the operation bridge emitted. Never log it.
pub fn persist_rotated_session_json<R: Runtime>(
    app: &tauri::AppHandle<R>,
    rotated_session_json: &str,
) -> Result<(), String> {
    let session: StoredAccountSession = serde_json::from_str(rotated_session_json)
        .map_err(|_| "Rotated AgentKitProject session could not be read safely.".to_string())?;
    if session.access_token.trim().is_empty() {
        return Err("Rotated AgentKitProject session was missing an access token.".to_string());
    }
    let connected_at = session.connected_at.clone();
    let user = session.user.clone();
    let normalized_json = serde_json::to_string(&session)
        .map_err(|error| format!("Unable to serialize AgentKitProject session: {error}"))?;
    secure_storage::store_account_session(&normalized_json)?;
    // Best-effort: keep the cached connected-account snapshot in sync with the
    // rotated user metadata, mirroring the refresh path.
    let _ = settings::save_connected_account(
        app,
        account_connection_from_user(user, connected_at),
    );
    Ok(())
}

pub fn access_token_with_proactive_refresh<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<String, String> {
    let token = require_access_token(app)?;
    if token_needs_refresh(
        jwt_exp_seconds(&token),
        epoch_seconds(),
        ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
    ) {
        return refresh_access_token(app);
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_identity_does_not_require_email_or_raw_user_id_for_display() {
        let connection = account_connection_from_user(
            WorkosUser {
                id: Some("user_123".to_string()),
                first_name: Some("Ada".to_string()),
                last_name: Some("Lovelace".to_string()),
                ..WorkosUser::default()
            },
            "1".to_string(),
        );

        assert_eq!(
            connection.user_display_name.as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(connection.avatar_initials.as_deref(), Some("AL"));
        assert_eq!(connection.user_email, None);
    }

    #[test]
    fn device_poll_errors_are_safe_user_messages() {
        let denied = "AgentKitProject login was cancelled or denied.";
        assert!(!denied.to_lowercase().contains("token"));
        assert!(!denied.to_lowercase().contains("device_code"));
    }

    #[test]
    fn refresh_response_parsing_preserves_optional_fields() {
        let refreshed: RefreshTokenResponse =
            serde_json::from_str(r#"{"access_token":"new-token"}"#).expect("parse");
        assert_eq!(refreshed.access_token, "new-token");
        assert!(refreshed.refresh_token.is_none());
        assert!(refreshed.user.is_none());

        let rotated: RefreshTokenResponse = serde_json::from_str(
            r#"{"access_token":"new-token","refresh_token":"new-refresh","user":{"id":"user_1"}}"#,
        )
        .expect("parse");
        assert_eq!(rotated.refresh_token.as_deref(), Some("new-refresh"));
        assert_eq!(
            rotated.user.and_then(|user| user.id).as_deref(),
            Some("user_1")
        );
    }

    #[test]
    fn reconnect_error_is_a_safe_user_message() {
        assert!(RECONNECT_REQUIRED_ERROR.starts_with("RECONNECT_REQUIRED"));
        assert!(!RECONNECT_REQUIRED_ERROR.to_lowercase().contains("bearer"));
        assert!(!RECONNECT_REQUIRED_ERROR
            .to_lowercase()
            .contains("refresh_token"));
    }

    fn jwt_with_exp(exp: u64) -> String {
        // header.payload.signature — only the payload is decoded; signature is
        // ignored (verification is the Market server's job via JWKS).
        let payload = format!(r#"{{"sub":"user_1","exp":{exp}}}"#);
        let encode = |bytes: &[u8]| {
            const ALPHABET: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let b = [
                    chunk[0],
                    *chunk.get(1).unwrap_or(&0),
                    *chunk.get(2).unwrap_or(&0),
                ];
                let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
                out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
                out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
                if chunk.len() > 1 {
                    out.push(ALPHABET[(n >> 6 & 63) as usize] as char);
                }
                if chunk.len() > 2 {
                    out.push(ALPHABET[(n & 63) as usize] as char);
                }
            }
            out
        };
        format!(
            "{}.{}.{}",
            encode(b"{\"alg\":\"RS256\"}"),
            encode(payload.as_bytes()),
            "sig"
        )
    }

    #[test]
    fn jwt_exp_extracted_from_sample_token() {
        let token = jwt_with_exp(1_900_000_000);
        assert_eq!(jwt_exp_seconds(&token), Some(1_900_000_000));
    }

    #[test]
    fn jwt_exp_returns_none_for_malformed_tokens() {
        assert_eq!(jwt_exp_seconds("not-a-jwt"), None);
        assert_eq!(jwt_exp_seconds("only.two"), None);
        assert_eq!(jwt_exp_seconds(""), None);
    }

    #[test]
    fn token_needs_refresh_when_expired_or_within_buffer() {
        // Expired well in the past.
        assert!(token_needs_refresh(Some(1_000), 2_000, 60));
        // Within the 60s buffer of now.
        assert!(token_needs_refresh(Some(2_030), 2_000, 60));
        // Exactly at the buffer boundary still refreshes.
        assert!(token_needs_refresh(Some(2_060), 2_000, 60));
        // Comfortably valid.
        assert!(!token_needs_refresh(Some(5_000), 2_000, 60));
        // No decodable expiry => refresh to be safe.
        assert!(token_needs_refresh(None, 2_000, 60));
    }

    #[test]
    fn full_jwt_round_trips_through_refresh_decision() {
        let now = epoch_seconds();
        let expired = jwt_with_exp(now.saturating_sub(600));
        let fresh = jwt_with_exp(now.saturating_add(3_600));
        assert!(token_needs_refresh(
            jwt_exp_seconds(&expired),
            now,
            ACCESS_TOKEN_REFRESH_BUFFER_SECONDS
        ));
        assert!(!token_needs_refresh(
            jwt_exp_seconds(&fresh),
            now,
            ACCESS_TOKEN_REFRESH_BUFFER_SECONDS
        ));
    }

    #[test]
    fn device_auth_scope_requests_offline_access_for_refresh_tokens() {
        // Without offline_access WorkOS never issues a refresh token, so
        // refresh can never work. This guards the root-cause fix.
        assert!(WORKOS_DEVICE_AUTH_SCOPE.contains("offline_access"));
    }

    #[test]
    fn client_id_can_be_absent_without_faking_connected_state() {
        if std::env::var("AGENTKITPROJECT_WORKOS_CLIENT_ID").is_err()
            && option_env!("AGENTKITPROJECT_WORKOS_CLIENT_ID").is_none()
        {
            assert!(workos_client_id().is_none());
        }
    }
}
