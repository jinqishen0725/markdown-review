/**
 * Post-install script to patch @aiden0z/pptx-renderer bugs.
 * Run automatically via npm postinstall or manually: node patches/apply-pptx-renderer-patches.js
 * 
 * Patches:
 * 1. Color bug: fontRefColor overrides defRPr cascade color (white text on light backgrounds)
 * 2. Indent bug: negative textIndent without matching marginLeft (bullet text clips left)
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'node_modules', '@aiden0z', 'pptx-renderer', 'dist', 'aiden0z-pptx-renderer.es.js');

if (!fs.existsSync(filePath)) {
    console.log('pptx-renderer not installed, skipping patches.');
    process.exit(0);
}

let c = fs.readFileSync(filePath, 'utf-8');
let patchCount = 0;

// Patch 1: Color bug — fontRefColor should not override cascade color (Y.color)
const colorOld = 'r != null && r.fontRefColor ? J = k ? Y.color : r.fontRefColor';
const colorNew = 'r != null && r.fontRefColor ? J = (Y.color || k) ? Y.color : r.fontRefColor';
if (c.includes(colorOld)) {
    c = c.replace(colorOld, colorNew);
    patchCount++;
    console.log('  ✓ Patch 1: Color resolution (defRPr cascade priority)');
} else if (c.includes(colorNew)) {
    console.log('  ○ Patch 1: Already applied');
} else {
    console.log('  ✗ Patch 1: Target not found — library version may have changed');
}

// Patch 2: Indent bug — ensure marginLeft >= |textIndent| for hanging indents
const indentOld = 'Z.marginLeft !== void 0 && (b.style.marginLeft = `${Z.marginLeft}px`), Z.textIndent !== void 0 && (b.style.textIndent = `${Z.textIndent}px`)';
const indentNew = 'Z.textIndent !== void 0 && Z.textIndent < 0 && (Z.marginLeft === void 0 || Z.marginLeft < Math.abs(Z.textIndent)) && (Z.marginLeft = Math.abs(Z.textIndent)), Z.marginLeft !== void 0 && (b.style.marginLeft = `${Z.marginLeft}px`), Z.textIndent !== void 0 && (b.style.textIndent = `${Z.textIndent}px`)';
if (c.includes(indentOld)) {
    c = c.replace(indentOld, indentNew);
    patchCount++;
    console.log('  ✓ Patch 2: Hanging indent overflow fix');
} else if (c.includes(indentNew)) {
    console.log('  ○ Patch 2: Already applied');
} else {
    console.log('  ✗ Patch 2: Target not found — library version may have changed');
}

if (patchCount > 0) {
    fs.writeFileSync(filePath, c);
    console.log(`Applied ${patchCount} patch(es) to @aiden0z/pptx-renderer`);
} else {
    console.log('No patches needed.');
}
