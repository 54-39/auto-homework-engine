import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set(['node_modules', 'dist', 'design-preview', 'archive-handoff']);
const collect = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) return [];
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? collect(file) : /\.(mjs|js)$/.test(entry.name) ? [file] : [];
});
let failures = 0;
const files = collect(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) {
    failures++;
    console.error('SYNTAX FAIL', path.relative(root, file), result.error?.message || result.stderr);
  }
}
console.log(`Syntax: ${files.length - failures}/${files.length} passed`);
const tests = fs.readdirSync(path.join(root, 'tools')).filter(name =>
  /^test-.*\.mjs$/.test(name) && !name.endsWith('-browser.mjs') && name !== 'test-extension-startup.mjs' &&
  (process.platform === 'win32' || name !== 'test-updater-bootstrap.mjs')).sort();
let passed = 0;
for (const name of tests) {
  const result = spawnSync(process.execPath, [path.join(root, 'tools', name)], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 0) { passed++; console.log('PASS', name); }
  else {
    failures++;
    console.error('FAIL', name, result.error?.message || '', result.stdout, result.stderr);
  }
}
console.log(`Offline suites: ${passed}/${tests.length} passed; browser launchers excluded`);
process.exitCode = failures ? 1 : 0;
