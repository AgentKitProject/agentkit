/**
 * Pure token-expiry helpers, ported from `account_auth.rs`.
 *
 * The JWT signature is NOT verified here — that is the Market server's job (via
 * remote JWKS). We only need the unverified `exp` claim to decide whether to
 * refresh proactively.
 */

/**
 * Refresh proactively when the access token is within this many seconds of
 * expiry (or already expired), instead of waiting for a 401.
 */
export const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 60;

/** Current wall-clock time as whole seconds since the Unix epoch. */
export function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Decode a base64url (no-padding) segment to bytes. Returns `null` on any
 * invalid character, mirroring the Rust decoder's strictness.
 */
function base64UrlDecode(input: string): Uint8Array | null {
  const trimmed = input.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed.charCodeAt(i);
    let six: number;
    if (c >= 65 && c <= 90) six = c - 65; // A-Z
    else if (c >= 97 && c <= 122) six = c - 97 + 26; // a-z
    else if (c >= 48 && c <= 57) six = c - 48 + 52; // 0-9
    else if (c === 45) six = 62; // -
    else if (c === 95) six = 63; // _
    else return null;
    buffer = (buffer << 6) | six;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Extract the numeric `exp` (seconds since epoch) claim from a JWT WITHOUT
 * verifying its signature. Returns `null` if the token is malformed or lacks a
 * numeric `exp`.
 */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const bytes = base64UrlDecode(parts[1]);
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (
    typeof json === "object" &&
    json !== null &&
    typeof (json as Record<string, unknown>).exp === "number" &&
    Number.isFinite((json as Record<string, unknown>).exp)
  ) {
    return (json as { exp: number }).exp;
  }
  return null;
}

/**
 * Pure decision: should we refresh now? True when the token is already expired
 * or will expire within `bufferSeconds` of `nowSeconds`. Tokens with no
 * decodable expiry are treated as needing refresh so we never sit on an
 * unknown/expired token.
 */
export function tokenNeedsRefresh(
  expSeconds: number | null,
  nowSeconds: number,
  bufferSeconds: number
): boolean {
  if (expSeconds === null) return true;
  return expSeconds <= nowSeconds + bufferSeconds;
}

/** Convenience: is the JWT access token expired or within the refresh buffer? */
export function isTokenExpired(
  token: string,
  nowSeconds: number = epochSeconds(),
  bufferSeconds: number = ACCESS_TOKEN_REFRESH_BUFFER_SECONDS
): boolean {
  return tokenNeedsRefresh(decodeJwtExp(token), nowSeconds, bufferSeconds);
}
