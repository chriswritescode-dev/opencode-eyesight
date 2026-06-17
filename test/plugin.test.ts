import { test, expect } from "bun:test";
import { VisionFallback } from "../src/index";
import type { Part, FilePart, TextPart, UserMessage, AssistantMessage, ToolPart, Message } from "@opencode-ai/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let nextPartId = 1;

function makeUserMsgParts(
  parts: Part[],
  model?: { providerID: string; modelID: string },
  sessionID = "ses_user",
): { info: Message; parts: Part[] } {
  return {
    info: {
      id: "user-1",
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: model ?? { providerID: "zai", modelID: "glm-4.6" },
    } as UserMessage,
    parts,
  };
}

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
  return buildInputWithDirectory(fakeClient, "/tmp");
}

function buildInputWithDirectory(fakeClient: Record<string, unknown>, directory: string) {
  return {
    client: fakeClient as any,
    project: {} as any,
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: (() => {}) as any,
  };
}

function makePromptCaptureClient(
  onPrompt: (args: any) => void,
  sessionId = "ses_prompt",
) {
  return {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => ({ data: { id: sessionId } }),
      prompt: async (args: any) => {
        onPrompt(args);
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: "described" }],
          },
        };
      },
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
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
  const msg = makeUserMsgParts([makeFilePart(), makeTextPart()]);
  const output = { messages: [msg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(msg.parts).toHaveLength(2);
  const replacement = msg.parts[0] as TextPart;
  expect(replacement.type).toBe("text");
  expect(replacement.text).toBe("a red square on white");
  expect(replacement.id).toBeDefined();
  expect(createCount).toBe(1);
  expect(deleteCount).toBe(1);
  expect(capturedModel).toEqual({ providerID: "openai", modelID: "gpt-4o" });
});

