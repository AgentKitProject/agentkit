// GET /api/account -> the current AuthKit session user (no secrets).
// On the web the AuthKit cookie session IS the AgentKitProject account; the
// WebForgeClient uses this to report connection state in place of device-auth.
import { withUser } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async (user) => ({
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
  }));
}
