@echo off
title Chess Advisor - Stockfish Server
cd /d "%~dp0server"
node stockfish-server.mjs
pause
