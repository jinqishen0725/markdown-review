# Word Support Integration Plan — Mapping to Markdown Review

## Overview

This document plans how to add .docx support to the existing markdown-review extension
by reusing the maximum amount of existing code. Each section maps a Word feature to the
existing markdown-review mechanism and specifies what changes are needed.

---

## 1. Block Identification System

### Current (Markdown)
- Blocks identified by **byte offsets** in clean text: `startOffset`, `endOffset`
- HTML elements have `data-start-offset` and `data-end-offset` attributes
- All JS selectors use: `querySelector('[data-start-offset="X"]')`
- Comment anchors: `<!--@cXXX-->` HTML comments injected into the .md file

### For Word — Using `w14:paraId` (Native Word Paragraph IDs)

**Discovery**: Modern Word documents (2013+) embed a unique `w14:paraId` hex identifier on every `<w:p>` paragraph element. Testing against a real 722-paragraph document confirmed:
- **100% coverage** — all 722 paragraphs have `paraId`
- **100% unique** — every ID is distinct (e.g., `77FE7CF5`, `77FE7CF6`, ...)
- **Persistent across saves** — Word preserves these IDs when the document is edited
- **Survives insertions/deletions** — adding paragraphs above doesn't change existing IDs

```xml
<w:p w14:paraId="77FE7CF5" w14:textId="77777777">
  <w:r><w:t>This is a paragraph</w:t></w:r>
</w:p>
```

This means we can use `paraId` as a **native, stable, unique anchor** — no hashing or fuzzy matching needed for modern files.

### Identification Strategy

| Priority | Method | When Used | Reliability |
|---|---|---|---|
| **Primary** | `w14:paraId` | Modern Word files (2013+) | ✅ 100% — Word-assigned, persistent, unique |
| **Fallback** | Sequential index + content hash | Older .docx files without `paraId` | ~95% — hash scan on mismatch |
| **Last resort** | `blockPreview` fuzzy match | When text was edited and hash changed | ~80% — substring match |

### Block Identification (replaces offsets)
- Blocks identified by **`paraId`** (e.g., `77FE7CF5`) or fallback index (e.g., `p42`)
- HTML elements will have `data-eid="77FE7CF5"` attributes
- All JS selectors: `querySelector('[data-eid="X"]')`
- **No in-document anchors** — comments reference `paraId` in the sidecar JSON only. The .docx is NEVER modified for review comments.

### Sidecar JSON Per Comment

```json
{
  "id": "c1775256960095",
  "elementId": "77FE7CF5",
  "contentHash": "sha256:a1b2c3",
  "blockType": "paragraph",
  "blockPreview": "The system uses a React SPA with AAD...",
  "comment": "Consider adding error handling here",
  "role": "user",
  "resolved": false
}
```

### Changes Needed

| File | What | How |
|---|---|---|
| `preview.ts` (JS) | All `data-start-offset` selectors | Add parallel `data-eid` based selectors, selected based on doc type |
| `preview.ts` (JS) | `placeGutterButtons()` | Use `blocks[i].eid` instead of `blocks[i].startOffset` for querySelector |
| `preview.ts` (JS) | `showPopover()` anchor lookup | Match by `eid` when in Word mode |
| `preview.ts` (JS) | `scrollToOffset()` → `scrollToElement()` | New function that takes `eid` |
| `comments.ts` | `Comment` interface | Add optional `elementId?: string` field alongside existing `startOffset/endOffset` |

### Approach: Dual-Mode Blocks

```typescript
// blocks[] currently:
{ startOffset: 150, endOffset: 280, blockType: 'paragraph', preview: '...' }

// For Word, add eid (using paraId):
{ eid: '77FE7CF5', startOffset: 0, endOffset: 0, blockType: 'paragraph', preview: '...' }

// Webview JS picks the right selector:
var selector = block.eid 
    ? '[data-eid="' + block.eid + '"]' 
    : '[data-start-offset="' + block.startOffset + '"]';
```

This is a minimal change — add `eid` to the Block interface, and add a `block.eid ?` branch in ~6 places in the webview JS.

---

## 2. Rendering Pipeline

### Current (Markdown)
```
markdown text 
  → strip anchors → anchorMap
  → remark-parse → remark-gfm → remark-math → remark-rehype
  → rehype-raw → rehypeSourcePositions → rehype-katex → rehype-stringify
  → HTML string with data-start-offset/data-end-offset
```

