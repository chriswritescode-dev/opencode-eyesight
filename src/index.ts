import { randomBytes } from "node:crypto";
import { createDescriber, resolveSettings, type ModelRef, type VisionSession } from "./vision";
import { systemNotice, transcribeMessages, withCache, withLimit, type Message } from "./transform";

interface RequestEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  system: { type: "text"; text: string }[];
  messages: Message[];
  tools?: Record<string, unknown>;
}

/** The part of the OpenCode v2 plugin context this plugin uses. */
export interface Host {
  options?: Record<string, unknown>;
  model: {
    list(): Promise<{
      data: readonly { id: string; providerID: string; capabilities: { input: readonly string[] } }[];
    }>;
  };
  session: VisionSession & {
    hook(kind: "context" | "compaction", callback: (event: RequestEvent) => Promise<void>): Promise<unknown>;
  };
}

export interface Deps {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Deadline for the model-capability lookup. */
  lookupTimeoutMs?: number;
}

export function createEyesight(deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const debug = !!env.EYESIGHT_DEBUG;
  const log = (message: string) => console.error(`opencode-eyesight: ${message}`);

  return {
    id: "eyesight",
    async setup(ctx: Host) {
      let settings;
      try {
        settings = await resolveSettings(ctx.options, env);
      } catch (error) {
        log(`disabled: ${error instanceof Error ? error.message : "invalid options"}`);
        return;
      }
      if (!settings) {
        log("disabled: set the model option (providerID/modelID) or OPENCODE_VISION_MODEL");
        return;
      }

      const internal = new Set<string>();
      // Cache outside the limiter: a cache hit, or a duplicate of an in-flight image, never waits for a slot.
      const describe = withCache(
        withLimit(createDescriber(ctx.session, settings, internal, log, deps.timeoutMs, debug)),
        `${settings.model.providerID}/${settings.model.id}`,
      );
      const nonce = randomBytes(8).toString("hex");
      const capability = new Map<string, boolean>();

      // true/false when the model is known to accept (or not accept) images, undefined when unknown.
      const acceptsImages = async (model: ModelRef): Promise<boolean | undefined> => {
        const key = `${model.providerID}/${model.id}`;
        const known = capability.get(key);
        if (known !== undefined) return known;
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const listed = await Promise.race([
            ctx.model.list(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), deps.lookupTimeoutMs ?? 5_000);
            }),
          ]).finally(() => clearTimeout(timer));
          const found = listed.data.find((m) => m.providerID === model.providerID && m.id === model.id);
          if (!found) return undefined;
          const result = found.capabilities.input.includes("image");
          capability.set(key, result);
          return result;
        } catch {
          return undefined;
        }
      };

      const onRequest = async (event: RequestEvent) => {
        try {
          // Our own vision sessions: no tools, whatever their permissions say, and no transcription.
          if (internal.has(event.sessionID)) {
            const before = Object.keys(event.tools ?? {}).length;
            for (const name of Object.keys(event.tools ?? {})) delete event.tools![name];
            event.system.length = 0;
            event.system.push({ type: "text", text: settings.prompt });
            if (debug) log(`vision session request: tools ${before} -> ${Object.keys(event.tools ?? {}).length}`);
            return;
          }
          const key = `${event.model.providerID}/${event.model.id}`;
          const accepts = await acceptsImages(event.model);
          if (accepts === undefined) {
            log(`image capability of ${key} unknown, request left unchanged`);
            return;
          }
          if (accepts) {
            if (debug) log(`${key} accepts images, nothing to do`);
            return;
          }
          const { messages, count } = await transcribeMessages(event.messages, describe, nonce);
          event.messages = messages;
          event.system.push({ type: "text", text: systemNotice(nonce) });
          if (debug) log(`${key} is text-only, handled ${count} image(s)`);
        } catch (error) {
          log(`request left unchanged after ${error instanceof Error ? error.name : "error"}`);
        }
      };

      await ctx.session.hook("context", onRequest);
      await ctx.session.hook("compaction", onRequest);
    },
  };
}

export default createEyesight();
