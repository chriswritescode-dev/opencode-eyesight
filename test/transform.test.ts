import { test, expect } from "bun:test";
import {
  isTranscribableImage,
  toolImageAttachments,
  transcribeMessages,
  getActiveModel,
  type TransformMessage,
  type DescribeFn,
} from "../src/transform";
import type { FilePart, TextPart, Part, ToolPart, ToolStateCompleted, Message } from "@opencode-ai/sdk";

let nextId = 1;

function makeFilePart(overrides?: Partial<FilePart>): FilePart {
  const id = String(nextId++);
  return {
    id,
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "file",
    mime: "image/png",
    filename: "screenshot.png",
    url: "file:///tmp/screenshot.png",
    ...overrides,
  };
}

function makeTextPart(overrides?: Partial<TextPart>): TextPart {
  const id = String(nextId++);
  return {
    id,
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "text",
    text: "existing text",
    ...overrides,
  };
}

function makeUserInfo(): Message {
  const id = String(nextId++);
  return {
    id,
    sessionID: "sess-1",
    role: "user",
    time: { created: 0 },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  } as Message;
}

function makeToolImagePart(
  attachments: FilePart[],
  overrides?: Partial<ToolPart>,
): ToolPart {
  const id = String(nextId++);
  return {
    id,
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: "screenshot",
    state: {
      status: "completed",
      input: {},
      output: "screenshot taken",
      title: "Screenshot",
      metadata: {},
      time: { start: 0, end: 1 },
      attachments,
    } satisfies ToolStateCompleted,
    ...overrides,
  };
}

async function transcribeWithUserTextCapture(messages: TransformMessage[]) {
  const captured = new Map<string, string>();
  const describe: DescribeFn = async (part, userText) => {
    captured.set(part.id, userText);
    return "described";
  };
  const count = await transcribeMessages(messages, describe, ["image/"], new Map());
  return { captured, count };
}

test("transcribeMessages replaces one image FilePart in place", async () => {
  const image = makeFilePart();
  const text = makeTextPart();
  const parts: Part[] = [image, text];
  const messages: TransformMessage[] = [{ info: makeUserInfo(), parts }];

  const describe: DescribeFn = async () => "a red square";
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(1);
  expect(parts).toHaveLength(2);
  expect(parts[1]).toBe(text);
  expect((parts[1] as TextPart).text).toBe("existing text");
  const replacement = parts[0] as TextPart;
  expect(replacement.type).toBe("text");
  expect(replacement.text).toBe("a red square");
  expect(replacement.id).toBe(image.id);
  expect(replacement.sessionID).toBe(image.sessionID);
  expect(replacement.messageID).toBe(image.messageID);
  expect(replacement.synthetic).toBe(false);
});

test("transcribeMessages replaces two image parts", async () => {
  const img1 = makeFilePart({ filename: "img1.png" });
  const img2 = makeFilePart({ filename: "img2.png" });
  const parts: Part[] = [img1, img2];
  const messages: TransformMessage[] = [{ info: makeUserInfo(), parts }];

  let callCount = 0;
  const describe: DescribeFn = async () => {
    callCount++;
    return `description-${callCount}`;
  };
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);
  expect(count).toBe(2);
  expect(callCount).toBe(2);
  expect((parts[0] as TextPart).text).toBe("description-1");
  expect((parts[1] as TextPart).text).toBe("description-2");
});

test("transcribeMessages skips non-image file parts", async () => {
  const pdf = makeFilePart({ mime: "application/pdf", filename: "doc.pdf" });
  const text = makeTextPart();
  const parts: Part[] = [pdf, text];
  const messages: TransformMessage[] = [{ info: makeUserInfo(), parts }];

  const describe: DescribeFn = async () => "should not be called";
  const count = await transcribeMessages(messages, describe, ["image/"], new Map());
  expect(count).toBe(0);
  expect((parts[0] as FilePart).type).toBe("file");
});

test("transcribeMessages returns 0 when no image parts exist", async () => {
  const parts: Part[] = [makeTextPart(), makeTextPart()];
  const messages: TransformMessage[] = [{ info: makeUserInfo(), parts }];
  const describe: DescribeFn = async () => "should not be called";
  const count = await transcribeMessages(messages, describe, ["image/"], new Map());
  expect(count).toBe(0);
  expect(parts).toHaveLength(2);
});

