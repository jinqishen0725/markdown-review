/**
 * Shared comment UI components for all webview formats (Markdown, Word, PowerPoint).
 *
 * Generates CSS and JS strings that are injected into each format's HTML template.
 * Format-specific behaviors are controlled by a `nativeSource` config parameter
 * ('word', 'pptx', or null for plain markdown).
 */

// ---------- Shared CSS ----------

/** CSS for popover, sidebar, badge, dialog, roles, and comment list — shared across all formats. */
export function commentUiCss(): string {
    return `
/* ---------- comment badge ---------- */
#comment-badge {
    cursor: pointer; display: none;
}

/* ---------- popover ---------- */
#comment-popover {
    display: none; position: absolute; z-index: 100;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-editorWidget-foreground);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 5px; padding: 12px; width: 340px;
    box-shadow: 0 4px 14px var(--vscode-widget-shadow);
    max-height: 400px; overflow-y: auto;
}
.pop-text { font-size: 13px; margin-bottom: 6px; }
.pop-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.pop-replies { margin: 10px 0; padding-left: 12px; border-left: 1px solid var(--vscode-editorWidget-border); max-height: 40vh; overflow-y: auto; }
.pop-reply { margin-bottom: 6px; }
.pop-reply-text { font-size: 12px; white-space: pre-wrap; }
.pop-reply-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
.pop-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.pop-actions button { min-height: 26px; padding: 0 9px; border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border)); border-radius: 4px; cursor: pointer; font-size: 11px; background: transparent; color: var(--vscode-foreground); }
.pop-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
.pop-reply-input { margin-top: 8px; }
.pop-reply-input textarea {
    width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border-radius: 3px; font-family: inherit; font-size: 12px;
    resize: none; box-sizing: border-box;
}
.pop-reply-input button {
    min-height: 26px; margin-top: 6px; padding: 0 9px; border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border)); background: transparent;
    color: var(--vscode-foreground); border-radius: 4px; cursor: pointer; font-size: 11px;
}
.pop-reply-input button:hover { background: var(--vscode-toolbar-hoverBackground); }

/* ---------- comment dialog ---------- */
#comment-dialog { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 2000; align-items: center; justify-content: center; }
#comment-dialog.open { display: flex; }
.dlg-box { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 20px; width: 500px; max-width: 90vw; box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
.dlg-box h3 { margin: 0 0 8px; color: var(--vscode-foreground, #ccc); }
.dlg-preview { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; padding: 8px; background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-textBlockQuote-border); }
.dlg-box textarea { width: 100%; min-height: 88px; padding: 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 3px; font-family: inherit; font-size: 13px; resize: vertical; box-sizing: border-box; }
.dlg-actions { margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end; }
.dlg-actions button { min-height: 28px; padding: 0 12px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-primary { background: var(--vscode-button-background, #0078D4); color: var(--vscode-button-foreground, #fff); }
.btn-cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn-copilot { background: var(--vscode-button-secondaryBackground) !important; color: var(--vscode-button-secondaryForeground) !important; border-color: var(--vscode-button-border, transparent) !important; }

/* ---------- role badges ---------- */
.role-badge { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-right: 5px; font-weight: 600; border: 1px solid var(--vscode-editorWidget-border); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.role-user { border-color: var(--vscode-charts-blue); }
.role-agent { border-color: var(--vscode-charts-purple); }
.role-word { border-color: var(--vscode-charts-green); }
.role-pptx { border-color: var(--vscode-charts-orange); }

/* ---------- inline edit / delete buttons ---------- */
.inline-edit-btn { background: none !important; border: none !important; color: var(--vscode-descriptionForeground) !important; cursor: pointer; font-size: 10px !important; padding: 0 2px !important; }
.inline-edit-btn:hover { color: var(--vscode-foreground) !important; }
.reply-delete-btn { background: none !important; border: none !important; color: var(--vscode-descriptionForeground) !important; cursor: pointer; font-size: 14px !important; padding: 0 2px !important; }
.reply-delete-btn:hover { color: var(--vscode-errorForeground) !important; }

/* ---------- sidebar / comment list panel ---------- */
.clist-item { padding: 14px 16px; margin: 0; background: transparent; border-radius: 0; border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-editorWidget-border)); cursor: pointer; }
.clist-item:hover { background: var(--vscode-list-hoverBackground); }
.clist-item.word-comment { box-shadow: inset 2px 0 var(--vscode-charts-green); }
.clist-item.pptx-comment { box-shadow: inset 2px 0 var(--vscode-charts-orange); }
.clist-item.resolved { opacity: 0.62; }
.item-preview { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item-comment { font-size: 13px; line-height: 1.45; margin-bottom: 5px; white-space: pre-wrap; }
.item-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
.item-replies { margin-top: 10px; padding-left: 12px; border-left: 1px solid var(--vscode-editorWidget-border); }
.item-reply { margin-bottom: 4px; }
.item-reply-text { font-size: 12px; white-space: pre-wrap; }
.item-reply-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
.item-actions { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.item-actions button, .item-reply-input button { min-height: 26px; padding: 0 9px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border)); border-radius: 4px; cursor: pointer; font-size: 11px; }
.item-actions button:hover, .item-reply-input button:hover { background: var(--vscode-toolbar-hoverBackground); }
.item-reply-input textarea { border-color: var(--vscode-input-border, transparent) !important; background: var(--vscode-input-background) !important; color: var(--vscode-input-foreground) !important; border-radius: 3px !important; padding: 6px 8px !important; }
`;
}

