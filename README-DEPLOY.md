# ETX Tax Recovery — Guía de Despliegue en la Nube

## Opciones recomendadas

| Opción | Costo | Dificultad | Mejor para |
|--------|-------|------------|------------|
| **VPS (DigitalOcean / Contabo)** | ~$6-12/mes | Media | ✅ Producción real con FIEL |
| **Railway** | $5/mes | Fácil | ✅ Demo / desarrollo |
| **Render** | Gratis / $7/mes | Fácil | ✅ Demo |

> **Recomendación:** Para un sistema que maneja certificados FIEL (e.Firma) usa un **VPS**
> ya que los archivos `.cer` y `.key` persisten en disco y tienes control total de la seguridad.

---

## OPCIÓN A — VPS con Ubuntu (Producción)

### Paso 1 — Crear el servidor

1. Ve a [DigitalOcean](https://digitalocean.com) o [Contabo](https://contabo.com)
2. Crea un **Droplet Ubuntu 22.04 LTS** (mínimo 1 vCPU, 1 GB RAM)
3. Guarda la IP pública (ejemplo: `167.99.100.200`)
4. Conéctate por SSH:
   ```bash
   ssh root@167.99.100.200
   ```

### Paso 2 — Instalar dependencias del servidor

```bash
# Actualizar sistema
apt update && apt upgrade -y

# Instalar Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verificar versión
node --version   # debe mostrar v20.x.x

# Instalar PM2 (gestor de procesos)
npm install -g pm2

# Instalar MySQL
apt install -y mysql-server
mysql_secure_installation

# Instalar Python (para fallback SAT wrapper)
apt install -y python3 python3-pip
pip3 install cfdiclient  # solo si usas el fallback Python

# Instalar Git
apt install -y git

# Instalar Nginx (proxy inverso, más eficiente que Apache para cloud)
apt install -y nginx
```

### Paso 3 — Configurar MySQL

```bash
# Entrar a MySQL
mysql -u root -p

# Crear base de datos y usuario
CREATE DATABASE IVATAXRECOVERY CHARACTER SET utf8mb4;
CREATE USER 'etxtax'@'localhost' IDENTIFIED BY 'PASSWORD_SEGURO_AQUI';
GRANT ALL PRIVILEGES ON IVATAXRECOVERY.* TO 'etxtax'@'localhost';
FLUSH PRIVILEGES;
EXIT;

# Importar el esquema (desde tu local, copia setup.sql al servidor primero)
mysql -u etxtax -p IVATAXRECOVERY < /ruta/a/setup.sql
```

### Paso 4 — Subir el código

```bash
# Crear directorio de la app
mkdir -p /var/www/etxtax
cd /var/www/etxtax

# Opción A: clonar desde GitHub (recomendado)
git clone https://github.com/TU-USUARIO/etx-tax.git .

# Opción B: copiar archivos desde tu PC (con scp o rsync)
# Desde tu Windows, en PowerShell:
# scp -r "C:\xampp\htdocs\ETX\Tax\*" root@167.99.100.200:/var/www/etxtax/
```

### Paso 5 — Instalar dependencias Node

```bash
cd /var/www/etxtax/backend
npm install --production
```

### Paso 6 — Configurar variables de entorno

```bash
# Copiar plantilla
cp .env.example .env

# Editar con tus valores reales
nano .env
```

Rellena `.env` con:
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=etxtax
DB_PASSWORD=PASSWORD_SEGURO_AQUI
DB_NAME=IVATAXRECOVERY
JWT_SECRET=GENERA_CON: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PORT=3000
NODE_ENV=production
FRONTEND_URL=https://TU-DOMINIO.com
```

### Paso 7 — Crear carpetas necesarias

```bash
mkdir -p /var/www/etxtax/backend/uploads/certs
mkdir -p /var/www/etxtax/backend/uploads/temp
mkdir -p /var/www/etxtax/backend/downloads
mkdir -p /var/www/etxtax/backend/logs

# Dar permisos al proceso Node
chown -R www-data:www-data /var/www/etxtax
chmod -R 755 /var/www/etxtax/backend/uploads
chmod -R 755 /var/www/etxtax/backend/downloads
```

### Paso 8 — Iniciar con PM2

```bash
cd /var/www/etxtax/backend

# Iniciar la app en modo producción
pm2 start ecosystem.config.cjs --env production

# Ver estado
pm2 status

# Ver logs
pm2 logs etx-tax

# Guardar configuración (sobrevive reinicios del SO)
pm2 save

# Configurar auto-inicio al arrancar el servidor
pm2 startup
# ← Este comando te dará otro comando para ejecutar. Cópialo y ejecútalo.
```

### Paso 9 — Configurar Nginx como proxy

```bash
# Crear configuración de Nginx
nano /etc/nginx/sites-available/etxtax
```

Pega esto (reemplaza `TU-DOMINIO.com` con tu dominio o IP):
```nginx
server {
    listen 80;
    server_name TU-DOMINIO.com www.TU-DOMINIO.com;

    # Archivos estáticos del frontend
    root /var/www/etxtax;
    index index.html;

    # Proxy al backend Node.js
    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        # Timeout generoso para operaciones SAT largas
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
    }

    # Resto de rutas → frontend SPA
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
# Activar sitio
ln -s /etc/nginx/sites-available/etxtax /etc/nginx/sites-enabled/
nginx -t           # verificar sin errores
systemctl restart nginx
systemctl enable nginx
```

### Paso 10 — HTTPS con Let's Encrypt (SSL gratis)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d TU-DOMINIO.com -d www.TU-DOMINIO.com
# Sigue las instrucciones, selecciona redirigir HTTP→HTTPS
# El certificado se renueva solo cada 90 días
```

### Paso 11 — Configurar Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
ufw status
```

### Verificar que todo funciona

```bash
# Estado del backend
curl http://localhost:3000/api/health

# Debe responder:
# {"status":"ok","ts":...,"db":"ok","uptime":...,"memory":"...MB","pid":...}
```

---

## OPCIÓN B — Railway (Más fácil, solo demo)

> ⚠️ Railway tiene **sistema de archivos efímero** — los certificados FIEL subidos
> se pierden al reiniciar. Solo úsalo para demos sin certificados reales.

1. Ve a [railway.app](https://railway.app) y crea cuenta
2. Haz click en **"New Project"** → **"Deploy from GitHub repo"**
3. Conecta tu repositorio
4. Railway detectará `package.json` y arrancará automáticamente
5. Ve a **"Variables"** y agrega todas las variables de tu `.env.example`
6. Agrega un plugin MySQL desde el panel de Railway
7. Railway te dará una URL tipo `https://etx-tax.up.railway.app`
8. Actualiza `FRONTEND_URL` en las variables con esa URL

---

## OPCIÓN C — Render (Gratis con límites)

1. Ve a [render.com](https://render.com) → **"New Web Service"**
2. Conecta tu repo de GitHub
3. Configuración:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free (duerme tras 15 min de inactividad) o Starter ($7/mes)
4. Agrega las variables de entorno en el panel
5. Agrega un servicio MySQL externo (PlanetScale gratis o Railway MySQL)

---

## Checklist pre-lanzamiento

- [ ] `JWT_SECRET` es único y aleatorio (no el del ejemplo)
- [ ] `DB_PASSWORD` es segura (no `Error404.`)
- [ ] `.env` NO está en el repositorio Git
- [ ] `uploads/certs/` NO está en el repositorio Git
- [ ] HTTPS activado (certificado SSL)
- [ ] Firewall habilitado (solo puertos 22, 80, 443)
- [ ] `pm2 save` y `pm2 startup` ejecutados
- [ ] `/api/health` responde `"db":"ok"`
- [ ] Login funciona con el usuario admin
- [ ] Autenticación SAT funciona con FIEL real
- [ ] `FRONTEND_URL` apunta a tu dominio real en `.env`

---

## Comandos útiles en producción

```bash
# Ver estado del servidor
pm2 status

# Ver logs en tiempo real
pm2 logs etx-tax --lines 50

# Reiniciar sin cortar conexiones activas (para actualizaciones)
pm2 reload etx-tax

# Actualizar código desde Git
cd /var/www/etxtax
git pull origin main
cd backend && npm install --production
pm2 reload etx-tax

# Ver uso de recursos
pm2 monit

# Health check rápido
curl https://TU-DOMINIO.com/api/health | python3 -m json.tool
```
