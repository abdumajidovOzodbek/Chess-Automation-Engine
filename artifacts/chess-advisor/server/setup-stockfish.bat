@echo off
echo ================================================
echo   Stockfish Download Setup for Chess Advisor
echo ================================================
echo.

REM Check if Stockfish already exists in PATH
where stockfish >nul 2>&1
if %errorlevel% == 0 (
    echo [OK] Stockfish is already in your system PATH
    stockfish --version
    echo.
    echo You're ready to run the server!
    pause
    exit /b 0
)

echo Stockfish not found. Let's download it...
echo.
echo Opening Stockfish download page...
echo Please download: stockfish-windows-x86-64-avx2.zip
echo.
echo After downloading:
echo 1. Extract the ZIP file
echo 2. Copy stockfish.exe to: C:\Program Files\Stockfish\
echo 3. Or run this script again and I'll help you add it to PATH
echo.

start https://stockfishchess.org/download/

echo.
echo Would you like me to open the install location (C:\Program Files\Stockfish\)?
set /p CREATE_DIR="Create directory and open it? (Y/N): "

if /i "%CREATE_DIR%"=="Y" (
    if not exist "C:\Program Files\Stockfish" mkdir "C:\Program Files\Stockfish"
    explorer "C:\Program Files\Stockfish"
    echo.
    echo After copying stockfish.exe there, run start-server.bat
)

echo.
pause
