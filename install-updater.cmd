@echo off
rem ---------------------------------------------------------------------------
rem  Homework Helper - one-time update component installer (portable).
rem  This file is deliberately ASCII-only: cmd.exe loses its parse offset when a
rem  batch file mixes a code page switch with multi-byte characters, which
rem  produced "not recognized as an internal or external command" garbage.
rem  All localized messages live in tools\updater-bootstrap.ps1 instead.
rem
rem  It works from any folder: first it looks next to itself, then it asks the
rem  browser profiles which folder the extension is actually loaded from.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
set "HW_INSTALL_RESULT=1"
set "HWROOT="
chcp 65001 >nul

if exist "%~dp0tools\updater-bootstrap.ps1" set "HWROOT=%~dp0"

if not defined HWROOT for /f "usebackq delims=" %%D in (`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; foreach($rel in @('Microsoft\Edge\User Data','Google\Chrome\User Data')){ $base=Join-Path $env:LOCALAPPDATA $rel; if(-not (Test-Path -LiteralPath $base)){continue}; foreach($d in (Get-ChildItem -LiteralPath $base -Directory)){ if(-not ($d.Name -eq 'Default' -or $d.Name -like 'Profile *')){continue}; foreach($f in @('Preferences','Secure Preferences')){ $jp=Join-Path $d.FullName $f; if(-not (Test-Path -LiteralPath $jp)){continue}; try { $json=Get-Content -LiteralPath $jp -Raw -Encoding UTF8; $obj=ConvertFrom-Json -InputObject $json } catch { continue }; $s=$obj.extensions.settings; if(-not $s){continue}; foreach($e in $s.PSObject.Properties){ $p=[string]$e.Value.path; if(-not $p){continue}; if(-not [IO.Path]::IsPathRooted($p)){ $p=Join-Path (Join-Path $d.FullName 'Extensions') $p }; if(Test-Path -LiteralPath (Join-Path $p 'tools\updater-bootstrap.ps1')){ Write-Output $p; exit 0 } } } } }; exit 1"`) do set "HWROOT=%%D\"

if not defined HWROOT goto notfound

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HWROOT%tools\updater-bootstrap.ps1" -Root "%HWROOT%." %*
set "HW_INSTALL_RESULT=%ERRORLEVEL%"
if "%HW_INSTALL_RESULT%"=="0" goto success
if "%HW_INSTALL_RESULT%"=="2" goto cancelled
echo.
echo Install failed. Read the message above, then see .update-install.log in the plugin folder.
goto finish

:success
echo.
echo Installed. Go back to the extension settings page; it reconnects automatically.
goto finish

:cancelled
echo.
echo Cancelled. Nothing was changed.

:finish
echo.
if not "%HW_INSTALL_RESULT%"=="0" goto waitkey
rem success: give the user three seconds to read, then close by itself
ping -n 4 127.0.0.1 >nul 2>&1
goto done
:waitkey
if "%HW_INSTALL_RESULT%"=="2" goto done
pause
:done
endlocal & exit /b %HW_INSTALL_RESULT%

:notfound
echo.
echo Could not find the Homework Helper plugin folder automatically.
echo Open the folder that contains manifest.json and tools\updater-bootstrap.ps1,
echo then run install-updater.cmd from there.
echo.
pause
endlocal & exit /b 1