Located in: `preview.ts` → `renderMarkdown()` (lines 556-605)

### For Word
```
.docx file
  → unzip (JSZip)
  → parse document.xml → DocElement[] + WordComment[]
  → render elements to HTML with data-eid attributes
  → inject KaTeX for OMML formulas
  → embed images as base64 data URIs
```

### Changes Needed

| File | What |
|---|---|
| **NEW** `src/docx-parser.ts` | Unzip + parse document.xml → elements + comments (already built in office-review) |
| **NEW** `src/omml-to-latex.ts` | OMML formula → LaTeX (already built in office-review) |
| **NEW** `src/document-model.ts` | DocElement, WordComment interfaces (already built) |
| `preview.ts` | Add `renderDocx()` method that calls the new parser and produces `{ html, blocks, wordComments }` |
| `preview.ts` | In `updateContent()`, branch: if `.docx` → `renderDocx()`, else → `renderMarkdown()` |

### Key Design: `renderDocx()` Must Return Same Shape as `renderMarkdown()`

```typescript
// renderMarkdown returns:
{ html: string, blocks: Block[], anchorMap: Map<string, number> }

// renderDocx should return same shape:
{ html: string, blocks: Block[], anchorMap: Map<string, number> /* empty for Word */ }

// Block is extended:
interface Block {
    startOffset: number;
    endOffset: number;
    blockType: string;
    preview: string;
    eid?: string;          // NEW: element ID for Word
}
```

---

## 3. Comment System

### Current (Markdown)
- `CommentsManager` reads/writes `.filename.md.comments.json`
- Comments have: `id`, `anchor` (<!--@cXXX-->), `startOffset`, `endOffset`, `blockType`, `blockPreview`
- Anchor `<!--@cXXX-->` is injected into the .md file before the target block
- Removing a comment also removes the anchor from the source file

### For Word
- Same `CommentsManager` with `.filename.docx.comments.json`
<!--@c1775257105079-->
- Comments have: `id`, `elementId` (e.g., "p42"), `blockType`, `blockPreview`
- **No in-document anchors** — the .docx file is NOT modified for review comments
- Removing a comment only removes from the sidecar JSON

### Changes Needed

| File | What | How |
|---|---|---|
| `comments.ts` | `Comment` interface | Add `elementId?: string` (optional, used only for Word) |
| `comments.ts` | `addComment()` | When `elementId` is provided, skip `anchor` generation |
| `preview.ts` | `addComment` handler | For Word: skip `insertAnchorViaApi()`, use elementId directly |
| `preview.ts` | `deleteComment` handler | For Word: skip `removeAnchorViaApi()`, just delete from JSON |
| `preview.ts` | Highlight logic | For Word: highlight by `data-eid` instead of `data-start-offset` |

### Word Native Comments (Read-Only Display)
- Parse `comments.xml` from the .docx ZIP
- Show in sidebar alongside review comments with different styling (e.g., blue border = Word comment, yellow = review comment)
- Don't modify Word comments — read-only display

---

## 4. Webview HTML/CSS/JS

### Current (preview.ts → getHtml())
~900 lines of inline HTML/CSS/JS. Structure:
- CSS: layout, markdown styles, comment styles, popover, sidebar, dialog
- HTML: badge, toolbar, wrapper+gutter+content, popover, sidebar panel, dialog
- JS: gutter placement, highlighting, popover, dialog, comment CRUD, sidebar list, message handlers

### For Word — What Changes

| Section | Change | Lines Affected |
|---|---|---|
| **CSS** | Add Word-specific styles (tables, code blocks, formulas) | ~30 new lines |
| **HTML structure** | Identical — no changes | 0 |
| **JS: placeGutterButtons()** | Add `eid` branch in selector | ~3 lines |
| **JS: highlightCommentedBlocks()** | Add `eid` branch in selector | ~3 lines |
| **JS: attachBlockClickHandlers()** | Add `eid` branch in selector | ~3 lines |
| **JS: scrollToElement()** | New function for eid-based scroll | ~8 new lines |
| **JS: buildList() click handler** | Add `eid` branch | ~3 lines |
| **JS: addComment dialog** | Pass `eid` instead of offsets when in Word mode | ~5 lines |
| **JS: mermaid init** | Skip when in Word mode | ~2 lines (conditional) |

