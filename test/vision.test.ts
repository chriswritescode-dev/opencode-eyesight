import { test, expect } from "bun:test";
import { DEFAULT_PROMPT, assistantText, createDescriber, parseModel, resolveSettings } from "../src/vision";

const noEnv = {};

test("parseModel splits on the first slash only", () => {
  expect(parseModel("google-vertex/gemini-3.8-flash")).toEqual({ providerID: "google-vertex", id: "gemini-3.8-flash" });
  expect(parseModel("openrouter/anthropic/claude-x")).toEqual({ providerID: "openrouter", id: "anthropic/claude-x" });
  for (const bad of ["nodash", "/x", "x/", "a b/c", "a/b c", ""]) expect(parseModel(bad)).toBeUndefined();
});

test("resolveSettings returns undefined when no model is configured", async () => {
  expect(await resolveSettings(undefined, noEnv)).toBeUndefined();
  expect(await resolveSettings({ model: "" }, { OPENCODE_VISION_MODEL: "" })).toBeUndefined();
});

test("resolveSettings reads the model from options, then env", async () => {
  expect((await resolveSettings({ model: "a/b" }, { OPENCODE_VISION_MODEL: "c/d" }))?.model).toEqual({ providerID: "a", id: "b" });
  expect((await resolveSettings(undefined, { OPENCODE_VISION_MODEL: "c/d" }))?.model).toEqual({ providerID: "c", id: "d" });
  expect((await resolveSettings({ model: "a/b" }, noEnv))?.prompt).toBe(DEFAULT_PROMPT);
});

test("resolveSettings rejects a malformed model", async () => {
  await expect(resolveSettings({ model: "nodash" }, noEnv)).rejects.toThrow("providerID/modelID");
});

test("resolveSettings rejects a relative promptFile without reading it", async () => {
  let reads = 0;
  const read = async () => (reads++, "x");
  await expect(resolveSettings({ model: "a/b", promptFile: "./prompt.md" }, noEnv, read)).rejects.toThrow("absolute");
  await expect(resolveSettings({ model: "a/b", promptFile: "prompt.md" }, noEnv, read)).rejects.toThrow("absolute");
  expect(reads).toBe(0);
});

test("resolveSettings reads an absolute promptFile; an inline prompt wins; an empty file falls back", async () => {
  const read = async (path: string) => `  from ${path}  \n`;
  expect((await resolveSettings({ model: "a/b", promptFile: "/etc/p.md" }, noEnv, read))?.prompt).toBe("from /etc/p.md");
  expect((await resolveSettings({ model: "a/b", promptFile: "/etc/p.md", prompt: "inline" }, noEnv, read))?.prompt).toBe("inline");
  expect((await resolveSettings({ model: "a/b", promptFile: "/etc/p.md" }, noEnv, async () => " "))?.prompt).toBe(DEFAULT_PROMPT);
});

test("assistantText returns the last assistant text and fails with short messages", () => {
  const msgs = [
    { type: "user", content: [{ type: "text", text: "q" }] },
    { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "old" }] },
    { type: "assistant", content: [{ type: "text", text: "new " }, { type: "text", text: "answer" }] },
  ];
  expect(assistantText(msgs)).toBe("new answer");
  expect(() => assistantText([msgs[0]])).toThrow("no answer");
  expect(() => assistantText([{ type: "assistant", content: [] }])).toThrow("no text");
  expect(() => assistantText([{ type: "assistant", content: [], error: { message: "secret body" } }])).toThrow(
    "vision model returned an error",
  );
  // partial text together with an error is a failure, not a result
  expect(() =>
    assistantText([{ type: "assistant", content: [{ type: "text", text: "half an answ" }], error: { message: "cut" } }]),
  ).toThrow("vision model returned an error");
});

const SETTINGS = { model: { providerID: "a", id: "b" }, prompt: "p" };
const IMAGE = { base64: "AAAA", mime: "image/png" };
const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session whose remove() is a tripwire: history must never be deleted. */
function fake(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const interrupted: { sessionID: string; resume: false }[] = [];
  const session = {
    create: async () => (calls.push("create"), { id: "s1" }),
    prompt: async () => void calls.push("prompt"),
    wait: async () => void calls.push("wait"),
    context: async () => (calls.push("context"), [{ type: "assistant", content: [{ type: "text", text: "ok" }] }]),
    interrupt: async (input: { sessionID: string; resume: false }) => (interrupted.push(input), { interrupted: true }),
    remove: () => {
      throw new Error("session.remove must never be called");
    },
    ...over,
  };
  return { session: session as any, calls, interrupted };
}

test("a completed exchange is kept: no interrupt, no remove, guard released", async () => {
  const f = fake();
  const internal = new Set<string>();
  expect(await createDescriber(f.session, SETTINGS, internal, () => {})(IMAGE)).toBe("ok");
  expect(f.interrupted).toEqual([]);
  expect(internal.size).toBe(0);
});

