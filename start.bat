@echo off
setlocal
chcp 65001 >nul
title model-gateway 本地模型网关
cd /d "%~dp0"

echo ============================================
echo   model-gateway 本地模型网关
echo   控制面板: http://127.0.0.1:8787/
echo   健康检查: http://127.0.0.1:8787/healthz
echo   停止: 关闭本窗口或按 Ctrl+C
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH。
  pause
  exit /b 1
)

REM 健壮启动：先清理占用 8787 的残留/孤儿 node 进程，避免 EADDRINUSE 与"关窗没停、端口被占"导致 agent 连不上
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":8787 .*LISTENING"') do (
  tasklist /fi "PID eq %%P" 2>nul | findstr /i "node.exe" >nul 2>nul
  if not errorlevel 1 (
    echo [!] 结束占用 8787 的残留 node 进程 PID=%%P
    taskkill /pid %%P /f >nul 2>nul
  )
)

node src/index.js
echo.
echo 网关已退出。按任意键关闭窗口...
pause >nul