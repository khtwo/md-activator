@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Launch MD Activator in Windows PowerShell
REM Usage:
REM   start.bat [content_root] [app options...]
REM   start.bat --cd content_root [app options...]

set "SCRIPT_DIR=%~dp0"
set "CONTENT_ROOT=%CD%"
set "DEFAULT_RELOAD=--reload"
set "APP_ARGS="

:parse_args
if "%~1"=="" goto args_done
if not defined FIRST_ARG_SEEN (
  set "FIRST_ARG_SEEN=1"
  set "FIRST_ARG=%~1"
  if not "!FIRST_ARG:~0,1!"=="-" (
    set "CONTENT_ROOT=%~1"
    shift
    goto parse_args
  )
)
if /I "%~1"=="--reload" set "DEFAULT_RELOAD="
if /I "%~1"=="--no-reload" set "DEFAULT_RELOAD="
set APP_ARGS=%APP_ARGS% "%~1"
shift
goto parse_args

:args_done
set "UV_CACHE_DIR=%SCRIPT_DIR%.uv-cache"

call uv --version >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo uv was not found. Please install uv and run this launcher again.
  exit /b 1
)

pushd "%SCRIPT_DIR%"
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%

echo Checking Python dependencies...
call uv sync --quiet --native-tls
if %ERRORLEVEL% NEQ 0 goto command_failed

echo Starting MD Activator ...
call uv run --no-sync --native-tls python -m app.main --cd "%CONTENT_ROOT%" %DEFAULT_RELOAD% --no-use-colors %APP_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%

:command_failed
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
