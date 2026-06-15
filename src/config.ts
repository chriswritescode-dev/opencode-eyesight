export interface VisionFallbackConfig {
  providerID: string;
  modelID: string;
  prompt: string;
  mimePrefixes: string[];
}

export type PromptFileReader = (path: string) => Promise<string>;

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

export async function resolveConfig(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  readPromptFile?: PromptFileReader,
): Promise<VisionFallbackConfig | undefined> {
  const modelStr =
    typeof options?.model === "string"
      ? options.model
      : env.OPENCODE_VISION_FALLBACK_MODEL;

  if (!modelStr) return undefined;

  const parsed = parseModel(modelStr);
  if (!parsed) return undefined;

  const prompt = await resolvePrompt(options, env, readPromptFile);

  return {
    ...parsed,
    prompt,
    mimePrefixes: ["image/"],
  };
}

async function resolvePrompt(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  readPromptFile?: PromptFileReader,
): Promise<string> {
  if (typeof options?.prompt === "string") return options.prompt;

  const promptFile =
    typeof options?.promptFile === "string"
      ? options.promptFile
      : env.OPENCODE_VISION_FALLBACK_PROMPT_FILE;

  if (promptFile && readPromptFile) {
    const prompt = (await readPromptFile(promptFile)).trim();
    if (prompt.length > 0) return prompt;
  }

  return env.OPENCODE_VISION_FALLBACK_PROMPT ?? DEFAULT_PROMPT;
}
