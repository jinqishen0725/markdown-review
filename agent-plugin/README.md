# Markdown Review Agent Plugin

This is the standalone, Markdown-only Agent Plugin for the VS Code Agent App. It is separate from the VS Code extension and includes:

- A `document-review` Agent Skill.
- A bundled stdio MCP server.
- Markdown comment list/read/reply/resolve/reopen/delete tools.
- An interactive MCP App with blue block-level `+` buttons, `Prepare for Agent`, and `Copy Prompt` actions.

`Prepare for Agent` fills the owning conversation's composer. VS Code does not auto-submit MCP App messages, so review and send the prepared prompt yourself.

The dedicated Agents window currently supports this MCP App as a compact inline chat widget. The full native **Markdown Review: Open Markdown Preview** experience, including blue gutter `+` buttons, remains available in the main VS Code window.

## Build And Test

From the repository root:

```powershell
npm run build:agent-plugin
npm run test:agent-plugin
```

The built plugin is self-contained under this folder. Its runtime files are in `dist/` and do not require repository `node_modules`.

## Local Installation

Until this plugin is published through a marketplace, register the folder in VS Code user settings:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "Q:/source/repos/markdown-review/agent-plugin": true
  }
}
```

Reload VS Code, open Agent Customizations, and verify that the `markdown-review` plugin, `document-review` skill, and `markdown-review` MCP server are enabled.

## Current Scope

- Supported: Markdown sidecar comments created by the Markdown Review extension.
- Deferred: Word, PowerPoint, native preview scrolling, and slide capture.