param(
  [string]$ExpectedId = '',
  [string]$ExpectedVersion = '',
  [string]$Root = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Normalize-Root([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.Length -gt 3) { $full = $full.TrimEnd([char[]]@('\', '/')) }
  if ($full -match '^[a-z]:') { $full = $full.Substring(0, 1).ToUpperInvariant() + $full.Substring(1) }
  return $full
}

function Get-ExtensionId([string]$Folder) {
  $canonical = Normalize-Root $Folder
  $bytes = [Text.Encoding]::Unicode.GetBytes($canonical)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hex = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant().Substring(0, 32) }
  finally { $sha.Dispose() }
  $alphabet = 'abcdefghijklmnop'
  $id = New-Object Text.StringBuilder
  for ($i = 0; $i -lt 32; $i++) { [void]$id.Append($alphabet[[Convert]::ToInt32($hex.Substring($i, 1), 16)]) }
  return $id.ToString()
}

function Test-ProjectFolder([string]$Folder) {
  try {
    $root = Normalize-Root $Folder
    $manifestPath = Join-Path $root 'manifest.json'
    foreach ($file in @('tools\install-native-host.mjs', 'tools\native-host.mjs', 'tools\native-host-install-core.mjs')) {
      if (-not (Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)) { return $null }
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne '作业助手') { return $null }
    if ($ExpectedVersion -and $manifest.version -ne $ExpectedVersion) { return $null }
    $id = Get-ExtensionId $root
    if ($ExpectedId -and $id -ne $ExpectedId) { return $null }
    return [pscustomobject]@{ Root = $root; Id = $id; Version = [string]$manifest.version }
  } catch { return $null }
}

function Get-EdgeCandidates {
  $userData = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
  if (-not (Test-Path -LiteralPath $userData -PathType Container)) { return @() }
  $profiles = @(Get-ChildItem -LiteralPath $userData -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -match '^Profile \d+$' })
  $found = @{}
  foreach ($profile in $profiles) {
    foreach ($fileName in @('Preferences', 'Secure Preferences')) {
      $prefsPath = Join-Path $profile.FullName $fileName
      if (-not (Test-Path -LiteralPath $prefsPath -PathType Leaf)) { continue }
      try {
        $prefs = Get-Content -LiteralPath $prefsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $settings = $prefs.extensions.settings
        if (-not $settings) { continue }
        foreach ($entry in $settings.PSObject.Properties) {
          if ($ExpectedId -and $entry.Name -ne $ExpectedId) { continue }
          $recordPath = [string]$entry.Value.path
          if (-not $recordPath) { continue }
          if (-not [IO.Path]::IsPathRooted($recordPath)) {
            $recordPath = Join-Path (Join-Path $profile.FullName 'Extensions') $recordPath
          }
          $candidate = Test-ProjectFolder $recordPath
          if ($candidate -and $candidate.Id -eq $entry.Name) {
            $found[$candidate.Root.ToLowerInvariant()] = $candidate
          }
        }
      } catch { continue }
    }
  }
  return @($found.Values)
}

function Select-ProjectFolder {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '请选择当前 Edge 正在使用的“作业助手”插件文件夹'
  $dialog.ShowNewFolderButton = $false
  if (Test-Path -LiteralPath $env:USERPROFILE -PathType Container) { $dialog.SelectedPath = $env:USERPROFILE }
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $dialog.SelectedPath
}

function Get-Architecture {
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if ($arch -eq 'ARM64') { return 'arm64' }
  if ($arch -eq 'AMD64') { return 'x64' }
  throw '暂不支持此 Windows 处理器架构。请联系开发者。'
}

function Get-VerifiedNode([string]$Folder) {
  $architecture = Get-Architecture
  $runtimeDir = Join-Path $Folder ('.native-runtime\v24.21.0-win-' + $architecture)
  $runtimeExe = Join-Path $runtimeDir 'node.exe'
  $expectedHash = if ($architecture -eq 'x64') {
    'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
  } else {
    'dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7'
  }
  if (Test-Path -LiteralPath $runtimeExe -PathType Leaf) {
    $hash = (Get-FileHash -LiteralPath $runtimeExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -eq $expectedHash) {
      $version = (& $runtimeExe --version 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $version -eq 'v24.21.0') { return [pscustomobject]@{ Path = $runtimeExe; Directory = $runtimeDir } }
    }
    Remove-Item -LiteralPath $runtimeExe -Force
  }
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $url = 'https://nodejs.org/download/release/v24.21.0/win-' + $architecture + '/node.exe'
  $part = $runtimeExe + '.download-' + [guid]::NewGuid().ToString('N')
  Write-Host ('正在下载并校验 Node.js v24.21.0（' + $architecture + '），只保存在插件目录内…')
  try {
    $request = [Net.HttpWebRequest]::Create($url)
    $request.Method = 'GET'
    $request.UserAgent = 'HomeworkHelper-Updater/0.6.9'
    $request.Timeout = 300000
    $request.ReadWriteTimeout = 300000
    $response = $request.GetResponse()
    try {
      if ($response.ContentLength -gt 0 -and ($response.ContentLength -lt 10000000 -or $response.ContentLength -gt 160000000)) {
        throw '下载文件大小异常'
      }
      $inputStream = $response.GetResponseStream()
      $outputStream = [IO.File]::Create($part)
      try {
        $buffer = New-Object byte[] 65536
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) { $outputStream.Write($buffer, 0, $read) }
      } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    } finally { $response.Dispose() }
    $downloadedHash = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadedHash -ne $expectedHash) { throw 'Node.js 文件 SHA-256 校验失败' }
    Move-Item -LiteralPath $part -Destination $runtimeExe -Force
    $version = (& $runtimeExe --version 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne 'v24.21.0') { Remove-Item -LiteralPath $runtimeExe -Force; throw 'Node.js 版本校验失败' }
    return [pscustomobject]@{ Path = $runtimeExe; Directory = $runtimeDir }
  } catch {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue }
    throw ('Node.js 运行环境下载或校验失败：' + $_.Exception.Message)
  }
}