test("an error interrupts the owned session once, never removes it, and releases the guard", async () => {
  const f = fake({ wait: async () => { throw new Error("boom"); } });
  const internal = new Set<string>();
  await expect(createDescriber(f.session, SETTINGS, internal, () => {})(IMAGE)).rejects.toThrow("boom");
  await sleep(10);
  expect(f.interrupted).toEqual([{ sessionID: "s1", resume: false }]);
  expect(internal.size).toBe(0);
});

test("a session created after the timeout is interrupted once it appears, never removed", async () => {
  const f = fake({ create: async () => (await sleep(40), { id: "late" }) });
  const internal = new Set<string>();
  const describe = createDescriber(f.session, SETTINGS, internal, () => {}, 10);
  await expect(describe(IMAGE)).rejects.toThrow("timed out");
  await sleep(100);
  expect(f.interrupted).toEqual([{ sessionID: "late", resume: false }]);
  expect(f.calls).not.toContain("prompt"); // nothing was sent to a late session
  expect(internal.size).toBe(0);
});

test("a prompt admitted after the timeout is interrupted again and wait is never reached", async () => {
  let admit!: () => void;
  const f = fake({ prompt: () => new Promise<void>((r) => (admit = r)) });
  const internal = new Set<string>();
  const describe = createDescriber(f.session, SETTINGS, internal, () => {}, 20);
  await expect(describe(IMAGE)).rejects.toThrow("timed out");
  expect(f.interrupted).toHaveLength(1);
  expect(internal.has("s1")).toBe(true); // guard held while the prompt can still be admitted
  admit();
  await sleep(20);
  expect(f.interrupted).toHaveLength(2); // late admission: fail closed
  expect(f.calls).toEqual(["create"]);
  expect(internal.size).toBe(0);
});

test("a timed-out wait is interrupted and the guard stays until the work settles", async () => {
  let release!: () => void;
  const f = fake({ wait: () => new Promise<void>((r) => (release = r)) });
  const internal = new Set<string>();
  const describe = createDescriber(f.session, SETTINGS, internal, () => {}, 20);
  await expect(describe(IMAGE)).rejects.toThrow("timed out");
  expect(f.interrupted).toEqual([{ sessionID: "s1", resume: false }]);
  expect(internal.has("s1")).toBe(true);
  release();
  await sleep(20);
  expect(internal.size).toBe(0);
});

test("an interrupt() that never settles does not block beyond the cleanup deadline and keeps the id guarded", async () => {
  const logs: string[] = [];
  const f = fake({ wait: never, interrupt: never });
  const internal = new Set<string>();
  const describe = createDescriber(f.session, SETTINGS, internal, (m) => logs.push(m), 20, false, 20);
  const started = Date.now();
  await expect(describe(IMAGE)).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(500);
  expect(internal.has("s1")).toBe(true); // unconfirmed stop: fail closed
  expect(logs).toEqual(["could not interrupt vision session: interrupt timed out"]);
});

test("an interrupt answered with interrupted:false keeps the id guarded, even after the work settled", async () => {
  const logs: string[] = [];
  const f = fake({ wait: async () => { throw new Error("boom"); }, interrupt: async () => ({ interrupted: false }) });
  const internal = new Set<string>();
  await expect(createDescriber(f.session, SETTINGS, internal, (m) => logs.push(m), 20, true)(IMAGE)).rejects.toThrow("boom");
  await sleep(20);
  expect(internal.has("s1")).toBe(true);
  expect(logs).not.toContain("interrupted vision session");
});

test("the guard is released once a follow-up interrupt is confirmed after interrupted:false", async () => {
  const answers = [false, true];
  let attempts = 0;
  const f = fake({ wait: async () => { throw new Error("boom"); }, interrupt: async () => ({ interrupted: answers[attempts++] ?? true }) });
  const internal = new Set<string>();
  await expect(createDescriber(f.session, SETTINGS, internal, () => {})(IMAGE)).rejects.toThrow("boom");
  await sleep(20);
  expect(attempts).toBe(2);
  expect(internal.size).toBe(0);
});

// Offline contract check against the pinned native declaration (OpenCode v2.0.26, commit 9b4ec5714d481559990db0a816d5dec19541a814,
// packages/client/src/promise/generated/types.ts). The published plugin doc's `continue: false` is stale; the field is `resume`.
const PINNED_SESSION_INTERRUPT_INPUT = `export type SessionInterruptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly resume?: { readonly resume?: boolean | undefined }["resume"]
}`;

test("interrupt is called with exactly the fields of the pinned native SessionInterruptInput", async () => {
  const declared = [...PINNED_SESSION_INTERRUPT_INPUT.matchAll(/^  readonly (\w+)\??:/gm)].map((m) => m[1]);
  expect(declared).toEqual(["sessionID", "resume"]);
  const f = fake({ wait: async () => { throw new Error("boom"); } });
  await expect(createDescriber(f.session, SETTINGS, new Set<string>(), () => {})(IMAGE)).rejects.toThrow("boom");
  await sleep(10);
  expect(f.interrupted).toHaveLength(1);
  for (const key of Object.keys(f.interrupted[0])) expect(declared).toContain(key);
  expect(f.interrupted[0]).toEqual({ sessionID: "s1", resume: false });
});