test("transcribeMessages handles describe throwing an error", async () => {
  const image = makeFilePart({ filename: "broken.png" });
  const parts: Part[] = [image];
  const messages: TransformMessage[] = [{ info: makeUserInfo(), parts }];

  const describe: DescribeFn = async () => {
    throw new Error("API error");
  };

  const count = await transcribeMessages(messages, describe, ["image/"], new Map());
  expect(count).toBe(1);

  const replacement = parts[0] as TextPart;
  expect(replacement.type).toBe("text");
  expect(replacement.text).toBe(
    '[Image "broken.png" could not be transcribed: API error]',
  );
  expect(replacement.id).toBe(image.id);
});

test("isTranscribableImage returns true for image file parts", () => {
  const image = makeFilePart({ mime: "image/png" });
  expect(isTranscribableImage(image, ["image/"])).toBe(true);
});

test("isTranscribableImage returns false for non-matching mime", () => {
  const pdf = makeFilePart({ mime: "application/pdf" });
  expect(isTranscribableImage(pdf, ["image/"])).toBe(false);
});

test("isTranscribableImage returns false for text parts", () => {
  const text = makeTextPart();
  expect(isTranscribableImage(text, ["image/"])).toBe(false);
});

test("toolImageAttachments returns image attachments for completed tool part", () => {
  const image = makeFilePart({ mime: "image/png" });
  const part = makeToolImagePart([image]);
  const result = toolImageAttachments(part, ["image/"]);
  expect(result).toEqual([image]);
});

test("toolImageAttachments returns [] when tool part has no attachments", () => {
  const part = makeToolImagePart([]);
  const result = toolImageAttachments(part, ["image/"]);
  expect(result).toEqual([]);
});

test("toolImageAttachments returns [] when state.status is running", () => {
  const image = makeFilePart({ mime: "image/png" });
  const id = String(nextId++);
  const part: ToolPart = {
    id,
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: "screenshot",
    state: {
      status: "running",
      input: {},
      title: "Screenshot",
      metadata: {},
      time: { start: 0 },
    },
  };
  const result = toolImageAttachments(part, ["image/"]);
  expect(result).toEqual([]);
});

test("toolImageAttachments filters out non-image attachments", () => {
  const image = makeFilePart({ mime: "image/png", filename: "img.png" });
  const pdf = makeFilePart({ mime: "application/pdf", filename: "doc.pdf" });
  const part = makeToolImagePart([image, pdf]);
  const result = toolImageAttachments(part, ["image/"]);
  expect(result).toEqual([image]);
});

test("toolImageAttachments returns [] for a non-tool part (TextPart)", () => {
  const text = makeTextPart();
  const result = toolImageAttachments(text, ["image/"]);
  expect(result).toEqual([]);
});

// ── transcribeMessages ──────────────────────────────────────

test("transcribeMessages transcribes single image attachment", async () => {
  const image = makeFilePart({ mime: "image/png", filename: "screenshot.png" });
  const toolPart = makeToolImagePart([image]);
  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [toolPart] },
  ];
  const describe: DescribeFn = async () => "a red square";
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(1);
  const state = toolPart.state as ToolStateCompleted;
  expect(state.attachments).toEqual([]);
  expect(state.output).toContain("screenshot taken");
  expect(state.output).toContain("a red square");
});

test("transcribeMessages transcribes two image attachments on one tool part", async () => {
  const img1 = makeFilePart({ mime: "image/png", filename: "img1.png" });
  const img2 = makeFilePart({ mime: "image/png", filename: "img2.png" });
  const toolPart = makeToolImagePart([img1, img2]);
  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [toolPart] },
  ];
  let callCount = 0;
  const describe: DescribeFn = async () => {
    callCount++;
    return `description-${callCount}`;
  };
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(2);
  const state = toolPart.state as ToolStateCompleted;
  expect(state.attachments).toEqual([]);
  expect(state.output).toContain("description-1");
  expect(state.output).toContain("description-2");
  expect(callCount).toBe(2);
});

test("transcribeMessages handles mixed image and pdf attachments", async () => {
  const image = makeFilePart({ mime: "image/png", filename: "img.png" });
  const pdf = makeFilePart({ mime: "application/pdf", filename: "doc.pdf" });
  const toolPart = makeToolImagePart([image, pdf]);
  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [toolPart] },
  ];
  const describe: DescribeFn = async () => "a red square";
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(1);
  const state = toolPart.state as ToolStateCompleted;
  expect(state.attachments).toHaveLength(1);
  expect(state.attachments![0].mime).toBe("application/pdf");
  expect(state.output).toContain("a red square");
});

