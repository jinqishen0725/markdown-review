# Markdown Review Agent Plugin

This is the standalone, Markdown-only Agent Plugin for the VS Code Agent App. It is separate from the VS Code extension and includes:

- A `document-review` Agent Skill.
- A bundled stdio MCP server.
- Markdown comment list/read/reply/resolve/reopen/delete tools.

## Visual Review Requirement

This plugin intentionally does not include an inline MCP App. For the full third-pane Markdown Review editor, blue gutter `+` buttons, and Ask Copilot actions, install the companion [Markdown Reader with Copilot extension](https://marketplace.visualstudio.com/items?itemName=JinqiShen.markdown-review).

The plugin remains usable by itself for agent-driven Markdown comment operations through its MCP tools. Agent Plugin marketplaces cannot install the companion VS Code extension automatically, so VS Code users must install both entries for the complete visual experience.

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