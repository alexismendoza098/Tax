require('dotenv').config();
const mysql = require('mysql2/promise');

// Intenta usar la URL de MySQL de Railway primero
const dbUrl = process.env['URL de MySQL'] || process.env.DATABASE_URL;
let dbConfig;

if (dbUrl && dbUrl.startsWith('mysql://')) {
  try {
    // Parsear URL de MySQL: mysql://usuario:pass@host:puerto/database
    const match = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
    if (match) {
      dbConfig = {
        host: match[3],
        port: parseInt(match[4]),
        user: match[1],
        password: match[2],
        database: match[5],
      };
    } else {
      throw new Error('Invalid MySQL URL format');
    }
  } catch (e) {
    console.error('[DB] Error parsing database URL, using fallback:', e.message);
    dbConfig = {
      host: process.env.DB_HOST || process.env['Host MySQL'] || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.MYSQLPORT || 3307),
      user: process.env.DB_USER || process.env.USUARIOMYSQL || 'root',
      password: process.env.DB_PASSWORD || process.env['CONTRASEÑA MYSQL'],
      database: process.env.DB_NAME || process.env['BASE DE DATOS MYSQL'] || 'ETaxes2_0',
    };
  }
} else {
  dbConfig = {
    host: process.env.DB_HOST || process.env['Host MySQL'] || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.MYSQLPORT || 3307),
    user: process.env.DB_USER || process.env.USUARIOMYSQL || 'root',
    password: process.env.DB_PASSWORD || process.env['CONTRASEÑA MYSQL'],
    database: process.env.DB_NAME || process.env['BASE DE DATOS MYSQL'] || 'ETaxes2_0',
  };
}

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
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
