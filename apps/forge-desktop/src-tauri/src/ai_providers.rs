use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::security::{redact_user_visible_error, validate_http_base_url};

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiProviderType {
    Openai,
    Anthropic,
    Gemini,
    Ollama,
    OpenaiCompatible,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: AiProviderType,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub default_model: String,
    pub supports_structured_json: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_source: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub provider_type: AiProviderType,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub default_model: String,
    pub supports_structured_json: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicAiProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: AiProviderType,
    pub base_url: Option<String>,
    pub has_api_key: bool,
    pub model: Option<String>,
    pub default_model: String,
    pub supports_structured_json: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct GenerateTextRequest {
    pub instructions: String,
    pub input: String,
    pub model: String,
    pub max_output_tokens: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionTestResult {
    pub ok: bool,
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
struct OpenAIResponsesRequest {
    model: String,
    instructions: String,
    input: String,
    max_output_tokens: u32,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct AnthropicRequest {
    model: String,
    system: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    generation_config: GeminiGenerationConfig,
}

#[derive(Debug, Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiGenerationConfig {
    max_output_tokens: u32,
}

#[derive(Debug, Serialize)]
struct OllamaRequest {
    model: String,
    system: String,
    prompt: String,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    num_predict: u32,
}

pub fn public_provider(config: &AiProviderConfig) -> PublicAiProviderConfig {
    PublicAiProviderConfig {
        id: config.id.clone(),
        name: config.name.clone(),
        provider_type: config.provider_type.clone(),
        base_url: config.base_url.clone(),
        has_api_key: config
            .api_key
            .as_ref()
            .is_some_and(|key| is_present_secret(key)),
        model: config.model.clone(),
        default_model: config.default_model.clone(),
        supports_structured_json: config.supports_structured_json,
        created_at: config.created_at.clone(),
        updated_at: config.updated_at.clone(),
    }
}

pub async fn test_connection(
    config: &AiProviderConfig,
    model_override: Option<String>,
) -> Result<ProviderConnectionTestResult, String> {
    let model = selected_model(config, model_override.as_deref())?;
    let response = generate_text(
        config,
        GenerateTextRequest {
            instructions: "Reply with OK.".to_string(),
            input: "OK".to_string(),
            model: model.clone(),
            max_output_tokens: 16,
        },
    )
    .await?;

    if response.trim().is_empty() {
        return Err("Provider returned an empty response.".to_string());
    }

    Ok(ProviderConnectionTestResult {
        ok: true,
        provider_id: config.id.clone(),
        provider_name: config.name.clone(),
        model,
        message: "Provider connection succeeded.".to_string(),
    })
}

pub async fn generate_text(
    config: &AiProviderConfig,
    request: GenerateTextRequest,
) -> Result<String, String> {
    validate_provider_config(config)?;

    match config.provider_type {
        AiProviderType::Openai => call_openai_responses(config, request).await,
        AiProviderType::OpenaiCompatible => call_openai_compatible(config, request).await,
        AiProviderType::Anthropic => call_anthropic(config, request).await,
        AiProviderType::Gemini => call_gemini(config, request).await,
        AiProviderType::Ollama => call_ollama(config, request).await,
    }
}

pub fn selected_model(
    config: &AiProviderConfig,
    model_override: Option<&str>,
) -> Result<String, String> {
    let model = model_override
        .map(str::trim)
        .filter(|value| is_present_config_value(value))
        .or_else(|| {
            config
                .model
                .as_deref()
                .map(str::trim)
                .filter(|value| is_present_config_value(value))
        })
        .or_else(|| {
            let default_model = config.default_model.trim();
            is_present_config_value(default_model).then_some(default_model)
        })
        .unwrap_or_default()
        .to_string();

    if model.is_empty() {
        Err(provider_missing_model_message(config))
    } else {
        Ok(model)
    }
}

pub fn validate_provider_config(config: &AiProviderConfig) -> Result<(), String> {
    if config.name.trim().is_empty() {
        return Err("Provider name is required.".to_string());
    }

    selected_model(config, None)?;

    match config.provider_type {
        AiProviderType::Openai | AiProviderType::Anthropic | AiProviderType::Gemini => {
            required_api_key(config)?;
        }
        AiProviderType::OpenaiCompatible => {
            required_base_url(config)?;
            required_api_key(config)?;
        }
        AiProviderType::Ollama => {
            validate_base_url(defaulted_base_url(config, "http://localhost:11434")?.as_str())?;
        }
    }

    Ok(())
}

fn required_api_key(config: &AiProviderConfig) -> Result<String, String> {
    config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| is_present_secret(value))
        .map(str::to_string)
        .ok_or_else(|| provider_missing_api_key_message(config))
}

fn required_base_url(config: &AiProviderConfig) -> Result<String, String> {
    let base_url = config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{} base URL is required.", config.name))?;
    validate_base_url(base_url)?;
    Ok(base_url.trim_end_matches('/').to_string())
}

fn defaulted_base_url(config: &AiProviderConfig, default: &str) -> Result<String, String> {
    let value = config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default);
    validate_base_url(value)?;
    Ok(value.trim_end_matches('/').to_string())
}

fn validate_base_url(value: &str) -> Result<(), String> {
    validate_http_base_url(value)
}

async fn call_openai_responses(
    config: &AiProviderConfig,
    request: GenerateTextRequest,
) -> Result<String, String> {
    let api_key = required_api_key(config)?;
    let base_url = defaulted_base_url(config, "https://api.openai.com/v1")?;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{base_url}/responses"))
        .bearer_auth(api_key)
        .json(&OpenAIResponsesRequest {
            model: request.model,
            instructions: request.instructions,
            input: request.input,
            max_output_tokens: request.max_output_tokens,
        })
        .send()
        .await
        .map_err(connection_error)?;

    response_text_from_openai_responses(response, "OpenAI").await
}

async fn call_openai_compatible(
    config: &AiProviderConfig,
    request: GenerateTextRequest,
) -> Result<String, String> {
    let base_url = required_base_url(config)?;
    let mut builder = reqwest::Client::new()
        .post(format!("{base_url}/chat/completions"))
        .json(&ChatCompletionRequest {
            model: request.model,
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: request.instructions,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: request.input,
                },
            ],
            max_tokens: request.max_output_tokens,
            temperature: 0.2,
        });

    if let Some(api_key) = config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.bearer_auth(api_key);
    }

    let response = builder.send().await.map_err(connection_error)?;
    response_text_from_chat_completion(response, &config.name).await
}