**Total JS changes: ~30 lines out of ~550 lines of JS = ~5% change.**

### How to Detect Word Mode in Webview

Inject a variable in the HTML template:
```javascript
var docMode = '${this.isDocx ? "docx" : "markdown"}';
```

Then in each selector:
```javascript
function findElement(block) {
    if (block.eid) {
        return content.querySelector('[data-eid="' + block.eid + '"]');
    }
    return content.querySelector('[data-start-offset="' + block.startOffset + '"]');
}
```

---

## 5. Preview Panel (preview.ts class)

### Current
- Constructor takes `(panel, document: TextDocument, extensionUri)`
- `updateContent()` reads `document.getText()`, calls `renderMarkdown()`
- Listens to `workspace.onDidChangeTextDocument` for auto-refresh
- `insertAnchorViaApi()` / `removeAnchorViaApi()` modify the .md source file

### For Word
- Constructor needs alternative input: `(panel, docxPath: string, extensionUri)`
- `updateContent()` calls `parseDocx(docxPath)` then generates HTML
- File watcher: watch the .docx file for external changes (same pattern)
- No anchor insertion/removal in document — skip those methods

### Changes Needed

| Change | Description |
|---|---|
| Add `docxPath?: string` to constructor | Alternate init for Word files |
| Add `isDocx` flag | Drives conditional behavior |
| Add `renderDocx()` method | Parallel to `renderMarkdown()` |
| Conditional anchor operations | Skip `insertAnchorViaApi`/`removeAnchorViaApi` when `isDocx` |
| Conditional offset mapping | Skip `cleanOffsetToDocOffset`/`docOffsetToCleanOffset` when `isDocx` |
| Add `docxModel?: DocumentModel` field | Cached parsed Word model |

### Message Handler Changes

| Message | Markdown behavior | Word behavior |
|---|---|---|
| `addComment` | Insert anchor in .md + save to JSON | Save to JSON only (with elementId) |
| `deleteComment` | Remove anchor from .md + delete from JSON | Delete from JSON only |
| `resolveComment` | Save to JSON | Same |
| `replyComment` | Save to JSON | Same |
| `editComment` | Save to JSON | Same |
| `scrollToSource` | Jump to line in .md editor | Open .docx in system Word (optional) |
| `sendAllToCopilot` | Build batch prompt | Same (use element preview instead of offset context) |
| `copyToClipboard` | Same | Same |

---

## 6. Extension Entry Point (extension.ts)

### Current
- Activates on `onLanguage:markdown` and specific commands
- Guards preview command on `languageId === 'markdown'`

### For Word
- Add activation event: `onCommand:markdownReview.openWordPreview`
- Add new command that accepts .docx files
- Add explorer context menu for `.docx` files

### Changes Needed

```json
// package.json additions:
"activationEvents": [
    "onCommand:markdownReview.openWordPreview"   // NEW
],
"commands": [
    {
        "command": "markdownReview.openWordPreview",
        "title": "Markdown Review: Open Word Document Preview"
    }
],
"menus": {
    "explorer/context": [
        {
            "when": "resourceExtname == .docx",
            "command": "markdownReview.openWordPreview",
            "group": "navigation"
        }
    ]
}
```

---

## 7. Copilot Tools (tools.ts)

### Current
- 7 tools, all using `resolveMarkdownPath()` → `CommentsManager`
- `getMarkdownContext()` reads .md file and extracts surrounding lines

### For Word
- Same 7 tools work — comments are stored the same way in sidecar JSON
- `resolveMarkdownPath()` → rename to `resolveDocumentPath()`, handle `.docx` too
- `getMarkdownContext()` → add `getDocxContext()` that extracts surrounding paragraphs from docx

### Changes

| Function | Change |
|---|---|
| `resolveMarkdownPath()` | Rename to `resolveDocumentPath()`, also check for `.docx` files and docx preview panels |
| `getMarkdownContext()` | Keep for .md; add `getDocxContext()` for .docx that parses the docx and returns element content |
| `ReadCommentTool` | Call `getDocxContext()` when filepath is .docx |
| All other tools | No changes — they operate on CommentsManager which is format-agnostic |

---

## 8. Content Extraction & Agent Editing Tools (NEW)

