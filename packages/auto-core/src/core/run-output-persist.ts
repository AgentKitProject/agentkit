/**
 * Persisted run outputs (event-driven expansion) — the worker-harness step
 * that uploads a terminal run's workspace files into the durable OutputStore
 * and stamps the run's `outputFiles` manifest.
 *
 * BOUNDED: at most RUN_OUTPUT_MAX_FILES files, RUN_OUTPUT_FILE_MAX_BYTES per
 * file, RUN_OUTPUT_TOTAL_MAX_BYTES total. Anything over a cap is SKIPPED and
 * audit-logged (never fatal). Retention: `expiresAt` = now + RUN_OUTPUT_TTL_MS
 * is stamped on every manifest entry (bucket lifecycle rules enforce actual
 * expiry where available; the manifest carries the deadline regardless).
 *
 * DEPLOY-SAFE: this step only runs when an OutputStore is configured — the
 * worker skips it silently otherwise and the run manifest stays
 * `result.files`-only.
 *
 * S2: output persistence touches ONLY the run's own workspace files — no
 * connection credentials are involved here (destination copying is a separate
 * harness step; see destination-executor.ts).
 */

import type { AutoRunRepository, OutputStore, WorkspaceStore } from "./ports.js";
import type { AutoRunOutputFile, WorkspaceFileEntry } from "./types.js";

/** Max files persisted per run (over-cap files are skipped + audited). */
export const RUN_OUTPUT_MAX_FILES = 50;

/** Max bytes for a single persisted output file (10 MB). */
export const RUN_OUTPUT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Max total bytes persisted per run (50 MB). */
export const RUN_OUTPUT_TOTAL_MAX_BYTES = 50 * 1024 * 1024;

/** Persisted-output retention (30 days) — stamped as `expiresAt`. */
export const RUN_OUTPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PersistRunOutputsArgs {
  runId: string;
  workspaceId: string;
  /** The terminal workspace manifest (result.files). */
  files: WorkspaceFileEntry[];
  deps: {
    workspace: WorkspaceStore;
    outputStore: OutputStore;
    /** Manifest write (setOutputFiles) + skip audit entries. */
    runs: AutoRunRepository;
  };
  /** Clock — ISO 8601. Injected; never an argless Date. */
  now: () => string;
}

/**
 * Uploads the run's workspace files to the OutputStore (bounded) and writes
 * the run's `outputFiles` manifest. BEST-EFFORT: never throws — a storage
 * hiccup is audited and the run's terminal status is unaffected. Returns the
 * manifest that was written ([] when nothing was persisted).
 */
export async function persistRunOutputs(args: PersistRunOutputsArgs): Promise<AutoRunOutputFile[]> {
  const { runId, workspaceId, files, deps, now } = args;
  const { workspace, outputStore, runs } = deps;

  const audit = async (detail: string): Promise<void> => {
    await runs
      .appendAudit(runId, {
        tool: "output_persist",
        argsSummary: `runId=${runId}`,
        outcome: "rejected",
        ts: now(),
        detail,
      })
      .catch(() => {});
  };

  const manifest: AutoRunOutputFile[] = [];
  const expiresAt = new Date(Date.parse(now()) + RUN_OUTPUT_TTL_MS).toISOString();
  let totalBytes = 0;
  let persisted = 0;

  try {
    for (const entry of files) {
      if (persisted >= RUN_OUTPUT_MAX_FILES) {
        await audit(
          `Skipped remaining output files: per-run file cap (${RUN_OUTPUT_MAX_FILES}) reached.`,
        );
        break;
      }
      if (entry.sizeBytes > RUN_OUTPUT_FILE_MAX_BYTES) {
        await audit(
          `Skipped output "${entry.path}": ${entry.sizeBytes} bytes exceeds the per-file cap (${RUN_OUTPUT_FILE_MAX_BYTES}).`,
        );
        continue;
      }
      if (totalBytes + entry.sizeBytes > RUN_OUTPUT_TOTAL_MAX_BYTES) {
        await audit(
          `Skipped output "${entry.path}": total persisted bytes would exceed the per-run cap (${RUN_OUTPUT_TOTAL_MAX_BYTES}).`,
        );
        continue;
      }
      try {
        const content = await workspace.readFile(workspaceId, entry.path);
        const bytes = Buffer.from(content, "utf8");
        const storeKey = await outputStore.putRunOutput(runId, entry.path, bytes);
        totalBytes += entry.sizeBytes;
        persisted += 1;
        manifest.push({ path: entry.path, sizeBytes: entry.sizeBytes, storeKey, expiresAt });
      } catch (err) {
        await audit(
          `Failed to persist output "${entry.path}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (manifest.length > 0 && runs.setOutputFiles) {
      await runs.setOutputFiles(runId, manifest);
    }
  } catch (err) {
    // Defensive: output persistence must never affect the run outcome.
    await audit(
      `Output persistence aborted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return manifest;
}
