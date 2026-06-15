import type { Part, FilePart, TextPart, ToolStateCompleted, Message } from "@opencode-ai/sdk";

export type DescribeFn = (part: FilePart) => Promise<string>;

function matchesMime(a: FilePart, mimePrefixes: string[]): boolean {
  return mimePrefixes.some((p) => a.mime.startsWith(p));
}

export function toolImageAttachments(part: Part, mimePrefixes: string[]): FilePart[] {
  if (part.type !== "tool" || part.state.status !== "completed") return [];
  const attachments = part.state.attachments;
  if (!attachments) return [];
  return attachments.filter((a) => matchesMime(a, mimePrefixes));
}

async function describeOrError(file: FilePart, describe: DescribeFn): Promise<string> {
  return describe(file).catch(
    (e: unknown) =>
      `[Image "${file.filename ?? "image"}" could not be transcribed: ${e instanceof Error ? e.message : String(e)}]`,
  );
}

export function isTranscribableImage(
  part: Part,
  mimePrefixes: string[],
): part is FilePart {
  return part.type === "file" && mimePrefixes.some((p) => part.mime.startsWith(p));
}

export type TransformMessage = { info: Message; parts: Part[] };

function attachmentKey(a: FilePart): string {
  return a.id || a.url;
}

function formatToolDescriptions(images: FilePart[], cache: Map<string, string>): string {
  const header =
    images.length === 1
      ? "[Tool returned an image attachment. Vision description:]"
      : `[Tool returned ${images.length} image attachments. Vision descriptions:]`;
  const lines = images.map((img) => {
    const label = img.filename ? `Image "${img.filename}"` : "Image";
    return `${label}: ${cache.get(attachmentKey(img)) ?? ""}`;
  });
  return [header, ...lines].join("\n\n");
}

type FileTarget = { kind: "file"; parts: Part[]; index: number; image: FilePart };
type ToolTarget = { kind: "tool"; state: ToolStateCompleted; images: FilePart[]; rest: FilePart[] };

export async function transcribeMessages(
  messages: TransformMessage[],
  describe: DescribeFn,
  mimePrefixes: string[],
  cache: Map<string, string>,
): Promise<number> {
  const targets: Array<FileTarget | ToolTarget> = [];

  for (const msg of messages) {
    msg.parts.forEach((part, index) => {
      if (isTranscribableImage(part, mimePrefixes)) {
        targets.push({ kind: "file", parts: msg.parts, index, image: part });
        return;
      }
      if (part.type !== "tool" || part.state.status !== "completed") return;
      const state = part.state;
      const attachments = state.attachments;
      if (!attachments || attachments.length === 0) return;
      const images = attachments.filter((a) => matchesMime(a, mimePrefixes));
      if (images.length === 0) return;
      const rest = attachments.filter((a) => !matchesMime(a, mimePrefixes));
      targets.push({ kind: "tool", state, images, rest });
    });
  }
  if (targets.length === 0) return 0;

  const pending = new Map<string, FilePart>();
  const addPending = (img: FilePart) => {
    const key = attachmentKey(img);
    if (!cache.has(key) && !pending.has(key)) pending.set(key, img);
  };
  for (const target of targets) {
    if (target.kind === "file") addPending(target.image);
    else for (const img of target.images) addPending(img);
  }
  await Promise.all(
    [...pending.entries()].map(async ([key, img]) => {
      cache.set(key, await describeOrError(img, describe));
    }),
  );

  let count = 0;
  for (const target of targets) {
    if (target.kind === "file") {
      const file = target.image;
      target.parts[target.index] = {
        id: file.id,
        sessionID: file.sessionID,
        messageID: file.messageID,
        type: "text",
        text: cache.get(attachmentKey(file)) ?? "",
        synthetic: false,
      } satisfies TextPart;
      count += 1;
    } else {
      const described = formatToolDescriptions(target.images, cache);
      target.state.output =
        target.state.output.trim().length > 0
          ? `${target.state.output}\n\n${described}`
          : described;
      target.state.attachments = target.rest;
      count += target.images.length;
    }
  }
  return count;
}

export function getActiveModel(
  messages: TransformMessage[],
): { providerID: string; modelID: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role === "user" && info.model) return info.model;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role === "assistant" && info.providerID && info.modelID)
      return { providerID: info.providerID, modelID: info.modelID };
  }
  return undefined;
}