// ---------- Shared JS ----------

/**
 * Shared JS for comment actions: popover, reply, edit, delete, sidebar list, badge, etc.
 *
 * The generated code expects these globals to be set before this script runs:
 *   - `vscode` (acquireVsCodeApi)
 *   - `comments` (array of comment objects)
 *   - `__nativePrefix` (string: 'word_', 'pptx_', or '' — prefix for native comment IDs)
 *   - `__nativeSource` (string: 'word', 'pptx', or '' — _source field of native comments)
 *
 * The generated code defines these on `window`:
 *   resolveComment, unresolveComment, deleteComment, submitReply, submitListReply,
 *   askCopilotThread, copyPromptThread, showPopover, startEditComment, saveEditComment,
 *   cancelEdit, startEditReply, saveEditReply, deleteReply, setFilter, resolveAll,
 *   deleteAllResolved, sendAllToCopilot, copyAllToClipboard, buildList, updateBadge
 */
export function commentUiJs(opts: { canSendPrompt?: boolean } = {}): string {
    const canSendPrompt = opts.canSendPrompt !== false;
    return `
    // ======== Shared Comment UI ========
    var __canSendPrompt = ${canSendPrompt ? 'true' : 'false'};
    function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

    // --- Comment actions ---
    window.resolveComment = function(id) { vscode.postMessage({ command: 'resolveComment', id: id }); };
    window.unresolveComment = function(id) { vscode.postMessage({ command: 'unresolveComment', id: id }); };
    window.deleteComment = function(id) { vscode.postMessage({ command: 'deleteComment', id: id }); };

    window.submitReply = function(id) {
        var inp = document.getElementById('pop-reply-input');
        if (!inp) inp = document.getElementById('reply-input');
        var t = inp ? inp.value.trim() : '';
        if (!t) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: t });
        inp.value = '';
    };
    window.submitListReply = function(id) {
        var inp = document.getElementById('list-reply-' + id);
        var t = inp ? inp.value.trim() : '';
        if (!t) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: t });
        inp.value = '';
    };
    function dispatchThreadPrompt(id, command) {
        var inp = document.getElementById('pop-reply-input') || document.getElementById('reply-input');
        if (!inp) inp = document.getElementById('list-reply-' + id);
        var replyText = inp ? inp.value.trim() : '';
        if (replyText) {
            vscode.postMessage({ command: 'replyComment', id: id, text: replyText });
            inp.value = '';
        }
        vscode.postMessage({ command: command, id: id, pendingReply: replyText });
    }
    window.askCopilotThread = function(id) {
        dispatchThreadPrompt(id, 'askCopilotThread');
    };
    window.copyPromptThread = function(id) {
        dispatchThreadPrompt(id, 'copyPromptThread');
    };
    // --- Popover ---
    function _isNativeComment(c) { return c._source === __nativeSource && __nativeSource; }
    function _isNativeReply(r) { return r.id && __nativePrefix && r.id.startsWith(__nativePrefix); }
    function _authorBadge(c) {
        if (c._source === 'word') return '<span class="role-badge role-word">' + esc(c._wordAuthor || 'Word') + '</span>';
        if (c._source === 'pptx') return '<span class="role-badge role-pptx">' + esc(c._wordAuthor || 'PPT') + '</span>';
        return '<span class="role-badge role-' + (c.role||'user') + '">' + (c.role||'user') + '</span>';
    }

    function showPopover(comment, anchorEl) {
        var pop = document.getElementById('comment-popover');
        if (!pop) return;
        var isNative = _isNativeComment(comment);
        var authorBadge = _authorBadge(comment);
        var resolveBtn = comment.resolved
            ? '<button onclick="unresolveComment(\\'' + comment.id + '\\')">Reopen</button>'
            : '<button class="btn-resolve" onclick="resolveComment(\\'' + comment.id + '\\')">Resolve</button>';
        var repliesHtml = '';
        if (comment.replies && comment.replies.length) {
            repliesHtml = '<div class="pop-replies">';
            comment.replies.forEach(function(r) {
                var rNative = _isNativeReply(r);
                var editBtn = rNative ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">edit</button>';
                var delBtn = rNative ? '' : ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">\u00d7</button>';
                repliesHtml += '<div class="pop-reply" id="pop-reply-' + r.id + '"><div class="pop-reply-text"><span class="role-badge role-' + (r.role||'user') + '">' + (r.role||'user') + '</span>' + esc(r.text) +
                    editBtn + delBtn + '</div>' +
                    '<div class="pop-reply-meta">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
            });
            repliesHtml += '</div>';
        }
        var editBtn = isNative ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + comment.id + '\\')">edit</button>';
        var directPromptBtn = __canSendPrompt
            ? '<button class="btn-copilot" onclick="askCopilotThread(\\'' + comment.id + '\\')">Ask Copilot</button>'
            : '';
        pop.innerHTML =
            '<div class="pop-text" id="pop-comment-' + comment.id + '">' + authorBadge + esc(comment.comment) + editBtn + '</div>' +
            '<div class="pop-meta">' + new Date(comment.timestamp).toLocaleString() + (comment.resolved ? ' \\u2705 Resolved' : '') + '</div>' +
            repliesHtml +
            '<div class="pop-reply-input"><textarea id="pop-reply-input" placeholder="Reply..." rows="2"></textarea>' +
            '<button onclick="submitReply(\\'' + comment.id + '\\')">Reply</button>' +
            directPromptBtn +
            '<button onclick="copyPromptThread(\\'' + comment.id + '\\')">Copy Prompt</button></div>' +
            '<div class="pop-actions">' + resolveBtn +
            (isNative ? '' : '<button onclick="deleteComment(\\'' + comment.id + '\\')">Delete</button>') + '</div>';
        var rect = anchorEl.getBoundingClientRect();
        pop.style.top = (rect.bottom + window.scrollY + 5) + 'px';
        pop.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 360) + 'px';
        pop.style.display = 'block';
    }
    window.showPopover = showPopover;

    // --- Edit / Delete ---
    window.startEditComment = function(id) {
        var c = comments.find(function(x) { return x.id === id; });
        if (!c) return;
        var el = document.getElementById('pop-comment-' + id) || document.getElementById('list-comment-' + id);
        if (!el) return;
        el.innerHTML =
            '<textarea id="edit-input" style="width:100%;min-height:60px;padding:6px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:4px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc(c.comment) + '</textarea>' +
            '<div style="margin-top:6px;display:flex;gap:6px;">' +
            '<button onclick="saveEditComment(\\'' + id + '\\')">Save</button>' +
            '<button onclick="cancelEdit()">Cancel</button></div>';
        var ta = document.getElementById('edit-input');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    };
    window.saveEditComment = function(id) {
        var input = document.getElementById('edit-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'editComment', id: id, text: text });
    };
    window.cancelEdit = function() {
        var pop = document.getElementById('comment-popover');
        if (pop) pop.style.display = 'none';
        if (typeof buildList === 'function') buildList();
    };
    window.startEditReply = function(commentId, replyId) {
        var c = comments.find(function(x) { return x.id === commentId; });
        if (!c || !c.replies) return;
        var r = c.replies.find(function(x) { return x.id === replyId; });
        if (!r) return;
        var el = document.getElementById('pop-reply-' + replyId) || document.getElementById('list-reply-item-' + replyId) || document.getElementById('list-reply-' + replyId);
        if (!el) return;
        var textEl = el.querySelector('.pop-reply-text') || el.querySelector('.item-reply-text') || el;
        textEl.innerHTML =
            '<textarea id="edit-reply-input" style="width:100%;min-height:40px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-family:inherit;font-size:12px;resize:vertical;box-sizing:border-box;">' + esc(r.text) + '</textarea>' +
            '<div style="margin-top:4px;display:flex;gap:4px;">' +
            '<button onclick="saveEditReply(\\'' + commentId + '\\',\\'' + replyId + '\\')">Save</button>' +
            '<button onclick="cancelEdit()">Cancel</button></div>';
        var ta = document.getElementById('edit-reply-input');
        if (ta) { ta.focus(); }
    };
    window.saveEditReply = function(commentId, replyId) {
        var input = document.getElementById('edit-reply-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'editReply', commentId: commentId, replyId: replyId, text: text });
    };
    window.deleteReply = function(commentId, replyId) {
        vscode.postMessage({ command: 'deleteReply', commentId: commentId, replyId: replyId });
    };

    // --- Filter & Bulk actions ---
    var currentFilter = 'all';
    window.setFilter = function(filter) {
        currentFilter = filter;
        document.querySelectorAll('.panel-filters button, #sidebar .panel-filters button').forEach(function(btn) {
            var isActive = btn.id === 'filter-' + filter;
            if (btn.classList) {
                btn.classList.toggle('active', isActive);
            }
            btn.style.background = isActive ? 'var(--vscode-button-background,#0078D4)' : 'transparent';
            btn.style.color = isActive ? '#fff' : '#ccc';
        });
        buildList();
    };
    window.resolveAll = function() { vscode.postMessage({ command: 'resolveAll' }); };
    window.deleteAllResolved = function() { vscode.postMessage({ command: 'deleteAllResolved' }); };
    window.sendAllToCopilot = function() { vscode.postMessage({ command: 'sendAllToCopilot' }); };
    window.copyAllToClipboard = function() { vscode.postMessage({ command: 'copyAllToClipboard' }); };

    // --- Badge ---
    function updateBadge() {
        var badge = document.getElementById('comment-badge');
        var span = document.getElementById('badge-count');
        if (!badge || !span) return;
        var unresolved = comments.filter(function(c) { return !c.resolved; });
        if (comments.length > 0) {
            badge.style.display = 'block';
            span.textContent = unresolved.length + ' / ' + comments.length;
        } else {
            badge.style.display = 'none';
        }
    }
    window.updateBadge = updateBadge;

    // --- Sidebar buildList ---
    // Expects a container: #comment-list (pptx sidebar) or #comment-list-body (md/docx panel)
    function buildList() {
        var container = document.getElementById('comment-list-body') || document.getElementById('comment-list');
        if (!container) return;
        container.innerHTML = '';
        var searchInput = document.getElementById('comment-search');
        var searchText = searchInput ? searchInput.value.trim().toLowerCase() : '';
        var filtered = comments.filter(function(c) {
            if (currentFilter === 'open' && c.resolved) return false;
            if (currentFilter === 'resolved' && !c.resolved) return false;
            if (currentFilter === 'user') { if (c.role === 'agent' || c._source) return false; }
            if (currentFilter === 'agent') { if ((c.role || 'user') !== 'agent') return false; }
            if (searchText) {
                var haystack = (c.comment + ' ' + (c.blockPreview || '') + ' ' +
                    (c.replies || []).map(function(r) { return r.text; }).join(' ')).toLowerCase();
                if (haystack.indexOf(searchText) < 0) return false;
            }
            return true;
        });
        if (!filtered.length) {
            container.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">' +
                (comments.length === 0 ? 'No comments yet' : 'No matching comments') + '</div>';
            return;
        }
        filtered.forEach(function(c) {
            var div = document.createElement('div');
            var isNative = _isNativeComment(c);
            var sourceClass = c._source === 'word' ? ' word-comment' : c._source === 'pptx' ? ' pptx-comment' : '';
            div.className = 'clist-item' + (c.resolved ? ' resolved' : '') + sourceClass;

            var authorBadge = _authorBadge(c);
            var editBtn = isNative ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + c.id + '\\')">edit</button>';

            var repliesHtml = '';
            if (c.replies && c.replies.length) {
                repliesHtml = '<div class="item-replies">';
                c.replies.forEach(function(r) {
                    var rNative = _isNativeReply(r);
                    var rEditBtn = rNative ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">edit</button>';
                    var rDelBtn = rNative ? '' : ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">\u00d7</button>';
                    repliesHtml += '<div class="item-reply" id="list-reply-item-' + r.id + '"><div class="item-reply-text"><span class="role-badge role-' + (r.role||'user') + '">' + (r.role||'user') + '</span>' + esc(r.text) +
                        rEditBtn + rDelBtn + '</div>' +
                        '<div class="item-reply-meta" style="font-size:10px;color:#888;">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
                });
                repliesHtml += '</div>';
            }

            var resolveBtn = c.resolved
                ? '<button onclick="event.stopPropagation();unresolveComment(\\'' + c.id + '\\')">Reopen</button>'
                : '<button onclick="event.stopPropagation();resolveComment(\\'' + c.id + '\\')">Resolve</button>';
            var deleteBtn = isNative ? '' : '<button onclick="event.stopPropagation();deleteComment(\\'' + c.id + '\\')">Delete</button>';
            var directPromptBtn = __canSendPrompt
                ? '<button class="btn-copilot" onclick="event.stopPropagation();askCopilotThread(\\'' + c.id + '\\')" style="margin-top:4px;">Ask Copilot</button>'
                : '';

            div.innerHTML =
                '<div class="item-preview">' + esc(c.blockPreview || '(block)') + '</div>' +
                '<div class="item-comment" id="list-comment-' + c.id + '">' + authorBadge + esc(c.comment) + editBtn + '</div>' +
                '<div class="item-meta">' + new Date(c.timestamp).toLocaleString() + (c.resolved ? ' \\u2705' : '') + '</div>' +
                repliesHtml +
                '<div class="item-reply-input" onclick="event.stopPropagation()">' +
                '<textarea id="list-reply-' + c.id + '" placeholder="Reply..." rows="1" style="width:100%;margin-top:6px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-size:12px;resize:none;box-sizing:border-box;"></textarea>' +
                '<button onclick="event.stopPropagation();submitListReply(\\'' + c.id + '\\')" style="margin-top:4px;">Reply</button>' +
                directPromptBtn +
                '<button onclick="event.stopPropagation();copyPromptThread(\\'' + c.id + '\\')" style="margin-top:4px;">Copy Prompt</button></div>' +
                '<div class="item-actions">' + resolveBtn +
                deleteBtn + '</div>';

            // Format-specific click: scroll to element
            if (typeof __onListItemClick === 'function') {
                div.addEventListener('click', function() { __onListItemClick(c); });
            }
            container.appendChild(div);
        });
    }
    window.buildList = buildList;

    // --- Message handler for comment updates ---
    // Call this from each format's message listener for shared comment messages.
    function handleCommentMessage(msg) {
        switch (msg.command) {
            case 'commentUpdated': {
                var idx = comments.findIndex(function(x) { return x.id === msg.comment.id; });
                if (idx >= 0) comments[idx] = msg.comment;
                updateBadge();
                buildList();
                if (typeof __onCommentChange === 'function') __onCommentChange();
                // Update popover if open
                var pop = document.getElementById('comment-popover');
                if (pop && pop.style.display === 'block') {
                    var updated = comments.find(function(x) { return x.id === msg.comment.id; });
                    if (updated && typeof __findAnchorForComment === 'function') {
                        var anchor = __findAnchorForComment(updated);
                        if (anchor) showPopover(updated, anchor);
                    }
                }
                return true;
            }
            case 'commentDeleted':
                comments = comments.filter(function(x) { return x.id !== msg.id; });
                updateBadge();
                buildList();
                if (typeof __onCommentChange === 'function') __onCommentChange();
                var _pop1 = document.getElementById('comment-popover');
                if (_pop1) _pop1.style.display = 'none';
                return true;
            case 'refreshComments':
                comments = msg.comments || [];
                updateBadge();
                buildList();
                if (typeof __onCommentChange === 'function') __onCommentChange();
                var _pop2 = document.getElementById('comment-popover');
                if (_pop2) _pop2.style.display = 'none';
                return true;
            case 'openPopover': {
                var oc = comments.find(function(x) { return x.id === msg.commentId; });
                if (oc && typeof __findAnchorForComment === 'function') {
                    var anchor = __findAnchorForComment(oc);
                    if (anchor) showPopover(oc, anchor);
                }
                return true;
            }
            case 'commentAdded':
                comments.push(msg.comment);
                updateBadge();
                buildList();
                if (typeof __onCommentChange === 'function') __onCommentChange();
                return true;
        }
        return false;
    }
    window.handleCommentMessage = handleCommentMessage;

    // --- State persistence across re-renders ---
    // Save UI state so it can be restored after webview.html is replaced
    function _saveState() {
        try {
            var state = vscode.getState() || {};
            state.scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
            state.filter = currentFilter;
            // Check if sidebar/panel is open. Use the COMPUTED style, not the inline
            // style: the panel's default hidden state comes from a CSS stylesheet rule
            // (display:none), so panel.style.display is '' on first load and would be
            // wrongly read as "open" — causing the panel to spuriously appear after a
            // re-render (e.g. when adding/replying to a comment).
            var sidebar = document.getElementById('sidebar');
            var panel = document.getElementById('comment-list-panel');
            if (sidebar) state.sidebarOpen = sidebar.classList.contains('open');
            if (panel) state.panelVisible = getComputedStyle(panel).display !== 'none';
            vscode.setState(state);
        } catch(e) {}
    }

    // Restore state on init
    function _restoreState() {
        try {
            var state = vscode.getState();
            if (!state) return;
            // Restore scroll position after a brief delay (DOM needs to render)
            if (state.scrollTop > 0) {
                setTimeout(function() { window.scrollTo(0, state.scrollTop); }, 100);
                // Second attempt for lazy-loaded content
                setTimeout(function() { window.scrollTo(0, state.scrollTop); }, 500);
            }
            // Restore filter
            if (state.filter && state.filter !== 'all') {
                currentFilter = state.filter;
                var filterBtn = document.getElementById('filter-' + state.filter);
                if (filterBtn) {
                    document.querySelectorAll('.panel-filters button').forEach(function(btn) {
                        btn.classList.remove('active');
                        btn.style.background = 'transparent';
                        btn.style.color = '#ccc';
                    });
                    filterBtn.classList.add('active');
                    filterBtn.style.background = 'var(--vscode-button-background,#0078D4)';
                    filterBtn.style.color = '#fff';
                }
            }
            // Restore sidebar/panel visibility
            if (state.sidebarOpen) {
                var sidebar = document.getElementById('sidebar');
                if (sidebar) sidebar.classList.add('open');
                if (typeof window.toggleSidebar === 'function' && sidebar && !sidebar.classList.contains('open')) {
                    // Already handled above
                }
                buildList();
            }
            if (state.panelVisible) {
                var panel = document.getElementById('comment-list-panel');
                if (panel) panel.style.display = 'block';
                buildList();
            }
        } catch(e) {}
    }
    window._restoreState = _restoreState;
    window._saveState = _saveState;

    // Auto-save state on scroll (debounced)
    var _scrollSaveTimer = null;
    window.addEventListener('scroll', function() {
        if (_scrollSaveTimer) clearTimeout(_scrollSaveTimer);
        _scrollSaveTimer = setTimeout(_saveState, 300);
    }, { passive: true });

    // Save state before page unload (webview.html replacement)
    window.addEventListener('beforeunload', function() { _saveState(); });
`;
}

