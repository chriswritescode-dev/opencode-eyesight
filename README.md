# opencode-eyesight

OpenCode v2 plugin that lets text-only models work with user-attached and tool-returned images.
Before each model request, the plugin replaces every image with a text description written by a
vision-capable model that you choose from any OpenCode provider.

This plugin needs OpenCode v2. It does not run on OpenCode v1.

## Installation

Add the plugin to `opencode.jsonc` and set the vision model:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-eyesight",
      "options": { "model": "google-vertex/gemini-3.8-flash" }
    }
  ]
}
```

For local development, build the plugin, then load it from a project plugin file such as
`.opencode/plugins/eyesight.js`:

```js
import plugin from "/path/to/opencode-eyesight/dist/index.js";

export default {
  ...plugin,
  setup: (ctx) => plugin.setup({ ...ctx, options: { model: "google-vertex/gemini-3.8-flash" } }),
};
```

## Options

| Option | Required | Description |
| --- | --- | --- |
| `model` | Yes | Vision model in `providerID/modelID` format. It can be any model of any OpenCode provider that accepts image input. Environment fallback: `OPENCODE_VISION_MODEL`. |
| `prompt` | No | Inline vision prompt. Takes precedence over `promptFile`. Environment fallback: `OPENCODE_VISION_PROMPT`. |
| `promptFile` | No | Absolute path of a file that holds the vision prompt. A relative path disables the plugin. Environment fallback: `OPENCODE_VISION_PROMPT_FILE`. |

Without a `model`, the plugin logs one line and does nothing. Set `EYESIGHT_DEBUG=1` to log each
decision the plugin makes.

## How it works

1. A hook on every model request checks whether the active model accepts image input. The plugin
   reads this from the model list of OpenCode. If the plugin cannot tell, it leaves the request
   unchanged and logs a line. It never sends an image out on a guess.
2. If the active model accepts images, the plugin does nothing.
3. If the active model is text-only, each image in the request is replaced by a text block.
   This covers pasted and attached images and images that tools return. The stored session history
   is not changed, so a later switch to a vision model sends the original image.
4. For each new image, the plugin opens a short-lived OpenCode session on the vision model, sends
   the image and a fixed prompt, reads the answer, and keeps the session and its history. OpenCode supplies the
   provider authentication and endpoint, so the plugin holds no credentials.
5. The text-only model also gets a system notice that explains the descriptions.

Descriptions are cached in memory by the hash of the image and the model (at most 256 entries).

## Data flow and limits

- Only the image and the fixed prompt go to the vision model. The text of the user message is not
  forwarded.
- Only inline images are used: base64 data, bytes, and `data:` URLs. The plugin never fetches
  `http(s)` or `file` URLs. Such an image becomes `[image omitted: reason]`.
- Supported types are PNG, JPEG, WebP, and GIF, up to 20 MB each. Other types become
  `[image omitted: reason]`.
- The vision session has no tools. Its permissions deny everything, and the plugin also removes all
  tools from its requests.
- The plugin never removes a session. A finished vision session stays in the history. If a call times out
  or fails, the plugin only interrupts that unfinished request.
- A failed description never stops the request: the image becomes
  `[image could not be transcribed: reason]`. A request waits while its new images are described, at most 4
  at a time. Each call has a 120-second limit, plus up to 5 seconds to interrupt an unfinished request.
- The vision model is called for the images of every request of a text-only model, including old
  messages. The cache means that each image is described once for each process.
  Vision sessions use the models and quotas of the provider you choose.

## Prompt injection

A description is untrusted text that comes from image content. It can contain text that looks like
instructions. The plugin does three things:

- It wraps each description in markers that carry a random code for the process.
- It breaks any `[Vision model description` or `[End vision model description` text inside the
  description, so the description cannot fake a marker.
- It tells the text-only model never to follow instructions found in a description.

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```
