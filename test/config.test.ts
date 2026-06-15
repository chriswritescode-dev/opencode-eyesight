import { test, expect } from "bun:test";
import { parseModel, resolveConfig, DEFAULT_PROMPT } from "../src/config";

test("parseModel splits on first slash", () => {
  expect(parseModel("openai/gpt-4o")).toEqual({
    providerID: "openai",
    modelID: "gpt-4o",
  });
});

test("parseModel preserves extra slashes in modelID", () => {
  expect(parseModel("openrouter/anthropic/claude-3")).toEqual({
    providerID: "openrouter",
    modelID: "anthropic/claude-3",
  });
});

test("parseModel returns undefined when no slash", () => {
  expect(parseModel("nodash")).toBeUndefined();
});

test("parseModel returns undefined when left side is empty", () => {
  expect(parseModel("/x")).toBeUndefined();
});

test("parseModel returns undefined when right side is empty", () => {
  expect(parseModel("x/")).toBeUndefined();
});

test("resolveConfig uses options.model", async () => {
  const config = await resolveConfig({ model: "openai/gpt-4o" }, {});
  expect(config).toBeDefined();
  expect(config!.providerID).toBe("openai");
  expect(config!.modelID).toBe("gpt-4o");
  expect(config!.prompt).toBe(DEFAULT_PROMPT);
  expect(config!.mimePrefixes).toEqual(["image/"]);
});

test("resolveConfig uses custom prompt from options", async () => {
  const config = await resolveConfig(
    { model: "openai/gpt-4o", prompt: "custom" },
    {},
  );
  expect(config).toBeDefined();
  expect(config!.prompt).toBe("custom");
});

test("resolveConfig falls back to env var for model", async () => {
  const config = await resolveConfig(undefined, {
    OPENCODE_VISION_FALLBACK_MODEL: "x/y",
  });
  expect(config).toBeDefined();
  expect(config!.providerID).toBe("x");
  expect(config!.modelID).toBe("y");
});

test("resolveConfig uses promptFile when provided", async () => {
  const config = await resolveConfig(
    { model: "openai/gpt-4o", promptFile: "prompt.md" },
    {},
    async (path) => {
      expect(path).toBe("prompt.md");
      return "\nmarkdown prompt\n";
    },
  );

  expect(config).toBeDefined();
  expect(config!.prompt).toBe("markdown prompt");
});

test("resolveConfig prefers prompt over promptFile", async () => {
  const config = await resolveConfig(
    { model: "openai/gpt-4o", prompt: "inline", promptFile: "prompt.md" },
    {},
    async () => "file",
  );

  expect(config).toBeDefined();
  expect(config!.prompt).toBe("inline");
});

test("resolveConfig returns undefined when no model resolved", async () => {
  expect(await resolveConfig(undefined, {})).toBeUndefined();
});

test("resolveConfig returns undefined for non-string model option", async () => {
  const config = await resolveConfig({ model: 123 as unknown }, {});
  expect(config).toBeUndefined();
});
