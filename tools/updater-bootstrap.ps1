param(
  [string]$ExpectedId = '',
  [string]$ExpectedVersion = '',
  [string]$Root = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# 安装过程全部落一份日志，窗口关掉之后还能查到底卡在哪一步。
$script:LogPath = ''
function Write-Step([string]$Text) {
  Write-Host $Text
  try {
    if ($script:LogPath) {
      Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $Text)
    }
  } catch { }
}

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

# 名称可能是字面量（旧包），也可能是本地化占位符 __MSG_extensionName__（当前包）。
# 旧实现在这里硬比 '作业助手'，占位符形态永远不相等，导致安装器必然失败。
function Test-ProjectName([string]$Folder, $Manifest) {
  $name = [string]$Manifest.name
  if ($name -and $name -notmatch '^__MSG_') { return ($name -like '*作业助手*') }
  foreach ($loc in @('zh_CN', 'en')) {
    $msgPath = Join-Path (Join-Path $Folder ('_locales\' + $loc)) 'messages.json'
    if (-not (Test-Path -LiteralPath $msgPath -PathType Leaf)) { continue }
    try {
      $msg = Get-Content -LiteralPath $msgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([string]$msg.extensionName.message -like '*作业助手*') { return $true }
    } catch { }
  }
  return $false
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
    if (-not (Test-ProjectName $root $manifest)) { return $null }
    if ($ExpectedVersion -and $manifest.version -ne $ExpectedVersion) { return $null }
    $id = Get-ExtensionId $root
    if ($ExpectedId -and $id -ne $ExpectedId) { return $null }
    return [pscustomobject]@{ Root = $root; Id = $id; Version = [string]$manifest.version }
  } catch { return $null }
}

function Get-ProfileCandidates([string]$Browser = 'edge') {
  $relative = if ($Browser -eq 'chrome') { 'Google\Chrome\User Data' } else { 'Microsoft\Edge\User Data' }
  $userData = Join-Path $env:LOCALAPPDATA $relative
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
            $candidate | Add-Member -NotePropertyName Browser -NotePropertyValue $Browser -Force
            $found[$candidate.Root.ToLowerInvariant()] = $candidate
          }
        }
      } catch { continue }
    }
  }
  return @($found.Values)
}

# 兼容旧调用名：默认只看 Edge。
function Get-EdgeCandidates { return Get-ProfileCandidates 'edge' }

function Get-BrowserCandidates {
  return @(Get-ProfileCandidates 'edge') + @(Get-ProfileCandidates 'chrome')
}

# 已经装好且可用时不必重复安装（省掉重新下载 93MB 运行时的机会）。
function Test-InstalledHost($Target) {
  if (-not $Target) { return $false }
  $browser = 'edge'
  if ($Target.Browser) { $browser = [string]$Target.Browser }
  $hostKey = if ($browser -eq 'chrome') { 'SOFTWARE\Google\Chrome\NativeMessagingHosts\' } else { 'SOFTWARE\Microsoft\Edge\NativeMessagingHosts\' }
  $exe = Join-Path $Target.Root 'tools\native-host.exe'
  $json = Join-Path $Target.Root ('.native-host-' + $Target.Id + '.json')
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath $json -PathType Leaf)) { return $false }
  try { $m = Get-Content -LiteralPath $json -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
  if ($m.name -ne ('com.homeworkhelper.autoupdate.' + $Target.Id)) { return $false }
  if ([string]$m.path -ne $exe) { return $false }
  if (-not ($m.allowed_origins -contains ('chrome-extension://' + $Target.Id + '/'))) { return $false }
  try {
    $q = & reg query ('HKCU\' + $hostKey + $m.name) /ve 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $q.Contains($json)) { return $false }
  } catch { return $false }
  $arch = Get-Architecture
  $runtimeExe = Join-Path $Target.Root ('.native-runtime\v24.21.0-win-' + $arch + '\node.exe')
  if (-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)) { return $false }
  return $true
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

<#
  文件是不是被标了“低完整性级别”：这种目录里的 node.exe 一启动就是低权限进程，
  既写不了 %TEMP% 也写不了注册表（改标签需要管理员权限，普通用户改不回来）。
  这种环境（例如沙箱/工作区目录）里必须换一份副本运行，见主流程。
#>
function Test-LowIntegrity([string]$Path) {
  try {
    $output = (& icacls.exe $Path 2>$null | Out-String)
    return [bool]($output -match 'Mandatory Label\\Low Mandatory Level')
  } catch { return $false }
}

# 自己算 SHA-256，不用 Get-FileHash：后者属于 Microsoft.PowerShell.Utility 模块，
# 从 PowerShell 7 会话里启动时 PSModulePath 被改写会加载不到（5.1 报“不是 cmdlet”，
# 曾让整条离线解压/校验链路静默退化）。.NET 直接算不吃任何环境。
function Get-Sha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}

