@echo off
rem Starts the local web server and opens the book in the default browser.
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%LOCALAPPDATA%\node-portable\node-v22.14.0-win-x64\node.exe"
start "" http://localhost:8080
"%NODE%" serve.mjs 8080
