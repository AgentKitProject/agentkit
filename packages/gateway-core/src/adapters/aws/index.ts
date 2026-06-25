/**
 * AWS adapter for the gateway core.
 *
 * Implements:
 *   - SessionStore            over DynamoDB (TTL attribute `expiresAt`)
 *
 * (The managed DynamoDB credit ledger lives in the commercial package;
 *  this public adapter provides session storage for both the free/BYO path
 *  and the hosted deployment.)
 *
 * Table design (mirrors agentkitmarket-infra CDK key schema patterns):
 *
 *   GatewaySessions        PK: sessionId  (TTL: expiresAt)
 *
 * All table names are injected at construction (from env via ConfigProvider)
 * so they can differ between environments.
 */

import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SessionStore } from "../../core/ports.js";
import type {
  AppendSessionMessagesInput,
  ConversationMessage,
  CreateSessionInput,
  GatewaySession,
  TurnState,
} from "../../core/types.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// DynamoDB client factory
// ---------------------------------------------------------------------------

export interface DynamoTableNames {
  creditAccounts: string;
  creditTxns: string;
  creditHolds: string;
  sessions: string;
}

/**
 * Canonical env-var names for the four gateway DynamoDB tables. The CDK stack
 * (agentkitgateway-infra) CfnOutputs these names and the Lambda composition root
 * injects them via these env vars — keep this mapping the single source of truth.
 *
 *   GATEWAY_CREDIT_ACCOUNTS_TABLE  →  creditAccounts  (PK userId)
 *   GATEWAY_CREDIT_TXNS_TABLE      →  creditTxns      (PK userId, SK sk = "createdAt#transactionId")
 *   GATEWAY_CREDIT_HOLDS_TABLE     →  creditHolds     (PK holdId)
 *   GATEWAY_SESSIONS_TABLE         →  sessions        (PK sessionId, TTL expiresAt)
 */
export const GATEWAY_TABLE_ENV_VARS = {
  creditAccounts: "GATEWAY_CREDIT_ACCOUNTS_TABLE",
  creditTxns: "GATEWAY_CREDIT_TXNS_TABLE",
  creditHolds: "GATEWAY_CREDIT_HOLDS_TABLE",
  sessions: "GATEWAY_SESSIONS_TABLE",
} as const;

/**
 * Resolves the four gateway table names from environment variables.
 * Throws if any is missing so the Lambda fails fast on misconfiguration.
 */
export function loadDynamoTableNames(
  env: Record<string, string | undefined> = process.env,
): DynamoTableNames {
  const resolve = (key: string): string => {
    const value = env[key];
    if (!value || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };
  return {
    creditAccounts: resolve(GATEWAY_TABLE_ENV_VARS.creditAccounts),
    creditTxns: resolve(GATEWAY_TABLE_ENV_VARS.creditTxns),
    creditHolds: resolve(GATEWAY_TABLE_ENV_VARS.creditHolds),
    sessions: resolve(GATEWAY_TABLE_ENV_VARS.sessions),
  };
}

export function createDynamoDBDocumentClient(config?: DynamoDBClientConfig): DynamoDBDocumentClient {
  const client = new DynamoDBClient(config ?? {});
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

// ---------------------------------------------------------------------------
// DynamoDB Session Store
// ---------------------------------------------------------------------------

export class DynamoSessionStore implements SessionStore {
  private readonly db: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(db: DynamoDBDocumentClient, tableName: string) {
    this.db = db;
    this.tableName = tableName;
  }

  async createSession(input: CreateSessionInput): Promise<GatewaySession> {
    const sessionId = randomUUID();
    const session: GatewaySession = {
      sessionId,
      userId: input.userId,
      kitId: input.kitId,
      kitSlug: input.kitSlug,
      systemPromptRef: input.systemPromptRef,
      billingMode: input.billingMode,
      byoProviderConfig: input.byoProviderConfig,
      messages: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
    await this.db.send(
      new PutCommand({ TableName: this.tableName, Item: session }),
    );
    return session;
  }

  async getSession(sessionId: string): Promise<GatewaySession | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { sessionId } }),
    );
    const item = result.Item as GatewaySession | undefined;
    if (!item) return undefined;
    // Soft-expire: check TTL client-side (DynamoDB TTL sweeper may be delayed).
    if (item.expiresAt < Math.floor(Date.now() / 1000)) return undefined;
    return item;
  }

  async appendMessages(input: AppendSessionMessagesInput): Promise<GatewaySession> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { sessionId: input.sessionId },
        UpdateExpression:
          "SET messages = list_append(if_not_exists(messages, :empty), :newMsgs), updatedAt = :now",
        ExpressionAttributeValues: {
          ":empty": [] as ConversationMessage[],
          ":newMsgs": input.messages,
          ":now": input.updatedAt,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as GatewaySession;
  }

  async replaceMessages(
    sessionId: string,
    messages: ConversationMessage[],
    updatedAt: string,
  ): Promise<GatewaySession> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: "SET messages = :msgs, updatedAt = :now",
        ExpressionAttributeValues: { ":msgs": messages, ":now": updatedAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as GatewaySession;
  }

  async setTurnState(
    sessionId: string,
    turnState: TurnState,
    updatedAt: string,
  ): Promise<GatewaySession> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: "SET turnState = :ts, updatedAt = :now",
        ExpressionAttributeValues: { ":ts": turnState, ":now": updatedAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as GatewaySession;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { sessionId } }),
    );
  }
}
