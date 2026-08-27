@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 后再运行。
  pause
  exit /b 1
)

echo 正在启动打工人小账本...
start "" "http://127.0.0.1:4173/"
call npm start

if errorlevel 1 (
  echo.
  echo 服务启动失败，请检查端口 4173 是否已被占用。
  pause
)