// ---------- Sidebar HTML ----------

/** Sidebar + toolbar HTML (search, filters, bulk actions). Used by both PPTX and Markdown/Word. */
export function sidebarHtml(opts: { containerId: string; toggleFn: string; filters?: string[]; canSendPrompt?: boolean }): string {
    const filters = opts.filters || ['all', 'open', 'resolved'];
    const filterBtns = filters.map(f => {
        const label = f.charAt(0).toUpperCase() + f.slice(1);
        return `<button id="filter-${f}" ${f === 'all' ? 'class="active"' : ''} onclick="setFilter('${f}')">${label}</button>`;
    }).join('\n            ');
    const directPromptButton = opts.canSendPrompt !== false
        ? '<button onclick="sendAllToCopilot()">Send All to Copilot</button>'
        : '';

    return `
<div class="panel-toolbar" style="padding:0 0 8px;">
    <input type="text" id="comment-search" placeholder="Search comments..." oninput="buildList()" style="width:100%;padding:4px 8px;margin-bottom:6px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-size:12px;box-sizing:border-box;">
    <div class="panel-filters" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
        ${filterBtns}
    </div>
    <div class="panel-bulk" style="display:flex;gap:4px;flex-wrap:wrap;">
        ${directPromptButton}
        <button onclick="copyAllToClipboard()">Copy Prompt</button>
        <button onclick="resolveAll()">Resolve All</button>
        <button onclick="deleteAllResolved()">Delete Resolved</button>
    </div>
</div>
<div id="${opts.containerId}"></div>`;
}

