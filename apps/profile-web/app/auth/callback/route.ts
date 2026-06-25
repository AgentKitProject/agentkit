import { handleAuth } from "@workos-inc/authkit-nextjs";
import { getAppUrl } from "@/lib/auth/urls";

export const GET = handleAuth({
  baseURL: getAppUrl(),
  returnPathname: "/account",
});
