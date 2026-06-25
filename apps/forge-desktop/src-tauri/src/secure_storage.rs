pub const SERVICE_NAME: &str = "com.agentkitforge.desktop.agentkitproject";
pub const SESSION_ACCOUNT: &str = "agentkitproject-session";
pub const KEYCHAIN_DOMAIN: &str = "User";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

pub fn store_account_session(secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("AgentKitProject session cannot be empty.".to_string());
    }

    store_account_session_impl(secret)?;
    verify_account_session(secret)
}

pub fn verify_account_session(expected_secret: &str) -> Result<(), String> {
    match load_account_session_impl() {
        Ok(stored) if stored == expected_secret => Ok(()),
        Ok(_) => Err("AgentKitProject session was saved to OS secure storage but read back different data. Please reconnect the account.".to_string()),
        Err(SecureStorageError::NoEntry) => Err(format!(
            "AgentKitProject session was saved but could not be found during OS secure storage readback. Keychain domain: {KEYCHAIN_DOMAIN}. Service: {SERVICE_NAME}. Account: {SESSION_ACCOUNT}."
        )),
        Err(SecureStorageError::Other(error)) => Err(format!(
            "Unable to verify AgentKitProject session in OS secure storage after saving: {error}"
        )),
    }
}

pub fn load_account_session() -> Result<Option<String>, String> {
    match load_account_session_impl() {
        Ok(secret) if secret.trim().is_empty() => Ok(None),
        Ok(secret) => Ok(Some(secret)),
        Err(SecureStorageError::NoEntry) => Ok(None),
        Err(SecureStorageError::Other(error)) => Err(format!(
            "Unable to load AgentKitProject session from OS secure storage: {error}"
        )),
    }
}

pub fn clear_account_session() -> Result<(), String> {
    match clear_account_session_impl() {
        Ok(()) | Err(SecureStorageError::NoEntry) => Ok(()),
        Err(SecureStorageError::Other(error)) => Err(format!(
            "Unable to clear AgentKitProject session from OS secure storage: {error}"
        )),
    }
}

enum SecureStorageError {
    NoEntry,
    Other(String),
}

#[cfg(target_os = "macos")]
fn store_account_session_impl(secret: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        SERVICE_NAME,
        SESSION_ACCOUNT,
        secret.as_bytes(),
    )
    .map_err(|error| {
        format!(
            "Unable to save AgentKitProject session in macOS Keychain using SecItem: {}",
            security_framework_error(error)
        )
    })
}

#[cfg(target_os = "macos")]
fn load_account_session_impl() -> Result<String, SecureStorageError> {
    let secret_bytes =
        security_framework::passwords::get_generic_password(SERVICE_NAME, SESSION_ACCOUNT)
            .map_err(map_security_framework_error)?;
    String::from_utf8(secret_bytes).map_err(|error| {
        SecureStorageError::Other(format!(
            "Stored AgentKitProject session was not valid UTF-8: {error}"
        ))
    })
}

#[cfg(target_os = "macos")]
fn clear_account_session_impl() -> Result<(), SecureStorageError> {
    security_framework::passwords::delete_generic_password(SERVICE_NAME, SESSION_ACCOUNT)
        .map_err(map_security_framework_error)
}

#[cfg(target_os = "macos")]
fn map_security_framework_error(error: security_framework::base::Error) -> SecureStorageError {
    if error.code() == ERR_SEC_ITEM_NOT_FOUND {
        SecureStorageError::NoEntry
    } else {
        SecureStorageError::Other(security_framework_error(error))
    }
}

#[cfg(target_os = "macos")]
fn security_framework_error(error: security_framework::base::Error) -> String {
    format!("{error} (OSStatus {})", error.code())
}

#[cfg(not(target_os = "macos"))]
fn store_account_session_impl(secret: &str) -> Result<(), String> {
    match account_session_entry()
        .map_err(secure_storage_error_message)?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => {
            return Err(format!(
                "Unable to replace existing AgentKitProject session in OS secure storage: {error}"
            ))
        }
    }
    account_session_entry()
        .map_err(secure_storage_error_message)?
        .set_password(secret)
        .map_err(|error| {
            format!("Unable to save AgentKitProject session in OS secure storage: {error}")
        })
}

#[cfg(not(target_os = "macos"))]
fn load_account_session_impl() -> Result<String, SecureStorageError> {
    account_session_entry()?
        .get_password()
        .map_err(map_keyring_error)
}

#[cfg(not(target_os = "macos"))]
fn clear_account_session_impl() -> Result<(), SecureStorageError> {
    account_session_entry()?
        .delete_credential()
        .map_err(map_keyring_error)
}

#[cfg(not(target_os = "macos"))]
fn account_session_entry() -> Result<keyring::Entry, SecureStorageError> {
    keyring::Entry::new(SERVICE_NAME, SESSION_ACCOUNT).map_err(|error| {
        SecureStorageError::Other(format!("Unable to access OS secure storage: {error}"))
    })
}

#[cfg(not(target_os = "macos"))]
fn secure_storage_error_message(error: SecureStorageError) -> String {
    match error {
        SecureStorageError::NoEntry => {
            "AgentKitProject session entry not found in OS secure storage.".to_string()
        }
        SecureStorageError::Other(message) => message,
    }
}

#[cfg(not(target_os = "macos"))]
fn map_keyring_error(error: keyring::Error) -> SecureStorageError {
    match error {
        keyring::Error::NoEntry => SecureStorageError::NoEntry,
        error => SecureStorageError::Other(error.to_string()),
    }
}
