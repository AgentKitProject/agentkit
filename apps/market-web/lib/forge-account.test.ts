import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ForgeAccountError, resolveForgeSubmissionAccount } from "./forge-account.ts";

describe("forge account resolution", () => {
  it("resolves canonical account email from WorkOS using the verified user id", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const restore = mockFetch(async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization")
      });

      return jsonResponse({ id: "user_forge", email: "forge@example.com" });
    });
    const env = setWorkOsEnv();

    try {
      const account = await resolveForgeSubmissionAccount({ id: "user_forge" });

      assert.deepEqual(account, { id: "user_forge", email: "forge@example.com" });
      assert.equal(calls[0]?.url, "http://127.0.0.1:9999/user_management/users/user_forge");
      assert.equal(calls[0]?.authorization, "Bearer sk_test_account_lookup");
    } finally {
      restore();
      env.restore();
    }
  });

  it("requires the WorkOS account to have an email for hosted Market submission", async () => {
    const restore = mockFetch(async () => jsonResponse({ id: "user_forge" }));
    const env = setWorkOsEnv();

    try {
      await assert.rejects(
        () => resolveForgeSubmissionAccount({ id: "user_forge" }),
        (error) => error instanceof ForgeAccountError && error.code === "ACCOUNT_EMAIL_MISSING"
      );
    } finally {
      restore();
      env.restore();
    }
  });

  it("fails closed when WorkOS API key is not configured", async () => {
    const previousApiKey = process.env.WORKOS_API_KEY;
    delete process.env.WORKOS_API_KEY;

    try {
      await assert.rejects(
        () => resolveForgeSubmissionAccount({ id: "user_forge" }),
        (error) => error instanceof ForgeAccountError && error.code === "ACCOUNT_CONFIG_ERROR"
      );
    } finally {
      restoreEnv("WORKOS_API_KEY", previousApiKey);
    }
  });
});

function mockFetch(handler: typeof fetch) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;

  return () => {
    globalThis.fetch = previous;
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function setWorkOsEnv() {
  const previousApiKey = process.env.WORKOS_API_KEY;
  const previousHostname = process.env.WORKOS_API_HOSTNAME;
  const previousHttps = process.env.WORKOS_API_HTTPS;
  const previousPort = process.env.WORKOS_API_PORT;

  process.env.WORKOS_API_KEY = "sk_test_account_lookup";
  process.env.WORKOS_API_HOSTNAME = "127.0.0.1:9999";
  process.env.WORKOS_API_HTTPS = "false";
  delete process.env.WORKOS_API_PORT;

  return {
    restore() {
      restoreEnv("WORKOS_API_KEY", previousApiKey);
      restoreEnv("WORKOS_API_HOSTNAME", previousHostname);
      restoreEnv("WORKOS_API_HTTPS", previousHttps);
      restoreEnv("WORKOS_API_PORT", previousPort);
    }
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") {
    process.env[key] = value;
    return;
  }

  delete process.env[key];
}
