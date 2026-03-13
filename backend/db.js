require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:    process.env.DB_HOST || process.env.HOST_DE_BASE_DE_DATOS || 'localhost',
  port:    parseInt(process.env.DB_PORT || process.env['Puerto de base de datos'] || 3307),
  user:    process.env.DB_USER || process.env.USUARIO_BD || 'root',
  password: process.env.DB_PASSWORD || process.env.CONTRASEÑA_DE_LA_BASE_DE_DATOS,
  database: process.env.DB_NAME || process.env.NOMBRE_DE_LA_BASE_DE_DATOS || 'ETaxes2_0',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  // Mantiene vivas las conexiones en entornos cloud (AWS RDS, Railway, Render…)
  // que cortan idle connections después de ~5 min
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000, // primer keepalive a los 30s de idle
  // Reintenta la conexión si MySQL se reinicia
  connectTimeout: 10000,
});

// ── Test de conexión al arrancar ────────────────────────────────────────────
pool.query('SELECT 1')
  .then(() => console.log('[DB] ✅ MySQL conectado correctamente'))
  .catch(err => {
    console.error('[DB] ⚠️  No se pudo conectar a MySQL:', err.message);
    console.error('[DB]    El pool reintentará en cada consulta. Verifica DB_HOST/PORT en .env');
  });

module.exports = pool;
