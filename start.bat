@echo off
setlocal EnableExtensions
title 打工人小账本 - 本地服务
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"

if defined NODE_EXE goto node_found
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if defined NODE_EXE goto node_found
if exist "D:\Program Files\nodejs\node.exe" set "NODE_EXE=D:\Program Files\nodejs\node.exe"
if defined NODE_EXE goto node_found
if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if defined NODE_EXE goto node_found
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto node_found

echo [错误] 未找到 Node.js。
echo 请安装 Node.js，或将 node.exe 加入系统 PATH。
pause
exit /b 1

:node_found
if not exist "%~dp0server.mjs" goto missing_server

echo 正在启动打工人小账本...
echo Node.js: "%NODE_EXE%"
echo 服务地址: http://127.0.0.1:4173/
echo 请保持此窗口开启；关闭窗口即可停止服务。
echo.
start "" "http://127.0.0.1:4173/"
"%NODE_EXE%" "%~dp0server.mjs"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" goto finished
echo.
echo [错误] 服务启动失败，退出码: %EXIT_CODE%
echo 常见原因：端口 4173 已被占用，或 server.mjs 启动报错。
echo.

:finished
pause
exit /b %EXIT_CODE%

:missing_server
echo [错误] 找不到 server.mjs，请确认此脚本位于项目根目录。
pause
exit /b 1
