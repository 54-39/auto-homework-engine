import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [rootArg, transactionId, extensionId] = process.argv.slice(2);
const root = path.resolve(rootArg || '');
if (!rootArg || !/^[0-9a-f-]{36}$/i.test(transactionId || '') || !/^[a-p]{32}$/.test(extensionId || '')) {
  process.exit(2);
}
try {
  const updater = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'autoupdate.mjs')).href);
  await updater.runUpdateTransaction({ root, transactionId, extensionId });
} catch (error) {
  const state = {
    ok: false, transactionId, extensionId, phase: 'failed',
    error: String(error?.message || error),
  };
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(root, '.update-state.json'), JSON.stringify(state, null, 2));
  } catch { /* next click can recover from an incomplete transaction */ }
}
