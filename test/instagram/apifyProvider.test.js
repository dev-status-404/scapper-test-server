import test from "node:test";
import assert from "node:assert/strict";
import {
  assertApifyCostBudget,
  buildApifyInstagramProfileInput,
  chunkUsernames,
  fetchAllApifyDatasetItems,
  normalizeAndDedupeUsernames,
} from "../../src/services/instagram/providers/apifyProfileProvider.js";
import { ProviderCostLimitError } from "../../src/services/instagram/errors.js";

test("normalizeAndDedupeUsernames normalizes and removes duplicate inputs", () => {
  assert.deepEqual(
    normalizeAndDedupeUsernames([
      "@OpenAI",
      "https://instagram.com/openai/",
      "sam.altman",
    ]),
    ["openai", "sam.altman"],
  );
});

test("chunkUsernames chunks inputs with bounded size", () => {
  assert.deepEqual(chunkUsernames(["a", "b", "c", "d", "e"], 2), [
    ["a", "b"],
    ["c", "d"],
    ["e"],
  ]);
});

test("buildApifyInstagramProfileInput converts usernames to profile URLs", () => {
  assert.deepEqual(buildApifyInstagramProfileInput(["openai"]), {
    usernames: ["https://www.instagram.com/openai/"],
  });
});

test("fetchAllApifyDatasetItems paginates until total is fetched", async () => {
  const calls = [];
  const allItems = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const fakeClient = {
    dataset(datasetId) {
      assert.equal(datasetId, "dataset-1");
      return {
        async listItems({ offset, limit }) {
          calls.push({ offset, limit });
          return {
            items: allItems.slice(offset, offset + limit),
            total: allItems.length,
          };
        },
      };
    },
  };

  const result = await fetchAllApifyDatasetItems("dataset-1", {
    client: fakeClient,
    pageSize: 2,
    maxItems: 10,
  });

  assert.equal(result.fetched, 5);
  assert.equal(result.total, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(calls, [
    { offset: 0, limit: 2 },
    { offset: 2, limit: 2 },
    { offset: 4, limit: 2 },
  ]);
});

test("fetchAllApifyDatasetItems respects maxItems and reports truncation", async () => {
  const fakeClient = {
    dataset() {
      return {
        async listItems({ offset, limit }) {
          const allItems = [{ id: 1 }, { id: 2 }, { id: 3 }];
          return {
            items: allItems.slice(offset, offset + limit),
            total: allItems.length,
          };
        },
      };
    },
  };

  const result = await fetchAllApifyDatasetItems("dataset-1", {
    client: fakeClient,
    pageSize: 2,
    maxItems: 2,
  });

  assert.equal(result.fetched, 2);
  assert.equal(result.truncated, true);
});

test("assertApifyCostBudget throws when estimate exceeds job cap", () => {
  assert.throws(
    () =>
      assertApifyCostBudget({
        inputCount: 100,
        maxCostUsd: 1,
        estimatedProfileCostUsd: 0.02,
      }),
    ProviderCostLimitError,
  );
});

