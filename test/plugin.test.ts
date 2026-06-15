import { test, expect } from "bun:test";
import { VisionFallback } from "../src/index";
import type { Part, FilePart, TextPart } from "@opencode-ai/sdk";

let nextPartId = 1;

function makeFilePart(overrides?: Partial<FilePart>): FilePart {
  const id = String(nextPartId++);
  return {
    id,
    sessionID: "ses_user",
    messageID: "msg-1",
    type: "file",
    mime: "image/png",
    filename: "screenshot.png",
    url: "file:///tmp/screenshot.png",
    ...overrides,
  };
}

function makeTextPart(text = "existing text"): TextPart {
  const id = String(nextPartId++);
  return {
    id,
    sessionID: "ses_user",
    messageID: "msg-1",
    type: "text",
    text,
  };
}

const providerFixture = {
  all: [
    {
      id: "zai",
      models: {
        "glm-4.6": { modalities: { input: ["text"], output: ["text"] } },
      },
    },
    {
      id: "openai",
      models: {
        "gpt-4o": { modalities: { input: ["text", "image"], output: ["text"] } },
      },
    },
    {
      id: "anthropic",
      models: {
        "claude-3": { modalities: { input: ["text", "image"], output: ["text"] } },
      },
    },
  ],
  default: {},
  connected: [],
};

function buildInput(fakeClient: Record<string, unknown>) {
  return {
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: (() => {}) as any,
  };
}

test("non-vision model with image: transcribes via vision model", async () => {
  let createCount = 0;
  let deleteCount = 0;
  let capturedModel: unknown;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: `ses_v_${createCount}` } };
      },
      prompt: async (args: any) => {
        capturedModel = args.body?.model;
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: "a red square on white" }],
          },
        };
      },
      delete: async () => {
        deleteCount++;
        return { data: true };
      },
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });
  const output = { message: {} as any, parts: [makeFilePart(), makeTextPart()] };

  await hooks["chat.message"]!(
    { sessionID: "ses_user", model: { providerID: "zai", modelID: "glm-4.6" } },
    output as any,
  );

  expect(output.parts).toHaveLength(2);
  const replacement = output.parts[0] as TextPart;
  expect(replacement.type).toBe("text");
  expect(replacement.text).toBe("a red square on white");
  expect(replacement.id).toBeDefined();
  expect(createCount).toBe(1);
  expect(deleteCount).toBe(1);
  expect(capturedModel).toEqual({ providerID: "openai", modelID: "gpt-4o" });
});

test("vision-capable model: parts untouched, no vision session created", async () => {
  let sessionCreateCount = 0;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        sessionCreateCount++;
        return { data: { id: "ses_v" } };
      },
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => {
        sessionCreateCount++;
        return { data: true };
      },
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });
  const image = makeFilePart();
  const output = { message: {} as any, parts: [image] };

  await hooks["chat.message"]!(
    {
      sessionID: "ses_user",
      model: { providerID: "anthropic", modelID: "claude-3" },
    },
    output as any,
  );

  expect(sessionCreateCount).toBe(0);
  expect(output.parts).toHaveLength(1);
  expect((output.parts[0] as FilePart).type).toBe("file");
  expect((output.parts[0] as FilePart).mime).toBe("image/png");
});

test("text-only parts: no SDK calls, parts unchanged", async () => {
  let providerListCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        providerListCount++;
        return { data: providerFixture };
      },
    },
    session: {
      create: async () => ({ data: { id: "s" } }),
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });
  const parts: Part[] = [makeTextPart("hello"), makeTextPart("world")];
  const output = { message: {} as any, parts };

  await hooks["chat.message"]!(
    { sessionID: "ses_user", model: { providerID: "zai", modelID: "glm-4.6" } },
    output as any,
  );

  expect(providerListCount).toBe(0);
  expect(output.parts).toBe(parts);
  expect(output.parts).toHaveLength(2);
  expect((output.parts[0] as TextPart).type).toBe("text");
  expect((output.parts[1] as TextPart).type).toBe("text");
});

test("configured-model guard: active model matches vision model, no transcription", async () => {
  let providerListCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        providerListCount++;
        return { data: providerFixture };
      },
    },
    session: {
      create: async () => ({ data: { id: "s" } }),
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });
  const image = makeFilePart();
  const output = { message: {} as any, parts: [image] };

  await hooks["chat.message"]!(
    {
      sessionID: "ses_user",
      model: { providerID: "openai", modelID: "gpt-4o" },
    },
    output as any,
  );

  expect(providerListCount).toBe(0);
  expect((output.parts[0] as FilePart).type).toBe("file");
  expect((output.parts[0] as FilePart).mime).toBe("image/png");
});

test("no model configured: returns empty hooks", async () => {
  let logCalled = false;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => ({ data: { id: "s" } }),
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => ({ data: true }),
    },
    app: {
      log: async () => {
        logCalled = true;
      },
    },
  };

  const input = buildInput(fakeClient);
  const hooks = await VisionFallback(input, undefined);

  expect(hooks).toEqual({});
  expect(logCalled).toBe(true);
});

test("describe session lifecycle: create, prompt, delete each called once", async () => {
  let createCount = 0;
  let deleteCount = 0;
  let promptCalled = false;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: "ses_lifecycle" } };
      },
      prompt: async (_args: any) => {
        promptCalled = true;
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: "described" }],
          },
        };
      },
      delete: async () => {
        deleteCount++;
        return { data: true };
      },
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });

  const output = { message: {} as any, parts: [makeFilePart()] };
  await hooks["chat.message"]!(
    { sessionID: "ses_user", model: { providerID: "zai", modelID: "glm-4.6" } },
    output as any,
  );

  expect(createCount).toBe(1);
  expect(deleteCount).toBe(1);
  expect(promptCalled).toBe(true);
  expect((output.parts[0] as unknown as TextPart).type).toBe("text");
  expect((output.parts[0] as unknown as TextPart).text).toBe("described");
});
