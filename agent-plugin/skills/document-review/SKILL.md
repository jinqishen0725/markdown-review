---
name: document-review
description: Review and address comments on Markdown documents using docReview tools. Use when a user asks to inspect, respond to, or implement Markdown review feedback. Do not use for Word or PowerPoint in this version.
---

# Markdown Document Review

1. Obtain the absolute Markdown file path from the user or current workspace context.
2. Call `docReview_list_comments` to discover review comments.
3. Call `docReview_read_comment` before acting on a specific comment.
4. Edit the Markdown file using the host's normal file-editing tools.
5. Call `docReview_reply_to_comment` with `role: "agent"` and briefly explain the completed change.
6. Do not resolve a comment unless the user explicitly asks. If asked, call `docReview_resolve_comment` only after the requested change is complete.
7. Open the bundled **Markdown Review** canvas for rendered Markdown, blue gutter `+` buttons, comment threads, and prompt handoff.
8. In VS Code, the companion **Markdown Review: Open Markdown Preview** command additionally provides inline editing, differences, export, source navigation, Word, and PowerPoint support.

Agents can use `docReview_add_comment` when the user explicitly asks them to create a comment on a block from the latest `docReview_list_comments` snapshot.

Preserve `<!--@c...-->` review anchors. The delete-comment tool owns anchor removal.

This initial Agent Plugin supports Markdown only. Do not claim Word or PowerPoint support.