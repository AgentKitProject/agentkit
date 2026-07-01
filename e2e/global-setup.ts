import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STORAGE_STATE_PATH = "auth/state.json";
const EMPTY_STATE = JSON.stringify({ cookies: [], origins: [] });

// If a Playwright storageState JSON is supplied via the E2E_STORAGE_STATE_JSON
// secret (a dedicated test user's captured session), materialize it so the
// `authed` project can reuse the session WITHOUT automating the WorkOS login
// form or ever handling a password in CI. When absent, write an EMPTY state so
// the file always resolves (Playwright errors on a missing storageState path)
// and the authed specs self-skip via `hasRealSession()`.
export default function globalSetup(): void {
  const json = process.env.E2E_STORAGE_STATE_JSON?.trim();
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(STORAGE_STATE_PATH, json || EMPTY_STATE, { encoding: "utf8" });
}

// True only when a real captured session was supplied (not the empty fallback).
export function hasRealSession(): boolean {
  return Boolean(process.env.E2E_STORAGE_STATE_JSON?.trim());
}
