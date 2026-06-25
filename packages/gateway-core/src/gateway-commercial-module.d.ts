/**
 * Ambient declaration for the OPTIONAL commercial gateway overlay package
 * `@agentkit-commercial/gateway`. It is an `optionalDependency`: present on the
 * hosted/managed-billing build, absent on the free/self-host/BYO build. The
 * hosted gateway composition root dynamically imports it inside try/catch; this
 * declaration gives that import a type without making the package a hard
 * dependency (mirrors market-core's `commercial-module.d.ts`).
 *
 * This file adds NO runtime code and does NOT change the public
 * `@agentkitforge/gateway-core` export surface — it is type-only.
 *
 * Managed billing is HOSTED-ONLY: self-host is BYO-key with no credit gateway,
 * so this overlay is never loaded by a self-hosted deployment.
 *
 * The overlay implements the public `CreditLedgerRepository` port over the
 * hosted DO Managed Postgres `agentkitgateway` database and ships the
 * credit-ledger DDL so the composition root can apply it at startup (alongside
 * the public gateway-core session schema, under an advisory lock).
 */
declare module '@agentkit-commercial/gateway' {
  import type { CreditLedgerRepository, PgPool } from '@agentkitforge/gateway-core';

  /**
   * Builds the managed Postgres credit ledger over a `pg` Pool (the hosted DO
   * Managed Postgres `agentkitgateway`). Parallels
   * `createPostgresCommercialRouter` in the market overlay.
   */
  export function createPostgresCreditLedger(pool: PgPool): CreditLedgerRepository;

  /**
   * The credit-ledger DDL (gateway_credit_accounts / _txns / _holds) as a
   * string. Idempotent; applied at startup under an advisory lock alongside the
   * gateway-core session schema. Parallels `COMMERCIAL_SCHEMA_SQL`.
   */
  export const GATEWAY_LEDGER_SCHEMA_SQL: string;

  /**
   * Applies the credit-ledger schema against a `pg` Pool. Parallels
   * `applyCommercialSchema`.
   */
  export function applyCreditLedgerSchema(pool: PgPool): Promise<void>;
}
