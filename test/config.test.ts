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

test("resolveConfig uses options.model", () => {
  const config = resolveConfig({ model: "openai/gpt-4o" }, {});
  expect(config).toBeDefined();
  expect(config!.providerID).toBe("openai");
  expect(config!.modelID).toBe("gpt-4o");
  expect(config!.prompt).toBe(DEFAULT_PROMPT);
  expect(config!.mimePrefixes).toEqual(["image/"]);
});

test("resolveConfig uses custom prompt from options", () => {
  const config = resolveConfig(
    { model: "openai/gpt-4o", prompt: "custom" },
    {},
  );
  expect(config).toBeDefined();
  expect(config!.prompt).toBe("custom");
});

test("resolveConfig falls back to env var for model", () => {
  const config = resolveConfig(undefined, {
    OPENCODE_VISION_FALLBACK_MODEL: "x/y",
  });
  expect(config).toBeDefined();
  expect(config!.providerID).toBe("x");
  expect(config!.modelID).toBe("y");
});

test("resolveConfig returns undefined when no model resolved", () => {
  expect(resolveConfig(undefined, {})).toBeUndefined();
});

test("resolveConfig returns undefined for non-string model option", () => {
  const config = resolveConfig({ model: 123 as unknown }, {});
  expect(config).toBeUndefined();
});
