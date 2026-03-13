# Markdown Review

**The most agent-friendly markdown review extension for VS Code.**

Markdown Review brings Quip/Google Docs-style inline commenting to your markdown files — directly inside VS Code. Add comments, reply in threads, resolve discussions, and let AI agents participate in the review via 7 built-in Copilot tools. Perfect for document reviews, design proposals, and technical specifications.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Features

### Inline Commenting
- **"+" gutter buttons** — Click the `+` button next to any block (heading, paragraph, table, formula, list item, blockquote) to add a review comment
- **Comment highlighting** — Commented blocks are highlighted with a yellow border
- **Popover details** — Click a highlighted block to see the comment, replies, and actions
- **Sidebar comment list** — Click the comment badge to see all comments in a panel

### Threaded Replies with Roles
- Reply to any comment from the popover or sidebar
- **User** and **Agent** role badges — user comments show a blue badge, agent replies show purple
- Edit comments and replies inline

### Cross-Reference Jumping
- **Preview → Source**: Double-click any block in the preview to jump to that line in the editor
- **Source → Preview**: Move your cursor in the editor and the preview scrolls to match

### Export
- **PDF Export** — One-click export via Chrome headless (no headers/footers, KaTeX formulas preserved)
- **DOCX Export** — One-click export via Pandoc with native Word equations (OMML)

### 7 Copilot Tools for Agent Mode
This is what makes Markdown Review uniquely **agent-friendly**. When you enable the extension's tools in Copilot Agent Mode, AI agents can:

| Tool | Description |
|---|---|
| `#listReviewComments` | List all comments with status, context, and reply count |
| `#readReviewComment` | Read a comment with replies and surrounding markdown context |
| `#replyToReviewComment` | Reply to a comment as `agent` role |
| `#resolveReviewComment` | Mark a comment as resolved |
| `#deleteReviewComment` | Delete a comment and remove its anchor |
| `#scrollToReviewComment` | Scroll preview and editor to a comment's location |
| `#captureReviewScreenshot` | Export the rendered preview as HTML for visual inspection |

**Example workflow:**
```
User: "Review the design proposal and respond to all open comments"
Agent: [calls #listReviewComments] → sees 3 open comments
       [calls #readReviewComment for each] → reads context
       [calls #replyToReviewComment] → posts agent replies
       [calls #resolveReviewComment] → resolves addressed items
```

### Anchor System
Comments are anchored to specific blocks in the markdown source using invisible HTML comments (`<!--@cXXX-->`). Anchors:
- Are placed on their own line before the target block
- Move with the content when you edit the document
- Are stripped during rendering so they don't affect the preview
- Are invisible in standard markdown renderers (GitHub, VS Code preview, etc.)

### Additional Features
- **Keyboard shortcut**: `Ctrl+Shift+V` to open review preview
- **Right-click menu**: Available in both editor and file explorer
- **Comment persistence**: Comments stored in a dot-prefixed JSON sidecar file (`.filename.md.comments.json`)
- **KaTeX math rendering**: Full support for `$inline$` and `$$display$$` math
- **GFM support**: Tables, task lists, strikethrough via remark-gfm
- **Debounced auto-render**: Preview updates automatically as you edit

---

## Quick Start

1. Install the extension from VSIX
2. Open any `.md` file
3. Press `Ctrl+Shift+V` (or right-click → "Markdown Review: Open Preview with Comments")
4. Click the `+` buttons in the gutter to add comments
5. In Copilot Agent Mode, enable the Markdown Review tools to let AI participate in the review

---

## Example

See the [examples/](examples/) folder for a sample design proposal with threaded comments and agent replies.

The example includes:
- A design proposal document with headings, tables, formulas, and blockquotes
- 3 review comments with threaded replies between user and agent
- Demonstrates resolved vs. open comments

---

## Requirements

- **VS Code** 1.93.0 or later
- **Chrome** (optional) — for PDF export via headless mode
- **Pandoc** (optional) — for DOCX export with native Word equations ([install](https://pandoc.org/installing.html))

---

## Extension Settings

No configuration needed. The extension activates automatically for markdown files.

---

## Architecture

```
src/
  extension.ts   — Command registration and tool registration
  preview.ts     — Webview panel with remark/rehype rendering pipeline
  comments.ts    — CommentsManager for JSON sidecar CRUD
  tools.ts       — 7 Copilot tool implementations
```

**Rendering pipeline:** Markdown → remark-parse → remark-gfm → remark-math → remark-rehype → rehype-raw → rehype-katex → rehype-stringify → HTML

**Offset system:** All block positions use clean-text offsets (anchor-free, LF-normalized). The extension maintains bidirectional mapping between clean offsets and document offsets (with anchors, CRLF-aware).

---

## Development

```bash
# Install dependencies
npm install

# Build
npx esbuild src/extension.ts --bundle --outfile=out/extension.js --format=cjs --platform=node --external:vscode

# Package
npx vsce package --no-dependencies --allow-missing-repository

# Run tests
node test/test-crlf-fix.js
node test/test-crossref.js
```

---

## Version History

| Version | Highlights |
|---|---|
| **3.2.x** | Context menus, keybinding, dot-prefixed comments file, DOCX export |
| **3.1.x** | PDF export via Chrome headless with KaTeX support |
| **3.0.x** | 7 Copilot tools for agent mode |
| **2.4.x** | Comment editing, reply editing, inline edit buttons |
| **2.3.x** | Comment replies with user/agent roles |
| **2.2.0** | Cross-reference jumping between source and preview |
| **2.1.0** | First stable release — anchor-based commenting with CRLF support |

---

## License

[MIT](LICENSE)
