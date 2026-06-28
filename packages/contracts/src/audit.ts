import { z } from "zod";

/**
 * AgentKitMarket Audit Log contracts.
 *
 * An append-only record of significant mutations across the Market. Records are
 * never updated or deleted. The canonical store lives in the Market backend;
 * audit is admin-only — there is no public or Forge-facing route.
 *
 * Route builders:
 *   marketBackendAuditRoutes — Seam B (market-app ↔ infra, admin-key)
 *   browserAuditRoutes       — market-app browser (AuthKit cookie, admin only)
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const auditActorTypeSchema = z.enum(["user", "admin", "system"]);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

export const auditTargetTypeSchema = z.enum([
  "submission",
  "kit",
  "org",
  "membership",
  "entitlement",
  "favorite"
]);
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

export const auditActionSchema = z.enum([
  // submission lifecycle
  "submission.created",
  "submission.validated",
  "submission.approved",
  "submission.rejected",
  "submission.archived",
  "submission.canceled",
  "submission.published",
  // kit lifecycle
  "kit.published",
  "kit.hidden",
  "kit.unhidden",
  "kit.removed",
  "kit.pricing_set",
  "kit.visibility_set",
  "kit.transferred",
  // org lifecycle
  "org.created",
  "org.member_added",
  "org.member_removed",
  "org.invite_created",
  "org.invite_accepted",
  "org.deleted",
  // entitlement lifecycle
  "entitlement.granted",
  "entitlement.revoked",
  "entitlement.subscription_status_set"
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

// ---------------------------------------------------------------------------
// Object schema
// ---------------------------------------------------------------------------

/** Small JSON record for context (e.g. {fromStatus,toStatus} or {priceCents}). */
export const auditMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export const auditEventSchema = z.object({
  auditId: z.string().min(1),
  timestamp: z.string(),
  actorUserId: z.string().min(1),
  actorEmail: z.string().optional(),
  actorType: auditActorTypeSchema,
  action: auditActionSchema,
  targetType: auditTargetTypeSchema,
  targetId: z.string().min(1),
  orgId: z.string().optional(),
  metadata: auditMetadataSchema.optional(),
  ip: z.string().optional()
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// ---------------------------------------------------------------------------
// List request / response
// ---------------------------------------------------------------------------

export const listAuditLogsQuerySchema = z.object({
  actorUserId: z.string().min(1).optional(),
  targetType: auditTargetTypeSchema.optional(),
  targetId: z.string().min(1).optional(),
  action: auditActionSchema.optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  nextToken: z.string().optional()
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export const listAuditLogsResponseSchema = z.object({
  items: z.array(auditEventSchema),
  nextToken: z.string().optional()
});
export type ListAuditLogsResponse = z.infer<typeof listAuditLogsResponseSchema>;

// ---------------------------------------------------------------------------
// Route builders (Seam B — market-app ↔ agentkitmarket-infra, admin-key auth)
// ---------------------------------------------------------------------------

export const marketBackendAuditRoutes = {
  /** GET /admin/audit-logs?actorUserId&targetType&targetId&action&since&until&limit&nextToken */
  adminListAuditLogs: () => "/admin/audit-logs"
} as const;

// ---------------------------------------------------------------------------
// Route builders (market-app browser — AuthKit cookie, admin only)
// ---------------------------------------------------------------------------

export const browserAuditRoutes = {
  /** GET /api/admin/audit-logs */
  auditLogs: () => "/api/admin/audit-logs"
} as const;
