/* API 引擎：按"接口类型"调用 + 自动探测
   - openai：POST {base}/chat/completions（OpenAI 兼容，DeepSeek/智谱/Kimi/火山/通义 等）
   - anthropic：POST {base}/v1/messages（Claude 系协议，火山 Coding Plan / Z.ai）
   - 自动探测：粘贴 Key 后并行尝试已知接口，谁先通过鉴权用谁（结果按 Key 尾号记住） */
import { buildMessages, parseAnswer, buildMultiVerify, buildJudgeVerify, parseJudgeVerify } from './engine.js';

export function sanitizeKey(k) {
  return String(k || '').replace(/[^\x21-\x7E]/g, '').trim();
}

function hostOf(baseURL) {
  try {
    return new URL(baseURL).host;
  } catch {
    return String(baseURL || '');
  }
}

function keyKind(k) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return 'uuid';
  if (/^[0-9a-zA-Z]{8,}\.[0-9a-zA-Z]{8,}$/.test(k)) return 'dot';
  return 'sk';
}

const TIMEOUT = 120000;

const OPENAI_PRESETS = [
  { baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
  { baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', models: ['doubao-seed-code', 'kimi-k2-thinking', 'deepseek-v3-2', 'glm-4-7', 'doubao-seed-2-0-code'] },
  { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6-flash-250815'] },
  { baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash'] },
  { baseURL: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k'] },
  { baseURL: 'https://api.z.ai/api/coding/paas/v4', models: ['glm-4.6'] },
];
const ANTHROPIC_PRESETS = [
  { baseURL: 'https://ark.cn-beijing.volces.com/api/coding', models: ['doubao-seed-code', 'kimi-k2-thinking'] },
  { baseURL: 'https://api.z.ai/api/anthropic', models: ['glm-4.6'] },
];

async function chatOpenAI(cfg, messages, maxTokens) {
  const url = String(cfg.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
  const key = sanitizeKey(cfg.apiKey);
  if (!key) throw new Error('API Key 清理后为空（可能全是中文/全角字符），请重新复制粘贴');
  // 火山（volces.com）：关闭思考模式——推理模型思考可达数分钟，客观题不需要；
  // 服务端不认该参数（400 提到 thinking）时自动去掉重试
  const isVolc = /volces\.com/.test(url);
  const mkBody = (withThinking) => {
    const b = { model: cfg.model, messages, temperature: 0, max_tokens: maxTokens, stream: false };
    if (withThinking) b.thinking = { type: 'disabled' };
    return b;
  };
  const attempt = async (body) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（120 秒无响应）。该模型可能响应较慢，可点「使用」换一条 Key 或在设置里换模型');
        throw e;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${txt.slice(0, 120)}（接口: ${hostOf(cfg.baseURL)}，模型: ${cfg.model}）`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('接口返回内容为空');
      return content;
    } finally {
      clearTimeout(timer);
    }
  };
  if (!isVolc) return await attempt(mkBody(false));
  try {
    return await attempt(mkBody(true));
  } catch (e) {
    // thinking 参数不被支持（400 且响应里提到参数问题）→ 去掉该参数重试
    if (e.status === 400 && !/key|token|auth/i.test(String(e.message || ''))) {
      return await attempt(mkBody(false));
    }
    throw e;
  }
}

async function chatAnthropic(cfg, userMsg, maxTokens, system) {
  const url = String(cfg.baseURL || '').replace(/\/+$/, '') + '/v1/messages';
  const key = sanitizeKey(cfg.apiKey);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: userMsg, temperature: 0 }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求超时（120 秒无响应）。该模型可能响应较慢，可点「使用」换一条 Key 或在设置里换模型');
      throw e;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${txt.slice(0, 120)}（接口: ${hostOf(cfg.baseURL)}/v1/messages，模型: ${cfg.model}）`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const content = Array.isArray(data.content) ? data.content.map((c) => c.text || '').join('') : '';
    if (!content) throw new Error('接口返回内容为空');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/* 探测/记忆（按 Key 尾号绑定） */
const EP_KEY = 'apiEndpoint';
async function loadEndpoint(tail) {
  try {
    const o = await chrome.storage.local.get(EP_KEY);
    const v = o[EP_KEY];
    if (v && v.keyTail === tail && v.baseURL && v.model) return { iface: v.iface || 'openai', baseURL: v.baseURL, model: v.model };
  } catch {
    /* storage 不可用时忽略 */
  }
  return null;
}
async function saveEndpoint(tail, ep) {
  try {
    await chrome.storage.local.set({ [EP_KEY]: { keyTail: tail, iface: ep.iface, baseURL: ep.baseURL, model: ep.model } });
  } catch {
    /* 同上 */
  }
}

/* 自动探测：并行尝试候选接口（按 Key 外观缩小范围），返回第一个通过鉴权的 {iface, baseURL, model} */
export async function detectEndpoint(rawKey, ifaceFilter, exclude) {
  const key = sanitizeKey(rawKey);
  const kind = keyKind(key);
  let cands = [];
  const push = (p, iface) => p.models.forEach((m) => cands.push({ iface, baseURL: p.baseURL, model: m }));
  if (kind === 'uuid') {
    OPENAI_PRESETS.forEach((p) => push(p, 'openai'));
    ANTHROPIC_PRESETS.forEach((p) => push(p, 'anthropic'));
  } else if (kind === 'dot') {
    OPENAI_PRESETS.filter((p) => p.baseURL.includes('bigmodel')).forEach((p) => push(p, 'openai'));
  } else {
    OPENAI_PRESETS.forEach((p) => push(p, 'openai'));
  }
  if (ifaceFilter === 'openai' || ifaceFilter === 'anthropic') cands = cands.filter((c) => c.iface === ifaceFilter);
  if (exclude) cands = cands.filter((c) => !(c.baseURL === exclude.baseURL && c.model === exclude.model && c.iface === exclude.iface));
  if (!cands.length) throw new Error('没有可尝试的候选接口，请手动指定接口类型和地址');
  const winner = await Promise.any(
    cands.map(async (c) => {
      if (c.iface === 'anthropic') {
        await chatAnthropic({ ...c, apiKey: key }, [{ role: 'user', content: 'hi' }], 8, '');
      } else {
        await chatOpenAI({ ...c, apiKey: key }, [{ role: 'user', content: 'hi' }], 8);
      }
      return c;
    }),
  );
  return winner;
}

function maxTokensFor(q) {
  // 推理模型（doubao-seed-code/kimi-k2-thinking 等）思考也消耗 token，预算给足；
  // 写作题要整篇作文，4096（其余主观题 2048、客观题 1024）
  return q.writing ? 4096 : q.type === 'subjective' ? 2048 : 1024;
}

async function callIface(cfg, messages, maxTokens) {
  if (cfg.iface === 'anthropic') {
    const [sys, ...rest] = messages;
    return await chatAnthropic(cfg, rest, maxTokens, sys.content);
  }
  return await chatOpenAI(cfg, messages, maxTokens);
}

async function run(q, endpoint, maxTokens, opts = {}) {
  const msgs = buildMessages(q);
  const cfg = { ...endpoint, apiKey: sanitizeKey(endpoint.apiKey) };
  let content = await callIface(cfg, msgs, maxTokens);
  let answer;
  try { answer = parseAnswer(q, content); }
  catch (e) { e.answerPreview = content; throw e; }
  let note = '';
  /* 两次结论冲突或复核失败时不能任选一个继续填写；交给既有失败即停流程。
     用户 2026-10-21 23:38 明确：先刷完，不强求正确率——所以这里改成保留初答继续填，
     把差异如实写进 note，事后可以回头看错题；填空题仍按原逻辑严格校验。 */
  if (['multi', 'judge'].includes(q.type) && answer && opts.verify2 !== false) {
    let verification = '';
    try {
      const messages = q.type === 'multi' ? buildMultiVerify(q, answer) : buildJudgeVerify(q, answer);
      verification = await callIface(cfg, messages, 1024);
      const checked = q.type === 'judge' ? parseJudgeVerify(verification) : parseAnswer(q, verification);
      if (!checked) note = '复核未给出明确答案，采用初答';
      else if (checked !== answer) note = `复核不一致（初答 ${answer} / 复核 ${checked}），采用初答继续`;
      else note = (q.type === 'multi' ? '多选' : '判断题') + '已二次复核确认';
    } catch (error) {
      /* 复核请求本身失败（网络/额度）也不该让整份测验作废，保留初答。 */
      note = '复核失败，采用初答：' + String(error.message || error).slice(0, 60);
    }
  }
  return { answer, raw: content, note: note || undefined };
}

async function withEndpoint(cfg, task) {
  const apiKey = sanitizeKey(cfg?.apiKey);
  if (!apiKey) throw new Error('API Key 未填写：粘贴后点「保存」');
  const tail = apiKey.slice(-4);
  const manual = cfg.iface === 'openai' || cfg.iface === 'anthropic';

  // 手动指定接口类型且填了地址/模型 → 直接用（用户覆盖优先）
  if (manual && cfg.baseURL && cfg.model) {
    return await task({ iface: cfg.iface, baseURL: cfg.baseURL, model: cfg.model, apiKey });
  }

  // 自动：优先用记住的组合；失效（401/403/404）则重新探测一次
  const saved = await loadEndpoint(tail);
  let endpoint = saved || (await detectEndpoint(apiKey, cfg.iface === 'anthropic' ? 'anthropic' : cfg.iface === 'openai' ? 'openai' : undefined));
  if (!saved) await saveEndpoint(tail, endpoint);
  try {
    const r = await task({ ...endpoint, apiKey });
    if (!saved) r.note = '已自动匹配接口：' + hostOf(endpoint.baseURL) + '（模型 ' + endpoint.model + '，已记住）';
    return r;
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      const ep2 = await detectEndpoint(apiKey, undefined, endpoint);
      await saveEndpoint(tail, ep2);
      const r = await task({ ...ep2, apiKey });
      return { ...r, note: '已重新自动匹配接口：' + hostOf(ep2.baseURL) + '（模型 ' + ep2.model + '）' };
    }
    throw e;
  }
}

export function answerWithAPI(q, cfg, opts = {}) {
  return withEndpoint(cfg, (endpoint) => run(q, endpoint, maxTokensFor(q), opts));
}

export function requestWithAPI(messages, cfg) {
  return withEndpoint(cfg, async (endpoint) => ({ raw: await callIface(endpoint, messages, 4096) }));
}

export async function testAPI(cfg) {
  if (!cfg?.baseURL || !cfg?.model) throw new Error('请先填写接口地址和模型名');
  const endpoint = { iface: cfg.iface === 'anthropic' ? 'anthropic' : 'openai', baseURL: cfg.baseURL, model: cfg.model };
  const content =
    endpoint.iface === 'anthropic'
      ? await chatAnthropic({ ...endpoint, apiKey: sanitizeKey(cfg.apiKey) }, [{ role: 'user', content: '请只回复两个字：正常' }], 16, '')
      : await chatOpenAI({ ...endpoint, apiKey: sanitizeKey(cfg.apiKey) }, [{ role: 'user', content: '请只回复两个字：正常' }], 16);
  return content.slice(0, 50);
}
