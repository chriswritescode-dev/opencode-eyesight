# opencode-eyesight

OpenCode plugin that lets text-only models work with pasted images by sending each image to a vision-capable model first, then replacing the image with a text description.

## Installation

Add the plugin package to your OpenCode config with the vision model you want to use for image descriptions.

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

The `model` value must use OpenCode's provider/model format:

```text
ProviderID/ModelID
```

Use a model that supports image input. Your active chat model can be text-only; `opencode-eyesight` will use the configured vision model only to describe images.

## Usage

1. Select a text-only model in OpenCode.
2. Paste or attach an image.
3. Send your message.

If the active model does not support image input, the plugin sends the image to the configured vision model, replaces the image with the generated description, and then continues with the active model.

If the active model already supports image input, the plugin leaves the image untouched.

## Options

| Option | Required | Description |
| --- | --- | --- |
| `model` | Yes | Vision-capable OpenCode model in `ProviderID/ModelID` format. |
| `promptFile` | No | Markdown file containing the prompt used when asking the vision model to describe an image. Relative paths resolve from the OpenCode project directory. |
| `prompt` | No | Inline prompt used when asking the vision model to describe an image. Takes precedence over `promptFile`. |

## Development

```bash
bun run build
bun test
bun run typecheck
```
