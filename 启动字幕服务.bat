@echo off
chcp 936 >nul
title Bili 字幕服务（关掉此窗口即停止）
cd /d "%~dp0server"
if not exist "run.bat" (
  echo 找不到 server\run.bat，请确认目录结构完整。
  pause
  exit /b 1
)
call run.bat
