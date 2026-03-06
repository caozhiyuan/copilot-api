@echo off
echo ================================================
echo GitHub Copilot API Server with Admin UI
echo ================================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    bun install
    echo.
)

echo Starting server...
echo The admin page will open automatically shortly after startup
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul && start \"\" \"http://localhost:4141/admin\""
bun run dev

pause
