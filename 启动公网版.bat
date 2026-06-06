@echo off
chcp 65001 >nul
title 贾门 Icebreaker

cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       贾门专属 Icebreaker                    ║
echo ╚══════════════════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 需要安装 Node.js
    echo    下载地址：https://nodejs.org
    echo    装完重新双击此脚本即可
    pause
    exit /b 1
)

:: Kill old processes
taskkill /f /im node.exe 2>nul
taskkill /f /im ssh.exe 2>nul
timeout /t 1 /nobreak >nul

:: Start server
echo 🚀 启动游戏服务器...
start /B node server.js
timeout /t 2 /nobreak >nul

:: Start tunnel
echo 🌐 建立公网隧道...
start /B ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 serveo.net
timeout /t 4 /nobreak >nul

echo.
echo ═══════════════════════════════════════════════
echo.
echo   公网隧道已启动。获取网址的方法：
echo.
echo   浏览器打开 http://localhost:3000/host
echo   页面上方会显示"加入地址"——那就是公网网址
echo.
echo   如果没有显示公网网址，说明 serveo.net 挂了
echo   此时请用局域网模式（大家连同一WiFi）
echo.
echo ═══════════════════════════════════════════════
echo.

start http://localhost:3000/host
echo ✅ 主持人页面已打开！
echo.
echo 玩完后关掉此窗口即可。
pause
