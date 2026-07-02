@echo off
title YM-бот
cd /d "%~dp0"

ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo ffmpeg не найден. Установи: winget install "FFmpeg (Essentials Build)"
    pause
    exit /b 1
)

call npm install

if not exist .env (
    echo.
    echo ========== Первый запуск — настройка ==========
    node setup.mjs
    if %errorlevel% neq 0 (
        echo.
        echo Ошибка настройки. Запусти start.bat заново.
        pause
        exit /b 1
    )
)

echo.
echo ========== Запуск бота ==========
npm start
pause
