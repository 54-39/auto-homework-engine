/* 截图只在后台裁剪题图区域，完整视口不发送到模型或内容脚本。 */
let captureTail = Promise.resolve();
let lastCaptureAt = 0;
function captureSerial(task) {
  const next = captureTail.then(async () => {
    const delay = Math.max(0, 550 - (Date.now() - lastCaptureAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const value = await task();
    lastCaptureAt = Date.now();
    return value;
  });
  captureTail = next.catch(() => {});
  return next;
}
export async function captureQuestionImage(sender, payload, api = chrome) {
  const tab = sender?.tab;
  if (!tab?.id || !Number.isInteger(tab.windowId)) throw new Error('找不到当前作业标签页');
  const here = new URL(sender.url || 'about:blank');
  if (!/^https?:$/.test(here.protocol) || !/(^|\.)chaoxing\.com$/i.test(here.hostname)) throw new Error('无效的题图截图请求');
  const { rect, viewport } = payload || {};
  if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || viewport.width < 1 || viewport.height < 1 ||
      rect.x + rect.width > viewport.width + 0.5 || rect.y + rect.height > viewport.height + 0.5) throw new Error('题图不完全位于可见区域');
  const active = async () => (await api.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id === tab.id;
  if (!(await active())) throw new Error('作业标签页当前不可见，无法截图');
  let data;
  try { data = await captureSerial(async () => {
    if (!(await active())) throw new Error('作业标签页当前不可见，无法截图');
    return api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  }); }
  catch { throw new Error('无法截图：请点击浏览器工具栏的作业助手图标授权当前页面后重试'); }
  if (!(await active())) throw new Error('截图期间标签页已切换，请重试');
  const bitmap = await createImageBitmap(await (await fetch(data)).blob());
  try {
    const sx = bitmap.width / viewport.width, sy = bitmap.height / viewport.height;
    const x = Math.max(0, Math.floor(rect.x * sx)), y = Math.max(0, Math.floor(rect.y * sy));
    const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * sx));
    const bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.height) * sy));
    const width = right - x, height = bottom - y;
    if (width < 1 || height < 1 || width * height > 16000000) throw new Error('题图尺寸不适合截图');
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return 'data:image/png;base64,' + btoa(binary);
  } finally { bitmap.close(); }
}