// ---------- Prompt builder helpers ----------

export interface PromptConfig {
    format: 'markdown' | 'docx' | 'pptx';
    filePath: string;
    fileName: string;
    toolPrefix: string;
    toolStyle?: 'native' | 'mcp' | 'both';
    docxXmlPath?: string;
    pptxExtractDir?: string;
}

type PromptTool =
    | 'listComments'
    | 'readComment'
    | 'replyComment'
    | 'resolveComment'
    | 'captureSlide'
    | 'listElements'
    | 'readElementXml'
    | 'writeElementXml'
    | 'saveDocument';

const PROMPT_TOOLS: Record<PromptTool, { native: string; mcp: string }> = {
    listComments: { native: 'listReviewComments', mcp: 'docReview_list_comments' },
    readComment: { native: 'readReviewComment', mcp: 'docReview_read_comment' },
    replyComment: { native: 'replyToReviewComment', mcp: 'docReview_reply_to_comment' },
    resolveComment: { native: 'resolveReviewComment', mcp: 'docReview_resolve_comment' },
    captureSlide: { native: 'captureSlide', mcp: 'docReview_capture_slide' },
    listElements: { native: 'listElements', mcp: 'docReview_list_elements' },
    readElementXml: { native: 'readElementXml', mcp: 'docReview_read_element_xml' },
    writeElementXml: { native: 'writeElementXml', mcp: 'docReview_write_element_xml' },
    saveDocument: { native: 'saveDocument', mcp: 'docReview_save_document' },
};

