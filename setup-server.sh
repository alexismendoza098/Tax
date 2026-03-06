#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-server.sh — Instalación completa de ETX Tax en VPS Ubuntu 22.04
#
# INSTRUCCIONES:
#   1. Conéctate a tu VPS por SSH:  ssh root@TU_IP
#   2. Sube este archivo:           scp setup-server.sh root@TU_IP:/root/
#   3. Ejecútalo:                   bash /root/setup-server.sh
#
# Qué instala: Node 20, MySQL 8, Nginx, PM2, Certbot, UFW
# Tiempo estimado: 5-10 minutos
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIGURACIÓN — EDITA ESTAS VARIABLES ANTES DE EJECUTAR
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOMINIO="TU-DOMINIO.com"                   # Ej: etxtax.miempresa.com (o la IP si no tienes dominio)
REPO_URL="https://github.com/TU-USUARIO/etx-tax.git"  # URL de tu repositorio Git
APP_DIR="/var/www/etxtax"
DB_NAME="IVATAXRECOVERY"
DB_USER="etxtax"
DB_PASS=""   # Dejar vacío para generar automáticamente una contraseña segura
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}" && exit 1; }

# Generar contraseña DB si no se especificó
if [ -z "$DB_PASS" ]; then
    DB_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
fi
JWT_SECRET=$(openssl rand -hex 32)

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  ETX Tax Recovery — Instalación automática VPS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── [1/8] Actualizar sistema ─────────────────────────────────────────────────
log "[1/8] Actualizando sistema..."
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq curl git ufw openssl python3 python3-pip

# ── [2/8] Instalar Node.js 20 LTS ────────────────────────────────────────────
log "[2/8] Instalando Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs
npm install -g pm2 > /dev/null 2>&1
echo "    Node: $(node --version) | npm: $(npm --version) | PM2: $(pm2 --version)"

# ── [3/8] Instalar MySQL 8 ───────────────────────────────────────────────────
log "[3/8] Instalando MySQL 8..."
apt-get install -y -qq mysql-server

# Configurar MySQL sin contraseña interactiva
mysql -e "CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
mysql -e "GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';"
mysql -e "FLUSH PRIVILEGES;"
echo "    ✅ Base de datos '${DB_NAME}' creada"

# ── [4/8] Instalar Nginx ─────────────────────────────────────────────────────
log "[4/8] Instalando Nginx..."
apt-get install -y -qq nginx

# Configurar Nginx como proxy inverso
cat > /etc/nginx/sites-available/etxtax << NGINX_EOF
server {
    listen 80;
    server_name ${DOMINIO};

    # Archivos estáticos del frontend (Node los sirve, pero Nginx los cacheará)
    root ${APP_DIR};
    index index.html;

    # Proxy al backend Node.js para rutas /api
    location /api/ {
        proxy_pass         http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout    300s;
        proxy_connect_timeout  10s;
        proxy_send_timeout    300s;
        proxy_buffering off;
    }

    # Todo lo demás → frontend SPA
    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache, must-revalidate" always;
    }

    # Archivos estáticos con cache largo
    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # No cachear la API
    location ~* \.json$ {
        add_header Cache-Control "no-store, no-cache" always;
    }
}
NGINX_EOF

ln -sf /etc/nginx/sites-available/etxtax /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx && systemctl enable nginx
echo "    ✅ Nginx configurado y activo"

# ── [5/8] Clonar repositorio ──────────────────────────────────────────────────
log "[5/8] Clonando repositorio..."
mkdir -p "$APP_DIR"
git clone "$REPO_URL" "$APP_DIR" || warn "No se pudo clonar — el directorio ya existe o la URL es incorrecta"

# Crear directorios necesarios
mkdir -p "${APP_DIR}/backend/uploads/certs"
mkdir -p "${APP_DIR}/backend/uploads/temp"
mkdir -p "${APP_DIR}/backend/downloads"
mkdir -p "${APP_DIR}/backend/logs"
chown -R www-data:www-data "${APP_DIR}/backend/uploads"
chmod -R 750 "${APP_DIR}/backend/uploads"
echo "    ✅ Directorios creados"

# ── [6/8] Configurar .env ─────────────────────────────────────────────────────
log "[6/8] Creando archivo .env..."
cat > "${APP_DIR}/backend/.env" << ENV_EOF
DB_HOST=localhost
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}
JWT_SECRET=${JWT_SECRET}
PORT=3000
NODE_ENV=production
FRONTEND_URL=https://${DOMINIO}
ENV_EOF

chmod 600 "${APP_DIR}/backend/.env"
echo "    ✅ .env creado con credenciales seguras"

# ── [7/8] Instalar dependencias e iniciar con PM2 ────────────────────────────
log "[7/8] Instalando dependencias Node y arrancando servidor..."
cd "${APP_DIR}/backend"
npm install --production --silent
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash > /dev/null 2>&1
echo "    ✅ Backend activo con PM2"

# ── [8/8] Configurar firewall ─────────────────────────────────────────────────
log "[8/8] Configurando firewall (UFW)..."
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow ssh        > /dev/null 2>&1
ufw allow 80/tcp     > /dev/null 2>&1
ufw allow 443/tcp    > /dev/null 2>&1
# IMPORTANTE: Puerto 3000 NO expuesto — solo accesible desde Nginx internamente
ufw --force enable   > /dev/null 2>&1
echo "    ✅ Firewall activo | Puertos abiertos: SSH(22), HTTP(80), HTTPS(443)"

# ── Verificación final ────────────────────────────────────────────────────────
sleep 3
HEALTH=$(curl -s --max-time 10 http://localhost:3000/api/health 2>/dev/null || echo '{}')

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅ Instalación completada${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  🌐 URL:         http://${DOMINIO}"
echo "  📊 Health:      $(echo $HEALTH | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('status')=='ok' else 'REVISAR')" 2>/dev/null || echo 'Revisar manualmente')"
echo ""
echo -e "${YELLOW}  ⚠️  GUARDA ESTAS CREDENCIALES EN LUGAR SEGURO:${NC}"
echo "  DB Usuario:     ${DB_USER}"
echo "  DB Contraseña:  ${DB_PASS}"
echo "  JWT Secret:     ${JWT_SECRET}"
echo ""
echo "  📋 SIGUIENTE PASO — Activar HTTPS gratuito:"
echo "     apt install -y certbot python3-certbot-nginx"
echo "     certbot --nginx -d ${DOMINIO}"
echo ""
echo "  📋 Importar esquema de BD (desde tu PC local):"
echo "     scp setup.sql root@TU_IP:/tmp/"
echo "     mysql -u ${DB_USER} -p'${DB_PASS}' ${DB_NAME} < /tmp/setup.sql"
echo ""
echo "  📋 Comandos útiles:"
echo "     pm2 status                # estado del servidor"
echo "     pm2 logs etx-tax          # logs en tiempo real"
echo "     pm2 reload etx-tax        # reiniciar sin downtime"
echo "     bash ${APP_DIR}/deploy.sh # actualizar desde Git"
echo ""
