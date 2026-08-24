@echo off
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

node src/index.js
echo.
echo 网关已退出。按任意键关闭窗口...
pause >nul
