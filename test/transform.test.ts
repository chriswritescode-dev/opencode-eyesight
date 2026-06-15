import { test, expect } from "bun:test";
import {
  transcribeImageParts,
  isTranscribableImage,
  type DescribeFn,
} from "../src/transform";
import type { FilePart, TextPart, Part } from "@opencode-ai/sdk";

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

test("transcribeImageParts replaces one image FilePart in place", async () => {
  const image = makeFilePart();
  const text = makeTextPart();
  const parts: Part[] = [image, text];

  const describe: DescribeFn = async () => "a red square";

  const count = await transcribeImageParts(parts, describe, ["image/"]);

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

test("transcribeImageParts replaces two image parts", async () => {
  const img1 = makeFilePart({ filename: "img1.png" });
  const img2 = makeFilePart({ filename: "img2.png" });
  const parts: Part[] = [img1, img2];

  let callCount = 0;
  const describe: DescribeFn = async () => {
    callCount++;
    return `description-${callCount}`;
  };

  const count = await transcribeImageParts(parts, describe, ["image/"]);
  expect(count).toBe(2);
  expect(callCount).toBe(2);
  expect((parts[0] as TextPart).text).toBe("description-1");
  expect((parts[1] as TextPart).text).toBe("description-2");
});

test("transcribeImageParts skips non-image file parts", async () => {
  const pdf = makeFilePart({ mime: "application/pdf", filename: "doc.pdf" });
  const text = makeTextPart();
  const parts: Part[] = [pdf, text];

  const describe: DescribeFn = async () => "should not be called";
  const count = await transcribeImageParts(parts, describe, ["image/"]);
  expect(count).toBe(0);
  expect((parts[0] as FilePart).type).toBe("file");
});

test("transcribeImageParts returns 0 when no image parts exist", async () => {
  const parts: Part[] = [makeTextPart(), makeTextPart()];
  const describe: DescribeFn = async () => "should not be called";
  const count = await transcribeImageParts(parts, describe, ["image/"]);
  expect(count).toBe(0);
  expect(parts).toHaveLength(2);
});

test("transcribeImageParts handles describe throwing an error", async () => {
  const image = makeFilePart({ filename: "broken.png" });
  const parts: Part[] = [image];

  const describe: DescribeFn = async () => {
    throw new Error("API error");
  };

  const count = await transcribeImageParts(parts, describe, ["image/"]);
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
