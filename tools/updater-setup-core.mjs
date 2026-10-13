export const DOWNLOADS_PERMISSION = 'downloads';
export const EXPECTED_EXTENSION_ID_TOKEN = '__HW_EXPECTED_EXTENSION_ID__';

export function isUpdaterHostReady(response, extensionId, version) {
  return Boolean(response?.ok && response.extensionId === extensionId && response.manifestVersion === version);
}

export function makeInstallerPayload(template, extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 格式无效');
  if (typeof template !== 'string' || !template.includes(EXPECTED_EXTENSION_ID_TOKEN)) throw new Error('安装器模板无效');
  return template.replaceAll(EXPECTED_EXTENSION_ID_TOKEN, extensionId);
}

export function requestDownloadsPermission(permissions) {
  return permissions.request({ permissions: [DOWNLOADS_PERMISSION] });
}
