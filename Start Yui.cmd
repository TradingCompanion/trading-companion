@echo off
rem Launches Yui. Needs no Node on the PATH: Electron ships its own runtime.
rem Any pet already running is closed first, so launching always gives you the current build.
rem The app path is "." on purpose: "%~dp0" ends in a backslash, which escapes the closing quote.
cd /d "%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -like '*desktop-pet*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
start "" "%~dp0node_modules\electron\dist\electron.exe" .
