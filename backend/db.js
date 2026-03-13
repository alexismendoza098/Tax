require('dotenv').config();
const mysql = require('mysql2/promise');

let dbConfig;

// Intenta usar la URL de MySQL de Railway primero
const dbUrl = process.env['HOST_DE_BASE_DE_DATOS'] || process.env['URL de MySQL'] || process.env.DATABASE_URL;

if (dbUrl) {
  try {
    // Parsear URL: mysql://usuario:contraseña@host:puerto/database
    // Quitar el protocolo mysql://
    const urlWithoutProtocol = dbUrl.replace('mysql://', '');

    // Separar credenciales del host
    const [credentials, hostAndDb] = urlWithoutProtocol.split('@');
    const [user, password] = credentials.split(':');

    // Separar host, puerto y base de datos
    const [hostAndPort, database] = hostAndDb.split('/');
    const [host, port] = hostAndPort.split(':');

    dbConfig = {
      host: host,
      port: parseInt(port) || 3306,
      user: user,
      password: password,
      database: database || 'ETaxes2_0',
    };

    console.log('[DB] ✅ URL de MySQL parseada correctamente');
  } catch (e) {
    console.error('[DB] Error parsing database URL:', e.message);
    console.error('[DB] Usando configuración por fallback');
    dbConfig = {
      host: process.env.DB_HOST || process.env['Host MySQL'] || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.MYSQLPORT || 3307),
      user: process.env.DB_USER || process.env.USUARIOMYSQL || 'root',
      password: process.env.DB_PASSWORD || process.env['CONTRASEÑA MYSQL'],
      database: process.env.DB_NAME || process.env['BASE DE DATOS MYSQL'] || 'ETaxes2_0',
    };
  }
} else {
  console.log('[DB] No URL encontrada, usando variables de entorno individuales');
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
