/**
 * Ambient declaration for the OPTIONAL commercial gateway overlay package
 * `@agentkit-commercial/gateway`. It is installed only in the hosted /
 * managed-billing worker image and is ABSENT in the public / self-host build.
 *
 * The worker's `buildBackendDeps` (entrypoints/run-task.ts) dynamically imports
 * it inside try/catch and degrades to the inert FREE credit ledger when it is
 * missing. This declaration gives that import a type without making the package
 * a hard dependency — mirroring gateway-core's `gateway-commercial-module.d.ts`
 * and the auto-web app's `types/commercial.d.ts`.
 *
 * This file adds NO runtime code and does NOT change the public
 * `@agentkitforge/auto-core` export surface — it is type-only.
 */
declare module "@agentkit-commercial/gateway" {
  import type { CreditLedgerRepository, PgPool } from "@agentkitforge/gateway-core";

  /**
   * Builds the managed Postgres credit ledger over a `pg` Pool (the hosted DO
   * Managed Postgres `agentkitgateway`). The worker calls this for the
   * `selfhost + managed` configuration.
   */
  export function createPostgresCreditLedger(pool: PgPool): CreditLedgerRepository;

  /** The credit-ledger Postgres adapter class (also exported by the overlay). */
  export const PostgresCreditLedgerRepository: new (pool: PgPool) => CreditLedgerRepository;
}
