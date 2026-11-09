/* 受限读取超星题图，不把远程链接发送给模型。 */
export async function readQuestionImage(src, fetcher = fetch) {
  let url;
  try { url = new URL(src); } catch { throw new Error('题目图片地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)chaoxing\.com$/i.test(url.hostname)) {
    throw new Error('题目图片不在可读取的超星域名，请使用截图');
  }
  const response = await fetcher(url.href, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('题目图片读取失败 HTTP ' + response.status);
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('题目图片过大');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > limit) throw new Error('题目图片为空或过大');
  const sig = (...v) => v.every((n, i) => bytes[i] === n);
  let mime = '';
  if (sig(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) mime = 'image/png';
  else if (sig(0xff, 0xd8, 0xff)) mime = 'image/jpeg';
  else if (sig(0x47, 0x49, 0x46, 0x38)) mime = 'image/gif';
  else if (sig(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) mime = 'image/webp';
  if (!mime) throw new Error('题目图片格式不支持');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}
