import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { getAppUrl, getSignOutReturnUrl, resolveAuthReturnTo, UrlConfigError } from "./url-config.ts";

describe("url-config", () => {
  it("resolves relative returnTo values against the production app URL", () => {
    assert.equal(
      resolveAuthReturnTo("/admin", "https://market.agentkitproject.com"),
      "https://market.agentkitproject.com/admin"
    );
  });

  it("rejects absolute localhost returnTo values in production", () => {
    assert.throws(
      () => resolveAuthReturnTo("http://localhost:3000/admin", "https://market.agentkitproject.com"),
      UrlConfigError
    );
  });

  it("fails production app URL resolution when the app URL is missing", () => {
    assert.throws(() => getAppUrl({ NODE_ENV: "production" }), UrlConfigError);
  });

  it("uses the local app URL in development when no app URL is configured", () => {
    assert.equal(getAppUrl({ NODE_ENV: "development" }), "http://localhost:3000");
  });

  it("uses the production app URL for sign-out return targets", () => {
    assert.equal(
      getSignOutReturnUrl({
        NODE_ENV: "production",
        APP_URL: "https://market.agentkitproject.com"
      }),
      "https://market.agentkitproject.com"
    );
  });

  it("requires APP_URL specifically for production sign-out", () => {
    assert.throws(
      () =>
        getSignOutReturnUrl({
          NODE_ENV: "production",
          NEXT_PUBLIC_APP_URL: "https://market.agentkitproject.com"
        }),
      UrlConfigError
    );
  });

  it("rejects localhost production sign-out return targets", () => {
    assert.throws(
      () =>
        getSignOutReturnUrl({
          NODE_ENV: "production",
          APP_URL: "http://localhost:3000"
        }),
      UrlConfigError
    );
  });

  it("renders sign-out as a plain anchor instead of a prefetched Next link", async () => {
    const header = await readFile(new URL("../components/SiteChrome.tsx", import.meta.url), "utf8");

    // Plain <a> (not next/link) — href may be accompanied by class/role/onClick attributes.
    assert.match(header, /<a\b[^>]*href="\/auth\/sign-out"[^>]*>/);
    assert.doesNotMatch(header, /<Link\b[^>]*href="\/auth\/sign-out"/);
  });

  it("sign-out route uses APP_URL and does not redirect to sign-in", async () => {
    // The sign-out handler now lives in the WorkOS auth provider (the hosted
    // path); the route file is a thin delegate. The behavior is unchanged: use
    // APP_URL, clear AuthKit cookies, full-page redirect, guard prefetch/RSC,
    // never redirect to sign-in. Assert against the provider where it lives.
    const route = await readFile(new URL("../lib/auth-provider/workos-provider.ts", import.meta.url), "utf8");

    assert.match(route, /getSignOutReturnUrl/);
    assert.match(route, /clearAuthKitCookies/);
    assert.match(route, /NextResponse\.redirect\(returnTo\)/);
    assert.match(route, /isPrefetchOrRscRequest/);
    assert.match(route, /new NextResponse\(null,\s*\{\s*status:\s*204\s*\}\)/);
    assert.doesNotMatch(route, /import \{ signOut \} from "@workos-inc\/authkit-nextjs"/);
    assert.doesNotMatch(route, /signOut\(\{ returnTo \}\)/);
    assert.doesNotMatch(route, /sign-in/);
  });
});
