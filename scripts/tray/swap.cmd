@echo off
rem Deploy the prepared mg-tray.new.exe as the running tray.
rem NOTE: the tray guards the gateway - restarting the tray briefly restarts the gateway.
taskkill /F /IM mg-tray.exe
timeout /t 2 /nobreak >nul
move /y "%~dp0..\mg-tray.new.exe" "%~dp0..\mg-tray.exe"
start "" "%~dp0..\mg-tray.exe"
