import { z } from "zod";

/**
 * Schema for environments.json — the public service-domain manifest.
 * API Gateway base URLs are environment-specific infrastructure and are NOT
 * part of the published manifest; services read those from their own env.
 */
export const serviceManifestSchema = z.object({
  marketApp: z.string().url(),
  profileApp: z.string().url(),
  forgeSite: z.string().url(),
  projectSite: z.string().url()
});

export type ServiceManifest = z.infer<typeof serviceManifestSchema>;
