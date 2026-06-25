/**
 * AWS Lambda composition root — Phase 0 STUB.
 *
 * This file will wire the AWS DynamoDB adapters (CreditLedgerRepository +
 * SessionStore) and the Anthropic ChatProvider, then expose an
 * APIGatewayProxyHandler that routes requests to the gateway core router.
 *
 * Phase 0: not yet implemented. This stub exports a placeholder handler so
 * the build graph is valid.
 *
 * Phase 1 work:
 *   - Wire DynamoSessionStore (+ the managed credit ledger from the commercial
 *     package, when managed billing is enabled)
 *   - Wire AnthropicChatProvider (managed key from SSM)
 *   - Wire the core router (to be built in Phase 1)
 *   - Implement APIGatewayProxyEvent → CoreRequest conversion
 */

// Placeholder — will be replaced with a real handler in Phase 1.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error("Gateway Lambda handler: not yet implemented (Phase 0 stub).");
};
