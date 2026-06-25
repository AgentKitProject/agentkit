use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{Manager, Runtime};

use crate::ai_providers::{
    is_present_config_value, is_present_secret, public_provider, validate_provider_config,
    AiProviderConfig, AiProviderInput, AiProviderType, PublicAiProviderConfig,
};

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    openai_api_key: Option<String>,
    default_model: Option<String>,
    ai_providers: Option<Vec<AiProviderConfig>>,
    default_ai_provider_id: Option<String>,
    default_output_folder: Option<String>,
    preferred_validation_profile: Option<String>,
    preferred_context_mode: Option<String>,
    theme: Option<String>,
    include_policies: Option<bool>,
    include_templates: Option<bool>,
    include_workflows: Option<bool>,
    include_references: Option<bool>,
    last_update_check_at: Option<String>,
    account_connection: Option<AccountConnection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApiKeySource {
    ProviderSpecific,
    Legacy,
    Missing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConnection {
    pub account_connection_status: String,
    pub user_display_name: Option<String>,
    pub user_email: Option<String>,
    pub user_handle: Option<String>,
    pub user_id: Option<String>,
    pub avatar_initials: Option<String>,
    pub connection_error: Option<String>,
    pub last_connected_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferencesInput {
    pub default_model: String,
    pub default_output_folder: String,
    pub preferred_validation_profile: String,
    pub preferred_context_mode: String,
    pub theme: String,
    pub include_policies: bool,
    pub include_templates: bool,
    pub include_workflows: bool,
    pub include_references: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub has_openai_api_key: bool,
    pub default_model: String,
    pub ai_providers: Vec<PublicAiProviderConfig>,
    pub default_ai_provider_id: Option<String>,
    pub default_output_folder: String,
    pub preferred_validation_profile: String,
    pub preferred_context_mode: String,
    pub theme: String,
    pub include_policies: bool,
    pub include_templates: bool,
    pub include_workflows: bool,
    pub include_references: bool,
    pub last_update_check_at: Option<String>,
    pub settings_path: String,
    pub account_connection: AccountConnection,
}

const DEFAULT_MODEL: &str = "gpt-5.4-mini";

pub fn get_public_settings<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PublicSettings, String> {
    let settings = read_settings_with_migration(app)?;
    let path = settings_path(app)?;
    let providers = normalized_providers(&settings);
    let default_provider = default_provider(&providers, settings.default_ai_provider_id.as_deref());

    Ok(PublicSettings {
        has_openai_api_key: providers.iter().any(|provider| {
            provider.provider_type == AiProviderType::Openai
                && provider
                    .api_key
                    .as_ref()
                    .is_some_and(|key| !key.trim().is_empty())
        }),
        default_model: default_provider
            .map(|provider| provider.default_model.clone())
            .or_else(|| {
                settings
                    .default_model
                    .filter(|model| !model.trim().is_empty())
            })
            .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        ai_providers: providers.iter().map(public_provider).collect(),
        default_ai_provider_id: default_provider.map(|provider| provider.id.clone()),
        default_output_folder: settings
            .default_output_folder
            .filter(|folder| !folder.trim().is_empty())
            .unwrap_or_else(|| default_library_folder(app).to_string_lossy().into_owned()),
        preferred_validation_profile: settings
            .preferred_validation_profile
            .filter(|profile| !profile.trim().is_empty())
            .unwrap_or_else(|| "local-valid".to_string()),
        preferred_context_mode: settings
            .preferred_context_mode
            .filter(|mode| !mode.trim().is_empty())
            .unwrap_or_else(|| "triggered".to_string()),
        theme: settings
            .theme
            .filter(|theme| !theme.trim().is_empty())
            .unwrap_or_else(|| "light".to_string()),
        include_policies: settings.include_policies.unwrap_or(true),
        include_templates: settings.include_templates.unwrap_or(true),
        include_workflows: settings.include_workflows.unwrap_or(true),
        include_references: settings.include_references.unwrap_or(false),
        last_update_check_at: settings.last_update_check_at,
        settings_path: path.to_string_lossy().into_owned(),
        account_connection: public_account_connection(settings.account_connection),
    })
}

pub fn save_openai_api_key<R: Runtime>(
    app: &tauri::AppHandle<R>,
    api_key: String,
) -> Result<PublicSettings, String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("OpenAI API key is required.".to_string());
    }

    let mut settings = read_settings_with_migration(app)?;
    settings.openai_api_key = Some(api_key.clone());
    let mut providers = normalized_providers(&settings);
    if let Some(provider) = providers
        .iter_mut()
        .find(|provider| provider.provider_type == AiProviderType::Openai)
    {
        provider.api_key = Some(api_key);
        provider.updated_at = now_timestamp();
    } else {
        providers.push(default_openai_provider(
            Some(api_key),
            settings.default_model.clone(),
        ));
    }
    settings.ai_providers = Some(providers);
    if settings.default_ai_provider_id.is_none() {
        settings.default_ai_provider_id = settings
            .ai_providers
            .as_ref()
            .and_then(|providers| providers.first())
            .map(|provider| provider.id.clone());
    }
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn clear_openai_api_key<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    settings.openai_api_key = None;
    if let Some(providers) = settings.ai_providers.as_mut() {
        for provider in providers
            .iter_mut()
            .filter(|provider| provider.provider_type == AiProviderType::Openai)
        {
            provider.api_key = None;
            provider.updated_at = now_timestamp();
        }
    }
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_default_model<R: Runtime>(
    app: &tauri::AppHandle<R>,
    model: String,
) -> Result<PublicSettings, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Default model is required.".to_string());
    }

    let mut settings = read_settings_with_migration(app)?;
    settings.default_model = Some(model);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_app_preferences<R: Runtime>(
    app: &tauri::AppHandle<R>,
    input: AppPreferencesInput,
) -> Result<PublicSettings, String> {
    let default_model = input.default_model.trim().to_string();
    if default_model.is_empty() {
        return Err("Default model is required.".to_string());
    }

    if !["local-valid", "publishable", "trusted", "verified"]
        .contains(&input.preferred_validation_profile.as_str())
    {
        return Err("Preferred validation profile is invalid.".to_string());
    }

    if !["all", "triggered"].contains(&input.preferred_context_mode.as_str()) {
        return Err("Preferred context mode is invalid.".to_string());
    }

    if !["light", "dark"].contains(&input.theme.as_str()) {
        return Err("Theme is invalid.".to_string());
    }

    let mut settings = read_settings_with_migration(app)?;
    settings.default_model = Some(default_model);
    settings.default_output_folder = Some(input.default_output_folder.trim().to_string());
    settings.preferred_validation_profile = Some(input.preferred_validation_profile);
    settings.preferred_context_mode = Some(input.preferred_context_mode);
    settings.theme = Some(input.theme);
    settings.include_policies = Some(input.include_policies);
    settings.include_templates = Some(input.include_templates);
    settings.include_workflows = Some(input.include_workflows);
    settings.include_references = Some(input.include_references);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_ai_provider<R: Runtime>(
    app: &tauri::AppHandle<R>,
    input: AiProviderInput,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    let mut providers = normalized_providers(&settings);
    let now = now_timestamp();
    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| provider_id(&input.provider_type, &now));

    let existing = providers.iter().find(|provider| provider.id == id).cloned();
    let api_key = input
        .api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|provider| provider.api_key.clone())
        });

    let provider = AiProviderConfig {
        id: id.clone(),
        name: input.name.trim().to_string(),
        provider_type: input.provider_type,
        base_url: input
            .base_url
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty()),
        api_key,
        model: existing
            .as_ref()
            .and_then(|provider| provider.model.clone()),
        default_model: input.default_model.trim().to_string(),
        supports_structured_json: input.supports_structured_json,
        created_at: existing
            .map(|provider| provider.created_at)
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        api_key_source: None,
    };
    validate_provider_config(&provider)?;

    if let Some(index) = providers.iter().position(|current| current.id == id) {
        providers[index] = provider;
    } else {
        providers.push(provider);
    }

    if settings.default_ai_provider_id.is_none() {
        settings.default_ai_provider_id = Some(id);
    }

    settings.ai_providers = Some(providers);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn remove_ai_provider<R: Runtime>(
    app: &tauri::AppHandle<R>,
    provider_id: String,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    let mut providers = normalized_providers(&settings);
    providers.retain(|provider| provider.id != provider_id);
    if settings.default_ai_provider_id.as_deref() == Some(provider_id.as_str()) {
        settings.default_ai_provider_id = providers.first().map(|provider| provider.id.clone());
    }
    settings.ai_providers = Some(providers);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn set_default_ai_provider<R: Runtime>(
    app: &tauri::AppHandle<R>,
    provider_id: String,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    let providers = normalized_providers(&settings);
    if !providers.iter().any(|provider| provider.id == provider_id) {
        return Err("Selected AI provider was not found.".to_string());
    }
    settings.default_ai_provider_id = Some(provider_id);
    settings.ai_providers = Some(providers);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_update_check_timestamp<R: Runtime>(
    app: &tauri::AppHandle<R>,
    checked_at: String,
) -> Result<PublicSettings, String> {
    let checked_at = checked_at.trim().to_string();
    if checked_at.is_empty() {
        return Err("Update check timestamp is required.".to_string());
    }

    let mut settings = read_settings_with_migration(app)?;
    settings.last_update_check_at = Some(checked_at);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn disconnect_account<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    settings.account_connection = Some(disconnected_account_connection());
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_connected_account<R: Runtime>(
    app: &tauri::AppHandle<R>,
    account_connection: AccountConnection,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    settings.account_connection = Some(account_connection);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_account_display_name<R: Runtime>(
    app: &tauri::AppHandle<R>,
    display_name: &str,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    let mut account_connection = settings
        .account_connection
        .unwrap_or_else(disconnected_account_connection);
    account_connection.user_display_name = Some(display_name.trim().to_string());
    settings.account_connection = Some(account_connection);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_account_error<R: Runtime>(
    app: &tauri::AppHandle<R>,
    error: &str,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    let mut account_connection = settings
        .account_connection
        .unwrap_or_else(disconnected_account_connection);
    account_connection.account_connection_status = "error".to_string();
    account_connection.connection_error = Some(error.trim().to_string());
    settings.account_connection = Some(account_connection);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn save_account_reconnect_required<R: Runtime>(
    app: &tauri::AppHandle<R>,
    error: &str,
) -> Result<PublicSettings, String> {
    let mut settings = read_settings_with_migration(app)?;
    let mut account_connection = settings
        .account_connection
        .unwrap_or_else(disconnected_account_connection);
    account_connection.account_connection_status = "error".to_string();
    account_connection.connection_error = Some(error.trim().to_string());
    settings.account_connection = Some(account_connection);
    write_settings(app, &settings)?;
    get_public_settings(app)
}

pub fn account_metadata_present<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<bool, String> {
    let settings = read_settings_with_migration(app)?;
    Ok(settings.account_connection.is_some_and(|connection| {
        connection.account_connection_status == "connected"
            || connection.user_display_name.is_some()
            || connection.user_email.is_some()
            || connection.user_handle.is_some()
            || connection.user_id.is_some()
            || connection.last_connected_at.is_some()
    }))
}

pub fn get_ai_provider<R: Runtime>(
    app: &tauri::AppHandle<R>,
    provider_id: Option<&str>,
) -> Result<AiProviderConfig, String> {
    let settings = read_settings_with_migration(app)?;
    let (provider, api_key_source) = resolve_ai_provider_from_settings(&settings, provider_id)?;
    log_provider_resolution(&provider, api_key_source);
    validate_provider_config(&provider)?;
    Ok(provider)
}

fn public_account_connection(account_connection: Option<AccountConnection>) -> AccountConnection {
    account_connection.unwrap_or_else(disconnected_account_connection)
}

fn disconnected_account_connection() -> AccountConnection {
    AccountConnection {
        account_connection_status: "disconnected".to_string(),
        user_display_name: None,
        user_email: None,
        user_handle: None,
        user_id: None,
        avatar_initials: None,
        connection_error: None,
        last_connected_at: None,
    }
}

fn read_settings<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<StoredSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(StoredSettings::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read local settings file: {error}"))?;

    serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse local settings file: {error}"))
}

fn read_settings_with_migration<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<StoredSettings, String> {
    let mut settings = read_settings(app)?;
    let providers = normalized_providers(&settings);
    if settings.ai_providers.is_none() || settings.default_ai_provider_id.is_none() {
        settings.ai_providers = Some(providers);
        if settings.default_ai_provider_id.is_none() {
            settings.default_ai_provider_id = settings
                .ai_providers
                .as_ref()
                .and_then(|providers| providers.first())
                .map(|provider| provider.id.clone());
        }
        write_settings(app, &settings)?;
    }
    Ok(settings)
}

fn write_settings<R: Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &StoredSettings,
) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Unable to resolve local settings folder.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create local settings folder: {error}"))?;

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Unable to serialize local settings: {error}"))?;

    fs::write(path, content).map_err(|error| format!("Unable to save local settings: {error}"))
}

fn settings_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("settings.json"))
        .map_err(|error| format!("Unable to resolve local settings folder: {error}"))
}

fn default_library_folder<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    let path = app
        .path()
        .document_dir()
        .map(|path| path.join("AgentKitForge").join("Kits"))
        .or_else(|_| {
            app.path()
                .app_local_data_dir()
                .map(|path| path.join("Kits"))
        })
        .unwrap_or_else(|_| PathBuf::from("AgentKitForge").join("Kits"));
    let _ = fs::create_dir_all(&path);
    path
}

fn normalized_providers(settings: &StoredSettings) -> Vec<AiProviderConfig> {
    let mut providers = settings.ai_providers.clone().unwrap_or_default();
    if providers.is_empty()
        || settings
            .openai_api_key
            .as_ref()
            .is_some_and(|key| is_present_secret(key))
    {
        let api_key = settings
            .openai_api_key
            .as_ref()
            .map(|key| key.trim().to_string())
            .filter(|key| is_present_secret(key));
        if let Some(existing) = providers
            .iter_mut()
            .find(|provider| provider.provider_type == AiProviderType::Openai)
        {
            if existing
                .api_key
                .as_ref()
                .is_none_or(|key| !is_present_secret(key))
            {
                existing.api_key = api_key;
            }
        } else {
            providers.push(default_openai_provider(
                api_key,
                settings.default_model.clone(),
            ));
        }
    }
    providers
}

fn resolve_ai_provider_from_settings(
    settings: &StoredSettings,
    provider_id: Option<&str>,
) -> Result<(AiProviderConfig, ApiKeySource), String> {
    let providers = settings.ai_providers.clone().unwrap_or_default();
    if providers.is_empty() {
        return Err("Add an AI provider in Settings before using this feature.".to_string());
    }

    let requested_provider_id = provider_id.map(str::trim).filter(|value| !value.is_empty());

    let selected = if let Some(provider_id) = requested_provider_id {
        providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .cloned()
            .ok_or_else(|| "Selected AI provider was not found.".to_string())?
    } else {
        default_provider(&providers, settings.default_ai_provider_id.as_deref())
            .cloned()
            .ok_or_else(|| "Select a default AI provider in Settings.".to_string())?
    };

    let mut provider = normalize_selected_provider(selected, settings);
    let api_key_source = provider_api_key_source(&provider, settings);
    if provider
        .api_key
        .as_ref()
        .is_none_or(|key| !is_present_secret(key))
    {
        provider.api_key = legacy_api_key_for_provider(settings, &provider.provider_type);
    }
    let api_key_source = if provider
        .api_key
        .as_ref()
        .is_some_and(|key| is_present_secret(key))
    {
        api_key_source
    } else {
        ApiKeySource::Missing
    };
    provider.api_key_source = Some(api_key_source.as_str().to_string());

    Ok((provider, api_key_source))
}

fn normalize_selected_provider(
    mut provider: AiProviderConfig,
    settings: &StoredSettings,
) -> AiProviderConfig {
    provider.name = provider.name.trim().to_string();
    provider.base_url = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| is_present_config_value(value))
        .map(normalized_provider_base_url);
    provider.api_key = provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| is_present_secret(value))
        .map(str::to_string);
    provider.model = provider
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| is_present_config_value(value))
        .map(str::to_string);
    provider.default_model = provider.default_model.trim().to_string();
    if !is_present_config_value(&provider.default_model) {
        provider.default_model = settings
            .default_model
            .as_deref()
            .map(str::trim)
            .filter(|value| is_present_config_value(value))
            .map(str::to_string)
            .unwrap_or_default();
    }
    if provider.base_url.is_none() {
        provider.base_url =
            default_base_url_for_provider(&provider.provider_type).map(str::to_string);
    }
    provider
}

