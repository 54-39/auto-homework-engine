export const EXPECTED_EXTENSION_ID_TOKEN = '__HW_EXPECTED_EXTENSION_ID__';
export const EXPECTED_VERSION_TOKEN = '__HW_EXPECTED_VERSION__';

export function isUpdaterHostReady(response, extensionId, version) {
  return Boolean(response?.ok && response.extensionId === extensionId && response.manifestVersion === version);
}

export function makeInstallerPayload(template, extensionId, version) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 格式无效');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号格式无效');
  if (typeof template !== 'string' ||
      template.split(`set "HW_EXPECTED_EXTENSION_ID=${EXPECTED_EXTENSION_ID_TOKEN}"`).length !== 2 ||
      template.split(`set "HW_EXPECTED_VERSION=${EXPECTED_VERSION_TOKEN}"`).length !== 2) {
    throw new Error('安装器模板无效');
  }
  return template.replace(/\r\n?/g, '\n')
    .replace(`set "HW_EXPECTED_EXTENSION_ID=${EXPECTED_EXTENSION_ID_TOKEN}"`, `set "HW_EXPECTED_EXTENSION_ID=${extensionId}"`)
    .replace(`set "HW_EXPECTED_VERSION=${EXPECTED_VERSION_TOKEN}"`, `set "HW_EXPECTED_VERSION=${version}"`)
    .replace(/\n/g, '\r\n');
}
