import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = 'repos/54-39/auto-homework-engine';
const PUSH = process.argv.includes('--push');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const MESSAGE = process.argv.find((a) => a.startsWith('--message='))?.slice(10) || ('Release v' + VERSION);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'design-preview', '.native-runtime', 'archive-handoff', '.codex', '.agents', '.workbuddy']);
const SKIP_FILES = new Set(['hot-reload.json', '.crinfo', '.update-state.json', '.update-files.json', 'tools/native-host.exe', '.gitattributes']);
const SKIP_GLOBS = [/^HANDOFF/, /^TASK-.*\.md$/, /^REPORT-.*\.md$/, /\.log$/, /^\.native-host.*\.json$/, /^\.env/, /^\.tmp/, /^\.update-/];

function gh(args, input) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('gh ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout).slice(0, 400));
  return r.stdout;
}
const api = (p, input) => JSON.parse(gh(['api', p, ...(input ? ['--method', 'POST', '--input', '-'] : [])], input));

function collect() {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (rel === '_locales/_locales') continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.tmp') || name.startsWith('.update-')) continue;
        walk(full);
      } else {
        if (SKIP_FILES.has(rel) || SKIP_FILES.has(name)) continue;
        if (SKIP_GLOBS.some((re) => re.test(name))) continue;
        out.push({ rel, full });
      }
    }
  })(ROOT);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const blobSha = (buf) => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');

const ref = api(REPO + '/git/ref/heads/master');
const baseSha = ref.object.sha;
const commit = api(REPO + '/git/commits/' + baseSha);
const baseTree = commit.tree.sha;
const remoteTree = api(REPO + '/git/trees/' + baseTree + '?recursive=1');
const remote = new Map(remoteTree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));

const files = collect();
const changed = [];
for (const f of files) {
  const buf = fs.readFileSync(f.full);
  const sha = blobSha(buf);
  if (remote.get(f.rel) === sha) continue;
  changed.push({ ...f, buf, sha });
}
const missing = [...remote.keys()].filter((p) => !files.some((f) => f.rel === p));

console.log(JSON.stringify({ baseSha, baseTree, localFiles: files.length, changed: changed.length, remoteOnly: missing.length, remoteOnlySample: missing.slice(0, 10) }, null, 1));
if (process.argv.includes('--verbose')) console.log('changed:', changed.map((f) => f.rel));
if (!PUSH) process.exit(0);
if (!changed.length) { console.log('no changes to push'); process.exit(0); }

const entries = [];
for (const f of changed) {
  const blob = api(REPO + '/git/blobs', JSON.stringify({ content: f.buf.toString('base64'), encoding: 'base64' }));
  entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  process.stdout.write('.');
}
console.log('\nblobs uploaded', entries.length);

const tree = api(REPO + '/git/trees', JSON.stringify({ base_tree: baseTree, tree: entries }));
const newCommit = api(REPO + '/git/commits', JSON.stringify({
  message: MESSAGE,
  tree: tree.sha,
  parents: [baseSha],
}));
api(REPO + '/git/refs/heads/master', JSON.stringify({ sha: newCommit.sha, force: false }));
const verify = api(REPO + '/git/ref/heads/master');
console.log(JSON.stringify({ commit: newCommit.sha, master: verify.object.sha, tree: tree.sha }));