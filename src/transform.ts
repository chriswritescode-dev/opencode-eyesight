import type { Part, FilePart, TextPart } from "@opencode-ai/sdk";

export type DescribeFn = (part: FilePart) => Promise<string>;

export function isTranscribableImage(
  part: Part,
  mimePrefixes: string[],
): part is FilePart {
  return part.type === "file" && mimePrefixes.some((p) => part.mime.startsWith(p));
}

/**
 * Transcribes image parts in-place, replacing them with text parts.
 * Returns the count of replaced parts.
 * Thrown errors from `describe` are caught and replaced with a fallback text.
 */
export async function transcribeImageParts(
  parts: Part[],
  describe: DescribeFn,
  mimePrefixes: string[],
): Promise<number> {
  const indices = parts
    .map((p, i) => (isTranscribableImage(p, mimePrefixes) ? i : -1))
    .filter((i) => i >= 0);

  if (indices.length === 0) return 0;

  await Promise.all(
    indices.map(async (i) => {
      const file = parts[i] as FilePart;
      const text = await describe(file).catch(
        (e: unknown) =>
          `[Image "${file.filename ?? "image"}" could not be transcribed: ${e instanceof Error ? e.message : String(e)}]`,
      );
      parts[i] = {
        id: file.id,
        sessionID: file.sessionID,
        messageID: file.messageID,
        type: "text",
        text,
        synthetic: false,
      } satisfies TextPart;
    }),
  );

  return indices.length;
}
