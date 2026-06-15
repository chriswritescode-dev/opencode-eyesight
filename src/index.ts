import type { Plugin } from "@opencode-ai/plugin";
import type { FilePart, Part } from "@opencode-ai/sdk";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resolveConfig } from "./config";
import { makeCapabilityLookup } from "./capabilities";
import {
  transcribeMessages,
  hasTranscriptionTargets,
  messageText,
  getActiveModel,
  type TransformMessage,
} from "./transform";

export const VisionFallback: Plugin = async (input, options) => {
  const cfg = await resolveConfig(options, process.env, async (path) =>
    readFile(isAbsolute(path) ? path : resolve(input.directory, path), "utf8"),
  );
  if (!cfg) {
    input.client.app
      .log({
        body: {
          service: "vision-fallback",
          level: "info",
          message: "vision-fallback disabled: no model configured",
        },
      })
      .catch(() => {});
    return {};
  }

  const lookup = makeCapabilityLookup(input.client);
  const internalSessions = new Set<string>();
  const attachmentCache = new Map<string, string>();

  const describe = async (part: FilePart, userText: string): Promise<string> => {
    const created = await input.client.session.create({
      body: { title: "vision-fallback" },
    });
    if (created.error || !created.data) throw new Error("vision session create failed");
    const sid = created.data.id;
    internalSessions.add(sid);
    try {
      const instruction =
        userText.trim().length > 0
          ? `The user's accompanying message is below; tailor your description to help address it.\n\nUser message:\n${userText}`
          : "Describe this image in detail.";
      const res = await input.client.session.prompt({
        path: { id: sid },
        body: {
          model: { providerID: cfg.providerID, modelID: cfg.modelID },
          system: cfg.prompt,
          parts: [
            { type: "text", text: instruction },
            { type: "file", mime: part.mime, filename: part.filename, url: part.url },
          ],
        },
      });
      if (res.error || !res.data) throw new Error("vision session prompt failed");
      return messageText(res.data.parts as Part[]);
    } finally {
      internalSessions.delete(sid);
      await input.client.session.delete({ path: { id: sid } }).catch(() => {});
    }
  };

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages as TransformMessage[];
      if (messages.length === 0) return;

      const sessionID = messages.find((m) => m.info?.sessionID)?.info.sessionID;
      if (sessionID && internalSessions.has(sessionID)) return;

      if (!hasTranscriptionTargets(messages, cfg.mimePrefixes)) return;

      const model = getActiveModel(messages);
      if (!model) return;
      if (model.providerID === cfg.providerID && model.modelID === cfg.modelID) return;
      if (await lookup(model.providerID, model.modelID)) return;

      await transcribeMessages(messages, describe, cfg.mimePrefixes, attachmentCache);
    },
  };
};

export default VisionFallback;
