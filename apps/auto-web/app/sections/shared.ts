// Shared types + utilities for the Auto UI section.
//
// Ported from agentkitforge-web/app/forge/sections/shared.ts, trimmed to ONLY
// the symbols AgentKitAuto needs: `MyKitEntry` (the kit-selector option shape),
// `Notify` (the toast callback), and `errMsg`.
import type { MyKitEntry } from "@/forge-client";

export type Notify = (msg: string, err?: boolean) => void;

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type { MyKitEntry };
