# opencode-eyesight

OpenCode plugin that lets text-only models work with user-provided and tool-returned images by sending each image through a built-in vision agent first, then replacing the image with a text description.

## Installation

Add the plugin package to your OpenCode config with the vision model you want the built-in `vision` agent to use for image descriptions.

```jsonc
{
  "plugin": [
    ["opencode-eyesight", { "model": "Provider/Model", "promptFile": "/path/to/prompt.md" }]
  ]
}
```

Example:

```jsonc
{
  "plugin": [
    ["opencode-eyesight", { "model": "lmstudio/Qwen3.6-27B", "promptFile": "./image-prompt.md" }]
  ]
}
```

For local development before publishing, use the project path instead:

```jsonc
{
  "plugin": [
    ["/Users/chris/development/opencode-eyesight", { "model": "lmstudio/Qwen3.6-27B", "promptFile": "./image-prompt.md" }]
  ]
}
```

A `model` value must use OpenCode's provider/model format:

```text
ProviderID/ModelID
```

Use a model that supports image input. Your active chat model can be text-only; `opencode-eyesight` registers a read-only `vision` subagent using the configured model and uses it only to describe images.

To customize the agent, define `vision` in `~/.config/opencode/agents/vision.md` or `.opencode/agents/vision.md`. Your agent fields override the plugin defaults, including its model, prompt, tools, and permissions.

## Usage

1. Select a text-only model in OpenCode.
2. Paste or attach an image.
3. Send your message.

If the active model does not support image input, the plugin sends the image to the configured vision model and substitutes the generated description for the image in the request sent to the active model. The substitution happens per request, so the original image is preserved in your session history and is sent as-is if you later switch to a vision-capable model.

If the active model already supports image input, the plugin leaves the image untouched.

Images returned by MCP or tool calls (e.g. screenshots) are handled the same way: when the active model is text-only, the description is appended to the tool's output text and the image attachment is removed from the request, while non-image attachments are preserved. Both pasted images and tool images share a process-lifetime cache, so repeated identical images with the same user context are described only once.

When you send a pasted image with an accompanying message, that message is included in the prompt to the vision model so the description is tailored to it. For images returned by MCP or tool calls, the most recent user message is used as context for the description, providing relevant framing.

## Options

| Option | Required | Description |
| --- | --- | --- |
| `model` | Yes | Default vision-capable OpenCode model for the built-in `vision` agent, in `ProviderID/ModelID` format. |
| `promptFile` | No | Markdown file containing the built-in agent's prompt. Relative paths resolve from the OpenCode project directory. |
| `prompt` | No | Inline prompt for the built-in agent. Takes precedence over `promptFile`. |

The model can also be supplied through `OPENCODE_VISION_FALLBACK_MODEL`. A user-defined `vision` agent takes precedence over the corresponding built-in defaults.

## Development

```bash
bun run build
bun test
bun run typecheck
```
