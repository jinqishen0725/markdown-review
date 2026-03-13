// Test html-to-docx conversion with the existing export HTML
const fs = require('fs');
const path = require('path');

async function test() {
    const HTMLtoDOCX = (await import('html-to-docx')).default;
    
    const htmlPath = 'c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary_export.html';
    const html = fs.readFileSync(htmlPath, 'utf-8');
    
    // Extract just the body content
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    
    const docxBuffer = await HTMLtoDOCX(bodyHtml, null, {
        table: { row: { cantSplit: true } },
        footer: false,
        header: false,
        pageNumber: false,
    });
    
    const outPath = 'c:/Users/jinqishen/Downloads/test_htmltodocx.docx';
    fs.writeFileSync(outPath, docxBuffer);
    console.log('DOCX written to:', outPath);
    console.log('Size:', fs.statSync(outPath).size, 'bytes');
}

test().catch(err => console.error('Error:', err.message));
