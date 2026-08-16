@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title DeepSeek Harness 一键启动

echo ============================================
echo    DeepSeek Harness 一键启动脚本
echo ============================================
echo.

:: ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^>= 22.19
    echo        下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo [检查] Node.js 版本: !NODE_VER!

:: ---------- 2. 检查 pnpm，缺失则通过 corepack 启用 ----------
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [检查] 未检测到 pnpm，正在通过 corepack 启用...
    call corepack enable
    call corepack prepare pnpm@11.7.0 --activate
    where pnpm >nul 2>nul
    if errorlevel 1 (
        echo [错误] pnpm 启用失败，请手动执行: corepack enable ^&^& corepack prepare pnpm@11.7.0 --activate
        pause
        exit /b 1
    )
)
for /f "delims=" %%v in ('pnpm -v') do set PNPM_VER=%%v
echo [检查] pnpm 版本: !PNPM_VER!

:: ---------- 3. 首次运行自动安装依赖 ----------
if not exist "node_modules" (
    echo.
    echo [初始化] 首次运行，正在安装依赖 ^(pnpm install^)，可能需要几分钟...
    call pnpm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
    echo [初始化] 依赖安装完成
)

:: ---------- 4. 检查 API Key ----------
if not exist ".env" (
    echo.
    echo [配置] 未找到 .env 文件，运行需要 DeepSeek API Key
    echo        ^(可前往 https://platform.deepseek.com/ 申请^)
    set /p APIKEY=请输入 DEEPSEEK_API_KEY ^(直接回车跳过，稍后手动创建 .env^):
    if not "!APIKEY!"=="" (
        echo DEEPSEEK_API_KEY=!APIKEY!> .env
        echo [配置] 已写入 .env
    ) else (
        echo [配置] 已跳过。注意: 没有 API Key 时 agent 相关功能将无法运行
    )
)

:: ---------- 5. 主菜单 ----------
:menu
echo.
echo ============================================
echo    请选择要启动的模式:
echo ============================================
echo    [1] 交互式 CLI        (pnpm dsh)
echo    [2] 无头模式          (执行单个任务后退出)
echo    [3] 浏览器 Web UI     (pnpm dsh web)
echo    [4] 构建项目          (pnpm run build)
echo    [5] 运行单元测试      (pnpm run test)
echo    [0] 退出
echo ============================================
choice /c 123450 /n /m "请输入选项 (0-5): "
set OPT=%errorlevel%

if "%OPT%"=="1" goto cli
if "%OPT%"=="2" goto headless
if "%OPT%"=="3" goto web
if "%OPT%"=="4" goto build
if "%OPT%"=="5" goto test
if "%OPT%"=="6" goto end

:cli
echo.
echo [启动] 交互式 CLI，退出后返回本菜单...
call pnpm dsh
goto menu

:headless
echo.
set /p TASK=请输入要执行的任务:
if "!TASK!"=="" (
    echo [提示] 任务不能为空
    goto menu
)
call pnpm dsh --profile headless "!TASK!"
echo.
echo [完成] 任务执行结束，按任意键返回菜单...
pause >nul
goto menu

:web
if not exist "apps\web\dist" (
    echo.
    echo [提示] Web 前端尚未构建，正在构建 ^(pnpm run build^)...
    call pnpm run build
    if errorlevel 1 (
        echo [错误] 构建失败，请查看上方错误信息
        pause
        goto menu
    )
)
echo.
echo [启动] Web UI，按 Ctrl+C 停止服务后返回本菜单...
call pnpm dsh web
goto menu

:build
echo.
echo [构建] 正在构建整个项目...
call pnpm run build
if errorlevel 1 (
    echo [错误] 构建失败，请查看上方错误信息
) else (
    echo [构建] 构建完成
)
echo.
pause
goto menu

:test
echo.
echo [测试] 正在运行单元测试...
call pnpm run test
echo.
pause
goto menu

:end
echo.
echo 再见！
endlocal
exit /b 0
