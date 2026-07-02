// GET /api/me/usage -> per-account quota usage snapshot.
// Returns current kit count, total bytes, and the configured limits.
import { withUser } from "@/lib/api";
import { getKitStore } from "@/server/store/local-disk";
import { getQuotaLimits } from "@/server/store/quota";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async (user) => {
    const [store, limits] = await Promise.all([getKitStore(), Promise.resolve(getQuotaLimits())]);
    const usage = await store.getUsage(user.id);
    return {
      kitCount: usage.kitCount,
      kitLimit: limits.maxKits,
      bytes: usage.bytes,
      byteLimit: limits.maxBytes
    };
  });
}
