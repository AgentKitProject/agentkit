const REDACTION = "[redacted]";
const MAX_ERROR_LENGTH = 4000;

export function redactUserVisibleError(value) {
  let output = String(value ?? "");
  output = output.replace(/(authorization\s*:\s*)(bearer\s+)?[^\s"',;]+/gi, `$1${REDACTION}`);
  output = output.replace(/(x-api-key\s*:\s*)[^\s"',;]+/gi, `$1${REDACTION}`);
  output = output.replace(/(bearer\s+)[^\s"',;]+/gi, `$1${REDACTION}`);
  output = output.replace(/([?&](?:key|api_key|access_token|token)=)[^&\s"',;]+/gi, `$1${REDACTION}`);
  output = output.replace(/\b(https?:\/\/)([^/\s"'@]+):([^/\s"'@]+)@/gi, `$1${REDACTION}@`);
  output = output.replace(/\b[A-Za-z0-9][A-Za-z0-9._:-]{31,}\b/g, (token) => {
    const hasLetter = /[A-Za-z]/.test(token);
    const hasNumber = /[0-9]/.test(token);
    return hasLetter && hasNumber ? REDACTION : token;
  });

  if (output.length > MAX_ERROR_LENGTH) {
    output = `${output.slice(0, MAX_ERROR_LENGTH)}\n[technical details truncated]`;
  }

  return output;
}

export function normalizeSecureBaseUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Base URL must start with http:// or https://.");
  }
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    throw new Error("Non-local HTTP providers may send prompts and keys without encryption. Use HTTPS or a local address such as localhost, 127.0.0.1, or ::1.");
  }
  return value.replace(/\/+$/, "");
}

function isLocalHost(hostname) {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
