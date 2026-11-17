@echo off
chcp 65001 >nul
title 日程同步服务
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    python server.py
    goto end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 server.py
    goto end
)

echo.
echo 没有检测到 Python。
echo 请先到 https://www.python.org/downloads/ 安装 Python 3，
echo 安装时记得勾选 "Add python.exe to PATH"。
echo.

:end
echo.
pause
