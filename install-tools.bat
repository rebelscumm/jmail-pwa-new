@echo off
echo Installing JMail PWA Development Tools
echo =======================================

REM Change to the directory where the batch file is located
cd /d "%~dp0"

echo Installing Azure Static Web Apps CLI...
npm install -g @azure/static-web-apps-cli

echo Installing Azure Functions Core Tools...
npm install -g azure-functions-core-tools@4

echo.
echo Installation complete!
echo You can now run start-dev.bat
pause
