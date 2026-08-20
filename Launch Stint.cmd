@echo off
REM Launches Stint without packaging or a console window.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
