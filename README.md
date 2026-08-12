# Markdown Reader with Copilot

**The most agent-friendly document review extension for VS Code and Cursor.**

Review and comment on **Markdown**, **Word (.docx)**, and **PowerPoint (.pptx)** documents — directly inside VS Code and Cursor. Add inline comments, reply in threads, resolve discussions, and let AI agents participate via 12 built-in Copilot tools, MCP server integration, direct Ask Copilot actions, and explicit Copy Prompt actions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Supported Formats

| Format | Preview | Comments | AI Tools | Save |
|--------|---------|----------|----------|------|
| **Markdown** (.md) | ✅ Rich rendering (KaTeX, Mermaid, GFM) | ✅ Block-level anchored | ✅ Full | PDF, DOCX export |
| **Word** (.docx) | ✅ Full document with styles | ✅ Native Word comments + review | ✅ Full + XML editing | ✅ Save .docx |
| **PowerPoint** (.pptx) | ✅ Slide rendering with shapes | ✅ Shape-level overlays | ✅ Full + XML editing + slide capture | ✅ Save .pptx |

---

## Quick Start

### 1. Open a Preview
- **Markdown**: Open any `.md` file → press **`Ctrl+Shift+R`** (Mac: `Cmd+Shift+R`), or right-click → **"Markdown Review: Open Markdown Preview"**
- **Word**: Right-click a `.docx` file in Explorer → **"Markdown Review: Open Word Document Preview"**
- **PowerPoint**: Right-click a `.pptx` file in Explorer → **"Markdown Review: Open PowerPoint Preview"**

### 2. Add Review Comments
- **Markdown**: Click the **`+`** gutter button next to any block
- **Word**: Click the **`+`** gutter button next to any paragraph
- **PowerPoint**: Hover over any shape and click **`+`**, or click **`+`** on slide corner

### 3. Enable AI Agent Tools
In **Copilot Agent Mode**, click **Tools** and enable the Document Review tools (prefixed with `#`). Then ask:
> *"Review this document and respond to all open comments"*

### 4. Send or Copy a Review Prompt
- **VS Code**: Select **Ask Copilot** to open the generated review prompt directly in Copilot Chat, or **Copy Prompt** to copy it.
- **Cursor and hosts without direct chat integration**: Use **Copy Prompt**, then paste the generated prompt into the agent composer.
- **Copy Prompt** is available when adding a comment, viewing a comment thread, reviewing a sidebar item, and sending all open comments.

---

## Features

### Rich Rendering
- **Markdown**: KaTeX math, Mermaid diagrams, GFM tables, syntax highlighting
- **Word**: Full document rendering with styles, images, tables, lists, math formulas (OMML → KaTeX)
- **PowerPoint**: Slide-by-slide rendering with shapes, text, colors, speaker notes

### Inline Commenting
- **"+" buttons** — Add comments on any block (markdown), paragraph (Word), or shape (PowerPoint)
- **Comment highlighting** — Commented elements are highlighted (yellow for review, green for Word native, blue for PPTX)
- **Popover details** — Click to see comment, replies, and actions (Reply, Resolve, Edit, Delete, Ask Copilot, Copy Prompt)
- **Sidebar panel** — Search, filter (All/Open/Resolved/User/Agent), and bulk actions

### Prompt Actions
- **Ask Copilot** — Available in VS Code when direct chat integration is supported. It sends the complete format-specific prompt to Copilot Chat.
- **Copy Prompt** — Copies the same complete prompt without opening or focusing chat. It does not copy only the visible comment text.
- **Portable tool references** — Because a copied prompt may be pasted into VS Code or an MCP-based agent, it includes both tool identifiers where they differ. For example: `#readReviewComment` (VS Code) or `docReview_read_comment` (MCP).
- **Host-aware controls** — Cursor and unknown hosts hide **Ask Copilot** and show the explicit **Copy Prompt** action instead.

### Native Comment Integration
- **Word**: Reads existing Word comments with author names and threading
- **PowerPoint**: Reads existing PPTX comments with author names
- Reply to native comments via sidecar — original document comments are preserved

### Document Editing (Word & PowerPoint)
- XML files are extracted for agent editing
- **File watcher** detects changes → auto-refreshes preview
- **Save button** repacks modified XML back into .docx/.pptx
- Copilot prompts include XML editing rules and format-specific guidance

### 12 AI Agent Tools

| Tool | Description | Formats |
|------|-------------|---------|
| `#listReviewComments` | List all comments with status and context | All |
| `#readReviewComment` | Read comment with replies and surrounding context | All |
| `#replyToReviewComment` | Reply to a comment as agent | All |
| `#resolveReviewComment` | Mark a comment as resolved | All |
| `#deleteReviewComment` | Delete a comment and its anchor | All |
| `#scrollToReviewComment` | Scroll preview/editor to a comment | All |
| `#captureReviewScreenshot` | Capture rendered preview as HTML | MD, Word |
| `#captureSlide` | Capture a slide as PNG image | PPTX |
| `#listElements` | List document elements with IDs | Word |
| `#readElementXml` | Read raw XML of a document element | Word |
| `#writeElementXml` | Replace an element's XML | Word |
| `#saveDocument` | Save changes back to .docx | Word |

### Export
- **PDF** — One-click export via Chrome headless (markdown)
- **DOCX** — One-click export via Pandoc with native Word equations (markdown)
- **Save .docx** — Save modified Word document back to file
- **Save .pptx** — Save modified PowerPoint back to file