test("transcribeMessages returns 0 for running tool part", async () => {
  const id = String(nextId++);
  const runningPart: ToolPart = {
    id,
    sessionID: "sess-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: "screenshot",
    state: {
      status: "running",
      input: {},
      title: "Screenshot",
      metadata: {},
      time: { start: 0 },
    },
  };
  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [runningPart] },
  ];
  const describe: DescribeFn = async () => "should not be called";
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);
  expect(count).toBe(0);
  expect(runningPart.state.status).toBe("running");
});

test("transcribeMessages returns 0 when no targets exist", async () => {
  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [makeTextPart(), makeTextPart()] },
  ];
  const describe: DescribeFn = async () => "should not be called";
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);
  expect(count).toBe(0);
});

test("transcribeMessages handles describe throwing an error", async () => {
  const image = makeFilePart({ mime: "image/png", filename: "broken.png" });
  const toolPart = makeToolImagePart([image]);
  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [toolPart] },
  ];
  const describe: DescribeFn = async () => {
    throw new Error("API error");
  };
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(1);
  const state = toolPart.state as ToolStateCompleted;
  expect(state.attachments).toEqual([]);
  expect(state.output).toContain('[Image "broken.png" could not be transcribed: API error]');
});

test("transcribeMessages reuses cache across messages with same attachment id", async () => {
  const sharedId = "shared-img-1";
  const img1 = makeFilePart({ id: sharedId, mime: "image/png", filename: "a.png" });
  const img2 = makeFilePart({ id: sharedId, mime: "image/png", filename: "a.png" });
  const toolPartA = makeToolImagePart([img1]);
  const toolPartB = makeToolImagePart([img2]);

  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [toolPartA] },
    { info: makeUserInfo(), parts: [toolPartB] },
  ];

  let describeCalls = 0;
  const describe: DescribeFn = async () => {
    describeCalls++;
    return "vision result";
  };
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(2);
  expect(describeCalls).toBe(1);
  const stateA = toolPartA.state as ToolStateCompleted;
  const stateB = toolPartB.state as ToolStateCompleted;
  expect(stateA.output).toContain("vision result");
  expect(stateB.output).toContain("vision result");
});

test("transcribeMessages handles user image and tool attachment together", async () => {
  const userImage = makeFilePart({ filename: "pasted.png" });
  const userParts: Part[] = [userImage, makeTextPart()];
  const toolImage = makeFilePart({ filename: "screenshot.png" });
  const toolPart = makeToolImagePart([toolImage]);

  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: userParts },
    { info: makeUserInfo(), parts: [toolPart] },
  ];

  let callCount = 0;
  const describe: DescribeFn = async () => {
    callCount++;
    return `vision-${callCount}`;
  };
  const cache = new Map<string, string>();

  const count = await transcribeMessages(messages, describe, ["image/"], cache);

  expect(count).toBe(2);
  expect(callCount).toBe(2);
  expect((userParts[0] as TextPart).type).toBe("text");
  expect((userParts[0] as TextPart).text).toBe("vision-1");
  const state = toolPart.state as ToolStateCompleted;
  expect(state.attachments).toEqual([]);
  expect(state.output).toContain("vision-2");
});

test("transcribeMessages passes accompanying user text as context for pasted image", async () => {
  const image = makeFilePart();
  const text = makeTextPart({ text: "What does the error message say?" });
  const parts: Part[] = [image, text];
  const messages: TransformMessage[] = [{ info: makeUserInfo(), parts }];

  const { captured } = await transcribeWithUserTextCapture(messages);
  expect(captured.get(image.id)).toBe("What does the error message say?");
});

test("transcribeMessages re-describes same image id when accompanying text differs", async () => {
  const img1 = makeFilePart({ id: "img-x" });
  const img2 = makeFilePart({ id: "img-x" });

  const msg1: TransformMessage = {
    info: makeUserInfo(),
    parts: [img1, makeTextPart({ text: "question one" })],
  };
  const msg2: TransformMessage = {
    info: makeUserInfo(),
    parts: [img2, makeTextPart({ text: "question two" })],
  };

  let describeCalls = 0;
  const describe: DescribeFn = async () => {
    describeCalls++;
    return "description";
  };
  const cache = new Map<string, string>();

  const count = await transcribeMessages([msg1, msg2], describe, ["image/"], cache);
  expect(count).toBe(2);
  expect(describeCalls).toBe(2);
});

