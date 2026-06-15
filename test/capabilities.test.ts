import { test, expect } from "bun:test";
import {
  supportsImageInput,
  makeCapabilityLookup,
  type ProviderListData,
} from "../src/capabilities";

const fixture: ProviderListData = {
  all: [
    {
      id: "zai",
      models: {
        "glm-4.6": {
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
    {
      id: "openai",
      models: {
        "gpt-4o": {
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
    {
      id: "weird",
      models: {
        "no-modalities": {},
      },
    },
  ],
  default: {},
  connected: [],
};

test("supportsImageInput returns true when model has image input modality", () => {
  expect(supportsImageInput(fixture, "openai", "gpt-4o")).toBe(true);
});

test("supportsImageInput returns false when model has only text input", () => {
  expect(supportsImageInput(fixture, "zai", "glm-4.6")).toBe(false);
});

test("supportsImageInput returns false when model has no modalities key", () => {
  expect(supportsImageInput(fixture, "weird", "no-modalities")).toBe(false);
});

test("supportsImageInput returns false for missing provider", () => {
  expect(supportsImageInput(fixture, "missing", "x")).toBe(false);
});

test("supportsImageInput returns false for missing model", () => {
  expect(supportsImageInput(fixture, "openai", "nonexistent")).toBe(false);
});

test("makeCapabilityLookup memoizes and only calls provider.list once", async () => {
  let callCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        callCount++;
        return { data: fixture, error: undefined };
      },
    },
  };

  const lookup = makeCapabilityLookup(fakeClient as any);

  const first = await lookup("openai", "gpt-4o");
  expect(first).toBe(true);
  expect(callCount).toBe(1);

  const second = await lookup("zai", "glm-4.6");
  expect(second).toBe(false);
  // Should still be 1 because data is cached
  expect(callCount).toBe(1);
});

test("makeCapabilityLookup returns false when provider.list returns error", async () => {
  const fakeClient = {
    provider: {
      list: async () => ({
        data: undefined,
        error: { name: "APIError", message: "fail" },
      }),
    },
  };

  const lookup = makeCapabilityLookup(fakeClient as any);
  const result = await lookup("openai", "gpt-4o");
  expect(result).toBe(false);
});

test("makeCapabilityLookup refetches on cache miss for unknown provider/model", async () => {
  let callCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        callCount++;
        return { data: fixture, error: undefined };
      },
    },
  };

  const lookup = makeCapabilityLookup(fakeClient as any);

  // First call: known provider/model, should fetch
  const first = await lookup("openai", "gpt-4o");
  expect(first).toBe(true);
  expect(callCount).toBe(1);

  // Second call: unknown provider, should refetch
  const second = await lookup("unknown", "x");
  expect(second).toBe(false);
  // Should have refetched: 2 calls now
  expect(callCount).toBe(2);

  // Third call: back to known provider/model, should NOT refetch (it was in the refetched data)
  const third = await lookup("openai", "gpt-4o");
  expect(third).toBe(true);
  expect(callCount).toBe(2);
});
