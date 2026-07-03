// GET /api/auto/email-in/availability — whether inbound-email triggers can be
// created on THIS instance (BROWSER / cookie auth).
//
// email_in is HOSTED-only: it needs an operator inbox domain (AUTO_EMAIL_INBOX_
// DOMAIN) so the server can mint `<slug>@<domain>` addresses. Unset (the
// self-host default) → the poller is inert and creating an email_in trigger
// would produce a dead address. The wizard feature-detects with this flag and
// hides/disables the "When an email arrives" card when unavailable — the same
// spirit as the OAuth start route's 501 feature-detection, but as an explicit
// read-only flag (never a create side effect).
//
// Only the boolean availability is exposed — never the domain itself.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { emailInboxDomain } from "@/server/core/auto-events";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUserForApi();
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  // Degrade to "unavailable" on any lookup issue rather than failing the load —
  // the card simply hides (fail closed).
  const available = emailInboxDomain() !== undefined;
  return Response.json({ available }, { status: 200 });
}