function toolRef(cfg: PromptConfig, tool: PromptTool): string {
    const names = PROMPT_TOOLS[tool];
    const native = `${cfg.toolPrefix}${names.native}`;
    if (cfg.toolStyle === 'mcp') return names.mcp;
    if (cfg.toolStyle === 'both') return `${native} (VS Code) or ${names.mcp} (MCP)`;
    return native;
}

const DOCX_XML_RULES = `XML EDITING RULES:
1. PRESERVE all w14:paraId attributes on <w:p> elements — review comments are anchored to these IDs
2. When adding NEW <w:p> paragraphs, include w14:paraId with a unique 8-char hex (e.g. w14:paraId="A1B2C3D4" w14:textId="77777777")
3. Do NOT modify <w:commentRangeStart/> or <w:commentRangeEnd/> — those are existing Word comments`;

const PPTX_XML_RULES = `PPTX XML EDITING GUIDE:
- Position: <a:off x="EMU" y="EMU"/> (914400 EMU = 1 inch)
- Size: <a:ext cx="EMU" cy="EMU"/>
- Font size: <a:rPr sz="N"/> (hundredths of a point, e.g. sz="1600" = 16pt)
- Bold/Italic: <a:rPr b="1" i="1"/>
- Text color: <a:solidFill><a:srgbClr val="RRGGBB"/></a:solidFill> inside <a:rPr>
- Shape fill: <a:solidFill><a:srgbClr val="RRGGBB"/></a:solidFill> inside <p:spPr>
- Geometry: <a:prstGeom prst="roundRect"/> (rect, roundRect, rightArrow, etc.)
- Text content: <a:r><a:rPr .../><a:t>text here</a:t></a:r>

XML EDITING RULES:
1. PRESERVE all <p:cNvPr id="N"> attributes — comments and references depend on these IDs
2. Do NOT modify or remove <p188:cm> elements or comment marker nodes — those are existing PowerPoint comments
3. Do NOT modify <mc:AlternateContent> blocks — those contain compatibility fallbacks
4. When changing text, keep the <a:rPr> attributes (font, size, color) unless explicitly asked to change them`;