test("non-vision model with two images: transcribes both via vision model", async () => {
  let createCount = 0;
  let deleteCount = 0;
  const promptedFiles: string[] = [];

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: `ses_v_${createCount}` } };
      },
      prompt: async (args: any) => {
        const filePart = args.body?.parts.find((part: Part) => part.type === "file") as FilePart;
        promptedFiles.push(filePart.filename ?? "");
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: `description for ${filePart.filename}` }],
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
  const msg = makeUserMsgParts([
    makeFilePart({ filename: "first.png", url: "file:///tmp/first.png" }),
    makeFilePart({ filename: "second.png", url: "file:///tmp/second.png" }),
    makeTextPart("Compare these screenshots."),
  ]);
  const output = { messages: [msg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(createCount).toBe(2);
  expect(deleteCount).toBe(2);
  expect(promptedFiles).toEqual(["first.png", "second.png"]);
  expect((msg.parts[0] as TextPart).text).toBe("[Image 1 vision description:]\ndescription for first.png");
  expect((msg.parts[1] as TextPart).text).toBe("[Image 2 vision description:]\ndescription for second.png");
  expect((msg.parts[2] as TextPart).text).toBe("Compare these screenshots.");
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
  const msg = makeUserMsgParts([image], { providerID: "anthropic", modelID: "claude-3" });
  const output = { messages: [msg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(sessionCreateCount).toBe(0);
  expect(msg.parts).toHaveLength(1);
  expect((msg.parts[0] as FilePart).type).toBe("file");
  expect((msg.parts[0] as FilePart).mime).toBe("image/png");
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
  const msg = makeUserMsgParts(parts);
  const output = { messages: [msg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(providerListCount).toBe(0);
  expect(msg.parts).toBe(parts);
  expect(msg.parts).toHaveLength(2);
  expect((msg.parts[0] as TextPart).type).toBe("text");
  expect((msg.parts[1] as TextPart).type).toBe("text");
});

test("current text-only request ignores prior vision-model image parts", async () => {
  let providerListCount = 0;
  let createCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        providerListCount++;
        return { data: providerFixture };
      },
    },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: "s" } };
      },
      prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "described" }] } }),
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });
  const oldImage = makeFilePart();
  const oldMsg = makeUserMsgParts([oldImage], { providerID: "openai", modelID: "gpt-4o" });
  const currentMsg = makeUserMsgParts([makeTextPart("continue")], { providerID: "zai", modelID: "glm-4.6" });
  const output = { messages: [oldMsg, currentMsg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(providerListCount).toBe(0);
  expect(createCount).toBe(0);
  expect(oldMsg.parts[0]).toBe(oldImage);
  expect((currentMsg.parts[0] as TextPart).text).toBe("continue");
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
  const msg = makeUserMsgParts([image], { providerID: "openai", modelID: "gpt-4o" });
  const output = { messages: [msg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(providerListCount).toBe(0);
  expect((msg.parts[0] as FilePart).type).toBe("file");
  expect((msg.parts[0] as FilePart).mime).toBe("image/png");
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

  const msg = makeUserMsgParts([makeFilePart()]);
  const output = { messages: [msg] };
  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(createCount).toBe(1);
  expect(deleteCount).toBe(1);
  expect(promptCalled).toBe(true);
  expect((msg.parts[0] as unknown as TextPart).type).toBe("text");
  expect((msg.parts[0] as unknown as TextPart).text).toBe("described");
});

test("promptFile loads markdown prompt for vision session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-eyesight-"));
  await writeFile(join(directory, "prompt.md"), "\nDescribe using markdown file.\n");

  let capturedSystem: unknown;

  const fakeClient = makePromptCaptureClient((args) => {
    capturedSystem = args.body?.system;
  }, "ses_prompt_file");

  try {
    const hooks = await VisionFallback(buildInputWithDirectory(fakeClient, directory), {
      model: "openai/gpt-4o",
      promptFile: "prompt.md",
    });

    const msg = makeUserMsgParts([makeFilePart()]);
    const output = { messages: [msg] };
    await hooks["experimental.chat.messages.transform"]!({}, output as any);

    expect(capturedSystem).toBe("Describe using markdown file.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("vision session disables all tools (read-only)", async () => {
  let capturedTools: unknown;

  const fakeClient = makePromptCaptureClient((args) => {
    capturedTools = args.body?.tools;
  }, "ses_readonly");

  const hooks = await VisionFallback(buildInput(fakeClient), { model: "openai/gpt-4o" });

  const msg = makeUserMsgParts([makeFilePart()]);
  const output = { messages: [msg] };
  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  expect(capturedTools).toEqual({ "*": false });
});

// ── Phase 4 helpers ──────────────────────────────────────────────────────────

function makeUserMsg(
  model?: { providerID: string; modelID: string },
  sessionID = "ses_user",
): { info: Message; parts: Part[] } {
  return {
    info: {
      id: "user-1",
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: model ?? { providerID: "zai", modelID: "glm-4.6" },
    } as UserMessage,
    parts: [makeTextPart("user message")],
  };
}

function makeToolPartWithAttachments(attachments?: FilePart[]): ToolPart {
  const id = String(nextPartId++);
  return {
    id,
    sessionID: "ses_user",
    messageID: "msg-tool",
    type: "tool",
    callID: "call-1",
    tool: "test_tool",
    state: {
      status: "completed",
      input: {},
      output: "original output",
      title: "Test Tool",
      metadata: {},
      time: { start: Date.now() - 1000, end: Date.now() },
      ...(attachments ? { attachments } : {}),
    },
  };
}

function makeAssistantMsgWithTool(
  toolPart: ToolPart,
  sessionID?: string,
): { info: Message; parts: Part[] } {
  return {
    info: {
      id: "assistant-1",
      sessionID: sessionID ?? toolPart.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "user-1",
      modelID: "glm-4.6",
      providerID: "zai",
      mode: "default",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage,
    parts: [toolPart],
  };
}

// ── Phase 4: experimental.chat.messages.transform ────────────────────────────

test("transform: text-only model with tool image attachment transcribes", async () => {
  let createCount = 0;
  let deleteCount = 0;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: `ses_v_${createCount}` } };
      },
      prompt: async (_args: any) => ({
        data: {
          info: {},
          parts: [{ type: "text", text: "a red square on white" }],
        },
      }),
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

  const toolPart = makeToolPartWithAttachments([makeFilePart()]);
  const messages = [makeUserMsg(), makeAssistantMsgWithTool(toolPart)];

  await hooks["experimental.chat.messages.transform"]!({}, { messages });

  expect(createCount).toBe(1);
  expect(deleteCount).toBe(1);

  const part = messages[1].parts[0] as ToolPart;
  expect(part.state.status).toBe("completed");
  const completed = part.state as { status: "completed"; attachments: FilePart[]; output: string };
  expect(completed.attachments).toEqual([]);
  expect(completed.output).toContain("a red square on white");
  expect(completed.output).toContain("Tool returned an image attachment");
});