function Test-NodeRuntime([string]$Exe, [string]$ExpectedHash) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $false }
  $hash = Get-Sha256 $Exe
  if ($hash -ne $ExpectedHash) { return $false }
  $version = (& $Exe --version 2>$null | Out-String).Trim()
  return ($LASTEXITCODE -eq 0 -and $version -eq 'v24.21.0')
}

# 离线包：只从 zip 里取出 node.exe，不整包解压（整包 36 MB，解压要 90 MB 且全是没用的东西）。
function Expand-NodeBundle([string]$ZipPath, [string]$TargetExe, [string]$Architecture) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expectedEntry = 'node-v24.21.0-win-' + $Architecture + '/node.exe'
  $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    # 只认 node.exe：优先官方 zip 里的那条路径，其次任何叫 node.exe 的条目（重新打包的 zip 分隔符可能不同）。
    $entries = @($zip.Entries | Where-Object { [IO.Path]::GetFileName($_.FullName) -eq 'node.exe' })
    $entry = @($entries | Where-Object { $_.FullName.Replace('\', '/') -eq $expectedEntry })[0]
    if (-not $entry) { $entry = $entries[0] }
    if (-not $entry) { throw ('压缩包里找不到 node.exe（应有 ' + $expectedEntry + '）') }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $TargetExe, $true)
  } finally { $zip.Dispose() }
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
  if (Test-NodeRuntime $runtimeExe $expectedHash) { return [pscustomobject]@{ Path = $runtimeExe; Directory = $runtimeDir } }
  if (Test-Path -LiteralPath $runtimeExe) { Remove-Item -LiteralPath $runtimeExe -Force }
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

  # ① 插件目录里带了离线压缩包就直接用，全程不联网（完整离线包就是这个用途）。
  $bundleName = 'node-v24.21.0-win-' + $architecture + '.zip'
  $bundle = @(
    (Join-Path $runtimeDir $bundleName),
    (Join-Path $Folder $bundleName)
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($bundle) {
    Write-Host ('发现离线 Node.js 压缩包，直接解压使用（不联网）：' + $bundle)
    try {
      Expand-NodeBundle $bundle $runtimeExe $architecture
      if (-not (Test-NodeRuntime $runtimeExe $expectedHash)) { throw '解压出来的 node.exe 校验失败' }
      return [pscustomobject]@{ Path = $runtimeExe; Directory = $runtimeDir }
    } catch {
      if (Test-Path -LiteralPath $runtimeExe) { Remove-Item -LiteralPath $runtimeExe -Force -ErrorAction SilentlyContinue }
      Write-Host ('离线压缩包不可用（' + $_.Exception.Message + '），改为在线下载。') -ForegroundColor Yellow
    }
  }

  # ② 没有离线包才联网下载：官方源不通就换国内镜像，三者校验同一份哈希。
  $sources = @(
    ('https://nodejs.org/download/release/v24.21.0/win-' + $architecture + '/node.exe'),
    ('https://registry.npmmirror.com/-/binary/node/v24.21.0/win-' + $architecture + '/node.exe'),
    ('https://cdn.npmmirror.com/binaries/node/v24.21.0/win-' + $architecture + '/node.exe')
  )
  $part = $runtimeExe + '.download-' + [guid]::NewGuid().ToString('N')
  $errors = New-Object Collections.Generic.List[string]
  foreach ($url in $sources) {
    Write-Host ('正在下载并校验 Node.js v24.21.0（' + $architecture + '）：' + $url)
    try {
      $request = [Net.HttpWebRequest]::Create($url)
      $request.Method = 'GET'
      $request.UserAgent = 'HomeworkHelper-Updater/0.9.11'
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
      $downloadedHash = Get-Sha256 $part
      if ($downloadedHash -ne $expectedHash) { throw 'Node.js 文件 SHA-256 校验失败' }
      Move-Item -LiteralPath $part -Destination $runtimeExe -Force
      $version = (& $runtimeExe --version 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $version -ne 'v24.21.0') { Remove-Item -LiteralPath $runtimeExe -Force; throw 'Node.js 版本校验失败' }
      return [pscustomobject]@{ Path = $runtimeExe; Directory = $runtimeDir }
    } catch {
      if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue }
      $errors.Add(($url + ' -> ' + $_.Exception.Message))
      Write-Host ('这个源不可用，换下一个：' + $_.Exception.Message) -ForegroundColor Yellow
    }
  }
  throw ('Node.js 运行环境下载失败，已尝试官方源与国内镜像：' + ($errors -join ' / '))

}

