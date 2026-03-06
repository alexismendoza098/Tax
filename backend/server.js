require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const pool = require('./db');
const { cleanupOnStartup } = require('./utils/fiel-cleanup');
const authRoutes = require('./routes/auth');
const contribuyentesRoutes = require('./routes/contribuyentes');
const comprobantesRoutes = require('./routes/comprobantes');
const uploadRoutes = require('./routes/upload');
const calculoRoutes = require('./routes/calculo');
const reportesRoutes = require('./routes/reportes');
const satRoutes = require('./routes/sat');
const flattenRoutes = require('./routes/flatten');
const usersRoutes = require('./routes/users');
const auditoriaRoutes = require('./routes/auditoria');
const adminRoutes = require('./routes/admin');
const fiscalRoutes            = require('./routes/fiscal');
const estadosCuentaRoutes     = require('./routes/estados-cuenta');
const papeleraRoutes          = require('./routes/papelera');
const diotRoutes              = require('./routes/diot');
const isrRoutes               = require('./routes/isr');
const contabilidadRoutes      = require('./routes/contabilidad');
const activosRoutes           = require('./routes/activos');
const estadosFinancierosRoutes = require('./routes/estados-financieros');
const validacionRoutes         = require('./routes/validacion');
const dashboardRoutes          = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// CORS — lee orígenes permitidos desde .env
//
// FRONTEND_URL puede contener múltiples URLs separadas
// por coma: FRONTEND_URL=https://mi-app.com,https://www.mi-app.com
//
// En desarrollo local siempre se permiten localhost:80/3000.
// En cloud agrega tu dominio en la variable de entorno.
// =====================================================
const BASE_ORIGINS = [
  'http://localhost',
  'http://localhost:80',
  'http://127.0.0.1',
  'http://127.0.0.1:80',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

// Lee FRONTEND_URL del .env y agrega cada URL a la lista
const envOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...BASE_ORIGINS, ...envOrigins])];

console.log('[CORS] Orígenes permitidos:', allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // Sin origen (curl, Postman, same-origin, SSR) → siempre permitir
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    console.warn(`[CORS] Bloqueado: ${origin}`);
    return callback(new Error(`CORS: origen no permitido — ${origin}`), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200,
};

// Handle preflight OPTIONS for all routes FIRST
app.options('*', cors(corsOptions));
// Apply CORS to all routes
app.use(cors(corsOptions));

// Security Middleware (AFTER CORS to avoid header conflicts)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,   // Allow cross-origin resource sharing
  crossOriginOpenerPolicy: false,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Rate limiter estricto para endpoints de autenticación (anti fuerza bruta)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  message: { error: 'Demasiados intentos. Espera 15 minutos antes de intentar de nuevo.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// Serve static frontend
app.use(express.static(path.join(__dirname, '..')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/contribuyentes', contribuyentesRoutes);
app.use('/api/comprobantes', comprobantesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/calculo-iva', calculoRoutes);
app.use('/api/reportes', reportesRoutes);
app.use('/api/sat', satRoutes);
app.use('/api/flatten', flattenRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/auditoria', auditoriaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/fiscal', fiscalRoutes);
app.use('/api/estados-cuenta', estadosCuentaRoutes);
app.use('/api/papelera', papeleraRoutes);
app.use('/api/diot', diotRoutes);
app.use('/api/isr', isrRoutes);
app.use('/api/contabilidad', contabilidadRoutes);
app.use('/api/activos', activosRoutes);
app.use('/api/estados-financieros', estadosFinancierosRoutes);
app.use('/api/validacion', validacionRoutes);
app.use('/api/dashboard', dashboardRoutes);

// =====================================================
// HEALTH CHECK — incluye estado de DB, uptime, memoria
// No requiere auth; lo usa el frontend cada ~30s
// =====================================================
app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'ok';
  } catch (e) {
    dbStatus = 'error';
  }
  res.json({
    status: 'ok',
    ts: Date.now(),
    db: dbStatus,
    uptime: Math.round(process.uptime()),
    memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
    pid: process.pid,
  });
});

// Root route serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// =====================================================
// INICIO DEL SERVIDOR — guarda referencia para shutdown
// =====================================================
const server = app.listen(PORT, () => {
  console.log(`[ETaxes+] ✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`[ETaxes+] PID: ${process.pid} | NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  // Limpiar archivos FIEL de sesiones anteriores (seguridad)
  cleanupOnStartup();
});

// =====================================================
// GRACEFUL SHUTDOWN — maneja SIGTERM (Docker/cloud) y
// SIGINT (Ctrl+C local). Cierra HTTP + DB pool limpio.
// PM2 envía SIGINT por defecto antes de matar el proceso.
// =====================================================
const shutdown = (signal) => {
  console.log(`\n[${signal}] Apagando servidor limpiamente...`);
  server.close(() => {
    console.log('[Shutdown] 🔌 HTTP server cerrado.');
    pool.end().then(() => {
      console.log('[Shutdown] 🗄️  DB pool cerrado. ¡Hasta luego!');
      process.exit(0);
    }).catch(() => process.exit(0));
  });
  // Si en 10s no terminó, forzar salida (PM2 reiniciará)
  setTimeout(() => {
    console.error('[Shutdown] ⚠️  Forzando salida después de 10s...');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// =====================================================
// PROTECCIÓN ANTI-CRASH — captura errores no manejados
// sin matar el proceso (PM2/nodemon los recupera igual)
// =====================================================
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] uncaughtException — ${err.message}`);
  console.error(err.stack);
  // No llamar process.exit() aquí — el servidor sigue en pie
  // PM2 con max_restarts se encargará si el proceso queda corrupto
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
