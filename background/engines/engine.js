/* 引擎共享：Prompt 构建 + 答案解析 + 缓存键哈希（API 引擎与豆包桥接引擎共用） */

export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

export function buildMessages(q) {
  const sys = '你是严谨的答题助手，严格按照用户要求的格式输出，不输出任何解释、前缀或多余内容。';
  const opts = (q.options || [])
    .map((o) => `${o.key}. ${String(o.text || '').replace(/^[A-Ha-h][\s.、．:：)）]*/, '')}`)
    .join('\n');
  let user = '';
  if (q.type === 'choice') {
    user = `【单选题】\n${q.stem}\n${opts}\n\n只输出一个正确选项的字母。`;
  } else if (q.type === 'multi') {
    user = `【多选题】\n${q.stem}\n${opts}\n\n这是多选题，正确选项通常有 2~4 个。请先在心里逐一判断每个选项是否正确（漏选、多选都算错），再输出最终全部正确选项的字母，连写不要分隔（如 ABD），只输出字母。`;
  } else if (q.type === 'judge') {
    user = `【判断题】\n${q.stem}\n\n只回答一个字："对"或"错"。`;
  } else if (q.type === 'blank') {
    user = `【填空题】${q.blanks > 1 ? `（共${q.blanks}个空）` : ''}\n${q.stem}\n\n只输出要填的内容；若有多个空，按顺序用分号(;)分隔。不要解释。`;
  } else {
    user = `【简答题】\n${q.stem}\n\n直接输出可提交的答案正文，简明扼要、条理清晰，约80~200字。不要"答："等前缀，不要解释。`;
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/* 多选题二次复核：把初答交给模型逐项复查（专治漏选/多选） */
export function buildMultiVerify(q, firstAnswer) {
  const NL = String.fromCharCode(10);
  const opts = (q.options || [])
    .map((o) => o.key + '. ' + String(o.text || '').replace(/^[A-Ha-h][\s.、．:：)）]*/, ''))
    .join(NL);
  const parts = [
    '【多选题复核】',
    q.stem,
    opts,
    '',
    '初答：' + firstAnswer,
    '',
    '请把每个选项单独判断为"正确"或"错误"（特别注意有没有漏选），最终只输出一行：全部正确选项的字母连写（如 ABD）。',
  ];
  return [
    { role: 'system', content: '你是严谨的答题助手，只按要求的格式输出。' },
    { role: 'user', content: parts.join(NL) },
  ];
}

/* 把模型自由格式的回答归一化为填写器能用的答案：
   choice → 单字母；multi → 去重排序字母串；judge → '对' | '错'；blank/subjective → 原文
   多选题专用健壮解析（防两类事故）：
   ① 模型输出逐项判断文本（A: 正确 / B: 错误…）→ 从判断行提取，绝不取"第一个字母"
   ② 优先"答案：X"与末行字母串 → 中间推理文字不参与取字母 */
function parseMulti(up) {
  // 1) 末尾字母串优先（模型几乎总把最终答案放最后；norm 已把换行压成空格）
  const tail = up.match(/((?:[A-H][\s、,，;；/·]*)+[A-H])\s*[。.\s]*$/);
  if (tail && tail[1].replace(/[^A-H]/g, '').length >= 2) {
    return [...new Set(tail[1].match(/[A-H]/g) || [])].sort().join('');
  }
  // 2) 显式"答案"行
  const ex = up.match(/答案\s*[是为:：]?\s*[:：]?\s*((?:[A-H][\s、,，;；/·]*)*[A-H])/);
  if (ex && /[A-H]/.test(ex[1])) {
    const exLetters = [...new Set(ex[1].match(/[A-H]/g) || [])];
    if (exLetters.length >= 2) return exLetters.sort().join('');
  }
  // 3) 逐项判断（行内或换行均可）："A: 正确 B: 错误 C、对 D：错"
  const verdicts = [...up.matchAll(/([A-H])\s*[:：]\s*([^\s：:A-H]{1,6})/g)];
  const seen = new Map();
  for (const v of verdicts) {
    const body = v[2].replace(/[。，,；;！!？?]/g, '');
    const neg = /^错|^不对|^误|[×✗✘]|^FALSE|^NO$/.test(body);
    const pos = /^正[确误]?|^对$|^√|^✓|^是$|^TRUE|^YES/.test(body) && !neg;
    if (pos || neg) seen.set(v[1], pos);
  }
  if (seen.size >= 2) {
    const yes = [...seen.entries()].filter(([, p]) => p).map(([k]) => k).sort().join('');
    return yes; // 可能为空串：模型判断全错，交由外层处理
  }
  // 4) 单字母"答案：X"
  if (ex) {
    const one = (ex[1] || '').match(/[A-H]/);
    if (one) return one[0];
  }
  // 5) 兜底：全文第一个连续字母段
  const run = up.match(/([A-H](?:[\s、,，;；]*[A-H])*)/);
  const letters = run ? [...new Set(run[1].match(/[A-H]/g) || [])] : [];
  return letters.sort().join('');
}

export function parseAnswer(q, raw) {
  const t = norm(String(raw ?? ''));
  if (!t) return '';
  if (q.type === 'choice') {
    const up = t.toUpperCase();
    const ex = up.match(/答案\s*[是为:：]?\s*[:：]?\s*([A-H])/);
    if (ex) return ex[1];
    if (/^[A-H]$/.test(up)) return up;
    // 末尾单字母优先（推理在前、答案在后）
    const tail = up.match(/(?:^|[^A-Z])([A-H])\s*[。.\s]*$/);
    if (tail) return tail[1];
    const standalone = up.match(/(?:^|[^A-Z])([A-H])(?:$|[^A-Z])/);
    if (standalone) return standalone[1];
    return (up.match(/[A-H]/) || [t])[0];
  }
  if (q.type === 'multi') {
    return parseMulti(t.toUpperCase()) || t;
  }
  if (q.type === 'judge') {
    const ex = t.match(/(对|正确|错|误|×|√)/);
    if (!ex) return t;
    return /错|误|×/.test(ex[1]) ? '错' : '对';
  }
  return t;
}

export async function hashKey(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
