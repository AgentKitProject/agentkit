/**
 * Shared top-up preset constants (Gateway 1b-ii).
 * Imported by the API route (server-side enforcement) and the client UI.
 */

/** Allowed top-up amounts in US cents. Enforced server-side by POST /api/credits/topup. */
export const TOP_UP_PRESETS_CENTS = [500, 1000, 2500, 5000] as const;
export type TopUpPresetCents = (typeof TOP_UP_PRESETS_CENTS)[number];
