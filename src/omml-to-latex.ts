/**
 * OMML (Office Math Markup Language) → LaTeX converter.
 * Converts Word equation XML to LaTeX strings for KaTeX rendering.
 */

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

export function ommlToLatex(node: any): string {
    if (!node) return '';
    const tag = node.localName;

    switch (tag) {
        case 'oMath':
        case 'oMathPara':
            return childrenToLatex(node);

        case 'r': {
            const tNodes = node.getElementsByTagNameNS(M, 't');
            let text = '';
            for (let i = 0; i < tNodes.length; i++) {
                text += tNodes[i].textContent || '';
            }
            const nor = node.getElementsByTagNameNS(M, 'nor');
            if (nor.length > 0 && text.match(/^[A-Za-z\s]+$/)) {
                return `\\text{${text}}`;
            }
            text = text
                .replace(/∩/g, '\\cap ')
                .replace(/∪/g, '\\cup ')
                .replace(/≥/g, '\\geq ')
                .replace(/≤/g, '\\leq ')
                .replace(/×/g, '\\times ')
                .replace(/±/g, '\\pm ')
                .replace(/∞/g, '\\infty ')
                .replace(/α/g, '\\alpha ')
                .replace(/β/g, '\\beta ')
                .replace(/γ/g, '\\gamma ')
                .replace(/δ/g, '\\delta ')
                .replace(/ε/g, '\\varepsilon ')
                .replace(/θ/g, '\\theta ')
                .replace(/λ/g, '\\lambda ')
                .replace(/μ/g, '\\mu ')
                .replace(/σ/g, '\\sigma ')
                .replace(/π/g, '\\pi ')
                .replace(/Σ/g, '\\Sigma ')
                .replace(/Π/g, '\\Pi ');
            return text;
        }

        case 'f': {
            const num = node.getElementsByTagNameNS(M, 'num')[0];
            const den = node.getElementsByTagNameNS(M, 'den')[0];
            return `\\frac{${childrenToLatex(num)}}{${childrenToLatex(den)}}`;
        }

        case 'rad': {
            const deg = node.getElementsByTagNameNS(M, 'deg')[0];
            const e = node.getElementsByTagNameNS(M, 'e')[0];
            const degText = childrenToLatex(deg);
            if (degText && degText.trim()) {
                return `\\sqrt[${degText}]{${childrenToLatex(e)}}`;
            }
            return `\\sqrt{${childrenToLatex(e)}}`;
        }

        case 'sSup': {
            const base = node.getElementsByTagNameNS(M, 'e')[0];
            const sup = node.getElementsByTagNameNS(M, 'sup')[0];
            return `{${childrenToLatex(base)}}^{${childrenToLatex(sup)}}`;
        }

        case 'sSub': {
            const base = node.getElementsByTagNameNS(M, 'e')[0];
            const sub = node.getElementsByTagNameNS(M, 'sub')[0];
            return `{${childrenToLatex(base)}}_{${childrenToLatex(sub)}}`;
        }

        case 'sSubSup': {
            const base = node.getElementsByTagNameNS(M, 'e')[0];
            const sub = node.getElementsByTagNameNS(M, 'sub')[0];
            const sup = node.getElementsByTagNameNS(M, 'sup')[0];
            return `{${childrenToLatex(base)}}_{${childrenToLatex(sub)}}^{${childrenToLatex(sup)}}`;
        }

        case 'nary': {
            const chr = getAttr(node, 'naryPr', 'chr', 'val') || '∫';
            const sub = node.getElementsByTagNameNS(M, 'sub')[0];
            const sup = node.getElementsByTagNameNS(M, 'sup')[0];
            const e = node.getElementsByTagNameNS(M, 'e')[0];
            const cmdMap: Record<string, string> = {
                '∑': '\\sum', '∏': '\\prod', '∫': '\\int',
                '∬': '\\iint', '∮': '\\oint'
            };
            const cmd = cmdMap[chr] || '\\sum';
            return `${cmd}_{${childrenToLatex(sub)}}^{${childrenToLatex(sup)}} ${childrenToLatex(e)}`;
        }

        case 'd': {
            const begChr = getAttr(node, 'dPr', 'begChr', 'val') || '(';
            const endChr = getAttr(node, 'dPr', 'endChr', 'val') || ')';
            const eNodes = node.getElementsByTagNameNS(M, 'e');
            const inner: string[] = [];
            for (let i = 0; i < eNodes.length; i++) inner.push(childrenToLatex(eNodes[i]));
            return `\\left${begChr} ${inner.join(' , ')} \\right${endChr}`;
        }

        case 'bar': {
            const e = node.getElementsByTagNameNS(M, 'e')[0];
            return `\\overline{${childrenToLatex(e)}}`;
        }

        case 'acc': {
            const e = node.getElementsByTagNameNS(M, 'e')[0];
            const accChr = getAttr(node, 'accPr', 'chr', 'val') || '\u0302';
            const accMap: Record<string, string> = {
                '\u0302': '\\hat', '\u0303': '\\tilde',
                '\u0307': '\\dot', '\u0308': '\\ddot'
            };
            const accCmd = accMap[accChr] || '\\hat';
            return `${accCmd}{${childrenToLatex(e)}}`;
        }

        case 'm': {
            const rows = node.getElementsByTagNameNS(M, 'mr');
            const rowStrs: string[] = [];
            for (let i = 0; i < rows.length; i++) {
                const cols = rows[i].getElementsByTagNameNS(M, 'e');
                const colStrs: string[] = [];
                for (let j = 0; j < cols.length; j++) colStrs.push(childrenToLatex(cols[j]));
                rowStrs.push(colStrs.join(' & '));
            }
            return `\\begin{matrix} ${rowStrs.join(' \\\\ ')} \\end{matrix}`;
        }

        // Container elements — recurse
        case 'e': case 'num': case 'den': case 'sub': case 'sup':
        case 'deg': case 'fName':
            return childrenToLatex(node);

        // Property elements — skip
        case 'rPr': case 'fPr': case 'sSubPr': case 'sSupPr':
        case 'sSubSupPr': case 'naryPr': case 'dPr': case 'barPr':
        case 'accPr': case 'ctrlPr': case 'mPr': case 'mrPr':
            return '';

        default:
            return childrenToLatex(node);
    }
}

function childrenToLatex(node: any): string {
    if (!node || !node.childNodes) return '';
    let result = '';
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1) {
            result += ommlToLatex(child);
        }
    }
    return result;
}

function getAttr(node: any, prTag: string, chrTag: string, attrName: string): string | null {
    const pr = node.getElementsByTagNameNS(M, prTag);
    if (pr.length === 0) return null;
    const chr = pr[0].getElementsByTagNameNS(M, chrTag);
    if (chr.length === 0) return null;
    return chr[0].getAttribute('m:' + attrName) || chr[0].getAttribute(attrName);
}
