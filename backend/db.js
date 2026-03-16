require('dotenv').config();
const mysql = require('mysql2/promise');

const parseDbUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    const dbName = (url.pathname || '').replace(/^\//, '');
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      user: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      database: dbName || undefined,
    };
  } catch {
    return null;
  }
};

const resolveDbConfig = () => {
  // Soporta variables estándar de Railway (MYSQL_URL, DATABASE_URL)
  // y también variables en español que el usuario haya definido manualmente
  const urlConfig =
    parseDbUrl(process.env.MYSQL_URL) ||
    parseDbUrl(process.env.DATABASE_URL) ||
    parseDbUrl(process.env['HOST_DE_BASE_DE_DATOS']) ||
    parseDbUrl(process.env['URL de MySQL']);

  const port =
    process.env.MYSQLPORT ||
    process.env.MYSQL_PORT ||
    undefined;

  const base = urlConfig
    ? {
        host: urlConfig.host,
        port: urlConfig.port,
        user: urlConfig.user,
        password: urlConfig.password,
        database: urlConfig.database,
      }
    : {
        // Variables automáticas de Railway MySQL plugin
        host:     process.env.MYSQLHOST     || process.env.MYSQL_HOST    || process.env['Host MySQL'],
        port:     port ? Number(port) : undefined,
        user:     process.env.MYSQLUSER     || process.env.MYSQL_USER    || process.env['USUARIOMYSQL'],
        password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD|| process.env['CONTRASEÑA MYSQL'],
        database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE|| process.env['BASE DE DATOS MYSQL'],
      };

  return {
    host:     process.env.DB_HOST || base.host || 'localhost',
    port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : (base.port || 3306),
    user:     process.env.DB_USER || base.user || 'root',
    password: process.env.DB_PASSWORD || base.password || '',
    database: process.env.DB_NAME || base.database || 'ETaxes2_0',
  };
};

const dbConfig = resolveDbConfig();

const pool = mysql.createPool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
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
