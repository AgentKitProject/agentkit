import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchFailedMessage,
  normalizeProviderConfig,
  parseAgentKitDraftFromProviderText,
  providerErrorMessage,
  resolveModel,
  summarizeJsonForDiagnostics,
  validateProviderConfig,
} from "../src-tauri/backend/generate-agent-kit-draft.mjs";
import * as core from "@agentkitforge/core";

test("provider default model is used when request model is null", () => {
  const provider = normalizeProviderConfig({
    id: "openai-default",
    name: "OpenAI",
    providerType: "openai",
    baseUrl: " https://api.openai.com/v1/ ",
    apiKey: " sk-test ",
    model: null,
    defaultModel: " gpt-5.4-nano ",
  });

  assert.equal(resolveModel(provider, null), "gpt-5.4-nano");
  assert.equal(provider.baseUrl, "https://api.openai.com/v1");
});

test("provider model is preferred over default model", () => {
  const provider = normalizeProviderConfig({
    providerType: "openai",
    apiKey: "sk-test",
    model: "gpt-custom",
    defaultModel: "gpt-default",
  });

  assert.equal(resolveModel(provider, undefined), "gpt-custom");
});

test("missing OpenAI API key is blocked before fetch", () => {
  const provider = normalizeProviderConfig({
    providerType: "openai",
    defaultModel: "gpt-5.4-nano",
    apiKey: "null",
  });

  assert.throws(
    () => validateProviderConfig(provider, resolveModel(provider)),
    /OpenAI API key is missing\. Add it in Settings\./,
  );
});

test("missing OpenAI model is blocked before fetch", () => {
  const provider = normalizeProviderConfig({
    providerType: "openai",
    apiKey: "sk-test",
    model: null,
    defaultModel: "undefined",
  });

  assert.throws(
    () => validateProviderConfig(provider, resolveModel(provider)),
    /OpenAI model is missing\. Select a model in Settings\./,
  );
});

test("OpenAI 401 maps to invalid API key", () => {
  assert.equal(
    providerErrorMessage("OpenAI", 401, JSON.stringify({ error: { message: "bad key" } })),
    "OpenAI API key is invalid. Check the key in Settings.",
  );
});

test("OpenAI 403 maps to account or project access issue", () => {
  assert.equal(
    providerErrorMessage("OpenAI", 403, JSON.stringify({ error: { message: "forbidden" } })),
    "OpenAI request was denied. Check account, project, model, or provider permissions.",
  );
});

test("network request failure includes safe cause", () => {
  const error = new TypeError("fetch failed");
  error.cause = {
    code: "ENOTFOUND",
    message: "getaddrinfo ENOTFOUND api.openai.com",
  };

  assert.equal(
    fetchFailedMessage({ name: "OpenAI" }, error),
    "OpenAI network request failed before receiving an HTTP response. Detail: ENOTFOUND: getaddrinfo ENOTFOUND api.openai.com.",
  );
});

test("network request failure without cause does not show raw fetch failed", () => {
  const error = new TypeError("fetch failed");

  assert.equal(
    fetchFailedMessage({ name: "OpenAI" }, error),
    "OpenAI network request failed before receiving an HTTP response. Detail: TypeError.",
  );
});

test("draft parser ignores schema echo before valid draft", () => {
  const draft = {
    id: "research-assistant",
    name: "Research Assistant",
    description: "Helps users plan and synthesize research.",
    skills: [
      {
        id: "plan-research",
        name: "Plan Research",
        description: "Build a research plan.",
        triggers: ["plan research"],
        riskLevel: "low",
        useWhen: "Use when a user needs a research plan.",
        procedure: "Clarify the topic, identify sources, and outline steps.",
        output: "A concise research plan.",
      },
    ],
  };
  const providerText = [
    "Here is the schema:",
    JSON.stringify({ title: "AgentKitDraft", type: "object", properties: { id: { type: "string" } } }),
    "Here is the draft:",
    JSON.stringify(draft),
  ].join("\n");

  const parsed = parseAgentKitDraftFromProviderText(core, providerText);

  assert.equal(parsed.id, "research-assistant");
  assert.equal(parsed.name, "Research Assistant");
});

test("JSON diagnostics summarize invalid candidate keys", () => {
  assert.equal(
    summarizeJsonForDiagnostics({ title: "AgentKitDraft", type: "object", properties: {} }),
    "object keys=title,type,properties",
  );
});