This section covers how AI agents can **read document content** and **make precise edits** to the Word document — going beyond commenting into actual content modification.

### Design Philosophy

The agent should **never see raw XML**. Instead:
1. The extension extracts content into a **compact, readable representation**
2. The agent reasons about the content and specifies edits in plain text
3. The extension validates and translates edits back to **surgical XML changes**
4. The extension re-zips the modified XML back to a .docx

### 8.1 Content Extraction Tools

#### `listElements(filePath?)` — Document Overview (~7K tokens vs ~68K raw XML)

Returns a compact outline of the entire document with element IDs:

```
Document: UMS_Dogfood_Production_Design.docx (254 elements, 16 comments)

[H1 id=77FE7CF5] "UMS Dogfood Portal — Production System Design"
[P id=77FE7CF6] "Authors: Jinqi Shen, Felipe Gutierrez..."
[H2 id=77FE7D05] "1. Overview"
[P id=77FE7D06] "The UMS Dogfood Portal is a web application..." 💬2
[H2 id=77FE7D12] "2. Architecture"
[IMG id=77FE7D13] image1.png (800x600)
[TABLE id=77FE7D14] 4 rows × 3 cols: "Component | Technology | Notes"
[H3 id=77FE7D20] "2.1 Frontend"
[P id=77FE7D21] "React SPA built with Vite and MSAL.js..."
[FORMULA id=77FE7D30] "Precision_u = |G_u ∩ U_u| / |U_u|"
[CODE id=77FE7D40] "$w = \"Backend\\wwwroot\"; if (Test-Path $w)..."
...
```

Tokens: ~30 per element × 254 elements = **~7,600 tokens** (vs ~68,000 for raw XML).

#### `readElement(elementId, filePath?)` — Single Element Detail

Returns the full content of one element with formatting metadata:

```
Element 77FE7D06 (paragraph):
  Text: "The UMS Dogfood Portal is a web application that allows Microsoft 
         employees to save and label their browser identifiers for ground 
         truth validation of the Unified Measurement Service (UMS)."
  Formatting: [normal text, no special formatting]
  Word comments on this element:
    - [Alice, Mar 15] "Is this global? If so, there are requirements..."
    - [Bob, Mar 16] "We can launch this by phases..."
  Review comments:
    - [You, open] "Needs clarification on scope"
  Neighbors:
    Before: [H2] "1. Overview"
    After: [P] "Key features include..."
```

For tables, returns structured data:
```
Element 77FE7D14 (table, 4 rows × 3 cols):
  | Component       | Technology    | Notes              |
  |-----------------|---------------|---------------------|
  | Frontend        | React + Vite  | MSAL.js for auth   |
  | Backend         | ASP.NET Core  | Azure App Service  |
  | Database        | Azure SQL     | DogfoodUserIDs     |
  | Data Pipeline   | Scope + ADF   | Synapse queries    |
```

#### `readSection(headingId, filePath?)` — Read Entire Section

Returns all elements under a heading (until the next heading of equal or higher level):

```
Section under 77FE7D12 ("2. Architecture"):
  [P id=77FE7D13] "The system architecture consists of..."
  [IMG id=77FE7D14] image1.png (800x600)
  [TABLE id=77FE7D15] (4×3 table as above)
  [H3 id=77FE7D20] "2.1 Frontend"
  [P id=77FE7D21] "React SPA built with Vite..."
  [H3 id=77FE7D25] "2.2 Backend"
  [P id=77FE7D26] "ASP.NET Core web API..."
```

### 8.2 Content Editing Tools

#### `editElement(elementId, newContent, filePath?)` — Edit Text

Agent specifies the element ID and new plain text content. The extension:
1. Locates the corresponding `<w:p>` in document.xml by `w14:paraId`
2. Replaces the text in `<w:t>` nodes while **preserving**:
   - Run properties (`<w:rPr>` — bold, italic, font, color)
   - Comment range markers (`commentRangeStart/End`)
   - Paragraph properties (`<w:pPr>` — heading style, list numbering)
3. Returns a confirmation with before/after diff

**Example agent interaction:**
```
Agent: editElement("77FE7D06", 
  "The UMS Dogfood Portal is a web application that enables Microsoft 
   employees to register and label browser identifiers for ground truth 
   validation of the Unified Measurement Service (UMS). It supports 
   Chrome, Edge, and mobile browsers.")

Extension response:
  "Element 77FE7D06 updated.
   Before: 'The UMS Dogfood Portal is a web application that allows...'
   After:  'The UMS Dogfood Portal is a web application that enables...'"
```

