@echo off
setlocal
node "%~dp0app\server.mjs" %*
exit /b %ERRORLEVEL%