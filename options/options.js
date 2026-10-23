/* 应用设置与工具设置同页；配置仍由后台合并，Key 列表沿用面板的 KEY_* 协议。 */
const IFACES = {
  auto: { baseURL: '', model: '', hint: '自动匹配已知接口；识别成功后会记住接口地址和模型。' },
  openai: { baseURL: '', model: '', hint: '填写服务商提供的 HTTPS 接口地址和模型名，支持 OpenAI 兼容接口。' },
  anthropic: { baseURL: 'https://ark.cn-beijing.volces.com/api/coding', model: 'doubao-seed-code', hint: 'Anthropic Messages 协议。已预填火山 Coding Plan 地址，模型名可按服务商配置修改。' },
};
const $ = id => document.getElementById(id);
let config = {};

const out = (id, text, kind = '') => {
  $(id).textContent = text;
  $(id).className = 'msg' + (kind ? ' ' + kind : '');
};
const send = async (type, payload) => {
  try { return await chrome.runtime.sendMessage({ type, payload }); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
};
const apiFields = () => ({ iface: $('provider').value, baseURL: $('baseURL').value.trim(), model: $('model').value.trim() });
const cleanKey = () => $('apiKey').value.replace(/[^\x21-\x7E]/g, '').trim();
const showEngine = () => {
  const api = $('engine').value === 'api';
  $('apiFields').hidden = !api;
  $('apiFields').disabled = !api;
  $('bridgeFields').hidden = api;
  $('bridgeFields').disabled = api;
  $('verify2').disabled = !api;
};
const showAPI = api => {
  $('provider').value = IFACES[api.iface] ? api.iface : (api.baseURL ? 'openai' : 'auto');
  $('baseURL').value = api.baseURL || '';
  $('model').value = api.model || '';
  $('providerHint').textContent = IFACES[$('provider').value].hint;
};

async function refreshKeys() {
  const [current, keys] = await Promise.all([send('GET_CONFIG'), send('KEY_LIST')]);
  if (!current?.ok || !keys?.ok) {
    out('keyMsg', '读取 Key 失败：' + (current?.error || keys?.error || '请刷新重试'), 'err');
    return false;
  }
  config = current.config;
  const active = config.api?.apiKey || '';
  const list = keys.list || [];
  $('keyStatus').textContent = active
    ? `使用中：尾号 ${active.slice(-4)}${list.some(rec => rec.key === active) ? '' : '（未加入已保存列表）'}`
    : '当前未使用 Key';
  $('clearKey').disabled = !active;
  $('savedKeys').replaceChildren();
  for (const rec of list) {
    const isActive = rec.key === active;
    const row = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'app-key-info';
    const title = document.createElement('strong');
    title.textContent = `${isActive ? '使用中 · ' : ''}尾号 ${rec.key.slice(-4)}`;
    if (isActive) title.className = 'active';
    const meta = document.createElement('small');
    const iface = rec.iface === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容';
    meta.textContent = `${iface} · ${new Date(rec.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'app-key-actions';
    const use = document.createElement('button');
    use.type = 'button'; use.className = 'ghost'; use.textContent = '使用'; use.disabled = isActive;
    use.setAttribute('aria-label', `使用尾号 ${rec.key.slice(-4)} 的 Key`);
    use.addEventListener('click', () => changeKey('KEY_USE', { id: rec.id }, `已使用尾号 ${rec.key.slice(-4)} 的 Key`));
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'ghost'; remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除尾号 ${rec.key.slice(-4)} 的 Key`);
    remove.addEventListener('click', () => changeKey('KEY_REMOVE', { id: rec.id, key: rec.key }, `已删除该 Key${isActive ? '，并停用' : ''}`));
    actions.append(use, remove); row.append(info, actions); $('savedKeys').append(row);
  }
  return true;
}

async function requestAPIHostPermission(baseURL, msgId) {
  let url;
  try { url = new URL(baseURL); } catch { out(msgId, '接口地址无效，请填写完整的 HTTPS 地址', 'err'); return false; }
  if (url.protocol !== 'https:') { out(msgId, '接口地址必须使用 HTTPS', 'err'); return false; }
  try {
    const origins = [`${url.origin}/*`];
    if (await chrome.permissions.contains({ origins })) return true;
    if (await chrome.permissions.request({ origins })) return true;
    out(msgId, '未授予该接口域名权限，请允许访问后重试', 'err');
  } catch (e) { out(msgId, '无法申请接口访问权限：' + e.message, 'err'); }
  return false;
}

async function changeKey(type, payload, message) {
  $('appFields').disabled = true;
  out('keyMsg', type === 'KEY_SAVE' ? '正在自动识别接口与模型，请稍候…' : '正在更新 Key…');
  try {
    const result = await send(type, payload);
    if (!result?.ok) return out('keyMsg', '操作失败：' + (result?.error || '请重试'), 'err');
    if (type === 'KEY_SAVE' || (type === 'SET_CONFIG' && payload.api?.apiKey)) $('apiKey').value = '';
    if (await refreshKeys()) {
      showAPI(config.api || {});
      out('keyMsg', message, 'ok');
    }
  } finally { $('appFields').disabled = false; }
}

