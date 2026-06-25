import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { getWorkOSRedirectUri } from "@/lib/auth/urls";

export default authkitMiddleware({
  redirectUri: getWorkOSRedirectUri(),
  middlewareAuth: {
    enabled: false,
    unauthenticatedPaths: [],
  },
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