### Cross-Reference Navigation (Markdown)
- **Preview → Source**: Double-click any block to jump to source
- **Source → Preview**: Cursor movement syncs preview scroll

---

## Cursor Support

Full support in **Cursor IDE** via an embedded MCP server that registers automatically.

- All preview, commenting, and export features work natively
- AI tools delivered via MCP server (12 tools registered in `~/.cursor/mcp.json`)
- **Copy Prompt** copies the complete format-specific review prompt for pasting into Composer
- Copied prompts include canonical MCP names such as `docReview_read_comment` alongside VS Code aliases, so the receiving agent can use the tools available in its host

---

## Agent App Plugin (Preview)

The separate [agent-plugin](agent-plugin) folder contains a Markdown-only Agent Plugin for the VS Code Agent App:

- `document-review` Agent Skill
- Self-contained stdio MCP server
- Interactive MCP App for reviewing comment threads
- **Prepare for Agent** fills the owning conversation's composer
- **Copy Prompt** provides an explicit clipboard fallback

The dedicated Agents window currently uses the compact inline MCP review UI; the full native Markdown Review preview remains available in the main VS Code window. VS Code does not auto-submit messages prepared by an MCP App, so review the populated composer and send it yourself. Word and PowerPoint support are deferred for this plugin preview; the VS Code extension continues to support them.

---

## Architecture

```
src/
  extension.ts    — Commands, editor detection, tool/MCP registration
  preview.ts      — Webview panel for all 3 formats
  comment-ui.ts   — Shared comment UI (CSS, JS, prompts) for all formats
  comments.ts     — CommentsManager for JSON sidecar CRUD
  tools.ts        — 12 Copilot tool implementations
  mcp-server.ts   — MCP server (12 tools for Cursor & MCP clients)
  docx-parser.ts  — Word document parser (OOXML → HTML)
  pptx-parser.ts  — PowerPoint parser (OOXML → slide model)
media/
  pptx-viewer.js  — PPTX renderer (browser-native slide rendering)
  html-to-image.min.js — DOM-to-PNG capture (for slide screenshots)
  mermaid.min.js  — Mermaid diagram renderer
```

---

## Development

```bash
npm install

# Bundle both entry points (extension + MCP server)
npm run bundle

# Build and test the standalone Markdown Agent Plugin
npm run build:agent-plugin
npm run test:agent-plugin

# Package VSIX
npx vsce package --no-dependencies --allow-missing-repository
```

> ⚠️ Both `src/extension.ts` **and** `src/mcp-server.ts` must be bundled — the MCP server runs as a separate Node process spawned by Cursor and has no access to `node_modules`. `npm run bundle` handles both via the `bundle:extension` and `bundle:mcp` scripts in `package.json`.

### Run tests
```bash
node test/test-comment-ui.js        # Unit tests for shared comment UI
node test/test-slide-capture.js     # E2E slide capture (requires Playwright)
node test/test-scroll-exact.js      # E2E click-to-scroll
node test/test-mermaid-edge-fix.js  # E2E mermaid rendering via Chrome/Edge headless
```

---

## Requirements

- **VS Code** 1.93.0+ or **Cursor** (latest)
- **Chrome** (optional) — for PDF export
- **Pandoc** (optional) — for DOCX export from markdown

---

## Version History

| Version | Highlights |
|---------|-----------|
| **5.2.6** | Wait for the Agents composer focus transition before inserting Ask Copilot prompts |
| **5.2.5** | Restore reliable Ask Copilot composer prefill in the Agents window, add clipboard fallback, and expose the review-comments badge as an accessible button |
| **5.2.4** | Add Markdown Review to Open With and send Ask Copilot prompts through the active Agents conversation |
| **5.2.3** | Remove the unintended Copy Comment action and include both VS Code and MCP tool identifiers in copied prompts |
| **5.2.2** | Add explicit Copy Prompt actions across comment dialogs, threads, and bulk review; Cursor now uses copy-only prompt handoff |
| **5.1.8** | Bundle MCP server with esbuild so it loads in Cursor without `node_modules` (fixes `MODULE_NOT_FOUND` for `@modelcontextprotocol/sdk`) |
| **5.1.7** | DOCX export progress notification |
| **5.1.6** | Friendly error when DOCX export is blocked by Word holding the file |
| **5.1.5** | Fix DOCX numbered lists jammed when no blank line before list |
| **5.1.4** | Fix Edge headless mermaid/PDF export on Windows (resolve real `msedge.exe` via versioned subdir, wait for async file writes) |
| **5.1.2** | Fix mermaid rendering — use OS temp dir, `pathToFileURL`, and local `mermaid.min.js` |
| **5.1.1** | Add Edge as fallback browser for Mermaid rendering and PDF export |
| **5.1.0** | State persistence across re-renders, scroll fix, KaTeX in Word, slide capture |
| **5.0.0** | 🎉 PowerPoint (.pptx) support: slide rendering, shape-level commenting, XML editing, slide capture as PNG, save .pptx. Shared comment UI module. KaTeX math in Word preview. 12 tools (was 7). |
| **4.5.x** | Word (.docx) support: preview, native comments, XML editing, save .docx |
| **4.1.x** | Cursor IDE support via MCP server |
| **4.0.0** | ✨ Ask Copilot buttons, popover persistence, DOCX table borders |
| **3.7.x** | Mermaid diagrams, Ctrl+Shift+R keybinding |
| **3.0.x** | 7 Copilot tools for agent mode |
| **2.1.0** | First stable release — anchor-based commenting |

---

## License

[MIT](LICENSE)
