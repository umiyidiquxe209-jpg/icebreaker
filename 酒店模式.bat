@echo off
chcp 65001 >nul
title 贾门 Icebreaker — 酒店模式

cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       贾门专属 Icebreaker                    ║
echo ║       酒店模式                               ║
echo ╚══════════════════════════════════════════════╝
echo.

:: Kill any existing server
echo 清理旧进程...
taskkill /f /im node.exe 2>nul
timeout /t 1 /nobreak >nul

:: Start server
echo 启动服务器...
start /B node server.js
timeout /t 3 /nobreak >nul

:: Get LAN IP — match server's getLocalIP logic
for /f "delims=" %%i in ('powershell -NoProfile -Command "$ips=@(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' -and $_.IPAddress -notmatch '^2\.' -and $_.IPAddress -ne '0.0.0.0'}).IPAddress; $pref=@($ips ^| Where-Object {$_ -match '^192\.168\.' -or $_ -match '^10\.' -or $_ -match '^172\.(1[6-9]^|2\d^|3[01])\.'}); if($pref){$pref[0]}else{$ips[0]}" 2^>nul') do set IP=%%i

if "%IP%"=="" set IP=localhost

echo.
echo ═══════════════════════════════════════════════
echo.
echo   同门手机打开：
echo      http://%IP%:3000
echo.
echo   主持人打开：
echo      http://localhost:3000/host
echo.
echo ═══════════════════════════════════════════════
echo.

start http://localhost:3000/host
echo 已打开主持人页面！玩完后关掉此窗口。
echo.
pause
