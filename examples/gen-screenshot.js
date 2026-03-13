const fs = require('fs');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkMath = require('remark-math').default || require('remark-math');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeKatex = require('rehype-katex').default || require('rehype-katex');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const { unified } = require('unified');

const md = fs.readFileSync('examples/design-proposal.md', 'utf-8').replace(/<!--@c\d+-->\r?\n?/g, '');
const html = String(unified().use(remarkParse).use(remarkGfm).use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
    .use(rehypeKatex, { throwOnError: false }).use(rehypeStringify, { allowDangerousHtml: true })
    .processSync(md));

const comments = JSON.parse(fs.readFileSync('examples/.design-proposal.md.comments.json', 'utf-8')).comments;

let out = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; max-width: 860px; margin: auto; padding: 20px 40px; background: #1e1e1e; color: #ccc; }
h1 { font-size: 2em; border-bottom: 1px solid #444; padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #444; padding-bottom: .3em; }
h3 { font-size: 1.25em; }
table { border-collapse: collapse; width: auto; margin-bottom: 16px; }
th, td { border: 1px solid #555; padding: 6px 13px; }
th { font-weight: 600; background: #333; }
blockquote { border-left: 4px solid #555; padding: 0 16px; color: #999; }
hr { border: none; border-top: 1px solid #444; margin: 24px 0; }
.comment-block { border-left: 4px solid #ffc107; padding: 8px 12px; background: rgba(255,193,7,.08); margin: 12px 0; border-radius: 4px; }
.comment-header { font-size: 11px; color: #888; margin-bottom: 4px; }
.role-badge { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
.role-user { background: #0e639c; color: #fff; }
.role-agent { background: #6a1b9a; color: #fff; }
.comment-text { font-size: 13px; margin-bottom: 4px; white-space: pre-wrap; }
.reply { margin-left: 16px; border-left: 2px solid #555; padding-left: 8px; margin-top: 6px; }
.resolved { opacity: .5; }
.status-open { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #e65100; color: #fff; margin-left: 4px; }
.status-resolved { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #2e7d32; color: #fff; margin-left: 4px; }
</style></head><body>`;

out += html;
out += '<hr><h2>Review Comments</h2>';

comments.forEach(c => {
    const cls = c.resolved ? 'comment-block resolved' : 'comment-block';
    const status = c.resolved
        ? '<span class="status-resolved">RESOLVED</span>'
        : '<span class="status-open">OPEN</span>';
    out += `<div class="${cls}">`;
    out += `<div class="comment-header"><span class="role-badge role-${c.role || 'user'}">${c.role || 'user'}</span> on <em>${c.blockPreview.substring(0, 60)}...</em> ${status}</div>`;
    out += `<div class="comment-text">${c.comment}</div>`;
    if (c.replies) {
        c.replies.forEach(r => {
            out += `<div class="reply"><div class="comment-header"><span class="role-badge role-${r.role || 'user'}">${r.role || 'user'}</span></div><div class="comment-text">${r.text}</div></div>`;
        });
    }
    out += '</div>';
});

out += '</body></html>';
fs.writeFileSync('examples/preview-screenshot.html', out, 'utf-8');
console.log('HTML written:', fs.statSync('examples/preview-screenshot.html').size, 'bytes');
