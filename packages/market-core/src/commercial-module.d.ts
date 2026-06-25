/**
 * Ambient declaration for the OPTIONAL commercial overlay package
 * `@agentkit-commercial/market-core`. It is an `optionalDependency`: present on
 * the hosted/commercial build, absent on the free/open-source build. The
 * entrypoints (`entrypoints/lambda`, `entrypoints/server`) dynamically import it
 * inside try/catch; this declaration gives those imports a type without making
 * the package a hard dependency.
 *
 * The commercial package builds a `CommercialRouter` (which owns the Tier-2
 * paid-kit + Stripe-payout routes and the paid-download gate) over its own
 * persistent backend (DynamoDB for hosted, Postgres for self-host). The factory
 * config mirrors the table/connection inputs the public AWS/Postgres adapters use.
 */
declare module '@agentkit-commercial/market-core' {
  import type { CommercialRouter } from '@agentkitforge/market-core';

  /** DynamoDB table-name config for the commercial router (hosted). */
  export interface DynamoCommercialConfig {
    entitlementsTableName: string;
    kitsTableName: string;
    kitVersionsTableName: string;
    organizationsTableName: string;
    orgMembershipsTableName?: string;
    orgInvitesTableName?: string;
    client?: {
      endpoint?: string;
      region?: string;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    };
  }

  /** Builds the DynamoDB-backed commercial router (hosted/Lambda). */
  export function createDynamoCommercialRouter(config: DynamoCommercialConfig): CommercialRouter;

  /** Builds the Postgres-backed commercial router (self-host). Accepts a `pg` Pool. */
  export function createPostgresCommercialRouter(pool: unknown): CommercialRouter;

  /** The commercial Postgres DDL (entitlements table + Tier-2/Stripe columns). */
  export const COMMERCIAL_SCHEMA_SQL: string;

  /** Reads + applies the commercial schema against a `pg` Pool (self-host startup). */
  export function applyCommercialSchema(pool: unknown): Promise<void>;

  /** Commercial route templates, for the entrypoint route matcher. */
  export const COMMERCIAL_ROUTES: Array<{ method: string; template: string }>;
}
