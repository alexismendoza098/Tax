/**
 * ecosystem.config.cjs — Configuración PM2 para ETX Tax Recovery
 *
 * USO RÁPIDO:
 *   npm install -g pm2          ← instalar PM2 una sola vez
 *   pm2 start ecosystem.config.cjs
 *   pm2 save                    ← guardar lista de procesos
 *   pm2 startup                 ← auto-arranque tras reinicio del SO
 *
 * COMANDOS ÚTILES:
 *   pm2 status                  ← ver estado
 *   pm2 logs etx-tax            ← ver logs en tiempo real
 *   pm2 restart etx-tax         ← reiniciar manualmente
 *   pm2 reload etx-tax          ← reinicio 0-downtime (actualiza sin cortar peticiones activas)
 *   pm2 monit                   ← dashboard CPU/RAM en tiempo real
 *
 * EN CLOUD (Railway, Render, DigitalOcean, AWS EC2…):
 *   - Establece las variables de entorno en el panel de la plataforma
 *     (NO uses .env en producción — PM2 lo carga con env_production abajo)
 *   - pm2 start ecosystem.config.cjs --env production
 */

module.exports = {
  apps: [
    {
      // ── Identidad ─────────────────────────────────────────────────────────
      name: 'etx-tax',
      script: 'server.js',
      cwd: __dirname, // misma carpeta que este archivo (backend/)

      // ── Modo instancias ───────────────────────────────────────────────────
      // instances: 1 → un proceso (recomendado mientras la app use memoria compartida
      //   para los jobs SAT — el Map() en requests.js no es compartido entre workers)
      // Cambiar a 'max' solo si refactorizas jobs a Redis/DB
      instances: 1,
      exec_mode: 'fork',

      // ── Reinicio automático ───────────────────────────────────────────────
      autorestart: true,
      watch: false,                // NO watch en producción (muy costoso en disco)
      max_memory_restart: '512M',  // reinicia si el proceso supera 512 MB de RAM
      min_uptime: '10s',           // si cae antes de 10s se considera fallo
      max_restarts: 15,            // máximo 15 reinicios seguidos antes de detenerse
      restart_delay: 4000,         // espera 4s entre reintentos (evita loops rápidos)
      exp_backoff_restart_delay: 100, // backoff exponencial en fallos repetidos

      // ── Señal de apagado ─────────────────────────────────────────────────
      // server.js escucha SIGINT → cierre limpio HTTP + DB pool
      kill_timeout: 12000,         // tras 12s PM2 envía SIGKILL forzado
      listen_timeout: 8000,        // tiempo máximo para que el servidor empiece a escuchar

      // ── Logs ─────────────────────────────────────────────────────────────
      error_file:  './logs/pm2-error.log',
      out_file:    './logs/pm2-out.log',
      log_file:    './logs/pm2-combined.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // ── Variables de entorno — DESARROLLO ────────────────────────────────
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },

      // ── Variables de entorno — PRODUCCIÓN ────────────────────────────────
      // pm2 start ecosystem.config.cjs --env production
      // En plataformas cloud estas variables se configuran en el panel web,
      // no en este archivo (para no exponer credenciales en el repo).
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME → panel de la plataforma
        // JWT_SECRET                                      → panel de la plataforma
        // FRONTEND_URL                                    → panel de la plataforma
      },
    },
  ],
};
