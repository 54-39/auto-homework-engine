/* 配置页逻辑：预设供应商、读写配置（走后台合并存储）、测试 API 连通性 */
const IFACES = {
  auto: { label: '自动识别（推荐）', baseURL: '', model: '', hint: '粘贴 Key 保存后自动并行尝试已知接口，谁先通过鉴权用谁；接口地址和模型都会自动匹配并记住。' },
  openai: { label: 'OpenAI Chat Completions', baseURL: '', model: '', hint: '通用协议。需填写接口地址（如 https://api.deepseek.com/v1）和模型名（如 deepseek-chat）。' },
  anthropic: { label: 'Anthropic Messages', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', model: 'doubao-seed-code', hint: 'Claude 系协议（/v1/messages）。火山 Coding Plan 地址已预填，模型名照抄使用配置页。' },
};

const $ = (id) => document.getElementById(id);

/* 引擎 / 接口类型与面板共用同一份自绘下拉（原生 select 的展开层是系统窗口，样式改不到）；
   尺寸差异由 options.html 的 :root 变量覆盖。控件接口模仿 select：.value 读写照旧。 */
const engineCtl = HW.Dropdown.create({
  into: $('engine'),
  items: [
    { id: 'api', label: 'API 引擎（OpenAI 兼容）' },
    { id: 'bridge', label: '豆包网页桥接（免费）' },
  ],
  value: 'api',
});
const providerCtl = HW.Dropdown.create({
  into: $('provider'),
  items: Object.entries(IFACES).map(([id, v]) => ({ id, label: v.label })),
  value: 'auto',
  onChange: (iface) => {
    const p = IFACES[iface];
    $('baseURL').value = p.baseURL;
    $('model').value = p.model;
    $('providerHint').textContent = p.hint || '';
  },
});

function currentAPIConfig() {
  return {
    iface: providerCtl.value,
    baseURL: $('baseURL').value.trim(),
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
  };
}

const msg = (text, cls = '') => ($('msg').textContent = text), setCls = (cls) => ($('msg').className = 'msg ' + cls);

async function requestAPIHostPermission(baseURL) {
  let url;
  try { url = new URL(baseURL); } catch { return false; }
  if (url.protocol !== 'https:') {
    msg('接口地址必须使用 HTTPS');
    setCls('err');
    return false;
  }
  const origin = `${url.origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    msg('未授予该接口域名权限，配置未保存');
    setCls('err');
  }
  return granted;
}

$('save').addEventListener('click', async () => {
  const rawKey = $('apiKey').value;
  const cleanKey = rawKey.replace(/[^\x21-\x7E]/g, '').trim();
  if (rawKey && !cleanKey) {
    msg('Key 无效：清理掉中文/全角/空格后为空，请重新复制');
    setCls('err');
    return;
  }
  if (cleanKey !== rawKey.trim()) {
    $('apiKey').value = cleanKey;
  }
  const api = currentAPIConfig();
  if (api.baseURL && !(await requestAPIHostPermission(api.baseURL))) return;
  const payload = {
    engine: engineCtl.value,
    subjMode: $('subjMode').value,
    verify2: $('verify2').checked,
    api,
    bridge: {
      delayMin: +$('delayMin').value || 3000,
      delayMax: +$('delayMax').value || 8000,
      newChat: $('newChat').checked,
    },
  };
  const res = await chrome.runtime.sendMessage({ type: 'SET_CONFIG', payload });
  if (res?.ok) {
    msg('已保存 ✓');
    setCls('ok');
  } else {
    msg('保存失败：' + (res?.error || '未知错误'));
    setCls('err');
  }
});

$('test').addEventListener('click', async () => {
  const api = currentAPIConfig();
  if (!api.baseURL || !api.apiKey || !api.model) {
    msg('请先填写 baseURL、模型名和 API Key');
    setCls('err');
    return;
  }
  if (!(await requestAPIHostPermission(api.baseURL))) return;
  msg('测试中…');
  setCls('');
  const res = await chrome.runtime.sendMessage({ type: 'TEST_API', payload: { api } });
  if (res?.ok) {
    msg('连接成功，模型回复：' + res.reply);
    setCls('ok');
  } else {
    msg('连接失败：' + (res?.error || '未知错误'));
    setCls('err');
  }
});

$('memAckReset').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SET_CONFIG', payload: { clearAck: false } });
  if (res?.ok) {
    $('memAckRow').hidden = true;
    msg('已恢复：下次在设置页清除记忆会先显示确认');
    setCls('ok');
  }
});

$('clearKey').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SET_CONFIG', payload: { api: { apiKey: '' } } });
  if (res?.ok) {
    $('apiKey').value = '';
    $('keyStatus').textContent = '已清除（当前未保存 Key）';
  }
});

// 初始化：读配置回显
(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  const cfg = res?.config;
  if (!cfg) return;
  engineCtl.value = cfg.engine;
  if (cfg.subjMode) $('subjMode').value = cfg.subjMode;
  $('verify2').checked = cfg.verify2 !== false;
  const api = cfg.api || {};
  providerCtl.value = IFACES[api.iface] ? api.iface : (api.baseURL ? 'openai' : 'auto');
  $('baseURL').value = api.baseURL || '';
  $('model').value = api.model || '';
  $('apiKey').value = api.apiKey || '';
  $('keyStatus').textContent = api.apiKey
    ? `当前已保存（尾号 ${api.apiKey.slice(-4)}），下方输入框输入新值可覆盖`
    : '当前未保存 Key';
  $('providerHint').textContent = IFACES[providerCtl.value].hint || '';
  $('memAckRow').hidden = !cfg.clearAck;
  const bridge = cfg.bridge || {};
  $('delayMin').value = bridge.delayMin ?? 3000;
  $('delayMax').value = bridge.delayMax ?? 8000;
  $('newChat').checked = bridge.newChat !== false;
})();
