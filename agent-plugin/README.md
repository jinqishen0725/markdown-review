# Markdown Review Agent Plugin

This is the standalone, Markdown-only Agent Plugin for the VS Code Agent App. It is separate from the VS Code extension and includes:

- A `document-review` Agent Skill.
- A bundled stdio MCP server.
- Markdown comment list/read/reply/resolve/reopen/delete tools.
- An interactive Markdown Review canvas with rendered content, gutter comment controls, threads, filters, and prompt handoff.

## Canvas And VS Code Extension

The bundled canvas provides the visual Markdown comment workflow from one plugin installation. It reuses the same Markdown renderer, comment controls, prompt builders, sidecar format, and review store as the existing implementation.

Install the companion [Markdown Reader with Copilot extension](https://marketplace.visualstudio.com/items?itemName=JinqiShen.markdown-review) for VS Code custom-editor integration, inline rendered editing and differences, source navigation, export, Word, and PowerPoint support. Agent Plugin marketplaces cannot install the VS Code extension automatically.

## Build And Test

From the repository root:

```powershell
npm run build:agent-plugin
npm run test:agent-plugin
```

The built plugin is self-contained under this folder. Its canonical manifest is `.github/plugin/plugin.json`, its MCP runtime is in `dist/`, and its Canvas extension is in `extensions/`. Neither requires repository `node_modules` at runtime.

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

Reload the Agent host and verify that the `markdown-review` plugin, `document-review` skill, `markdown-review` MCP server, and **Markdown Review** canvas are enabled.

## Current Scope

- Canvas: rendered Markdown, local images, comment CRUD and threads, filters, bulk actions, Copy Prompt, and Ask Copilot. In an untouched Agent App conversation, Canvas opens a selectable prompt dialog because it cannot prefill the composer and embedded WebViews may deny direct clipboard access.
- MCP: agent-driven Markdown comment operations with the same anchors and sidecar files.
- Companion VS Code extension: inline editing/differences, export, source synchronization, Word, and PowerPoint.