async fn call_anthropic(
    config: &AiProviderConfig,
    request: GenerateTextRequest,
) -> Result<String, String> {
    let api_key = required_api_key(config)?;
    let base_url = defaulted_base_url(config, "https://api.anthropic.com/v1")?;
    let response = reqwest::Client::new()
        .post(format!("{base_url}/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&AnthropicRequest {
            model: request.model,
            system: request.instructions,
            messages: vec![AnthropicMessage {
                role: "user".to_string(),
                content: request.input,
            }],
            max_tokens: request.max_output_tokens,
        })
        .send()
        .await
        .map_err(connection_error)?;

    let body = checked_body(response, "Anthropic").await?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Anthropic returned unexpected JSON: {error}"))?;
    let text = parsed
        .get("content")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(|text| text.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    non_empty_text(text, "Anthropic")
}

async fn call_gemini(
    config: &AiProviderConfig,
    request: GenerateTextRequest,
) -> Result<String, String> {
    let api_key = required_api_key(config)?;
    let base_url = defaulted_base_url(config, "https://generativelanguage.googleapis.com/v1beta")?;
    let response = reqwest::Client::new()
        .post(format!(
            "{base_url}/models/{}:generateContent",
            request.model
        ))
        .query(&[("key", api_key)])
        .json(&GeminiRequest {
            contents: vec![GeminiContent {
                parts: vec![GeminiPart {
                    text: format!("{}\n\n{}", request.instructions, request.input),
                }],
            }],
            generation_config: GeminiGenerationConfig {
                max_output_tokens: request.max_output_tokens,
            },
        })
        .send()
        .await
        .map_err(connection_error)?;

    let body = checked_body(response, "Gemini").await?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Gemini returned unexpected JSON: {error}"))?;
    let text = parsed
        .get("candidates")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .flat_map(|candidate| {
            candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(|parts| parts.as_array())
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|part| {
            part.get("text")
                .and_then(|text| text.as_str())
                .map(str::to_string)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    non_empty_text(text, "Gemini")
}

async fn call_ollama(
    config: &AiProviderConfig,
    request: GenerateTextRequest,
) -> Result<String, String> {
    let base_url = defaulted_base_url(config, "http://localhost:11434")?;
    let response = reqwest::Client::new()
        .post(format!("{base_url}/api/generate"))
        .json(&OllamaRequest {
            model: request.model,
            system: request.instructions,
            prompt: request.input,
            stream: false,
            options: OllamaOptions {
                num_predict: request.max_output_tokens,
            },
        })
        .send()
        .await
        .map_err(connection_error)?;

    let body = checked_body(response, "Ollama").await?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Ollama returned unexpected JSON: {error}"))?;
    let text = parsed
        .get("response")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    non_empty_text(text, "Ollama")
}

async fn response_text_from_openai_responses(
    response: reqwest::Response,
    provider_label: &str,
) -> Result<String, String> {
    let body = checked_body(response, provider_label).await?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("{provider_label} returned unexpected JSON: {error}"))?;

    let text = parsed
        .get("output_text")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            Some(
                parsed
                    .get("output")?
                    .as_array()?
                    .iter()
                    .flat_map(|item| {
                        item.get("content")
                            .and_then(|content| content.as_array())
                            .cloned()
                            .unwrap_or_default()
                    })
                    .filter_map(|content| {
                        content
                            .get("text")
                            .and_then(|text| text.as_str())
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    non_empty_text(text, provider_label)
}

async fn response_text_from_chat_completion(
    response: reqwest::Response,
    provider_label: &str,
) -> Result<String, String> {
    let body = checked_body(response, provider_label).await?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("{provider_label} returned unexpected JSON: {error}"))?;
    let text = parsed
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    non_empty_text(text, provider_label)
}

async fn checked_body(response: reqwest::Response, provider_label: &str) -> Result<String, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Unable to read {provider_label} response: {error}"))?;

    if !status.is_success() {
        return Err(provider_error_message(provider_label, status, &body));
    }

    Ok(body)
}

fn non_empty_text(text: String, provider_label: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        Err(format!("{provider_label} returned an empty response."))
    } else {
        Ok(text)
    }
}

fn provider_error_message(provider_label: &str, status: StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(|message| message.as_str())
                        .or_else(|| error.as_str())
                })
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("{provider_label} request failed."));

    let hint = match status.as_u16() {
        401 => " The API key is invalid or was rejected.",
        403 => " Check account, project, model, or provider permissions.",
        404 => " Check the model ID and base URL.",
        _ => "",
    };

    redact_user_visible_error(&format!(
        "{provider_label} request failed ({status}): {message}{hint}"
    ))
}

