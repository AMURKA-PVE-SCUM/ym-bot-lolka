@echo off
cd /d "%~dp0"

ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo ffmpeg не найден. Установи: winget install "FFmpeg (Essentials Build)"
    pause
    exit /b 1
)

echo Запуск YM-бота...
call npm install
node ym-bot.js
pause
