/* 精确分数四则运算。只接受数字、括号和运算符，不执行任意代码。 */
export function rational(text) {
  let input = String(text ?? '').replace(/\$/g, '').replace(/\\(?:left|right)/g, '')
    .replace(/\\(?:dfrac|tfrac|frac)\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}/g, '($1/$2)')
    .replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
  if (!input || input.length > 160 || /[^\d.+\-*/()]/.test(input)) return null;
  const gcd = (a, b) => { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; };
  const norm = (n, d) => {
    if (!d) throw Error('zero');
    if (d < 0n) { n = -n; d = -d; }
    if (n.toString().length > 100 || d.toString().length > 100) throw Error('large');
    const g = gcd(n, d); return { n: n / g, d: d / g };
  };
  let i = 0, count = 0;
  const atom = depth => {
    if (++count > 80 || depth > 16) throw Error('limit');
    if (input[i] === '+' || input[i] === '-') { const minus = input[i++] === '-'; const v = atom(depth + 1); return minus ? { n: -v.n, d: v.d } : v; }
    if (input[i] === '(') { i++; const v = sum(depth + 1); if (input[i++] !== ')') throw Error('bracket'); return v; }
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(input.slice(i));
    if (!m || m[0].replace('.', '').length > 18) throw Error('number');
    i += m[0].length; const [whole, fraction = ''] = m[0].split('.');
    return norm(BigInt((whole || '0') + fraction), 10n ** BigInt(fraction.length));
  };
  const term = depth => {
    let a = atom(depth);
    while (input[i] === '*' || input[i] === '/') { const op = input[i++], b = atom(depth); a = op === '*' ? norm(a.n * b.n, a.d * b.d) : norm(a.n * b.d, a.d * b.n); }
    return a;
  };
  const sum = depth => {
    let a = term(depth);
    while (input[i] === '+' || input[i] === '-') { const op = input[i++], b = term(depth); a = norm(a.n * b.d + (op === '+' ? 1n : -1n) * b.n * a.d, a.d * b.d); }
    return a;
  };
  try { const v = sum(0); return i === input.length ? v : null; } catch { return null; }
}

export function checkCalculation(calculation, optionText) {
  if (typeof calculation !== 'string') return 'unsupported';
  const parts = calculation.split('=');
  if (parts.length !== 2) return 'unsupported';
  const left = rational(parts[0]), right = rational(parts[1]);
  if (!left || !right) return 'unsupported';
  if (left.n !== right.n || left.d !== right.d) return 'mismatch';
  const option = rational(String(optionText || '').replace(/^[A-H][.、．:：)）\s]+/, ''));
  if (option && (option.n !== right.n || option.d !== right.d)) return 'mismatch';
  return 'consistent';
}
