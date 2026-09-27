/* 配置页逻辑：预设供应商、读写配置（走后台合并存储）、测试 API 连通性 */
const IFACES = {
  auto: { label: '自动识别（推荐）', baseURL: '', model: '', hint: '粘贴 Key 保存后自动并行尝试已知接口，谁先通过鉴权用谁；接口地址和模型都会自动匹配并记住。' },
  openai: { label: 'OpenAI Chat Completions', baseURL: '', model: '', hint: '通用协议。需填写接口地址（如 https://api.deepseek.com/v1）和模型名（如 deepseek-chat）。' },
  anthropic: { label: 'Anthropic Messages', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', model: 'doubao-seed-code', hint: 'Claude 系协议（/v1/messages）。火山 Coding Plan 地址已预填，模型名照抄使用配置页。' },
};

const $ = (id) => document.getElementById(id);
const providerSel = $('provider');
Object.entries(IFACES).forEach(([k, v]) => {
  const o = document.createElement('option');
  o.value = k;
  o.textContent = v.label;
  providerSel.appendChild(o);
});

function currentAPIConfig() {
  return {
    iface: providerSel.value,
    baseURL: $('baseURL').value.trim(),
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
  };
}

providerSel.addEventListener('change', () => {
  const p = IFACES[providerSel.value];
  $('baseURL').value = p.baseURL;
  $('model').value = p.model;
  $('providerHint').textContent = p.hint || '';
});

const msg = (text, cls = '') => ($('msg').textContent = text), setCls = (cls) => ($('msg').className = 'msg ' + cls);

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
  const payload = {
    engine: $('engine').value,
    subjMode: $('subjMode').value,
    api: currentAPIConfig(),
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
    $('memAckRow').style.display = 'none';
    msg('已恢复：下次点击面板 🧹 会先显示介绍弹窗');
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
  $('engine').value = cfg.engine;
  if (cfg.subjMode) $('subjMode').value = cfg.subjMode;
  const api = cfg.api || {};
  providerSel.value = IFACES[api.iface] ? api.iface : (api.baseURL ? 'openai' : 'auto');
  $('baseURL').value = api.baseURL || '';
  $('model').value = api.model || '';
  $('apiKey').value = api.apiKey || '';
  $('keyStatus').textContent = api.apiKey
    ? `当前已保存（尾号 ${api.apiKey.slice(-4)}），下方输入框输入新值可覆盖`
    : '当前未保存 Key';
  $('providerHint').textContent = IFACES[providerSel.value].hint || '';
  $('memAckRow').style.display = cfg.clearAck ? '' : 'none';
  const bridge = cfg.bridge || {};
  $('delayMin').value = bridge.delayMin ?? 3000;
  $('delayMax').value = bridge.delayMax ?? 8000;
  $('newChat').checked = bridge.newChat !== false;
})();
