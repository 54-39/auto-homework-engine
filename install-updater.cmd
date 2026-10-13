@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto folder_error
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\updater-bootstrap.ps1" -Root "%~dp0."
set "HW_INSTALL_RESULT=%ERRORLEVEL%"
if "%HW_INSTALL_RESULT%"=="0" goto success
if "%HW_INSTALL_RESULT%"=="2" goto cancelled
echo.
echo 安装失败。请查看上方原因，修复后再重新运行。
goto finish

:success
echo.
echo 安装已完成。请回到 Edge 设置页，页面会自动检查连接。
goto finish

:cancelled
echo.
echo 已取消，没有安装更新组件。
goto finish

:folder_error
set "HW_INSTALL_RESULT=1"
echo 无法打开插件目录。
goto finish

:finish
echo.
pause
popd
exit /b %HW_INSTALL_RESULT%
