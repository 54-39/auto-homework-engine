/* API 引擎：按"接口类型"调用 + 自动探测
   - openai：POST {base}/chat/completions（OpenAI 兼容，DeepSeek/智谱/Kimi/火山/通义 等）
   - anthropic：POST {base}/v1/messages（Claude 系协议，火山 Coding Plan / Z.ai）
   - 自动探测：粘贴 Key 后并行尝试已知接口，谁先通过鉴权用谁（结果按 Key 尾号记住） */
import { buildMessages, parseAnswer, buildMultiVerify } from './engine.js';

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
    const b = { model: cfg.model, messages, temperature: cfg.temperature ?? 0, max_tokens: maxTokens, stream: false };
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
        err.body = txt;
        err.fatal = true;
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
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: userMsg, temperature: cfg.temperature ?? 0 }),
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
      err.fatal = true;
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

async function run(q, endpoint, maxTokens) {
  const msgs = buildMessages(q);
  const cfg = { ...endpoint, apiKey: sanitizeKey(endpoint.apiKey) };
  let content = await callIface(cfg, msgs, maxTokens);
  let answer = parseAnswer(q, content);
  let note = '';
  // 多选题：自动二次复核（初答交给模型逐项复查，专治漏选）
  if (q.type === 'multi' && answer) {
    try {
      const vMsgs = buildMultiVerify(q, answer);
      const vRaw = await callIface({ ...cfg, maxTokens: undefined }, vMsgs, 96);
      const vAns = parseAnswer(q, vRaw);
      if (vAns && vAns !== answer) {
        if (vAns.length < answer.length) {
          // 复核结果比初答还少字母：大概率是解析/模型抖动，拒绝降级，保留初答
          note = '多选复核结果异常（字母变少），已保留初答 ' + answer;
        } else {
          note = '多选已二次复核修正：' + answer + ' → ' + vAns;
          answer = vAns;
        }
      } else if (vAns === answer) {
        note = '多选已二次复核确认';
      }
    } catch {
      /* 复核失败不阻断，用初答 */
    }
  }
  return { answer, raw: content, note: note || undefined };
}

export async function answerWithAPI(q, cfg) {
  const apiKey = sanitizeKey(cfg?.apiKey);
  if (!apiKey) throw new Error('API Key 未填写：粘贴后点「保存」');
  const tail = apiKey.slice(-4);
  const manual = cfg.iface === 'openai' || cfg.iface === 'anthropic';

  // 手动指定接口类型且填了地址/模型 → 直接用（用户覆盖优先）
  if (manual && cfg.baseURL && cfg.model) {
    return await run(q, { iface: cfg.iface, baseURL: cfg.baseURL, model: cfg.model, apiKey }, maxTokensFor(q));
  }

  // 自动：优先用记住的组合；失效（401/403/404）则重新探测一次
  const saved = await loadEndpoint(tail);
  let endpoint = saved || (await detectEndpoint(apiKey, cfg.iface === 'anthropic' ? 'anthropic' : cfg.iface === 'openai' ? 'openai' : undefined));
  if (!saved) await saveEndpoint(tail, endpoint);
  try {
    const r = await run(q, { ...endpoint, apiKey }, maxTokensFor(q));
    if (!saved) r.note = '已自动匹配接口：' + hostOf(endpoint.baseURL) + '（模型 ' + endpoint.model + '，已记住）';
    return r;
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      const ep2 = await detectEndpoint(apiKey, undefined, endpoint);
      await saveEndpoint(tail, ep2);
      const r = await run(q, { ...ep2, apiKey }, maxTokensFor(q));
      return { ...r, note: '已重新自动匹配接口：' + hostOf(ep2.baseURL) + '（模型 ' + ep2.model + '）' };
    }
    throw e;
  }
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
