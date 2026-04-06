const { parseDocx } = require('../out/test-parser.js');
const docxPath = 'C:\\Users\\jinqishen\\OneDrive - Microsoft\\Documents\\UMS_Documentation\\Metric\\dogfood\\UMS_Dogfood_Production_Design_export.docx';

parseDocx(docxPath).then(model => {
    console.log('Elements:', model.elements.length);
    console.log('Comments:', model.comments.length);
    
    const roots = model.comments.filter(c => !c.parentId);
    const replies = model.comments.filter(c => c.parentId);
    console.log('Root comments:', roots.length);
    console.log('Reply comments:', replies.length);
    
    roots.forEach(r => {
        const reps = replies.filter(rep => rep.parentId === r.id);
        const anchor = r._anchorText || '(no anchor)';
        console.log('  Thread ' + r.id + ' by ' + r.author.substring(0,20) + ': ' + JSON.stringify(r.text.substring(0,60)));
        console.log('    Anchor: ' + JSON.stringify(anchor.substring(0, 80)));
        reps.forEach(rep => {
            console.log('    Reply ' + rep.id + ' by ' + rep.author.substring(0,20) + ': ' + JSON.stringify(rep.text.substring(0,60)));
        });
    });
}).catch(e => console.error(e));
