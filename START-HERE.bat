@echo off
cls
echo ================================================
echo   Chess Automation Engine - Quick Start
echo ================================================
echo.
echo This will start the Stockfish server.
echo After the server starts:
echo.
echo 1. Load the browser extension
echo 2. Go to chessfriends.com or chess.com
echo 3. Start a game and watch the magic!
echo.
echo ================================================
echo.
pause
cd artifacts\chess-advisor
call start-server.bat