fn provider_api_key_source(provider: &AiProviderConfig, settings: &StoredSettings) -> ApiKeySource {
    if provider
        .api_key
        .as_ref()
        .is_some_and(|key| is_present_secret(key))
    {
        ApiKeySource::ProviderSpecific
    } else if legacy_api_key_for_provider(settings, &provider.provider_type)
        .as_ref()
        .is_some_and(|key| is_present_secret(key))
    {
        ApiKeySource::Legacy
    } else {
        ApiKeySource::Missing
    }
}

impl ApiKeySource {
    fn as_str(self) -> &'static str {
        match self {
            ApiKeySource::ProviderSpecific => "provider-specific",
            ApiKeySource::Legacy => "legacy",
            ApiKeySource::Missing => "missing",
        }
    }
}

fn legacy_api_key_for_provider(
    settings: &StoredSettings,
    provider_type: &AiProviderType,
) -> Option<String> {
    match provider_type {
        AiProviderType::Openai => settings
            .openai_api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| is_present_secret(value))
            .map(str::to_string),
        AiProviderType::Anthropic
        | AiProviderType::Gemini
        | AiProviderType::Ollama
        | AiProviderType::OpenaiCompatible => None,
    }
}

fn default_base_url_for_provider(provider_type: &AiProviderType) -> Option<&'static str> {
    match provider_type {
        AiProviderType::Openai => Some("https://api.openai.com/v1"),
        AiProviderType::Anthropic => Some("https://api.anthropic.com/v1"),
        AiProviderType::Gemini => Some("https://generativelanguage.googleapis.com/v1beta"),
        AiProviderType::Ollama => Some("http://localhost:11434"),
        AiProviderType::OpenaiCompatible => None,
    }
}

