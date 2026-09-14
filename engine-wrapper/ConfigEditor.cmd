@echo off
rem Standalone engine config editor (no server, no services).
rem Layout: this file sits next to ShogiHomeLab.exe and engine-wrapper\engines.json.
setlocal
set "HERE=%~dp0"
rem Trim trailing backslash for --config-dir.
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
"%HERE%\ShogiHomeLab.exe" --config-editor --config-dir "%HERE%\engine-wrapper"
