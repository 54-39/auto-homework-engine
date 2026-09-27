const fs = require('fs');

// ===== engine.js：多选复核消息构建器 =====
let e = fs.readFileSync('background/engines/engine.js', 'utf8');
if (!e.includes('buildMultiVerify')) {
  e = e.replace(
    '/* 把模型自由格式的回答归一化',
    `/* 多选题二次复核：把初答交给模型逐项复查（专治漏选/多选） */
export function buildMultiVerify(q, firstAnswer) {
  const opts = (q.options || [])
    .map((o) => o.key + '. ' + String(o.text || '').replace(/^[A-Ha-h][\s.、．:：)）]*/, ''))
    .join('\n');
  return [
    { role: 'system', content: '你是严谨的答题助手，只按要求的格式输出。' },
    {
      role: 'user',
      content: '【多选题复核】\n' + q.stem + '\n' + opts +
        '\n\n初答：' + firstAnswer +
        '\n\n请把每个选项单独判断为"正确"或"错误"（特别注意有没有漏选），最终只输出一行：全部正确选项的字母连写（如 ABD）。',
    },
  ];
}

/* 把模型自由格式的回答归一化`);
  fs.writeFileSync('background/engines/engine.js', e);
  console.log('engine.js buildMultiVerify added');
}

// ===== api-engine.js：多选二轮复核 =====
let a = fs.readFileSync('background/engines/api-engine.js', 'utf8');
a = a.replace(
  "import { buildMessages, parseAnswer } from './engine.js';",
  "import { buildMessages, parseAnswer, buildMultiVerify } from './engine.js';"
);
a = a.replace(
  `async function run(q, endpoint, maxTokens) {
  const [sys, user] = buildMessages(q);
  const cfg = { ...endpoint, apiKey: sanitizeKey(endpoint.apiKey) };
  let content;
  if (endpoint.iface === 'anthropic') {
    content = await chatAnthropic(cfg, [{ role: 'user', content: user.content }], maxTokens, sys.content);
  } else {
    content = await chatOpenAI(cfg, [sys, user], maxTokens);
  }
  return { answer: parseAnswer(q, content), raw: content };
}`,
  `async function callIface(cfg, messages, maxTokens) {
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
      const vRaw = await callIface({ ...cfg, maxTokens: undefined }, vMsgs, 64);
      const vAns = parseAnswer(q, vRaw);
      if (vAns && vAns !== answer) {
        note = '多选已二次复核修正：' + answer + ' → ' + vAns;
        answer = vAns;
      } else if (vAns === answer) {
        note = '多选已二次复核确认';
      }
    } catch {
      /* 复核失败不阻断，用初答 */
    }
  }
  return { answer, raw: content, note: note || undefined };
}`
);
fs.writeFileSync('background/engines/api-engine.js', a);
console.log('api-engine verify pass added');

// ===== SW：点击单行重答后更新缓存（错误旧缓存被覆盖） =====
let w = fs.readFileSync('background/service-worker.js', 'utf8');
const wOld = `    const r = await askEngine(cfg, item.q);
    item.status = 'answered';
    item.answer = r.answer;
    sendTab(tabId, { type: 'HW_ANSWER', payload: { index, answer: r.answer, note: r.note } });
    return { ok: true };`;
const wNew = `    const r = await askEngine(cfg, item.q);
    item.status = 'answered';
    item.answer = r.answer;
    // 手动重答视为最新权威答案：覆盖旧缓存（包括之前的错误答案）
    if (r.answer && cfg.engine !== 'demo') {
      const key = await cacheKeyOf(item.q);
      await cacheSet(key, { answer: r.answer, note: r.note || null });
    }
    sendTab(tabId, { type: 'HW_ANSWER', payload: { index, answer: r.answer, note: r.note } });
    return { ok: true };`;
if (w.includes(wOld)) {
  w = w.replace(wOld, wNew);
  fs.writeFileSync('background/service-worker.js', w);
  console.log('SW rerun cache-write added');
} else {
  console.log('SW rerunOne pattern not found — 检查');
  const i = w.indexOf('async function rerunOne');
  console.log(w.slice(i, i + 900));
}