test("transform: vision-capable model leaves tool attachments untouched", async () => {
  let createCount = 0;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: "ses_v" } };
      },
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => {
        createCount++;
        return { data: true };
      },
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });

  const image = makeFilePart();
  const toolPart = makeToolPartWithAttachments([image]);
  const messages = [makeUserMsg({ providerID: "anthropic", modelID: "claude-3" }), makeAssistantMsgWithTool(toolPart)];

  await hooks["experimental.chat.messages.transform"]!({}, { messages });

  expect(createCount).toBe(0);
  const part = messages[1].parts[0] as ToolPart;
  expect(part.state.status).toBe("completed");
  const completed = part.state as { status: "completed"; attachments?: FilePart[]; output: string };
  expect(completed.attachments).toHaveLength(1);
  expect(completed.attachments![0]).toBe(image);
  expect(completed.output).toBe("original output");
});

test("transform: no tool attachments avoids SDK calls", async () => {
  let providerListCount = 0;
  let createCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        providerListCount++;
        return { data: providerFixture };
      },
    },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: "s" } };
      },
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });

  const toolPart = makeToolPartWithAttachments(); // no attachments
  const messages = [makeUserMsg(), makeAssistantMsgWithTool(toolPart)];

  await hooks["experimental.chat.messages.transform"]!({}, { messages });

  expect(providerListCount).toBe(0);
  expect(createCount).toBe(0);
});

test("transform: internal vision session is skipped", async () => {
  let createCount = 0;
  let deleteCount = 0;
  let hooks: any;
  let nestedSkipped = false;

  const fakeClient = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: "ses_v_internal" } };
      },
      prompt: async (_args: any) => {
        // While this prompt runs, "ses_v_internal" is in internalSessions.
        // Invoke the transform hook with a message using that sessionID.
        const innerTool = makeToolPartWithAttachments([makeFilePart()]);
        const innerMsgs = [
          makeUserMsg({ providerID: "zai", modelID: "glm-4.6" }, "ses_v_internal"),
          makeAssistantMsgWithTool(innerTool, "ses_v_internal"),
        ];
        const prev = createCount;
        await hooks["experimental.chat.messages.transform"]!({}, { messages: innerMsgs });
        nestedSkipped = createCount === prev;
        return { data: { info: {}, parts: [{ type: "text", text: "described" }] } };
      },
      delete: async () => {
        deleteCount++;
        return { data: true };
      },
    },
    app: { log: async () => {} },
  };

  hooks = await VisionFallback(buildInput(fakeClient), { model: "openai/gpt-4o" });

  // Trigger describe so internalSessions gets populated
  const outer = { messages: [makeUserMsgParts([makeFilePart()], { providerID: "zai", modelID: "glm-4.6" })] };
  await hooks["experimental.chat.messages.transform"]!({}, outer as any);

  expect(nestedSkipped).toBe(true);
  expect(createCount).toBe(1);
  expect(deleteCount).toBe(1);
});

test("transform: configured model guard skips transcription", async () => {
  let createCount = 0;
  let providerListCount = 0;

  const fakeClient = {
    provider: {
      list: async () => {
        providerListCount++;
        return { data: providerFixture };
      },
    },
    session: {
      create: async () => {
        createCount++;
        return { data: { id: "s" } };
      },
      prompt: async () => ({ data: { info: {}, parts: [] } }),
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });

  const toolPart = makeToolPartWithAttachments([makeFilePart()]);
  const messages = [makeUserMsg({ providerID: "openai", modelID: "gpt-4o" }), makeAssistantMsgWithTool(toolPart)];

  await hooks["experimental.chat.messages.transform"]!({}, { messages });

  expect(createCount).toBe(0);
  expect(providerListCount).toBe(0);
  const part = messages[1].parts[0] as ToolPart;
  expect(part.state.status).toBe("completed");
  const completed = part.state as { status: "completed"; attachments?: FilePart[]; output: string };
  expect(completed.attachments).toHaveLength(1);
  expect(completed.output).toBe("original output");
});

// ── Phase 3: vision prompt includes user's accompanying text ─────────────────

test("vision prompt includes the user's accompanying message", async () => {
  let capturedParts: unknown;

  const fakeClient = makePromptCaptureClient((args) => {
    capturedParts = args.body?.parts;
  }, "ses_prompt_text");

  const hooks = await VisionFallback(buildInput(fakeClient), {
    model: "openai/gpt-4o",
  });

  const msg = makeUserMsgParts([
    makeFilePart(),
    makeTextPart("What is the hex color of the button?"),
  ]);
  const output = { messages: [msg] };

  await hooks["experimental.chat.messages.transform"]!({}, output as any);

  const textPart = (capturedParts as Array<Record<string, unknown>>).find(
    (p) => p.type === "text",
  );
  expect(textPart).toBeDefined();
  expect(textPart!.text).toContain("What is the hex color of the button?");
  expect(textPart!.text).toContain("tailor your description");
});
