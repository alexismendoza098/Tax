#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Actualizar ETX Tax en el servidor VPS
#
# USO:  bash deploy.sh
# Qué hace:
#   1. Descarga los cambios más recientes de Git
#   2. Instala dependencias nuevas (si las hay)
#   3. Reinicia el servidor sin cortar peticiones activas (0-downtime)
#   4. Verifica que el health check responde OK
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail  # Detener en cualquier error

APP_DIR="/var/www/etxtax"
BACKEND_DIR="$APP_DIR/backend"
APP_NAME="etx-tax"
HEALTH_URL="http://localhost:3000/api/health"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ETX Tax — Deploy $(date '+%Y-%m-%d %H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Descargar cambios ──────────────────────────────────────────────────────
echo ""
echo "▶ [1/4] Descargando código..."
cd "$APP_DIR"
git pull origin main
echo "    ✅ Código actualizado"

# ── 2. Instalar dependencias ──────────────────────────────────────────────────
echo ""
echo "▶ [2/4] Instalando dependencias..."
cd "$BACKEND_DIR"
npm install --production --silent
echo "    ✅ Dependencias OK"

# ── 3. Reinicio 0-downtime con PM2 ───────────────────────────────────────────
echo ""
echo "▶ [3/4] Reiniciando servidor (0-downtime)..."
pm2 reload "$APP_NAME" --update-env
echo "    ✅ Servidor recargado"

# ── 4. Verificar health check ─────────────────────────────────────────────────
echo ""
echo "▶ [4/4] Verificando que el servidor responde..."
sleep 3

HEALTH=$(curl -s --max-time 10 "$HEALTH_URL" 2>/dev/null || echo '{"status":"error"}')
DB_STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('db','?'))" 2>/dev/null || echo "?")
UPTIME=$(echo "$HEALTH"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('uptime','?'))" 2>/dev/null || echo "?")
MEMORY=$(echo "$HEALTH"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('memory','?'))" 2>/dev/null || echo "?")

if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "    ✅ Servidor OK | DB: $DB_STATUS | Uptime: ${UPTIME}s | RAM: $MEMORY"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ Deploy completado exitosamente"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo "    ❌ ALERTA: El servidor no responde correctamente"
    echo "    Respuesta: $HEALTH"
    echo ""
    echo "    → Revisa logs: pm2 logs $APP_NAME --lines 30"
    exit 1
fi