async function saveKey(remember, acknowledge = false) {
  const key = cleanKey();
  if (!key) { out('keyMsg', '请粘贴有效的 API Key', 'err'); $('apiKey').focus(); return; }
  if (acknowledge) {
    const result = await send('SET_CONFIG', { keyWarned: true });
    if (!result?.ok) return out('keyMsg', '无法保存风险告知状态：' + (result?.error || '请重试'), 'err');
    config.keyWarned = true;
  }
  $('keyConfirm').hidden = true;
  if (remember) await changeKey('KEY_SAVE', { key, iface: 'auto' }, '已识别接口并记住 Key');
  else {
    const api = $('apiDetails').open ? apiFields() : { iface: 'auto', baseURL: '', model: '' };
    if (api.baseURL && !(await requestAPIHostPermission(api.baseURL, 'keyMsg'))) return;
    await changeKey('SET_CONFIG', { api: { apiKey: key, ...api } }, '已临时使用 Key，未加入已保存列表');
  }
}

$('engine').addEventListener('change', showEngine);
$('provider').addEventListener('change', () => showAPI({ iface: $('provider').value, ...IFACES[$('provider').value] }));
$('saveKey').addEventListener('click', () => {
  if (!cleanKey()) { out('keyMsg', '请先粘贴 API Key', 'err'); $('apiKey').focus(); return; }
  if (config.keyWarned) return saveKey(true);
  $('keyConfirm').hidden = false;
  $('keyConfirmSave').focus();
});
$('tempKey').addEventListener('click', () => saveKey(false));
$('keyConfirmSave').addEventListener('click', () => saveKey(true, true));
$('keyConfirmTemp').addEventListener('click', () => saveKey(false, true));
$('keyCancel').addEventListener('click', () => { $('keyConfirm').hidden = true; $('apiKey').focus(); });
$('clearKey').addEventListener('click', () => changeKey('SET_CONFIG', { api: { apiKey: '' } }, '已停用当前 Key，列表记录保留，可随时重新使用'));

$('appForm').addEventListener('submit', async event => {
  event.preventDefault();
  const api = apiFields();
  const bridge = { delayMin: +$('delayMin').value, delayMax: +$('delayMax').value, newChat: $('newChat').checked };
  if ($('engine').value === 'bridge' && bridge.delayMax < bridge.delayMin) {
    out('msg', '间隔上限不能小于下限，请调整后再保存', 'err'); $('delayMax').focus(); return;
  }
  if ($('engine').value === 'api' && api.iface !== 'auto' && (!api.baseURL || !api.model)) {
    $('apiDetails').open = true;
    out('msg', '请填写自定义接口地址与模型名，或选择自动识别', 'err'); return;
  }
  if ($('engine').value === 'api' && api.baseURL && !(await requestAPIHostPermission(api.baseURL, 'msg'))) return;
  $('appFields').disabled = true;
  out('msg', '正在保存设置…');
  const payload = { engine: $('engine').value, subjMode: $('subjMode').value, verify2: $('verify2').checked, api, bridge };
  const result = await send('SET_CONFIG', payload);
  $('appFields').disabled = false;
  if (result?.ok) {
    config = result.config;
    out('msg', '设置已保存' + ($('apiKey').value.trim() ? '；新粘贴的 Key 请点「识别并记住」或「临时使用」' : ''), 'ok');
  } else out('msg', '保存失败：' + (result?.error || '请重试'), 'err');
});

$('test').addEventListener('click', async () => {
  const api = { ...apiFields(), apiKey: cleanKey() || config.api?.apiKey || '' };
  if (!api.baseURL || !api.apiKey || !api.model) return out('testMsg', '请填写接口地址、模型名和 API Key，或先识别并记住 Key', 'err');
  if (!(await requestAPIHostPermission(api.baseURL, 'testMsg'))) return;
  $('test').disabled = true;
  out('testMsg', '正在测试连接…');
  const result = await send('TEST_API', { api });
  $('test').disabled = false;
  out('testMsg', result?.ok ? '连接成功：' + result.reply : '连接失败：' + (result?.error || '请重试'), result?.ok ? 'ok' : 'err');
});

(async () => {
  if (!(await refreshKeys())) { out('msg', '设置读取失败，请刷新页面后重试', 'err'); return; }
  $('engine').value = config.engine || 'api';
  $('subjMode').value = config.subjMode || 'ask';
  $('verify2').checked = config.verify2 !== false;
  showAPI(config.api || {});
  $('delayMin').value = config.bridge?.delayMin ?? 3000;
  $('delayMax').value = config.bridge?.delayMax ?? 8000;
  $('newChat').checked = config.bridge?.newChat !== false;
  showEngine();
  $('appFields').disabled = false;
  out('msg', '');
})();
