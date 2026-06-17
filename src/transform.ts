import type { Part, FilePart, TextPart, ToolStateCompleted, Message } from "@opencode-ai/sdk";

export type DescribeFn = (part: FilePart, userText: string) => Promise<string>;

function matchesMime(a: FilePart, mimePrefixes: string[]): boolean {
  return mimePrefixes.some((p) => a.mime.startsWith(p));
}

async function describeOrError(file: FilePart, userText: string, describe: DescribeFn): Promise<string> {
  return describe(file, userText).catch(
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

function cacheKey(image: FilePart, userText: string): string {
  return userText ? `${attachmentKey(image)}\u0000${userText}` : attachmentKey(image);
}

export function messageText(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function formatToolDescriptions(images: FilePart[], cache: Map<string, string>, userText: string): string {
  const header =
    images.length === 1
      ? "[Tool returned an image attachment. Vision description:]"
      : `[Tool returned ${images.length} image attachments. Vision descriptions:]`;
  const lines = images.map((img) => {
    const label = img.filename ? `Image "${img.filename}"` : "Image";
    return `${label}: ${cache.get(cacheKey(img, userText)) ?? ""}`;
  });
  return [header, ...lines].join("\n\n");
}

function formatUserImageDescription(index: number, description: string, includeLabel: boolean): string {
  if (!includeLabel) return description;
  return `[Image ${index} vision description:]\n${description}`;
}

type FileTarget = { kind: "file"; parts: Part[]; index: number; image: FilePart; userText: string };
type ToolTarget = { kind: "tool"; state: ToolStateCompleted; images: FilePart[]; rest: FilePart[]; userText: string };

function splitToolAttachments(
  part: Part,
  mimePrefixes: string[],
): { state: ToolStateCompleted; images: FilePart[]; rest: FilePart[] } | undefined {
  if (part.type !== "tool" || part.state.status !== "completed") return undefined;
  const attachments = part.state.attachments;
  if (!attachments || attachments.length === 0) return undefined;

  const images: FilePart[] = [];
  const rest: FilePart[] = [];
  for (const attachment of attachments) {
    if (matchesMime(attachment, mimePrefixes)) images.push(attachment);
    else rest.push(attachment);
  }
  if (images.length === 0) return undefined;
  return { state: part.state, images, rest };
}

export function collectTranscriptionTargets(
  messages: TransformMessage[],
  mimePrefixes: string[],
): Array<FileTarget | ToolTarget> {
  const targets: Array<FileTarget | ToolTarget> = [];
  let currentUserText = "";

  for (const msg of messages) {
    let msgUserText: string | undefined;
    const getMsgUserText = () => (msgUserText ??= messageText(msg.parts));
    if (msg.info.role === "user") currentUserText = getMsgUserText();

    msg.parts.forEach((part, index) => {
      if (isTranscribableImage(part, mimePrefixes)) {
        targets.push({ kind: "file", parts: msg.parts, index, image: part, userText: getMsgUserText() });
        return;
      }
      const split = splitToolAttachments(part, mimePrefixes);
      if (!split) return;
      targets.push({ kind: "tool", ...split, userText: currentUserText });
    });
  }

  return targets;
}

export function currentRequestMessages(messages: TransformMessage[]): TransformMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") return messages.slice(i);
  }
  return messages;
}

export function hasTranscriptionTargets(messages: TransformMessage[], mimePrefixes: string[]): boolean {
  return collectTranscriptionTargets(messages, mimePrefixes).length > 0;
}

export function toolImageAttachments(part: Part, mimePrefixes: string[]): FilePart[] {
  return splitToolAttachments(part, mimePrefixes)?.images ?? [];
}

export async function transcribeMessages(
  targets: Array<FileTarget | ToolTarget>,
  describe: DescribeFn,
  cache: Map<string, string>,
): Promise<number> {
  if (targets.length === 0) return 0;

  const pending = new Map<string, { img: FilePart; userText: string }>();
  const addPending = (img: FilePart, userText: string) => {
    const key = cacheKey(img, userText);
    if (!cache.has(key) && !pending.has(key)) pending.set(key, { img, userText });
  };
  for (const target of targets) {
    if (target.kind === "file") addPending(target.image, target.userText);
    else for (const img of target.images) addPending(img, target.userText);
  }
  await Promise.all(
    [...pending.entries()].map(async ([key, { img, userText }]) => {
      cache.set(key, await describeOrError(img, userText, describe));
    }),
  );

  const fileTargetCounts = new Map<Part[], number>();
  const fileTargetIndexes = new Map<FileTarget, number>();
  for (const target of targets) {
    if (target.kind === "file") {
      const index = (fileTargetCounts.get(target.parts) ?? 0) + 1;
      fileTargetCounts.set(target.parts, index);
      fileTargetIndexes.set(target, index);
    }
  }

  let count = 0;
  for (const target of targets) {
    if (target.kind === "file") {
      const file = target.image;
      const description = cache.get(cacheKey(file, target.userText)) ?? "";
      target.parts[target.index] = {
        id: file.id,
        sessionID: file.sessionID,
        messageID: file.messageID,
        type: "text",
        text: formatUserImageDescription(
          fileTargetIndexes.get(target) ?? 1,
          description,
          (fileTargetCounts.get(target.parts) ?? 0) > 1,
        ),
        synthetic: false,
      } satisfies TextPart;
      count += 1;
    } else {
      const described = formatToolDescriptions(target.images, cache, target.userText);
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
