@echo off
REM ═══════════════════════════════════════════════════════════════
REM  ETaxes+ — Arranque rápido del servidor
REM  (asume que ya corriste setup.bat alguna vez)
REM ═══════════════════════════════════════════════════════════════

echo.
echo  ETaxes+ iniciando...
echo  Abre tu navegador en: http://localhost:3000
echo  Presiona Ctrl+C para detener.
echo.

cd /d "%~dp0"
node server.js