try {
  if ($ExpectedId -and $ExpectedId -notmatch '^[a-p]{32}$') { throw '启动器中的扩展 ID 无效。请重新下载安装器。' }
  if ($ExpectedVersion -and $ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw '启动器中的版本号无效。请重新下载安装器。' }

  # 安装器可以放在任意位置：先看自己所在目录，不对再自动扫浏览器配置，最后才让用户选。
  $selected = $null
  if ($Root) {
    $selected = Test-ProjectFolder $Root
    if (-not $selected) {
      Write-Host ('安装器所在目录不是作业助手插件目录，改为自动查找浏览器正在加载的目录：' + $Root)
    }
  }
  if (-not $selected) {
    $candidates = @(Get-BrowserCandidates)
    if ($DryRun) {
      Write-Host ('EDGE_CANDIDATES=' + $candidates.Count)
      foreach ($candidate in $candidates) { Write-Host ($candidate.Id + '|' + $candidate.Version + '|' + $candidate.Root) }
      exit 0
    }
    if ($candidates.Count -eq 1) { $selected = $candidates[0] }
    else {
      if ($candidates.Count -eq 0) { Write-Host '未能从 Edge/Chrome 配置中确认插件目录，请在弹出的窗口中选择。' }
      else { Write-Host '找到多个插件目录，请在弹出的窗口中选择当前使用的目录。' }
      $chosen = Select-ProjectFolder
      if (-not $chosen) { Write-Host '已取消，没有安装更新组件。'; exit 2 }
      $selected = Test-ProjectFolder $chosen
      if (-not $selected) { throw '所选文件夹不匹配作业助手版本或缺少安装文件，没有写入宿主注册信息。' }
    }
  }
  $browser = 'edge'
  if ($selected.Browser) { $browser = [string]$selected.Browser }

  $script:LogPath = Join-Path $selected.Root '.update-install.log'
  Write-Step ('确认插件目录：' + $selected.Root + '（' + $browser + '，扩展 ID ' + $selected.Id + '）')
  if ($ExpectedId -and $selected.Id -ne $ExpectedId) { throw '插件目录 ID 与当前浏览器加载的扩展不一致，没有安装。' }
  if ($DryRun) { exit 0 }
  # 已经有安装产物时不再跳过：重装只要一两秒（运行时已校验过就不会重下），
  # 而且能把启动器里写死的 node 路径刷成当前这份，避免系统 node 变动后又失效。
  if (Test-InstalledHost $selected) { Write-Step '检测到已有可用安装，刷新一次登记信息。' }
  $runtime = Get-VerifiedNode $selected.Root
  # 插件目录带低完整性级别标记时，目录里的 node.exe 起不来（写不了 %TEMP%，也写不了注册表），
  # 复制一份到 %TEMP%（无标记）来跑安装；启动器里仍然写插件目录那份稳定路径。
  $runNode = $runtime.Path
  $mirrorDir = ''
  if (Test-LowIntegrity $runtime.Path) {
    $mirrorDir = Join-Path $env:TEMP ('hw-runtime-' + $selected.Id.Substring(0, 8))
    New-Item -ItemType Directory -Path $mirrorDir -Force | Out-Null
    $runNode = Join-Path $mirrorDir 'node.exe'
    Write-Host '检测到插件目录带“低完整性级别”标记，先在插件目录外准备一份运行副本…'
    Copy-Item -LiteralPath $runtime.Path -Destination $runNode -Force
  }
  $installer = Join-Path $selected.Root 'tools\install-native-host.mjs'
  $oldPath = $env:PATH
  try {
    $env:PATH = $runtime.Directory + ';' + $oldPath
    & $runNode $installer $browser ('--expected-id=' + $selected.Id) ('--node=' + $runtime.Path)
    $installCode = $LASTEXITCODE
  } finally { $env:PATH = $oldPath }
  if ($installCode -ne 0) { throw ('宿主安装失败，错误代码：' + $installCode) }
  if ($mirrorDir -and (Test-Path -LiteralPath $mirrorDir)) { Remove-Item -LiteralPath $mirrorDir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Step '安装命令已完成。请回到 Edge 设置页；页面会自动重新检查连接。'
  exit 0
} catch {
  Write-Host ('安装失败：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '没有安装成功。修复上方提示后，再重新双击此文件。'
  if ($script:LogPath) {
    try {
      Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  [失败] ' + $_.Exception.Message)
      Write-Host ('详细日志：' + $script:LogPath)
    } catch { }
  }
  exit 1
}
