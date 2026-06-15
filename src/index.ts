import type { Plugin } from "@opencode-ai/plugin";
import type { FilePart } from "@opencode-ai/sdk";
import { resolveConfig } from "./config";
import { makeCapabilityLookup } from "./capabilities";
import { transcribeImageParts } from "./transform";

export const VisionFallback: Plugin = async (input, options) => {
  const cfg = resolveConfig(options, process.env);
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

  const describe = async (part: FilePart): Promise<string> => {
    const created = await input.client.session.create({
      body: { title: "vision-fallback" },
    });
    if (created.error || !created.data) throw new Error("vision session create failed");
    const sid = created.data.id;
    internalSessions.add(sid);
    try {
      const res = await input.client.session.prompt({
        path: { id: sid },
        body: {
          model: { providerID: cfg.providerID, modelID: cfg.modelID },
          system: cfg.prompt,
          parts: [
            { type: "text", text: "Describe this image in detail." },
            { type: "file", mime: part.mime, filename: part.filename, url: part.url },
          ],
        },
      });
      if (res.error || !res.data) throw new Error("vision session prompt failed");
      return (res.data.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text!)
        .join("\n")
        .trim();
    } finally {
      internalSessions.delete(sid);
      await input.client.session.delete({ path: { id: sid } }).catch(() => {});
    }
  };

  return {
    "chat.message": async (hookInput, output) => {
      if (!hookInput.model) return;
      if (internalSessions.has(hookInput.sessionID)) return;
      const { providerID, modelID } = hookInput.model;
      if (providerID === cfg.providerID && modelID === cfg.modelID) return;
      if (
        !output.parts.some(
          (p) => p.type === "file" && cfg.mimePrefixes.some((m) => p.mime.startsWith(m)),
        )
      )
        return;
      if (await lookup(providerID, modelID)) return;
      await transcribeImageParts(output.parts, describe, cfg.mimePrefixes);
    },
  };
};

export default VisionFallback;
