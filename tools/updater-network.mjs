import { spawnSync } from 'node:child_process';

export function windowsSystemProxy() {
  const script = "$u=[Uri]'https://api.github.com/';$p=[System.Net.WebRequest]::DefaultWebProxy.GetProxy($u);if($p -and $p.AbsoluteUri -ne $u.AbsoluteUri){[Console]::Write($p.AbsoluteUri)}";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  const value = String(result.stdout || '').replace(/^\uFEFF/, '').trim();
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function updaterEnvironment(source = process.env, { platform = process.platform, lookupSystemProxy = windowsSystemProxy } = {}) {
  const env = { ...source };
  if (!env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';
  if (!env.NODE_USE_SYSTEM_CA) env.NODE_USE_SYSTEM_CA = '1';

  const getProxy = (name) => env[name] || env[name.toLowerCase()] || '';
  let httpProxy = getProxy('HTTP_PROXY');
  let httpsProxy = getProxy('HTTPS_PROXY');
  if (platform === 'win32' && !httpProxy && !httpsProxy) {
    const systemProxy = lookupSystemProxy();
    if (systemProxy) httpProxy = httpsProxy = systemProxy;
  }
  if (!httpsProxy && httpProxy) httpsProxy = httpProxy;
  if (!httpProxy && httpsProxy) httpProxy = httpsProxy;
  if (httpProxy) {
    env.HTTP_PROXY ||= httpProxy;
    env.http_proxy ||= httpProxy;
  }
  if (httpsProxy) {
    env.HTTPS_PROXY ||= httpsProxy;
    env.https_proxy ||= httpsProxy;
  }
  return env;
}
