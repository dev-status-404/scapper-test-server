import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInstagramUsername,
  normalizeExternalUrl,
  normalizeContactData,
} from "../../src/services/instagram/normalizers.js";
import { ProviderInvalidInputError } from "../../src/services/instagram/errors.js";

test("normalizeInstagramUsername handles usernames, handles, and URLs", () => {
  assert.equal(normalizeInstagramUsername("@OpenAI"), "openai");
  assert.equal(normalizeInstagramUsername("Open.AI_123"), "open.ai_123");
  assert.equal(
    normalizeInstagramUsername("https://www.instagram.com/OpenAI/?hl=en"),
    "openai",
  );
  assert.equal(normalizeInstagramUsername("https://instagram.com/openai/"), "openai");
});

test("normalizeInstagramUsername rejects invalid or non-profile URLs", () => {
  assert.throws(
    () => normalizeInstagramUsername("https://example.com/openai"),
    ProviderInvalidInputError,
  );
  assert.throws(
    () => normalizeInstagramUsername("https://instagram.com/p/abc123"),
    ProviderInvalidInputError,
  );
  assert.throws(() => normalizeInstagramUsername("bad username"), ProviderInvalidInputError);
});

test("normalizeExternalUrl normalizes http URLs and rejects invalid values", () => {
  assert.equal(normalizeExternalUrl("example.com/path#section"), "https://example.com/path");
  assert.equal(normalizeExternalUrl("https://example.com/?a=1"), "https://example.com/?a=1");
  assert.equal(normalizeExternalUrl("not a url"), null);
});

test("normalizeContactData lowercases and dedupes contacts", () => {
  assert.deepEqual(
    normalizeContactData({
      emails: ["A@Example.com", "a@example.com", ""],
      phones: [" +1 555 ", "+1 555"],
    }),
    {
      emails: ["a@example.com"],
      phone_numbers: ["+1 555"],
    },
  );
});

