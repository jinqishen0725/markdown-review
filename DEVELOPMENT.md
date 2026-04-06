# Development Guide

## Prerequisites

- Node.js 20+
- VS Code 1.93+
- npm

## Setup

```bash
git clone <repo-url>
cd markdown-review
npm install          # also runs postinstall to patch pptx-renderer
```

## Build

```bash
# Build the VS Code extension
npm run bundle

# Build the PowerPoint webview renderer (pptx-viewer.js)
npm run bundle:pptx-viewer

# Build both
npm run bundle && npm run bundle:pptx-viewer

# Package VSIX for distribution
npx @vscode/vsce package --no-dependencies
```

## Hot-Deploy (Development)

Copy built files directly to the installed extension for quick testing without VSIX reinstall:

```bash
# Find your installed extension version
ls ~/.vscode/extensions/ | grep markdown-review

# Copy extension + pptx viewer bundle
cp out/extension.js ~/.vscode/extensions/jinqishen.markdown-review-<version>/out/extension.js
cp media/pptx-viewer.js ~/.vscode/extensions/jinqishen.markdown-review-<version>/media/pptx-viewer.js
cp package.json ~/.vscode/extensions/jinqishen.markdown-review-<version>/package.json
```

Then reload VS Code: `Ctrl+Shift+P` → "Developer: Reload Window"

**Note:** `package.json` must also be copied when adding new commands or tools — VS Code reads it for command/menu/tool declarations.

## Project Structure

```
src/
  extension.ts          — VS Code extension entry point, command registration
  preview.ts            — WebviewPanel: markdown, Word, and PowerPoint preview rendering
  comments.ts           — CommentsManager: sidecar .comments.json read/write
  tools.ts              — 11 Copilot language model tools (docReview_*)
  mcp-server.ts         — MCP server for Claude Code / Cursor / Windsurf
  pptx-parser.ts        — PowerPoint XML parser: slides, shapes, comments, notes
  pptx-viewer-webview.ts — Entry point for pptx-viewer.js webview bundle
  docx-parser.ts        — Word XML parser: paragraphs, comments, threading
  omml-to-latex.ts      — OMML formula → LaTeX converter (Word equations)
  document-model.ts     — Shared interfaces (DocElement, WordComment, etc.)
  logger.ts             — Output channel logging

media/
  pptx-viewer.js        — Bundled @aiden0z/pptx-renderer for webview (IIFE, ~2.8MB)
  mermaid.min.js        — Mermaid.js for diagram rendering
  trim-png-bundled.js   — PNG trimming utility

patches/
  apply-pptx-renderer-patches.js — Automatic patches for pptx-renderer bugs

test/
  test-*.js             — Standalone test scripts (node test/test-*.js)
  *.html                — Browser-based test pages for pptx rendering
```

## Patched Dependencies

### @aiden0z/pptx-renderer@1.0.2

The library has two bugs that we patch automatically via `npm postinstall`:

**Patch 1: Color resolution (defRPr cascade)**
- **Bug:** `fontRefColor` from slide master theme (often white) overrides the paragraph's `defRPr` color. Text on colored shapes appears white-on-white.
- **Fix:** When `Y.color` (cascade-resolved color) exists, it takes priority over `fontRefColor`.
- **Location:** `aiden0z-pptx-renderer.es.js`, text run color assignment

**Patch 2: Hanging indent overflow**
- **Bug:** Bullet paragraphs with `indent=-285750` (negative text-indent) get `margin-left: 0` because `marL` is lost in the style cascade. Text clips outside the shape boundary.
- **Fix:** Before applying styles, if `textIndent < 0` and `marginLeft < |textIndent|`, enforce `marginLeft = |textIndent|`.
- **Location:** `aiden0z-pptx-renderer.es.js`, paragraph style application

**To re-apply patches manually:**
```bash
node patches/apply-pptx-renderer-patches.js
npm run bundle:pptx-viewer
```

**If the library updates:** The patch script checks for exact string matches. If the library version changes and strings don't match, it prints warnings. Update the patch strings accordingly.

## Tools (Copilot + MCP)

All 11 tools use the `docReview_` prefix:

| Tool | Purpose |
|------|---------|
| `docReview_list_comments` | List all comments (sidecar + native Word/PPTX) |
| `docReview_read_comment` | Read comment with replies and context |
| `docReview_reply_to_comment` | Reply as agent (creates sidecar for Word/PPTX) |
| `docReview_resolve_comment` | Mark comment resolved |
| `docReview_delete_comment` | Delete comment and anchor |
| `docReview_scroll_to_comment` | Scroll preview to comment |
| `docReview_capture_screenshot` | Export preview as HTML |
| `docReview_read_element_xml` | Read Word element raw XML |
| `docReview_write_element_xml` | Replace Word element XML |
| `docReview_save_document` | Save Word edits back to .docx |
| `docReview_list_elements` | List Word document structure |

### MCP Server (Claude Code / Cursor)

```bash
node out/mcp-server.js --document-path /path/to/file.md
```

## File Format Support

### Markdown (.md)
- Full rendering with remark/rehype pipeline
- KaTeX math, Mermaid diagrams, GFM tables
- Inline comment anchors (`<!--@cID-->`)

### Word (.docx)
- JSZip + xmldom parsing
- Native Word comment import with threading (commentsExtended.xml)
- XML extraction to `.{filename}_xml/` sibling folder
- Agent-editable XML with live preview refresh

### PowerPoint (.pptx)
- @aiden0z/pptx-renderer for browser-native rendering
- Our parser extracts text, comments, notes for AI tools
- Slide XML extraction to `.{filename}_xml/` sibling folder
- Modern comment format (p188 namespace) support

## Testing

```bash
# Run parser tests
node test/test-threading.js        # Word comment threading
node test/test-pptx-parser.js      # PPTX parser output
node test/test-pptx-color-fix.js   # PPTX color fix verification
node test/test-colorfix-verify.js  # Color fix map validation
node test/test-reply-flow.js       # Reply button flow simulation

# Browser tests (start server first)
python -m http.server 8767
# Then open http://localhost:8767/test/test-pptx-standalone.html
```
