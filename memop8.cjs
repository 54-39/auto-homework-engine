const fs = require('fs');
const p = 'C:/Users/PC/.zcode/cli/memories/projects/auth-a67ba6e4ae8aacba/memory/homework-helper-project.md';
const insert = fs.readFileSync('mem8.txt', 'utf8');
let s = fs.readFileSync(p, 'utf8');
const idx = s.indexOf('- **0.4.0 清除记忆功能');
if (idx < 0) { console.log('NOT FOUND'); process.exit(1); }
fs.writeFileSync(p, s.slice(0, idx) + insert + s.slice(idx));
fs.unlinkSync('mem8.txt');
console.log('memory ok');
