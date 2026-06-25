import { z } from "zod";
import { agentKitDraftSchema, type AgentKitDraft } from "./schema.js";

export interface AgentKitDraftRevision {
  id: string;
  version: number;
  draft: AgentKitDraft;
  changeRequest?: string;
  provider?: string;
  model?: string;
  warnings?: string[];
  createdAt: string;
}

export interface AgentKitDraftSession {
  id: string;
  name: string;
  originalRequest: string;
  currentRevisionId: string;
  revisions: AgentKitDraftRevision[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentKitDraftChangeRequest {
  sessionId?: string;
  currentDraft: AgentKitDraft;
  originalRequest?: string;
  changeRequest: string;
  desiredValidationLevel?: string;
  constraints?: string[];
  sourceNotes?: string[];
}

export interface CreateDraftSessionInput {
  originalRequest: string;
  initialDraft: unknown;
  provider?: string;
  model?: string;
  warnings?: string[];
  name?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface AddDraftRevisionInput {
  draft: unknown;
  changeRequest?: string;
  provider?: string;
  model?: string;
  warnings?: string[];
  now?: Date;
}

export const agentKitDraftRevisionSchema: z.ZodType<AgentKitDraftRevision> = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    draft: agentKitDraftSchema,
    changeRequest: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    warnings: z.array(z.string()).optional(),
    createdAt: z.string().min(1)
  })
  .strict();

export const agentKitDraftSessionSchema: z.ZodType<AgentKitDraftSession> = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    originalRequest: z.string().min(1),
    currentRevisionId: z.string().min(1),
    revisions: z.array(agentKitDraftRevisionSchema).min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export function createDraftSession(input: CreateDraftSessionInput): AgentKitDraftSession {
  const draft = parseDraft(input.initialDraft);
  const timestamp = (input.now ?? new Date()).toISOString();
  const sessionId = `draft-session-${timestampToId(timestamp)}`;
  const revisionId = `${sessionId}-rev-1`;

  return {
    id: sessionId,
    name: input.name ?? draft.name,
    originalRequest: input.originalRequest,
    currentRevisionId: revisionId,
    revisions: [
      {
        id: revisionId,
        version: 1,
        draft,
        provider: input.provider,
        model: input.model,
        warnings: input.warnings,
        createdAt: timestamp
      }
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: input.metadata
  };
}

export function addDraftRevision(
  session: AgentKitDraftSession,
  input: AddDraftRevisionInput
): AgentKitDraftSession {
  const parsedSession = validateDraftSession(session);
  const draft = parseDraft(input.draft);
  const version = Math.max(...parsedSession.revisions.map((revision) => revision.version)) + 1;
  const timestamp = (input.now ?? new Date()).toISOString();
  const revision: AgentKitDraftRevision = {
    id: `${parsedSession.id}-rev-${version}`,
    version,
    draft,
    changeRequest: input.changeRequest,
    provider: input.provider,
    model: input.model,
    warnings: input.warnings,
    createdAt: timestamp
  };

  return {
    ...parsedSession,
    currentRevisionId: revision.id,
    revisions: [...parsedSession.revisions, revision],
    updatedAt: timestamp
  };
}

export function getCurrentDraftRevision(session: AgentKitDraftSession): AgentKitDraftRevision {
  const parsedSession = validateDraftSession(session);
  const revision = parsedSession.revisions.find(
    (entry) => entry.id === parsedSession.currentRevisionId
  );
  if (!revision) {
    throw new Error(`Current draft revision not found: ${parsedSession.currentRevisionId}`);
  }

  return revision;
}

export function restoreDraftRevision(
  session: AgentKitDraftSession,
  revisionId: string,
  now: Date = new Date()
): AgentKitDraftSession {
  const parsedSession = validateDraftSession(session);
  if (!parsedSession.revisions.some((revision) => revision.id === revisionId)) {
    throw new Error(`Draft revision not found: ${revisionId}`);
  }

  return {
    ...parsedSession,
    currentRevisionId: revisionId,
    updatedAt: now.toISOString()
  };
}

export function validateDraftSession(session: unknown): AgentKitDraftSession {
  const parsed = agentKitDraftSessionSchema.safeParse(session);
  if (!parsed.success) {
    throw new Error(
      `Invalid Agent Kit draft session: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return parsed.data;
}

function parseDraft(draft: unknown): AgentKitDraft {
  const parsed = agentKitDraftSchema.safeParse(draft);
  if (!parsed.success) {
    throw new Error(
      `Invalid AgentKitDraft: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return parsed.data;
}

function timestampToId(timestamp: string): string {
  return timestamp.replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}