fn provider_missing_api_key_message(config: &AiProviderConfig) -> String {
    match config.provider_type {
        AiProviderType::Openai => "OpenAI API key is missing. Add it in Settings.".to_string(),
        AiProviderType::Anthropic => {
            "Anthropic API key is missing. Add it in Settings.".to_string()
        }
        AiProviderType::Gemini => "Gemini API key is missing. Add it in Settings.".to_string(),
        AiProviderType::OpenaiCompatible => {
            format!("{} API key is missing. Add it in Settings.", config.name)
        }
        AiProviderType::Ollama => {
            format!("{} API key is missing. Add it in Settings.", config.name)
        }
    }
}

fn provider_missing_model_message(config: &AiProviderConfig) -> String {
    match config.provider_type {
        AiProviderType::Openai => {
            "OpenAI model is missing. Select a model in Settings.".to_string()
        }
        AiProviderType::Anthropic => {
            "Anthropic model is missing. Select a model in Settings.".to_string()
        }
        AiProviderType::Gemini => {
            "Gemini model is missing. Select a model in Settings.".to_string()
        }
        AiProviderType::OpenaiCompatible => {
            format!(
                "{} model is missing. Select a model in Settings.",
                config.name
            )
        }
        AiProviderType::Ollama => {
            "Ollama model is missing. Select a model in Settings.".to_string()
        }
    }
}

pub fn is_present_config_value(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && !trimmed.eq_ignore_ascii_case("null")
        && !trimmed.eq_ignore_ascii_case("undefined")
}

pub fn is_present_secret(value: &str) -> bool {
    is_present_config_value(value)
}

fn connection_error(error: reqwest::Error) -> String {
    let message = if error.is_connect() {
        format!("Connection refused or provider is unreachable: {error}")
    } else if error.is_timeout() {
        format!("Provider request timed out: {error}")
    } else {
        format!("Unable to reach provider: {error}")
    };
    redact_user_visible_error(&message)
}
