@echo off
chcp 65001 >nul
echo.
echo  作业助手 - 受控 Edge 启动器（会先关闭当前所有 Edge 窗口）
echo  ------------------------------------------------------------
echo  为什么必须关：Edge 只在**第一个**进程上生效 --remote-debugging-port，
echo  已经开着一个普通窗口时再启动，新窗口会并进去、调试端口根本不监听。
echo.
echo  按任意键继续（会强制结束所有 msedge.exe，未提交的网页表单请先处理）
pause >nul
taskkill /f /im msedge.exe >nul 2>&1
timeout /t 3 >nul
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=19223 --user-data-dir="C:/Users/PC/AppData/Local/Microsoft/Edge/User" --no-first-run --no-default-browser-check --edge-skip-compat-layer-relaunch --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=IntensiveWakeUpThrottling about:blank
echo.
echo  正在检测 19223 端口...
timeout /t 6 >nul
powershell -NoProfile -Command "if ((Test-NetConnection 127.0.0.1 -Port 19223 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host 'OK: 19223 已监听，可以回到对话框继续' } else { Write-Host '失败: 端口没起来，请截图这一行告诉助手' }"
echo.
echo  提醒：窗口**不要最小化**，最小化会让站点自己暂停视频。
pause
