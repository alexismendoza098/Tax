@echo off
title ETaxes+ - Iniciando...
color 0A
setlocal enabledelayedexpansion

echo ========================================================
echo      ETaxes+ - Sistema Fiscal SAT
echo      ETaxes+ v2.0
echo ========================================================
echo.

:: Ruta del proyecto
set PROJECT=C:\Users\alexis\Desktop\ETaxes2\ETX2\Tax2
set BACKEND=%PROJECT%\backend

:: ── [0] Verificar server.js ─────────────────────────────
if not exist "%BACKEND%\server.js" (
    color 0C
    echo [ERROR] No se encuentra server.js en:
    echo         %BACKEND%
    echo.
    echo Verifica que el proyecto este completo.
    pause
    exit /b 1
)

:: ── [1] Verificar que MySQL este activo en puerto 3307 ──
echo [1/4] Verificando MySQL en puerto 3307...
netstat -ano | findstr ":3307.*LISTENING" >nul 2>&1
if errorlevel 1 (
    color 0E
    echo.
    echo [AVISO] MySQL NO esta corriendo en el puerto 3307.
    echo.
    echo  Abre XAMPP Control Panel e inicia MySQL,
    echo  o inicia el servicio MySQL desde Windows.
    echo.
    echo  Intentando abrir XAMPP...
    start "" "C:\xampp\xampp-control.exe" >nul 2>&1
    echo.
    echo  Esperando 8 segundos para que inicies MySQL...
    timeout /t 8 >nul
    color 0A
) else (
    echo       MySQL detectado en puerto 3307. OK
)

:: ── [2] Limpiar puerto 3000 ──────────────────────────────
echo.
echo [2/4] Limpiando puerto 3000...
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3000.*LISTENING"') do (
    echo       Deteniendo proceso PID: %%p
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 >nul
echo       Puerto 3000 libre. OK

:: ── [3] Iniciar Backend Node.js ─────────────────────────
echo.
echo [3/4] Iniciando Servidor Backend ETaxes+...
echo       Abriendo ventana del servidor (no la cierres)...
start "ETaxes+ Backend" cmd /k "cd /d "%BACKEND%" && echo. && echo  [ETaxes+] Iniciando en puerto 3000... && echo. && node server.js || (echo. && echo  [ERROR] El servidor fallo. Revisa los mensajes arriba. && pause)"

:: Esperar a que arranque
echo       Esperando al servidor...
set RETRY=0
:WAIT_LOOP
timeout /t 2 >nul
set /a RETRY+=1
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo       Servidor activo en puerto 3000. OK
    goto SERVER_READY
)
if %RETRY% lss 6 (
    echo       Intento !RETRY!/6... esperando...
    goto WAIT_LOOP
)
echo.
echo [AVISO] El servidor no respondio en 12 segundos.
echo         Revisa la ventana negra "ETaxes+ Backend".
echo.

:SERVER_READY
:: ── [4] Abrir Navegador ──────────────────────────────────
echo.
echo [4/4] Abriendo ETaxes+ en el navegador...
start http://localhost:3000

echo.
echo ========================================================
echo  ETaxes+ INICIADO
echo ========================================================
echo.
echo  URL del sistema:  http://localhost:3000
echo  Backend API:      http://localhost:3000/api
echo  Base de datos:    ETaxes2_0
echo.
echo  IMPORTANTE: NO cierres la ventana negra del servidor.
echo  Para detener, cierra esa ventana.
echo.
pause