**Safety rules:**
- Only text content changes — never formatting, structure, or comments
- If the edit would break XML structure (unmatched tags, invalid chars), reject with error
- If the element has comment range markers inside it, preserve their exact positions

#### `editTableCell(tableId, row, col, newContent, filePath?)` — Edit Table Cell

Agent specifies table element ID + row/col (0-indexed) + new text:
```
Agent: editTableCell("77FE7D14", 2, 2, "Azure App Service (P1v3)")

Extension: 
  "Cell [2,2] updated in table 77FE7D14.
   Before: 'Azure App Service'
   After:  'Azure App Service (P1v3)'"
```

#### `insertElement(afterElementId, type, content, filePath?)` — Insert New Content

Insert a new paragraph, heading, or list item after a specified element:
```
Agent: insertElement("77FE7D06", "paragraph", 
  "Note: This portal is currently available for internal Microsoft use only.")

Extension:
  "New paragraph inserted after 77FE7D06 with paraId=AUTO_GENERATED.
   Content: 'Note: This portal is currently available for...'"
```

#### `deleteElement(elementId, filePath?)` — Remove Content

Delete a paragraph or other element (with confirmation):
```
Agent: deleteElement("77FE7D21")

Extension:
  "Element 77FE7D21 deleted.
   Was: [P] 'React SPA built with Vite and MSAL.js...'"
```

### 8.3 Save / Export Flow

#### `saveDocument(filePath?, outputPath?)` — Re-zip and Save

After all edits are applied to the in-memory XML model:
1. Validate all XML is well-formed
2. Re-zip all files back into a .docx
3. Save to `outputPath` (defaults to original path or `*_reviewed.docx` if locked)
4. Return summary of all changes made

```
Agent: saveDocument(outputPath="UMS_Design_v2.docx")

Extension:
  "Document saved to UMS_Design_v2.docx
   Changes: 3 paragraphs edited, 1 paragraph inserted, 2 comments added
   All existing Word comments preserved (16)
   All images preserved (9)
   All formatting preserved"
```

### 8.4 Completeness Check

#### `validateDocument(filePath?)` — Pre-Save Validation

Before saving, the agent (or user) can run a validation check:

```
Agent: validateDocument()

Extension:
  "Validation results:
   ✅ All XML well-formed
   ✅ All image references valid (9 images)
   ✅ All comment ranges intact (16 Word comments)
   ✅ All review comments mapped to valid elements (3 review comments)
   ⚠️  1 orphaned review comment (element deleted): c1775257105079
   ✅ Document re-zippable"
```

### 8.5 Full Agent Editing Workflow

```
User: "Review section 2 and update the architecture description 
       to reflect that we migrated from Cosmos DB to Azure SQL"

Agent:
  1. listElements() → sees document structure
  2. readSection("77FE7D12") → reads the Architecture section in detail
  3. readElement("77FE7D13") → reads the specific paragraph to edit
  4. editElement("77FE7D13", "...updated text mentioning Azure SQL...")
  5. readElement("77FE7D14") → reads the architecture table
  6. editTableCell("77FE7D14", 3, 1, "Azure SQL") → updates DB row
  7. addComment("77FE7D13", "Updated architecture description to reflect SQL migration")
  8. validateDocument() → confirms everything is valid
  9. saveDocument(outputPath="UMS_Design_v2.docx")
```

### 8.6 Tool Summary (Updated — 13 Tools Total)

| Tool | Category | Description |
|---|---|---|
| `listElements` | Read | Compact document outline with IDs |
| `readElement` | Read | Full content of one element |
| `readSection` | Read | All elements under a heading |
| `editElement` | Write | Edit text content of an element |
| `editTableCell` | Write | Edit a specific table cell |
| `insertElement` | Write | Insert new paragraph/heading after an element |
| `deleteElement` | Write | Remove an element |
| `listComments` | Comment | List all Word + review comments |
| `addComment` | Comment | Add a review comment on an element |
| `replyToComment` | Comment | Reply to a comment |
| `resolveComment` | Comment | Mark a comment resolved |
| `saveDocument` | Export | Re-zip and save the modified .docx |
| `validateDocument` | Export | Pre-save validation check |

