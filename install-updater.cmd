@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto folder_error
chcp 65001 >nul
node tools\install-native-host.mjs edge
if errorlevel 1 goto install_error
echo.
pause
popd
exit /b 0

:install_error
echo.
echo Installation failed. Fix the error shown above, then run this file again.
echo.
pause
popd
exit /b 1

:folder_error
echo Could not open the plugin folder.
echo.
pause
exit /b 1
