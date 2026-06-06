@echo off
chcp 65001 >nul
title 贾门 Icebreaker
echo.
echo ╔══════════════════════════════════════════╗
echo ║     贾门专属 Icebreaker                 ║
echo ╚══════════════════════════════════════════╝
echo.
echo   [1] 生成公网链接（同门手机可连）★ 推荐
echo   [2] 仅局域网（同WiFi+关防火墙）
echo   [3] 单机版（不需手机参与）
echo.
set /p choice="选: "

if "%choice%"=="1" goto tunnel
if "%choice%"=="2" goto local
if "%choice%"=="3" goto standalone
exit

:standalone
start "" "%~dp0standalone.html"
echo ✅ 已打开！投屏到电视，主持人在底部控制栏操作。
pause
exit

:local
echo.
where node >nul 2>&1 || (echo ❌ 需要 Node.js && pause && exit)
echo 🚀 启动中（同门请连同一WiFi）...
echo.
echo ═══════════════════════════════════════════
echo   主持人：localhost:3000/host
echo   同门：看上方显示的局域网地址
echo ═══════════════════════════════════════════
echo.
node server.js
pause
exit

:tunnel
echo.
where node >nul 2>&1 || (echo ❌ 需要 Node.js && pause && exit)
echo.
echo 🔍 检查 SSH...
where ssh >nul 2>&1 || (echo ❌ 系统不支持 && pause && exit)
echo ✅ SSH 可用
echo.
echo 🚀 启动服务器...
start /B node server.js
timeout /t 3 /nobreak >nul
echo.
echo ═══════════════════════════════════════════
echo   隧道启动后，把显示的网址发给同门！
echo   主持人页面在网址后面加 /host
echo   按 Ctrl+C 可以退出
echo ═══════════════════════════════════════════
echo.
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 serveo.net
echo.
echo 隧道已断开。按任意键退出。
pause