fn normalized_provider_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn log_provider_resolution(provider: &AiProviderConfig, api_key_source: ApiKeySource) {
    let api_key_length = provider
        .api_key
        .as_ref()
        .map(|key| key.trim().len())
        .unwrap_or(0);
    let api_key_source = api_key_source.as_str();
    let resolved_model = provider
        .model
        .as_deref()
        .filter(|value| is_present_config_value(value))
        .or_else(|| {
            let default_model = provider.default_model.trim();
            is_present_config_value(default_model).then_some(default_model)
        })
        .unwrap_or("");
    eprintln!(
        "AgentKitForge AI provider resolution: selectedProviderId={}; providerType={:?}; baseUrl={}; resolvedModel={}; apiKeyPresent={}; apiKeyLength={}; apiKeySource={}",
        provider.id,
        provider.provider_type,
        provider.base_url.as_deref().unwrap_or(""),
        resolved_model,
        api_key_length > 0,
        api_key_length,
        api_key_source
    );
}

fn default_provider<'a>(
    providers: &'a [AiProviderConfig],
    default_id: Option<&str>,
) -> Option<&'a AiProviderConfig> {
    default_id
        .and_then(|id| providers.iter().find(|provider| provider.id == id))
        .or_else(|| providers.first())
}

fn default_openai_provider(
    api_key: Option<String>,
    default_model: Option<String>,
) -> AiProviderConfig {
    let now = now_timestamp();
    AiProviderConfig {
        id: "openai-default".to_string(),
        name: "OpenAI".to_string(),
        provider_type: AiProviderType::Openai,
        base_url: Some("https://api.openai.com/v1".to_string()),
        api_key,
        model: None,
        default_model: default_model
            .filter(|model| !model.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        supports_structured_json: true,
        created_at: now.clone(),
        updated_at: now,
        api_key_source: None,
    }
}

fn provider_id(provider_type: &AiProviderType, timestamp: &str) -> String {
    let prefix = match provider_type {
        AiProviderType::Openai => "openai",
        AiProviderType::Anthropic => "anthropic",
        AiProviderType::Gemini => "gemini",
        AiProviderType::Ollama => "ollama",
        AiProviderType::OpenaiCompatible => "openai-compatible",
    };
    format!("{prefix}-{timestamp}")
}

pub fn now_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_settings_json(openai_api_key: &str, provider_api_key: Option<&str>) -> String {
        let provider_key = provider_api_key
            .map(|key| format!(r#""{key}""#))
            .unwrap_or_else(|| "null".to_string());
        format!(
            r#"{{
              "defaultAiProviderId": "openai-default",
              "openaiApiKey": {openai_api_key},
              "aiProviders": [
                {{
                  "id": "openai-default",
                  "name": "OpenAI",
                  "providerType": "openai",
                  "baseUrl": " https://api.openai.com/v1/ ",
                  "model": null,
                  "defaultModel": "gpt-5.4-nano",
                  "apiKey": {provider_key},
                  "supportsStructuredJson": true,
                  "createdAt": "1",
                  "updatedAt": "1"
                }}
              ]
            }}"#
        )
    }

    #[test]
    fn provider_specific_api_key_wins_when_legacy_openai_key_is_null() {
        let settings: StoredSettings =
            serde_json::from_str(&provider_settings_json("null", Some(" provider-key "))).unwrap();

        let (provider, source) =
            resolve_ai_provider_from_settings(&settings, Some("openai-default")).unwrap();

        assert_eq!(provider.api_key.as_deref(), Some("provider-key"));
        assert_eq!(source, ApiKeySource::ProviderSpecific);
        assert_eq!(
            provider.api_key_source.as_deref(),
            Some("provider-specific")
        );
        assert_eq!(
            provider.base_url.as_deref(),
            Some("https://api.openai.com/v1")
        );
    }

    #[test]
    fn legacy_openai_key_is_used_only_when_provider_key_is_missing() {
        let settings: StoredSettings =
            serde_json::from_str(&provider_settings_json(r#"" legacy-key ""#, None)).unwrap();

        let (provider, source) = resolve_ai_provider_from_settings(&settings, None).unwrap();

        assert_eq!(provider.api_key.as_deref(), Some("legacy-key"));
        assert_eq!(source, ApiKeySource::Legacy);
        assert_eq!(provider.api_key_source.as_deref(), Some("legacy"));
    }

    #[test]
    fn provider_model_falls_back_to_default_model() {
        let settings: StoredSettings =
            serde_json::from_str(&provider_settings_json("null", Some("provider-key"))).unwrap();
        let (provider, _) = resolve_ai_provider_from_settings(&settings, None).unwrap();

        assert_eq!(
            crate::ai_providers::selected_model(&provider, None).unwrap(),
            "gpt-5.4-nano"
        );
    }

    #[test]
    fn missing_or_placeholder_key_is_rejected_before_fetch() {
        let settings: StoredSettings =
            serde_json::from_str(&provider_settings_json(r#""null""#, Some("undefined"))).unwrap();
        let (provider, _) = resolve_ai_provider_from_settings(&settings, None).unwrap();

        assert_eq!(
            validate_provider_config(&provider).unwrap_err(),
            "OpenAI API key is missing. Add it in Settings."
        );
    }

    #[test]
    fn missing_or_placeholder_model_is_rejected_before_fetch() {
        let mut settings: StoredSettings =
            serde_json::from_str(&provider_settings_json("null", Some("provider-key"))).unwrap();
        let provider = settings.ai_providers.as_mut().unwrap().first_mut().unwrap();
        provider.default_model = "undefined".to_string();

        let (provider, _) = resolve_ai_provider_from_settings(&settings, None).unwrap();

        assert_eq!(
            crate::ai_providers::selected_model(&provider, Some("null")).unwrap_err(),
            "OpenAI model is missing. Select a model in Settings."
        );
    }
}
