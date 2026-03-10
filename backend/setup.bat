@echo off
REM ═══════════════════════════════════════════════════════════════
REM  ETaxes+ — Configuración inicial (usar solo la primera vez
REM  o después de un git pull con cambios de dependencias/DB)
REM ═══════════════════════════════════════════════════════════════

echo.
echo  ┌──────────────────────────────────────┐
echo  │   ETaxes+ Setup Inicial              │
echo  └──────────────────────────────────────┘
echo.

REM Verificar que existe .env
if not exist "%~dp0.env" (
    echo  [ERROR] No existe el archivo backend\.env
    echo  Copia backend\.env.example como backend\.env y rellena tus datos.
    echo.
    pause
    exit /b 1
)

echo  [1/3] Instalando dependencias npm...
cd /d "%~dp0"
call npm install
if %errorlevel% neq 0 (
    echo  [ERROR] npm install falló
    pause
    exit /b 1
)

echo.
echo  [2/3] Ejecutando migraciones de base de datos...
node scripts\migrate.js
if %errorlevel% neq 0 (
    echo  [AVISO] Las migraciones tuvieron errores. Revisa arriba.
    echo  Puede ser normal si las tablas ya existen.
)

echo.
echo  [3/3] Iniciando servidor ETaxes+...
echo  Abre tu navegador en: http://localhost:3000
echo  Presiona Ctrl+C para detener el servidor.
echo.
node server.js
