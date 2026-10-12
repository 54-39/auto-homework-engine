@echo off
setlocal
pushd "%~dp0"
node "%~dp0tools\install-native-host.mjs" edge
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo 安装失败，请根据上面的错误修复后重新双击本文件。
)
echo.
pause
popd
exit /b %RESULT%
