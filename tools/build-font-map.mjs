/* 从公开的Source Han Sans CN Normal TrueType字体生成本地字形索引；字体来源和许可见fonts/NOTICE.txt。 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
if (!process.argv[2]) throw new Error('用法：node tools/build-font-map.mjs <SourceHanSansCN-Normal.ttf>');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync('content/homework/font-decoder.js', 'utf8'), sandbox);
const candidates = new Map();
for (const [char, bytes] of sandbox.window.HW.FontDecoder.glyphs(fs.readFileSync(process.argv[2]))) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!candidates.has(hash)) candidates.set(hash, new Set());
  candidates.get(hash).add(char.normalize('NFKC'));
}
const map = Object.fromEntries([...candidates].filter(([, chars]) => chars.size === 1).map(([hash, chars]) => [hash, [...chars][0]]));
fs.mkdirSync('content/homework/fonts', { recursive: true });
fs.writeFileSync('content/homework/fonts/glyph-map.json', JSON.stringify({ algorithm: 'sha256-trim-zero-padding', map }));
console.log(`本地字体索引：${Object.keys(map).length} 个唯一字形；${candidates.size - Object.keys(map).length} 个歧义字形未收入`);
