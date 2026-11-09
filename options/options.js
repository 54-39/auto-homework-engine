/* 应用设置与工具设置同页；配置仍由后台合并，Key 列表沿用面板的 KEY_* 协议。 */
const IFACES = {
  auto: { baseURL: '', model: '', hint: '自动匹配已知接口；识别成功后会记住接口地址和模型。' },
  openai: { baseURL: '', model: '', hint: '填写服务商提供的 HTTPS 接口地址和模型名，支持 OpenAI 兼容接口。' },
  anthropic: { baseURL: 'https://ark.cn-beijing.volces.com/api/coding', model: 'doubao-seed-code', hint: 'Anthropic Messages 协议。已预填火山 Coding Plan 地址，模型名可按服务商配置修改。' },
};
const $ = id => document.getElementById(id);
let config = {};

/* 模型候选按接口地址所属服务商给出：DeepSeek 地址只有 deepseek-chat，
   换到别家的地址就不再出现 DeepSeek 的模型。地址未填写或不在已知服务商时给占位项。 */
const MODEL_PRESETS = [
  { match: /^https?:\/\/api\.deepseek\.com(?:\/|$)/i, models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { match: /^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/coding(?:\/|$)/i, models: ['doubao-seed-code', 'kimi-k2-thinking', 'deepseek-v3-2', 'glm-4-7', 'doubao-seed-2-0-code'] },
  { match: /^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/v3(?:\/|$)/i, models: ['doubao-seed-1-6-flash-250815'] },
  { match: /^https?:\/\/open\.bigmodel\.cn(?:\/|$)/i, models: ['glm-4-flash', 'glm-4.6'] },
  { match: /^https?:\/\/api\.moonshot\.cn(?:\/|$)/i, models: ['moonshot-v1-8k'] },
  { match: /^https?:\/\/api\.z\.ai(?:\/|$)/i, models: ['glm-4.6'] },
];
const modelsFor = baseURL => {
  const url = String(baseURL || '').trim();
  return url ? (MODEL_PRESETS.find(p => p.match.test(url))?.models || []) : [];
};

const out = (id, text, kind = '') => {
  $(id).textContent = text;
  $(id).className = 'msg' + (kind ? ' ' + kind : '');
};
const send = async (type, payload) => {
  try { return await chrome.runtime.sendMessage({ type, payload }); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
};
const CUSTOM_MODEL = '__custom';
const apiFields = () => ({
  iface: $('provider').value,
  baseURL: $('baseURL').value.trim(),
  model: $('model').value === CUSTOM_MODEL ? $('modelCustom').value.trim() : $('model').value.trim(),
});
const cleanKey = () => $('apiKey').value.replace(/[^\x21-\x7E]/g, '').trim();
/* keep 只在属于当前服务商时保留；未知服务商才给「自定义…」，已知服务商只列自己的模型。 */
const refreshModelOptions = (baseURL, keep) => {
  const models = modelsFor(baseURL);
  const picked = keep && keep !== CUSTOM_MODEL ? keep : '';
  const list = [...models];
  if (picked && !list.includes(picked)) list.push(picked);
  if (!models.length) { list.push(''); list.push(CUSTOM_MODEL); } // 占位 + 自定义
  const select = $('model');
  select.replaceChildren(...list.map(m => m === CUSTOM_MODEL ? new Option('自定义…', CUSTOM_MODEL) : m === '' ? new Option('填写接口地址后选择', '') : new Option(m, m)));
  select.value = picked || models[0] || '';
  window.HW?.SettingsControls?.enhance(select);
  syncCustomField();
  showModelNote(select.value);
};
const syncCustomField = () => { $('modelCustomField').hidden = $('model').value !== CUSTOM_MODEL; };
/* 三个 DeepSeek 模型的差别写在下拉下方，换模型即更新。 */
const MODEL_NOTES = {
  'deepseek-flash': 'flash：速度最快、价格最低；复杂计算和长材料容易出错。适合选择、判断等常识题。',
  'deepseek-chat': 'chat：速度与准确度均衡；比 flash 贵，复杂推理不如 reasoner。适合大多数常规题。',
  'deepseek-reasoner': 'reasoner：先思考再作答，难题和计算题最准，面板会显示思考过程；速度最慢，思考 token 也计费，价格最高。适合数学和多步推理题。',
};
const showModelNote = value => {
  const el = $('modelHint');
  el.textContent = value === CUSTOM_MODEL ? '自定义：按服务商文档填写模型名。' : (MODEL_NOTES[value] || '');
  el.hidden = !el.textContent;
};
const showEngine = () => {
  const api = $('engine').value === 'api';
  $('apiFields').hidden = !api;
  $('apiFields').disabled = !api;
  $('bridgeFields').hidden = api;
  $('bridgeFields').disabled = api;
};
const showAPI = api => {
  $('provider').value = IFACES[api.iface] ? api.iface : (api.baseURL ? 'openai' : 'auto');
  $('baseURL').value = api.baseURL || '';
  $('modelCustom').value = api.model && !modelsFor(api.baseURL).includes(api.model) ? api.model : '';
  refreshModelOptions(api.baseURL || '', api.model || '');
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
$('baseURL').addEventListener('change', () => {
  const url = $('baseURL').value;
  const keep = $('model').value;
  refreshModelOptions(url, keep !== CUSTOM_MODEL && modelsFor(url).includes(keep) ? keep : '');
});
$('model').addEventListener('change', () => { syncCustomField(); showModelNote($('model').value); });
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
  const bridge = { delayMin: +$('delayMin').value, delayMax: +$('delayMax').value, newChat: false, viewMode: $('bridgeViewMode').value };
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
  const payload = { engine: $('engine').value, subjMode: $('subjMode').value, rewriteConfirm: $('rewriteConfirm').checked, api, bridge };
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
  $('rewriteConfirm').checked = config.rewriteConfirm !== false;
  showAPI(config.api || {});
  $('delayMin').value = config.bridge?.delayMin ?? 3000;
  $('delayMax').value = config.bridge?.delayMax ?? 8000;
  $('bridgeViewMode').value = config.bridge?.viewMode === 'window' ? 'window' : 'split';
  showEngine();
  $('appFields').disabled = false;
  out('msg', '');
})();
