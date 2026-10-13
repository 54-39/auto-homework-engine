@echo off
setlocal
chcp 65001 >nul
set "HW_EXPECTED_EXTENSION_ID=__HW_EXPECTED_EXTENSION_ID__"
if "%HW_EXPECTED_EXTENSION_ID%"=="__HW_EXPECTED_EXTENSION_ID__" goto invalid

echo 请选择浏览器当前加载的作业助手文件夹。
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='请选择当前浏览器加载的作业助手文件夹'; $dialog.ShowNewFolderButton=$false; if($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){ exit 2 }; $root=$dialog.SelectedPath; if(!(Test-Path (Join-Path $root 'manifest.json')) -or !(Test-Path (Join-Path $root 'tools\install-native-host.mjs')) -or !(Test-Path (Join-Path $root 'tools\native-host.mjs')) -or !(Test-Path (Join-Path $root 'tools\native-host-install-core.mjs'))){ Write-Host '所选文件夹不像作业助手插件目录。'; exit 3 }; $node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source; if(-not $node){ $node=@('C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1 }; if(-not $node){ Write-Host '找不到 Node.js。请先安装 Node.js，再重新运行。'; exit 4 }; Set-Location $root; & $node '.\tools\install-native-host.mjs' edge ('--expected-id=' + $env:HW_EXPECTED_EXTENSION_ID); exit $LASTEXITCODE"
set "HW_INSTALL_RESULT=%ERRORLEVEL%"
if "%HW_INSTALL_RESULT%"=="0" goto success
if "%HW_INSTALL_RESULT%"=="2" goto cancelled
if "%HW_INSTALL_RESULT%"=="3" goto wrong_folder
if "%HW_INSTALL_RESULT%"=="4" goto missing_node
echo.
echo 安装失败。请查看上方错误，修复后再重新运行。
goto finish

:success
echo.
echo 安装命令已完成。请回到更新页，等待“运行”按钮验证后消失。
goto finish

:cancelled
echo.
echo 已取消，尚未安装更新组件。
goto finish

:wrong_folder
echo.
echo 没有安装任何内容。请重新运行并选择正确的作业助手文件夹。
goto finish

:missing_node
echo.
echo 请先安装 Node.js，再重新运行此文件。
goto finish

:invalid
set "HW_INSTALL_RESULT=1"
echo.
echo 启动器无效。请回到设置页重新下载。
:finish
echo.
pause
exit /b %HW_INSTALL_RESULT%