const NO_AUTO_RESOLVE = `IMPORTANT: Do NOT resolve or close comments automatically. Only resolve a comment when the user explicitly asks you to. After making changes, reply to the comment explaining what you did, but leave it open for the user to verify and resolve.`;

function docxToolsText(cfg: PromptConfig): string {
    const xmlInfo = cfg.docxXmlPath ? `\nThe extracted document.xml is at: ${cfg.docxXmlPath}` : '';
    return `This is a Word (.docx) document stored as XML. You have these tools:\n` +
        `- ${toolRef(cfg, 'listComments')} — list all review comments\n` +
        `- ${toolRef(cfg, 'readComment')} — read full comment with replies\n` +
        `- ${toolRef(cfg, 'replyComment')} — post a reply to a comment\n` +
        `- ${toolRef(cfg, 'resolveComment')} — mark a comment as resolved\n` +
        `- ${toolRef(cfg, 'listElements')} — get a compact text outline of the document (use first for general context)\n` +
        `- ${toolRef(cfg, 'readElementXml')} — read raw XML of a specific element\n` +
        `- ${toolRef(cfg, 'writeElementXml')} — replace an element's XML\n` +
        `- ${toolRef(cfg, 'saveDocument')} — save changes back to .docx\n` +
        `For substantial edits, you can directly edit the XML file.${xmlInfo}\n` +
        DOCX_XML_RULES;
}

