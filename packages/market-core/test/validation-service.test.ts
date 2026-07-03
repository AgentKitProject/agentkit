/**
 * Unit tests for the extracted validation service (`runValidationJob`), using a
 * fake ObjectStore + a fake AdminRepository so the test needs no cloud SDK and
 * no external services. Asserts the sha256 + the job/submission updates match the
 * infra validation worker's behavior.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { runValidationJob } from '../src/core/services/validation.js';
import type {
  ObjectStore,
  ValidationJobMessage,
  ValidationJobUpdate,
  SubmissionValidationUpdate,
} from '../src/core/ports.js';

function fakeObjectStore(contents: Map<string, Uint8Array>): ObjectStore {
  return {
    createUploadUrl: async (key) => `upload:${key}`,
    createDownloadUrl: async (key) => `download:${key}`,
    exists: async (key) => contents.has(key),
    readStream: async (key) => {
      const bytes = contents.get(key);
      if (!bytes) {
        throw new Error(`Object not found: ${key}`);
      }
      // Yield in two chunks to exercise streaming.
      const mid = Math.floor(bytes.length / 2);
      async function* gen(): AsyncGenerator<Uint8Array> {
        yield bytes.subarray(0, mid);
        yield bytes.subarray(mid);
      }
      return gen();
    },
  };
}

interface RecordedAdmin {
  jobUpdates: Array<{ jobId: string; update: ValidationJobUpdate }>;
  submissionUpdates: Array<{ submissionId: string; update: SubmissionValidationUpdate }>;
}

function fakeAdmin(recorded: RecordedAdmin) {
  return {
    updateValidationJob: async (jobId: string, update: ValidationJobUpdate) => {
      recorded.jobUpdates.push({ jobId, update });
    },
    updateSubmissionValidationResult: async (submissionId: string, update: SubmissionValidationUpdate) => {
      recorded.submissionUpdates.push({ submissionId, update });
    },
  // The service only calls these two methods; cast through unknown for the rest.
  } as unknown as Parameters<typeof runValidationJob>[1]['admin'];
}

const message: ValidationJobMessage = {
  jobId: 'validation_job_1',
  submissionId: 'submission_1',
  kitId: 'kit_1',
  packageKey: 'submissions/submission_1/package.agentkit.zip',
};

describe('runValidationJob', () => {
  it('passes a valid package and records sha256 + size on job and submission', async () => {
    const payload = new TextEncoder().encode('hello agent kit package bytes');
    const expectedSha = createHash('sha256').update(payload).digest('hex');
    const objectStore = fakeObjectStore(new Map([[message.packageKey, payload]]));
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };

    await runValidationJob(message, { objectStore, admin: fakeAdmin(recorded) });

    // First job update marks it running.
    expect(recorded.jobUpdates[0]!.update.status).toBe('running');
    // Final job update carries the passed summary.
    const finalJob = recorded.jobUpdates.at(-1)!;
    expect(finalJob.jobId).toBe('validation_job_1');
    expect(finalJob.update.status).toBe('passed');
    const jobSummary = finalJob.update.result as { sha256?: string; packageSizeBytes?: number };
    expect(jobSummary.sha256).toBe(expectedSha);
    expect(jobSummary.packageSizeBytes).toBe(payload.byteLength);

    // Submission update reflects validation_passed + the same sha256/size.
    expect(recorded.submissionUpdates).toHaveLength(1);
    const sub = recorded.submissionUpdates[0]!;
    expect(sub.submissionId).toBe('submission_1');
    expect(sub.update.status).toBe('validation_passed');
    expect(sub.update.validationStatus).toBe('passed');
    expect(sub.update.sha256).toBe(expectedSha);
    expect(sub.update.packageSizeBytes).toBe(payload.byteLength);
    expect(sub.update.contentType).toBe('application/zip');
  });

  it('fails an empty package without a sha256', async () => {
    const objectStore = fakeObjectStore(new Map([[message.packageKey, new Uint8Array(0)]]));
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };

    await runValidationJob(message, { objectStore, admin: fakeAdmin(recorded) });

    const finalJob = recorded.jobUpdates.at(-1)!;
    expect(finalJob.update.status).toBe('failed');
    const sub = recorded.submissionUpdates[0]!;
    expect(sub.update.status).toBe('validation_failed');
    expect(sub.update.validationStatus).toBe('failed');
    expect(sub.update.sha256).toBeUndefined();
  });

  it('fails when the package key has the wrong shape', async () => {
    const badMessage: ValidationJobMessage = { ...message, packageKey: 'submissions/x/other.zip' };
    const objectStore = fakeObjectStore(new Map());
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };

    await runValidationJob(badMessage, { objectStore, admin: fakeAdmin(recorded) });

    const finalJob = recorded.jobUpdates.at(-1)!;
    expect(finalJob.update.status).toBe('failed');
    const summary = finalJob.update.result as { checks: string[] };
    expect(summary.checks).toContain('package-key-shape');
  });

  it('writes a safe-error summary when the object read throws', async () => {
    const objectStore = fakeObjectStore(new Map()); // key absent -> readStream throws
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };

    await runValidationJob(message, { objectStore, admin: fakeAdmin(recorded) });

    const finalJob = recorded.jobUpdates.at(-1)!;
    expect(finalJob.update.status).toBe('failed');
    const summary = finalJob.update.result as { checks: string[] };
    expect(summary.checks).toContain('safe-error-summary');
    expect(recorded.submissionUpdates[0]!.update.status).toBe('validation_failed');
  });
});

describe('runValidationJob — suggested automations extraction', () => {
  it('extracts automations via the injected seam, schema-filters them, and rides the summary', async () => {
    const payload = new TextEncoder().encode('zip-bytes');
    const objectStore = fakeObjectStore(new Map([[message.packageKey, payload]]));
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };
    const seen: Uint8Array[] = [];
    const extractAutomations = async (bytes: Uint8Array) => {
      seen.push(bytes);
      return [
        {
          name: 'Daily digest',
          trigger: { type: 'schedule', config: { cron: '0 9 * * *' } },
          promptTemplate: 'Summarize the day.'
        },
        // Smuggled fields must be rejected by the strict contracts schema →
        // the WHOLE array fails safeParse → omitted... so instead assert the
        // strictness separately below with a second run.
      ];
    };

    await runValidationJob(message, { objectStore, admin: fakeAdmin(recorded), extractAutomations });

    // The extractor received the exact streamed bytes.
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!).toString()).toBe('zip-bytes');

    const finalJob = recorded.jobUpdates.at(-1)!;
    expect(finalJob.update.status).toBe('passed');
    const summary = finalJob.update.result as { automations?: unknown[] };
    expect(summary.automations).toHaveLength(1);
    expect((summary.automations![0] as { name: string }).name).toBe('Daily digest');
    // The submission update carries the same summary object (publish copies it on).
    const sub = recorded.submissionUpdates[0]!.update as { validationSummary?: { automations?: unknown[] } };
    expect(sub.validationSummary?.automations).toHaveLength(1);
  });

  it('rejects smuggled fields (strict schema) and omits the automations field entirely', async () => {
    const payload = new TextEncoder().encode('zip-bytes');
    const objectStore = fakeObjectStore(new Map([[message.packageKey, payload]]));
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };
    const extractAutomations = async () => [
      {
        name: 'Sneaky',
        trigger: { type: 'schedule' },
        promptTemplate: 'x',
        approvalId: 'appr-1' // smuggling attempt — strict schema must reject
      }
    ];

    await runValidationJob(message, { objectStore, admin: fakeAdmin(recorded), extractAutomations });

    const summary = recorded.jobUpdates.at(-1)!.update.result as { automations?: unknown[]; status: string };
    expect(summary.status).toBe('passed'); // extraction failure never fails the job
    expect(summary.automations).toBeUndefined();
  });

  it('default extractor on non-zip bytes → no automations field, job still passes', async () => {
    const payload = new TextEncoder().encode('definitely not a zip');
    const objectStore = fakeObjectStore(new Map([[message.packageKey, payload]]));
    const recorded: RecordedAdmin = { jobUpdates: [], submissionUpdates: [] };

    await runValidationJob(message, { objectStore, admin: fakeAdmin(recorded) });

    const summary = recorded.jobUpdates.at(-1)!.update.result as { automations?: unknown[]; status: string };
    expect(summary.status).toBe('passed');
    expect(summary.automations).toBeUndefined();
  });
});
