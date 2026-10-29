@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

set "MIRROR=https://mirrors.aliyun.com/pypi/simple"
set "HF_ENDPOINT=https://hf-mirror.com"

echo ============================================
echo   bili-ai-whisper 本地字幕服务
echo ============================================

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 创建虚拟环境...
    py -3.12 -m venv .venv >nul 2>&1
    if not exist ".venv\Scripts\python.exe" py -3.11 -m venv .venv >nul 2>&1
    if not exist ".venv\Scripts\python.exe" python -m venv .venv
)

if not exist ".venv\Scripts\python.exe" (
    echo.
    echo 创建虚拟环境失败。请先安装 Python 3.11 或更高版本。
    echo 下载地址: https://www.python.org/downloads/
    echo 安装时务必勾选 "Add Python to PATH"。
    echo.
    pause
    exit /b 1
)

echo [2/3] 检查依赖...
".venv\Scripts\python.exe" -c "import flask, flask_cors, requests, faster_whisper, ctranslate2, sherpa_onnx" >nul 2>&1
if errorlevel 1 (
    echo 首次运行需要安装依赖（约 400MB），请耐心等待...
    rem 不升级 pip：新版 pip 解析部分国内镜像会直接返回空版本列表
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt -i %MIRROR%
    if errorlevel 1 (
        echo.
        echo 依赖安装失败。回退到清华镜像再试一次...
        ".venv\Scripts\python.exe" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        if errorlevel 1 (
            echo.
            echo 两种镜像都失败。请检查网络，或安装 Python 3.12 后重试。
            echo.
            pause
            exit /b 1
        )
    )
    ".venv\Scripts\python.exe" -c "import flask, flask_cors, requests, faster_whisper, ctranslate2"
    if errorlevel 1 (
        echo.
        echo 依赖装上了但导入失败，通常是 ctranslate2 与当前 Python 版本不匹配。
        echo 解决办法：安装 Python 3.12 后删除 .venv 目录，重新运行本脚本。
        echo.
        pause
        exit /b 1
    )
)

rem sherpa-onnx 装不上不阻断启动：会自动退回 whisper，只是慢很多
".venv\Scripts\python.exe" -c "import sherpa_onnx" >nul 2>&1
if errorlevel 1 (
    echo   [提示] sherpa-onnx 未装上，将改用 whisper 后端：能用，但慢约 10 倍。
)

echo [3/3] 启动服务...

rem 端口被占用时 python 会静默退出（输出已写入日志），这里提前提示，免得窗口看起来没反应
netstat -ano | findstr /C:"127.0.0.1:8765" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo 端口 8765 已被占用，多半是已经有一个服务窗口在运行。
    echo 请先关掉那个黑色的服务窗口，再运行本脚本。
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   服务地址   http://127.0.0.1:8765
echo   运行日志   server.log （本目录，可用记事本打开）
echo   停止服务   按 Ctrl 键加 C，或直接关闭本窗口
echo ============================================================
echo.
echo 看到上面这段就代表已启动，再等 3 到 5 秒服务即可访问。
echo 本窗口可以最小化，但不要关闭。
echo.

".venv\Scripts\python.exe" server.py

echo.
echo 服务已停止。
pause