function pptxToolsText(cfg: PromptConfig): string {
    const extractInfo = cfg.pptxExtractDir ? `\nExtracted slide XMLs are at: ${cfg.pptxExtractDir}` : '';
    return `This is a .pptx file (Office Open XML). Slide XMLs have been extracted for editing.${extractInfo}\n` +
        PPTX_XML_RULES + '\n\n' +
        `Available tools:\n` +
        `- ${toolRef(cfg, 'listComments')} — list all comments\n` +
        `- ${toolRef(cfg, 'readComment')} — read full comment with replies\n` +
        `- ${toolRef(cfg, 'replyComment')} — post a reply\n` +
        `- ${toolRef(cfg, 'resolveComment')} — mark as resolved\n` +
        `- ${toolRef(cfg, 'captureSlide')} — capture a specific slide as a rendered screenshot (provide slideNumber)`;
}

function reviewToolsText(cfg: PromptConfig): string {
    return `Please use ${toolRef(cfg, 'readComment')} to get the full context, ` +
        `then use ${toolRef(cfg, 'replyComment')} to post a helpful response.`;
}

export function buildSinglePrompt(cfg: PromptConfig, comment: any, mode: 'new' | 'thread'): string {
    const { format, filePath, fileName } = cfg;
    const repliesText = (mode === 'thread' && comment.replies?.length)
        ? '\n- Existing replies:\n' + comment.replies.map((r: any) => `  [${r.role || 'user'}] ${r.text}`).join('\n')
        : '';
    const statusText = mode === 'thread' ? `\n- Status: ${comment.resolved ? 'Resolved' : 'Open'}` : '';
    const action = mode === 'new' ? 'A new review comment was just added' : 'Please respond to this comment thread';

    let header: string;
    let context: string;
    let instructions: string;

    if (format === 'docx') {
        header = `I'm reviewing a Word document "${fileName}" (${filePath}). ${action}:\n\n` +
            `- Comment #${comment.id}: "${comment.comment}"\n` +
            `- On element (paraId=${comment.elementId || 'unknown'}): "${comment.blockPreview || '(unknown)'}"${statusText}` +
            repliesText;
        context = docxToolsText(cfg);
        instructions = `To edit this element: use ${toolRef(cfg, 'readElementXml')}(elementId="${comment.elementId || 'unknown'}") to see its XML, ` +
            `then ${toolRef(cfg, 'writeElementXml')} to replace it, then ${toolRef(cfg, 'saveDocument')} to save.\n` +
            `In the XML, find the <w:p> tag with w14:paraId="${comment.elementId || 'unknown'}" — that's the target element.\n\n` +
            `Please use ${toolRef(cfg, 'readComment')} (with commentId="${comment.id}" and filePath="${filePath}") first, ` +
            `then make the requested changes and use ${toolRef(cfg, 'replyComment')} to explain what you did.`;
    } else if (format === 'pptx') {
        const slideNum = (comment.elementId || '').match(/slide_(\d+)/)?.[1] || '?';
        const shapeId = (comment.elementId || '').split('_shape_')[1] || '';
        header = `I'm reviewing a PowerPoint presentation "${fileName}" (${filePath}). ${action}:\n\n` +
            `- Comment #${comment.id}: "${comment.comment}"\n` +
            `- On: "${comment.blockPreview || '(unknown)'}"\n` +
            `- Slide: ${slideNum}, Shape cNvPr id: ${shapeId || 'N/A'}${statusText}` +
            repliesText;
        context = pptxToolsText(cfg) +
            (shapeId ? `\nTo find this shape, open slide${slideNum}.xml and search for: <p:cNvPr id="${shapeId}"` : '');
        instructions = `Please use ${toolRef(cfg, 'readComment')} (commentId="${comment.id}", filePath="${filePath}") first, ` +
            `then use ${toolRef(cfg, 'replyComment')} to respond.`;
    } else {
        header = `I'm reviewing "${fileName}" (${filePath}). ${action}:\n\n` +
            `- Comment #${comment.id}: "${comment.comment}"\n` +
            `- On block: "${comment.blockPreview || '(unknown)'}"${statusText}` +
            repliesText;
        context = `Available tools:\n` +
            `- ${toolRef(cfg, 'listComments')} — list all review comments\n` +
            `- ${toolRef(cfg, 'readComment')} — read full comment with replies\n` +
            `- ${toolRef(cfg, 'replyComment')} — post a reply\n` +
            `- ${toolRef(cfg, 'resolveComment')} — mark as resolved`;
        instructions = `Please use ${toolRef(cfg, 'readComment')} to get the full context of comment "${comment.id}", ` +
            `then use ${toolRef(cfg, 'replyComment')} to post a helpful response.`;
    }

    return [header, context, instructions, NO_AUTO_RESOLVE].filter(Boolean).join('\n\n');
}

