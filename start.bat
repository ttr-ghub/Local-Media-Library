@echo off
cd /d "%~dp0"
echo Starting Local Media Library...
start /B cmd /c "npm start"
timeout /t 3 /nobreak > nul
start http://localhost:3000
