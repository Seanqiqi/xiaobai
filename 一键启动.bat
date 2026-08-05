@echo off
title 数字馆互动导览

echo ============================================
echo    数字馆互动导览 - 正在启动...
echo ============================================
echo.

:: 切换到脚本所在目录
cd /d "%~dp0"

:: 检查 Python 是否可用
where python >nul 2>&1
if %errorlevel% equ 0 (
    echo [√] 检测到 Python，正在启动本地服务器...
    echo.
    echo 请在弹出的浏览器窗口中点击"点击开始"按钮
    echo 关闭此窗口即可停止程序
    echo.
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto :end
)

:: 检查 Python3
where python3 >nul 2>&1
if %errorlevel% equ 0 (
    echo [√] 检测到 Python3，正在启动本地服务器...
    echo.
    echo 请在弹出的浏览器窗口中点击"点击开始"按钮
    echo 关闭此窗口即可停止程序
    echo.
    start "" "http://localhost:8080"
    python3 -m http.server 8080
    goto :end
)

:: 没有 Python，尝试用 Node.js
where npx >nul 2>&1
if %errorlevel% equ 0 (
    echo [√] 检测到 Node.js，正在启动本地服务器...
    echo.
    echo 请在弹出的浏览器窗口中点击"点击开始"按钮
    echo 关闭此窗口即可停止程序
    echo.
    start "" "http://localhost:8080"
    npx http-server -p 8080 -c-1 --cors
    goto :end
)

:: 都没有
echo [!] 未检测到 Python 或 Node.js
echo.
echo 解决方法（任选其一）：
echo   1. 安装 Python: https://www.python.org/downloads/
echo      安装时勾选 "Add Python to PATH"
echo   2. 安装 Node.js: https://nodejs.org/
echo.
echo 安装完成后重新双击此文件即可启动。
echo.
pause

:end