export function buildBatchPromptText(cfg: PromptConfig, comments: any[]): string {
    const { format, filePath, fileName } = cfg;
    const parts: string[] = [];

    if (format === 'docx') {
        parts.push(`Review comments on Word document "${fileName}" (${filePath}):`);
        parts.push(docxToolsText(cfg));
    } else if (format === 'pptx') {
        const extractInfo = cfg.pptxExtractDir ? ` Extracted slide XMLs at: ${cfg.pptxExtractDir}` : '';
        parts.push(`Review comments on PowerPoint "${fileName}" (${filePath}):${extractInfo}`);
        parts.push(`This is a .pptx file. Each shape has <p:cNvPr id="N" name="..."/>. The shapeId in comments matches this id.`);
        parts.push(`XML EDITING: Position=<a:off x/y EMU>, Size=<a:ext cx/cy>, Font=<a:rPr sz="hundredths-pt">, Color=<a:solidFill><a:srgbClr val="hex"/>`);
        parts.push(`RULES: 1) PRESERVE <p:cNvPr id> attributes. 2) Do NOT modify <p188:cm> comment elements. 3) Keep <a:rPr> unless asked to change.`);
        parts.push(`Available tools: ${toolRef(cfg, 'listComments')}, ${toolRef(cfg, 'readComment')}, ${toolRef(cfg, 'replyComment')}, ${toolRef(cfg, 'resolveComment')}, ${toolRef(cfg, 'captureSlide')}\n`);
    } else {
        parts.push(`Review comments on "${fileName}" (${filePath}):`);
        parts.push(`Available tools: ${toolRef(cfg, 'listComments')}, ${toolRef(cfg, 'readComment')}, ${toolRef(cfg, 'replyComment')}, ${toolRef(cfg, 'resolveComment')}\n`);
    }

    for (const c of comments) {
        const eidInfo = c.elementId ? ` (paraId=${c.elementId})` : '';
        let entry = `- Comment #${c.id} [${c.resolved ? 'RESOLVED' : 'OPEN'}]${eidInfo}: "${c.comment}"\n  Block: "${c.blockPreview || '(unknown)'}"`;
        if (c.replies?.length) {
            entry += '\n  Replies:\n' + c.replies.map((r: any) => `    [${r.role || 'user'}] ${r.text}`).join('\n');
        }
        parts.push(entry);
    }
    parts.push(`\nPlease review and respond to each open comment above. For each comment:\n` +
        `1. Use ${toolRef(cfg, 'readComment')} (with commentId and filePath="${filePath}") to get the full context\n` +
        `2. Make the requested changes if applicable\n` +
        `3. Use ${toolRef(cfg, 'replyComment')} (with commentId, text, and filePath="${filePath}") to explain what you did\n` +
        `IMPORTANT: Do NOT resolve comments automatically. Leave them open for the user to verify and resolve.`);
    return parts.join('\n');
}

// ---------- Native comment merge ----------

export interface NativeCommentConfig {
    id: string;            // native ID (e.g. the raw comment ID)
    prefix: string;        // 'word_' or 'pptx_'
    text: string;
    author: string;
    date: string;
    blockType: string;
    blockPreview: string;
    elementId: string;
    source: 'word' | 'pptx';
    nativeReplies?: { id: string; role: string; text: string; timestamp: string }[];
}

export function buildMergedNativeComment(cfg: NativeCommentConfig, sidecarComments: any[]): any {
    const fullId = cfg.prefix + cfg.id;
    const sidecar = sidecarComments.find((c: any) => c.id === fullId);
    const sidecarReplies = sidecar?.replies || [];
    const nativeReplies = cfg.nativeReplies || [];

    return {
        id: fullId,
        anchor: '',
        startOffset: 0,
        endOffset: 0,
        blockType: cfg.blockType,
        blockPreview: cfg.blockPreview,
        comment: cfg.text,
        role: 'user' as const,
        timestamp: cfg.date || new Date().toISOString(),
        resolved: sidecar?.resolved || false,
        elementId: cfg.elementId,
        replies: [...nativeReplies, ...sidecarReplies],
        _wordAuthor: cfg.author,
        _source: cfg.source,
    };
}