### 8.7 Phase Plan for Editing

| Phase | Tools | When |
|---|---|---|
| **Phase 1** (current) | `listElements`, `readElement`, `readSection` + all comment tools | With initial Word support |
| **Phase 2** | `editElement`, `editTableCell`, `saveDocument`, `validateDocument` | After comment system is stable |
| **Phase 3** | `insertElement`, `deleteElement` | After edit workflow is validated |

---

## 9. MCP Server (mcp-server.ts)

### Current
- Standalone Node.js process, reads `.comments.json` sidecar directly
- `findMarkdownPath()` auto-detects .md files

### For Word
- Same server works — sidecar JSON is the same format
- `findMarkdownPath()` → also look for .docx files
- Add content extraction tools (`listElements`, `readElement`, `readSection`) to MCP

### Change: ~3 lines in `findMarkdownPath()` to also glob for `.docx`, plus new tool registrations

---

## 10. File Summary — What Changes Where

| File | Lines Changed | Type |
|---|---|---|
| `src/preview.ts` | ~100 lines added, ~30 modified | Conditional branches for Word mode |
| `src/comments.ts` | ~10 lines | Add `elementId` field, conditional anchor skip |
| `src/tools.ts` | ~20 lines | Rename resolve fn, add docx context extractor |
| `src/extension.ts` | ~20 lines | Add Word preview command |
| `src/mcp-server.ts` | ~5 lines | Extend file finder |
| **NEW** `src/docx-parser.ts` | ~300 lines | Word XML parser (from office-review) |
| **NEW** `src/omml-to-latex.ts` | ~170 lines | Formula converter (from office-review) |
| **NEW** `src/document-model.ts` | ~60 lines | Type interfaces (from office-review) |
| `package.json` | ~15 lines | Commands, menus, activation events |
| **Total new code** | ~530 lines | Already written in office-review |
| **Total modified code** | ~185 lines | In existing files |

---

## 11. Implementation Order

### Step 1: Add New Source Files (copy from office-review)
- Copy `docx-parser.ts`, `omml-to-latex.ts`, `document-model.ts` into `src/`
- Install `jszip` and `@xmldom/xmldom` dependencies

### Step 2: Extend Block Interface + Comment Interface
- Add `eid?: string` to Block type in preview.ts
- Add `elementId?: string` to Comment interface in comments.ts

### Step 3: Add `renderDocx()` to Preview Panel
- New method that calls `parseDocx()` and produces `{ html, blocks }` in the same shape as `renderMarkdown()`
- The HTML includes `data-eid` attributes on every element

### Step 4: Add Word Mode to `updateContent()`
- Branch: if `this.isDocx` → call `renderDocx()`, else → `renderMarkdown()`
- Pass same blocks/comments shape to `getHtml()`

### Step 5: Update Webview JS for Dual Selectors
- Add `findElement(block)` helper that uses `eid` or `startOffset`
- Update ~6 call sites: placeGutterButtons, highlight, attach handlers, scroll, list click, dialog

### Step 6: Conditional Anchor Operations
- `addComment` handler: skip `insertAnchorViaApi()` when `isDocx`, use `elementId` instead
- `deleteComment` handler: skip `removeAnchorViaApi()` when `isDocx`

### Step 7: Add Word Preview Command
- New command in extension.ts + package.json
- Explorer context menu for .docx files

### Step 8: Update Tools for .docx
- Generalize `resolveDocumentPath()` to find .docx files
- Add `getDocxContext()` for reading element context

### Step 9: Test
- Open a .docx file → verify preview renders
- Add a comment → verify it saves to sidecar JSON
- Reply, resolve, delete → verify all work
- Test Copilot tools → verify they find comments on .docx files
- Test alongside .md files → verify no regression

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Large preview.ts becomes unwieldy (~2000+ lines) | Could extract Word-specific rendering into a separate file `docx-renderer.ts` that preview.ts imports |
| Offset-to-eid change breaks markdown mode | Use `block.eid ?` conditional — offset path completely unchanged |
| JSZip increases bundle size | ~50KB — acceptable |
| Word file locked by Word app | Copy to temp dir before parsing (already planned in docx-parser) |
| Comment drift (element IDs shift after Word edits) | Use content hash + index for resilient matching (future improvement) |
