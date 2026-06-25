/**
 * Commercial bridge — optional Stripe/payments + entitlement/licensing layer.
 *
 * The PUBLIC market-web app ships ONLY the free path (browse catalog, free kit
 * download). The paid-kit checkout/webhook/entitlement/payout route logic and
 * the paid-kit UI live in the PRIVATE `@agentkit-commercial/market-web` package,
 * which is an OPTIONAL dependency. When that package is absent (the open-source
 * build, any self-hoster), every commercial route is inert: it returns HTTP 503
 * `{ error: "commerce_disabled" }`. The `stripe` npm dep lives there too, so the
 * public build never needs it.
 *
 * NEXT_PUBLIC_COMMERCE_ENABLED gates the optional re-introduction of moved UI in
 * client/server components (via next/dynamic) so the public bundle never tries
 * to resolve the moved components when commerce is off.
 */

/** Module specifier for the optional commercial package. */
const COMMERCIAL_MODULE = "@agentkit-commercial/market-web";

/** Standard inert response when the commercial package is not installed. */
export function commerceDisabledResponse(): Response {
  return new Response(JSON.stringify({ error: "commerce_disabled" }), {
    status: 503,
    headers: { "Content-Type": "application/json" }
  });
}

/** True when the hosted/commercial layer is enabled (UI gate). */
export function isCommerceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COMMERCE_ENABLED === "1";
}

type RouteHandler = (request: Request, ...params: string[]) => Promise<Response> | Response;

/**
 * Resolve a named route handler from the optional commercial package and run
 * it. If the package is not installed (or the export is missing), return the
 * standard inert 503 so the public app builds and runs without it.
 *
 * @param exportName the named handler export from `@agentkit-commercial/market-web`
 */
export function commercialHandlerOr503(exportName: string) {
  return async (request: Request, ...params: string[]): Promise<Response> => {
    let mod: Record<string, unknown> | undefined;
    try {
      // Optional dependency: absent on the public/self-host/free build. The
      // dynamic specifier keeps Next from hard-resolving it at build time.
      mod = (await import(/* webpackIgnore: true */ COMMERCIAL_MODULE)) as Record<string, unknown>;
    } catch {
      return commerceDisabledResponse();
    }
    const handler = mod?.[exportName] as RouteHandler | undefined;
    if (typeof handler !== "function") {
      return commerceDisabledResponse();
    }
    return handler(request, ...params);
  };
}
