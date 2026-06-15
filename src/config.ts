export interface VisionFallbackConfig {
  providerID: string;
  modelID: string;
  prompt: string;
  mimePrefixes: string[];
}

export const DEFAULT_PROMPT = `Describe this image thoroughly. Transcribe all visible text verbatim, identify UI elements (buttons, dialogs, input fields, menus), list objects and people, describe layout and spatial relationships, and state the overall purpose or context. Be concise but complete so a blind user can fully understand what is shown.`;

export function parseModel(
  model: string,
): { providerID: string; modelID: string } | undefined {
  const idx = model.indexOf("/");
  if (idx === -1) return undefined;
  const providerID = model.slice(0, idx);
  const modelID = model.slice(idx + 1);
  if (providerID.length === 0 || modelID.length === 0) return undefined;
  return { providerID, modelID };
}

export function resolveConfig(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
): VisionFallbackConfig | undefined {
  const modelStr =
    typeof options?.model === "string"
      ? options.model
      : env.OPENCODE_VISION_FALLBACK_MODEL;

  if (!modelStr) return undefined;

  const parsed = parseModel(modelStr);
  if (!parsed) return undefined;

  const prompt =
    typeof options?.prompt === "string"
      ? options.prompt
      : env.OPENCODE_VISION_FALLBACK_PROMPT ?? DEFAULT_PROMPT;

  return {
    ...parsed,
    prompt,
    mimePrefixes: ["image/"],
  };
}
