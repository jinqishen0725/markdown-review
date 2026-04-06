const fs = require('fs');
let c = fs.readFileSync('node_modules/@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.es.js', 'utf-8');

// Instead of debug logging, let's just fix the bug directly.
// The issue: when marginLeft is 0 and textIndent is negative, text clips.
// Fix: if textIndent is negative and marginLeft would make the effective position negative relative to the container padding,
// ensure marginLeft is at least |textIndent|.

// Find the textIndent application point
const target = 'Z.marginLeft !== void 0 && (b.style.marginLeft = `${Z.marginLeft}px`), Z.textIndent !== void 0 && (b.style.textIndent = `${Z.textIndent}px`)';

// Fix: If textIndent is negative and marginLeft is less than |textIndent|, bump marginLeft up
const fix = 'Z.textIndent !== void 0 && Z.textIndent < 0 && (Z.marginLeft === void 0 || Z.marginLeft < Math.abs(Z.textIndent)) && (Z.marginLeft = Math.abs(Z.textIndent)), Z.marginLeft !== void 0 && (b.style.marginLeft = `${Z.marginLeft}px`), Z.textIndent !== void 0 && (b.style.textIndent = `${Z.textIndent}px`)';

const count = c.split(target).length - 1;
console.log('Found ' + count + ' occurrences');

if (count === 1) {
    c = c.replace(target, fix);
    fs.writeFileSync('node_modules/@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.es.js', c);
    console.log('Patched: negative textIndent now ensures minimum marginLeft');
} else {
    console.log('ERROR: Expected 1 occurrence, found ' + count);
}
