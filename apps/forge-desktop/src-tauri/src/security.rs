use std::{net::IpAddr, time::Duration};

pub const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(120);

const REDACTION: &str = "[redacted]";
const MAX_ERROR_LEN: usize = 4000;

pub fn redact_user_visible_error(input: &str) -> String {
    let mut output = input.to_string();
    output = redact_after_case_insensitive(&output, "bearer ");
    output = redact_header_value(&output, "authorization:");
    output = redact_header_value(&output, "x-api-key:");
    output = redact_query_value(&output, "key=");
    output = redact_query_value(&output, "api_key=");
    output = redact_query_value(&output, "access_token=");
    output = redact_query_value(&output, "token=");
    output = redact_credential_urls(&output);
    output = redact_long_secret_like_tokens(&output);
    truncate_error(&output)
}

pub fn validate_http_base_url(value: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(value).map_err(|_| "Base URL must be a valid URL.".to_string())?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => {
            if is_local_host(parsed.host_str().unwrap_or_default()) {
                Ok(())
            } else {
                Err("Non-local HTTP providers may send prompts and keys without encryption. Use HTTPS or a local address such as localhost, 127.0.0.1, or ::1.".to_string())
            }
        }
        _ => Err("Base URL must start with http:// or https://.".to_string()),
    }
}

fn is_local_host(host: &str) -> bool {
    let normalized = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if normalized == "localhost" {
        return true;
    }

    normalized
        .parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn redact_after_case_insensitive(input: &str, marker: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let marker_lower = marker.to_ascii_lowercase();
    let mut cursor = 0;

    while let Some(relative_index) = lower[cursor..].find(&marker_lower) {
        let start = cursor + relative_index;
        let value_start = start + marker.len();
        output.push_str(&input[cursor..value_start]);
        let value_end = input[value_start..]
            .find(|character: char| {
                character.is_whitespace()
                    || character == '"'
                    || character == '\''
                    || character == ','
                    || character == ';'
            })
            .map(|index| value_start + index)
            .unwrap_or(input.len());
        output.push_str(REDACTION);
        cursor = value_end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn redact_header_value(input: &str, header: &str) -> String {
    let mut lines = Vec::new();
    for line in input.lines() {
        if line.trim_start().to_ascii_lowercase().starts_with(header) {
            let prefix_len = line.find(':').map(|index| index + 1).unwrap_or(line.len());
            lines.push(format!("{} {}", &line[..prefix_len], REDACTION));
        } else {
            lines.push(line.to_string());
        }
    }
    lines.join("\n")
}

fn redact_query_value(input: &str, key: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(relative_index) = lower[cursor..].find(&key_lower) {
        let start = cursor + relative_index;
        let value_start = start + key.len();
        output.push_str(&input[cursor..value_start]);
        let value_end = input[value_start..]
            .find(|character: char| {
                matches!(character, '&' | '"' | '\'' | ' ' | '\n' | '\r' | '\t')
            })
            .map(|index| value_start + index)
            .unwrap_or(input.len());
        output.push_str(REDACTION);
        cursor = value_end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn redact_credential_urls(input: &str) -> String {
    let mut output = input.to_string();
    for scheme in ["https://", "http://"] {
        let mut cursor = 0;
        loop {
            let Some(relative_index) = output[cursor..].find(scheme) else {
                break;
            };
            let scheme_start = cursor + relative_index;
            let authority_start = scheme_start + scheme.len();
            let authority_end = output[authority_start..]
                .find(|character: char| {
                    matches!(character, '/' | ' ' | '\n' | '\r' | '\t' | '"' | '\'')
                })
                .map(|index| authority_start + index)
                .unwrap_or(output.len());
            let authority = &output[authority_start..authority_end];
            let Some(at_index) = authority.rfind('@') else {
                cursor = authority_end;
                continue;
            };
            let replacement = format!("{}{}@{}", scheme, REDACTION, &authority[at_index + 1..]);
            output.replace_range(scheme_start..authority_end, &replacement);
            cursor = scheme_start + replacement.len();
        }
    }
    output
}

fn redact_long_secret_like_tokens(input: &str) -> String {
    input
        .split_inclusive(|character: char| {
            character.is_whitespace()
                || matches!(character, '"' | '\'' | ',' | ';' | ')' | '(' | '[' | ']')
        })
        .map(|part| {
            let token = part.trim_matches(|character: char| {
                character.is_whitespace()
                    || matches!(character, '"' | '\'' | ',' | ';' | ')' | '(' | '[' | ']')
            });
            let looks_secret = token.len() >= 32
                && token.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
                })
                && token.chars().any(|character| character.is_ascii_digit())
                && token
                    .chars()
                    .any(|character| character.is_ascii_alphabetic());
            if looks_secret {
                part.replace(token, REDACTION)
            } else {
                part.to_string()
            }
        })
        .collect()
}

fn truncate_error(input: &str) -> String {
    if input.chars().count() <= MAX_ERROR_LEN {
        return input.to_string();
    }

    let truncated = input.chars().take(MAX_ERROR_LEN).collect::<String>();
    format!("{truncated}\n[technical details truncated]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_tokens() {
        let message = "Authorization: Bearer sk-test1234567890abcdefghijklmnopqrstuvwxyz";
        let redacted = redact_user_visible_error(message);
        assert!(redacted.contains(REDACTION));
        assert!(!redacted.contains("sk-test1234567890"));
    }

    #[test]
    fn redacts_credential_urls() {
        let message = "fatal: https://user:secret-token@example.com/org/repo.git failed";
        let redacted = redact_user_visible_error(message);
        assert!(redacted.contains("https://[redacted]@example.com"));
        assert!(!redacted.contains("secret-token"));
    }

    #[test]
    fn blocks_non_local_http_base_urls() {
        assert!(validate_http_base_url("http://api.example.com/v1").is_err());
        assert!(validate_http_base_url("http://localhost:11434").is_ok());
        assert!(validate_http_base_url("http://127.0.0.1:11434").is_ok());
        assert!(validate_http_base_url("http://[::1]:11434").is_ok());
        assert!(validate_http_base_url("https://api.example.com/v1").is_ok());
    }
}
