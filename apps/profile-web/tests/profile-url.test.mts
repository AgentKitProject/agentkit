import assert from "node:assert/strict";
import test from "node:test";
import { joinProfileApiUrl } from "../lib/profile/url.ts";

const expectedUrl = "https://glz766c120.execute-api.us-east-1.amazonaws.com/prod/me";

test("preserves stage for trailing slash base and leading slash path", () => {
  assert.equal(
    joinProfileApiUrl("https://glz766c120.execute-api.us-east-1.amazonaws.com/prod/", "/me").toString(),
    expectedUrl,
  );
});

test("preserves stage for trailing slash base and relative path", () => {
  assert.equal(
    joinProfileApiUrl("https://glz766c120.execute-api.us-east-1.amazonaws.com/prod/", "me").toString(),
    expectedUrl,
  );
});

test("preserves stage for base without trailing slash and leading slash path", () => {
  assert.equal(
    joinProfileApiUrl("https://glz766c120.execute-api.us-east-1.amazonaws.com/prod", "/me").toString(),
    expectedUrl,
  );
});

test("preserves stage for base without trailing slash and relative path", () => {
  assert.equal(
    joinProfileApiUrl("https://glz766c120.execute-api.us-east-1.amazonaws.com/prod", "me").toString(),
    expectedUrl,
  );
});

test("preserves stage for nested public profile handle paths", () => {
  assert.equal(
    joinProfileApiUrl(
      "https://glz766c120.execute-api.us-east-1.amazonaws.com/prod/",
      "/profiles/handle/example",
    ).toString(),
    "https://glz766c120.execute-api.us-east-1.amazonaws.com/prod/profiles/handle/example",
  );
});
