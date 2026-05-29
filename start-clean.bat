@echo off
cd /d "%~dp0"
echo Starting Local Media Library in Clean Verification Mode...
set LOCAL_MEDIA_DATA_DIR=data_test_fresh
start /B cmd /c "npm run start"
timeout /t 3 /nobreak > nul
start http://localhost:3000