test("transcribeMessages passes latest user message as context for tool image", async () => {
  const image = makeFilePart();
  const toolPart = makeToolImagePart([image]);

  const messages: TransformMessage[] = [
    {
      info: makeUserInfo(),
      parts: [makeTextPart({ text: "Find the bug in this screenshot" })],
    },
    {
      info: makeAssistantInfo(),
      parts: [toolPart],
    },
  ];

  const { captured, count } = await transcribeWithUserTextCapture(messages);
  expect(count).toBe(1);
  expect(captured.get(image.id)).toBe("Find the bug in this screenshot");
});

test("transcribeMessages scopes each tool image to its nearest preceding user message", async () => {
  const imageA = makeFilePart({ id: "tool-img-a" });
  const imageB = makeFilePart({ id: "tool-img-b" });

  const messages: TransformMessage[] = [
    { info: makeUserInfo(), parts: [makeTextPart({ text: "investigate bug A" })] },
    { info: makeAssistantInfo(), parts: [makeToolImagePart([imageA])] },
    { info: makeUserInfo(), parts: [makeTextPart({ text: "now do bug B" })] },
    { info: makeAssistantInfo(), parts: [makeToolImagePart([imageB])] },
  ];

  const { captured, count } = await transcribeWithUserTextCapture(messages);
  expect(count).toBe(2);
  expect(captured.get("tool-img-a")).toBe("investigate bug A");
  expect(captured.get("tool-img-b")).toBe("now do bug B");
});

// ── getActiveModel ──────────────────────────────────────────────────

function makeAssistantInfo(
  overrides?: Partial<{ providerID: string; modelID: string }>,
): Message {
  const id = String(nextId++);
  return {
    id,
    sessionID: "sess-1",
    parentID: "parent-1",
    role: "assistant",
    mode: "chat",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0 },
    providerID: "test-provider",
    modelID: "test-model",
    ...overrides,
  } as unknown as Message;
}

test("getActiveModel returns the last user message's model when present", () => {
  const messages: TransformMessage[] = [
    {
      info: makeUserInfo(),
      parts: [],
    },
    {
      info: {
        ...makeUserInfo(),
        model: { providerID: "custom", modelID: "custom-model" },
      } as unknown as Message,
      parts: [],
    },
  ];
  const result = getActiveModel(messages);
  expect(result).toEqual({ providerID: "custom", modelID: "custom-model" });
});

test("getActiveModel falls back to assistant provider/model when user has no model", () => {
  const messages: TransformMessage[] = [
    {
      info: makeAssistantInfo({ providerID: "fallback", modelID: "fallback-model" }),
      parts: [],
    },
  ];
  const result = getActiveModel(messages);
  expect(result).toEqual({ providerID: "fallback", modelID: "fallback-model" });
});

test("getActiveModel skips latest user without model and falls back to assistant", () => {
  const messages: TransformMessage[] = [
    {
      info: makeAssistantInfo({ providerID: "assistant-provider", modelID: "assistant-model" }),
      parts: [],
    },
    {
      info: {
        ...makeUserInfo(),
        model: undefined,
      } as unknown as Message,
      parts: [],
    },
  ];
  const result = getActiveModel(messages);
  expect(result).toEqual({ providerID: "assistant-provider", modelID: "assistant-model" });
});

test("getActiveModel returns undefined when no user model and no assistant provider/model", () => {
  const messages: TransformMessage[] = [
    {
      info: makeAssistantInfo({ providerID: "", modelID: "" }),
      parts: [],
    },
  ];
  const result = getActiveModel(messages);
  expect(result).toBeUndefined();
});

test("getActiveModel prefers last user model over last assistant provider/model", () => {
  const messages: TransformMessage[] = [
    {
      info: makeUserInfo(),
      parts: [],
    },
    {
      info: makeAssistantInfo({ providerID: "assistant", modelID: "assistant-model" }),
      parts: [],
    },
  ];
  const result = getActiveModel(messages);
  expect(result).toEqual({ providerID: "test", modelID: "test" });
});