try {
  if ($ExpectedId -and $ExpectedId -notmatch '^[a-p]{32}$') { throw '启动器中的扩展 ID 无效。请重新下载安装器。' }
  if ($ExpectedVersion -and $ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw '启动器中的版本号无效。请重新下载安装器。' }

  $selected = $null
  if ($Root) {
    $selected = Test-ProjectFolder $Root
    if (-not $selected) { throw '此安装器所在目录不是匹配版本的“作业助手”插件文件夹。' }
  } else {
    $candidates = @(Get-EdgeCandidates)
    if ($DryRun) {
      Write-Host ('EDGE_CANDIDATES=' + $candidates.Count)
      foreach ($candidate in $candidates) { Write-Host ($candidate.Id + '|' + $candidate.Version + '|' + $candidate.Root) }
      exit 0
    }
    if ($candidates.Count -eq 1) { $selected = $candidates[0] }
    else {
      if ($candidates.Count -eq 0) { Write-Host '未能从 Edge 配置中唯一确认插件目录，请在弹出的窗口中选择。' }
      else { Write-Host 'Edge 中找到多个插件目录，请在弹出的窗口中选择当前使用的目录。' }
      $chosen = Select-ProjectFolder
      if (-not $chosen) { Write-Host '已取消，没有安装更新组件。'; exit 2 }
      $selected = Test-ProjectFolder $chosen
      if (-not $selected) { throw '所选文件夹不匹配作业助手版本或缺少安装文件，没有写入宿主注册信息。' }
    }
  }

  Write-Host ('已确认插件目录：' + $selected.Root)
  if ($ExpectedId -and $selected.Id -ne $ExpectedId) { throw '插件目录 ID 与当前浏览器加载的扩展不一致，没有安装。' }
  if ($DryRun) { exit 0 }
  $runtime = Get-VerifiedNode $selected.Root
  $installer = Join-Path $selected.Root 'tools\install-native-host.mjs'
  $oldPath = $env:PATH
  try {
    $env:PATH = $runtime.Directory + ';' + $oldPath
    & $runtime.Path $installer 'edge' ('--expected-id=' + $selected.Id)
    $installCode = $LASTEXITCODE
  } finally { $env:PATH = $oldPath }
  if ($installCode -ne 0) { throw ('宿主安装失败，错误代码：' + $installCode) }
  Write-Host '安装命令已完成。请回到 Edge 设置页；页面会自动重新检查连接。'
  exit 0
} catch {
  Write-Host ('安装失败：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '没有安装成功。修复上方提示后，再重新双击此文件。'
  exit 1
}
