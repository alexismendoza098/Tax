#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         ETaxes+ — AGENTE PODEROSO v2.0                         ║
 * ║  Auditoría · Corrección · Generación · Pruebas · Diagnóstico   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Uso:
 *   node scripts/agent.js              → Todo (audit + db + tests)
 *   node scripts/agent.js --audit      → Solo auditoría de código
 *   node scripts/agent.js --fix        → Corregir errores automáticamente
 *   node scripts/agent.js --improve    → Crear utilidades de mejora
 *   node scripts/agent.js --generate   → Generar nuevas rutas/features
 *   node scripts/agent.js --test       → Pruebas HTTP de endpoints
 *   node scripts/agent.js --db         → Diagnóstico de base de datos
 *   node scripts/agent.js --full       → Todo + correcciones + mejoras
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

// ─── COLORES ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};
const red    = s => C.red    + s + C.reset;
const green  = s => C.green  + s + C.reset;
const yellow = s => C.yellow + s + C.reset;
const cyan   = s => C.cyan   + s + C.reset;
const bold   = s => C.bold   + s + C.reset;
const dim    = s => C.dim    + s + C.reset;

// ─── MODO ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const full = args.includes('--full');
const MODE = {
  audit:    full || args.includes('--audit')    || args.length === 0,
  fix:      full || args.includes('--fix'),
  improve:  full || args.includes('--improve'),
  generate: full || args.includes('--generate'),
  test:     full || args.includes('--test')     || args.length === 0,
  db:       full || args.includes('--db')       || args.length === 0,
};

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const HOST = `http://localhost:${PORT}`;

// ─── REPORTE GLOBAL ───────────────────────────────────────────────────────────
const report = {
  audit:    { issues: [], scanned: 0, lines: 0 },
  fixes:    { applied: [], skipped: [] },
  improved: [],
  generated:[],
  tests:    { passed: 0, failed: 0, errors: [] },
  db:       { status: 'unknown' },
  started:  Date.now(),
};

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 1: AUDITORÍA
// ══════════════════════════════════════════════════════════════════════════════
function runAudit() {
  const SKIP = [path.basename(__filename), 'audit.js'];
  const DIRS = ['routes', 'utils', 'middleware'].map(d => path.join(ROOT, d));

  function scan(fullPath) {
    const rel = path.relative(ROOT, fullPath);
    const src = fs.readFileSync(fullPath, 'utf8');
    const lines = src.split('\n');
    report.audit.scanned++;
    report.audit.lines += lines.length;

    lines.forEach((line, idx) => {
      const i = idx + 1;
      const add = (sev, type, msg) => report.audit.issues.push({ file: rel, line: i, severity: sev, type, msg });

      if (/pool\.query\s*\(/.test(line) && /\+\s*(req\.|body\.|params\.|query\.)/.test(line))
        add('CRITICAL', 'SQL_INJECT', 'SQL concatenado con input: ' + line.trim().slice(0, 80));
      if (/\beval\s*\([^)]*\)/.test(line) && !/\/\//.test(line.split('eval')[0]))
        add('CRITICAL', 'SECURITY', 'eval() en producción: ' + line.trim().slice(0, 80));
      if (/exec\s*\(/.test(line) && /\+\s*(req\.|body\.|params\.)/.test(line))
        add('CRITICAL', 'CMD_INJECT', 'Command injection riesgo: ' + line.trim().slice(0, 80));
      if (/res\.(send|json)\s*\(\s*req\.(body|query|params)/.test(line))
        add('HIGH', 'XSS', 'Input sin sanitizar en respuesta: ' + line.trim().slice(0, 80));
      if (/console\.log\s*\(/.test(line) && /password/.test(line) && !/error/i.test(line))
        add('HIGH', 'DATA_LEAK', 'console.log con password: ' + line.trim().slice(0, 80));
      // Bare catch{} sin comentario que explique por qué se silencia
      if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line) && !/\/\*/.test(line))
        add('MEDIUM', 'BARE_CATCH', 'Bare catch{} silencia error: ' + line.trim().slice(0, 80));
      if (/\b(TODO|FIXME|HACK)\b/.test(line))
        add('LOW', 'TODO', line.trim().slice(0, 80));
    });
  }

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      if (['node_modules', '__pycache__', '.git'].includes(e)) continue;
      const full = path.join(dir, e);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (e.endsWith('.js') && !SKIP.includes(e)) scan(full);
    }
  }
  DIRS.forEach(walk);

  // ENV vars críticas
  ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'JWT_SECRET', 'PORT'].forEach(v => {
    if (!process.env[v])
      report.audit.issues.push({ file: '.env', line: 0, severity: 'CRITICAL', type: 'CONFIG', msg: `Variable faltante: ${v}` });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 2: AUTO-CORRECCIÓN DE ERRORES
// ══════════════════════════════════════════════════════════════════════════════
const FIX_RULES = [
  // ── Bare catch en limpieza de archivos (intentional, pero añadir comentario)
  {
    id: 'cleanup-catch',
    description: 'Bare catch en limpieza de archivos temporales → añadir comentario explícito',
    files: ['routes/flatten.js', 'routes/sat/downloads.js'],
    find: /try \{ fs\.unlinkSync\(([^)]+)\); \} catch\([^)]*\) \{\}/g,
    replace: (m, p1) => `try { fs.unlinkSync(${p1}); } catch (_) { /* cleanup-temp: no bloquear respuesta */ }`,
  },
  {
    id: 'upload-cleanup-catch',
    description: 'Bare catch en limpieza de archivos upload → añadir comentario explícito',
    files: ['routes/upload.js'],
    find: /try \{ fs\.unlinkSync\(([^)]+)\); \} catch \(_\) \{\}/g,
    replace: (m, p1) => `try { fs.unlinkSync(${p1}); } catch (_) { /* cleanup-upload: no bloquear respuesta */ }`,
  },
  {
    id: 'json-parse-catch',
    description: 'Bare catch en JSON.parse → añadir console.warn para visibilidad',
    files: ['routes/flatten.js'],
    find: /\} catch \(e\) \{\}\s*\n(\s*}\);)/,
    replace: (m, p1) => `} catch (e) { console.warn('[flatten] JSON parse error:', e.message); }\n${p1}`,
  },
  // ── Validación faltante en POST /contabilidad/catalogo
  {
    id: 'contabilidad-validation',
    description: 'Añadir validación de campos requeridos en POST /catalogo',
    files: ['routes/contabilidad.js'],
    find: /const \{ numero_cuenta, descripcion, naturaleza, tipo, sub_tipo, nivel,\s*\n\s*cuenta_padre_id, codigo_agrupador \} = req\.body;/,
    replace: `const { numero_cuenta, descripcion, naturaleza, tipo, sub_tipo, nivel,
            cuenta_padre_id, codigo_agrupador } = req.body;
    if (!numero_cuenta || !descripcion || !naturaleza || !tipo) {
      return res.status(400).json({ error: 'Campos requeridos: numero_cuenta, descripcion, naturaleza, tipo' });
    }
    if (!['D','A'].includes(naturaleza)) {
      return res.status(400).json({ error: 'naturaleza debe ser D (Deudora) o A (Acreedora)' });
    }`,
  },
  // ── Validación faltante en PUT /contabilidad/catalogo
  {
    id: 'contabilidad-put-validation',
    description: 'Añadir validación de campos requeridos en PUT /catalogo/:id',
    files: ['routes/contabilidad.js'],
    find: /const \{ descripcion, naturaleza, tipo, sub_tipo, codigo_agrupador, activa \} = req\.body;\s*\n\s*await pool\.query/,
    replace: `const { descripcion, naturaleza, tipo, sub_tipo, codigo_agrupador, activa } = req.body;
    if (!descripcion || !naturaleza || !tipo) {
      return res.status(400).json({ error: 'Campos requeridos: descripcion, naturaleza, tipo' });
    }
    await pool.query`,
  },
  // ── ISR: validar campos requeridos en POST /isr/calcular
  {
    id: 'isr-calc-validation',
    description: 'Añadir validación de año/mes en POST /isr/calcular',
    files: ['routes/isr.js'],
    find: /router\.post\('\/calcular', authMiddleware, async \(req, res\) => \{\s*\n\s*try \{/,
    replace: `router.post('/calcular', authMiddleware, async (req, res) => {
  try {
    const { year, mes } = req.body;
    if (!year || !mes) return res.status(400).json({ error: 'year y mes son requeridos' });
    const y = parseInt(year), m = parseInt(mes);
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12 || y < 2000 || y > 2100)
      return res.status(400).json({ error: 'year (ej. 2024) y mes (1-12) deben ser números válidos' });`,
  },
];

function applyFix(rule) {
  let fixedCount = 0;
  for (const relFile of rule.files) {
    const filePath = path.join(ROOT, relFile);
    if (!fs.existsSync(filePath)) continue;

    const original = fs.readFileSync(filePath, 'utf8');
    let modified = original;

    if (typeof rule.replace === 'function') {
      modified = modified.replace(rule.find, rule.replace);
    } else {
      modified = modified.replace(rule.find, rule.replace);
    }

    if (modified === original) {
      report.fixes.skipped.push({ id: rule.id, file: relFile, reason: 'patrón no encontrado' });
      continue;
    }

    // Verificar sintaxis antes de escribir
    const tmpFile = filePath + '.agent_tmp';
    fs.writeFileSync(tmpFile, modified, 'utf8');
    try {
      execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
      fs.writeFileSync(filePath, modified, 'utf8');
      report.fixes.applied.push({ id: rule.id, file: relFile, description: rule.description });
      fixedCount++;
    } catch (syntaxErr) {
      report.fixes.skipped.push({ id: rule.id, file: relFile, reason: 'sintaxis inválida tras el fix: ' + syntaxErr.message.slice(0, 80) });
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
  return fixedCount;
}

function runFixes() {
  for (const rule of FIX_RULES) {
    applyFix(rule);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 3: MEJORAS — CREAR UTILIDADES
// ══════════════════════════════════════════════════════════════════════════════
const IMPROVEMENTS = [
  {
    id: 'respond-helper',
    file: 'utils/respond.js',
    description: 'Helper de respuestas API estandarizadas',
    content: `/**
 * ETaxes+ — Respuestas API estandarizadas
 * Generado por el Agente v2
 *
 * Uso:
 *   const { ok, fail, paginate } = require('../utils/respond');
 *   ok(res, { data })
 *   fail(res, 400, 'Mensaje de error')
 *   paginate(res, rows, total, page, limit)
 */

/** 200 OK con data */
exports.ok = (res, data = {}) =>
  res.json({ success: true, ...data });

/** Error con código HTTP y mensaje */
exports.fail = (res, status, message, extra = {}) =>
  res.status(status).json({ error: message, ...extra });

/** 201 Created */
exports.created = (res, data = {}) =>
  res.status(201).json({ success: true, ...data });

/** Respuesta paginada */
exports.paginate = (res, rows, total, page, limit) =>
  res.json({
    data: rows,
    pagination: {
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / limit),
    },
  });

/** 204 No Content (para DELETE exitoso) */
exports.noContent = (res) => res.status(204).end();

/** Error interno estandarizado (500) */
exports.serverError = (res, err, context = '') => {
  const msg = err?.message || String(err);
  if (context) console.error(\`[ETaxes+ ERROR] \${context}:\`, msg);
  return res.status(500).json({ error: 'Error interno del servidor' });
};
`,
  },
  {
    id: 'validate-helper',
    file: 'utils/validate.js',
    description: 'Validación de inputs fiscales (RFC, CURP, fechas, montos)',
    content: `/**
 * ETaxes+ — Validadores de inputs fiscales
 * Generado por el Agente v2
 *
 * Uso:
 *   const { validarRFC, validarRango, validarMonto } = require('../utils/validate');
 */

// ── RFC ──────────────────────────────────────────────────────────────────────
/** Valida RFC de Persona Moral (12 caracteres) o Física (13 caracteres) */
exports.validarRFC = (rfc) => {
  if (!rfc || typeof rfc !== 'string') return false;
  const clean = rfc.trim().toUpperCase();
  // PM: 3 letras + 6 dígitos fecha + 3 homoclave
  const PM = /^[A-ZÑ&]{3}\d{6}[A-Z0-9]{3}$/;
  // PF: 4 letras + 6 dígitos fecha + 3 homoclave
  const PF = /^[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}$/;
  return PM.test(clean) || PF.test(clean);
};

// ── Rango de fechas ───────────────────────────────────────────────────────────
/**
 * Valida rango de fechas.
 * @returns { valid: bool, error?: string, start?: Date, end?: Date }
 */
exports.validarRango = (inicio, fin) => {
  if (!inicio || !fin) return { valid: false, error: 'fecha_inicio y fecha_fin son requeridas' };
  const s = new Date(inicio);
  const e = new Date(fin);
  if (isNaN(s.getTime())) return { valid: false, error: \`fecha_inicio inválida: \${inicio}\` };
  if (isNaN(e.getTime())) return { valid: false, error: \`fecha_fin inválida: \${fin}\` };
  if (s > e) return { valid: false, error: 'fecha_inicio debe ser anterior a fecha_fin' };
  const diffDays = (e - s) / 86400000;
  if (diffDays > 366) return { valid: false, error: 'El rango máximo permitido es 366 días' };
  return { valid: true, start: s, end: e };
};

// ── Monto ──────────────────────────────────────────────────────────────────────
/** Valida que un monto sea numérico no negativo */
exports.validarMonto = (val, campo = 'monto') => {
  const n = parseFloat(val);
  if (isNaN(n)) return { valid: false, error: \`\${campo} debe ser un número\` };
  if (n < 0)    return { valid: false, error: \`\${campo} no puede ser negativo\` };
  return { valid: true, value: n };
};

// ── Año/Mes ───────────────────────────────────────────────────────────────────
/** Valida año (2000-2100) y mes (1-12) */
exports.validarPeriodo = (year, mes) => {
  const y = parseInt(year);
  const m = parseInt(mes);
  if (isNaN(y) || y < 2000 || y > 2100) return { valid: false, error: \`Año inválido: \${year}\` };
  if (isNaN(m) || m < 1 || m > 12)       return { valid: false, error: \`Mes inválido: \${mes} (debe ser 1-12)\` };
  return { valid: true, year: y, mes: m };
};

// ── UUID CFDI ─────────────────────────────────────────────────────────────────
/** Valida formato UUID (36 caracteres, guiones en posiciones correctas) */
exports.validarUUID = (uuid) => {
  if (!uuid || typeof uuid !== 'string') return false;
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(uuid.trim());
};

// ── Paginación ────────────────────────────────────────────────────────────────
/** Parsea y valida parámetros de paginación de la query string */
exports.parsePagination = (query, defaultLimit = 50) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(500, Math.max(1, parseInt(query.limit) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};
`,
  },
  {
    id: 'async-handler',
    file: 'middleware/asyncHandler.js',
    description: 'Wrapper para rutas async — elimina try-catch repetitivo',
    content: `/**
 * ETaxes+ — asyncHandler middleware
 * Generado por el Agente v2
 *
 * Envuelve funciones async de Express para capturar errores automáticamente
 * y pasarlos al error handler global (next(err)).
 *
 * Uso ANTES (repetitivo):
 *   router.get('/ruta', authMiddleware, async (req, res) => {
 *     try {
 *       const data = await pool.query(...);
 *       res.json(data);
 *     } catch (e) {
 *       res.status(500).json({ error: e.message });
 *     }
 *   });
 *
 * Uso DESPUÉS (limpio):
 *   const wrap = require('../middleware/asyncHandler');
 *   router.get('/ruta', authMiddleware, wrap(async (req, res) => {
 *     const data = await pool.query(...);
 *     res.json(data);
 *   }));
 */

/**
 * @param {Function} fn - función async (req, res, next) => Promise<void>
 * @returns {Function} middleware de Express con manejo automático de errores
 */
module.exports = function asyncHandler(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error(\`[AsyncHandler] \${req.method} \${req.originalUrl}: \${err.message}\`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error interno del servidor' });
      }
    });
  };
};
`,
  },
  {
    id: 'db-helpers',
    file: 'utils/dbHelpers.js',
    description: 'Helpers de base de datos: paginación, exists check, conteo',
    content: `/**
 * ETaxes+ — DB Helpers
 * Generado por el Agente v2
 *
 * Funciones de utilidad para consultas comunes a MySQL.
 */
const pool = require('../db');

/**
 * Consulta paginada.
 * @param {string} sql   - SQL sin LIMIT/OFFSET
 * @param {Array}  params - parámetros del WHERE
 * @param {number} page   - página (1-indexed)
 * @param {number} limit  - registros por página
 * @returns {{ rows, total, pages, page, limit }}
 */
exports.queryPaginated = async (sql, params = [], page = 1, limit = 50) => {
  const offset   = (page - 1) * limit;
  const countSql = \`SELECT COUNT(*) AS n FROM (\${sql}) AS _t\`;
  const [[{ n }]]= await pool.query(countSql, params);
  const [rows]   = await pool.query(\`\${sql} LIMIT ? OFFSET ?\`, [...params, limit, offset]);
  return { rows, total: n, pages: Math.ceil(n / limit), page, limit };
};

/**
 * Verificar si un registro existe.
 * @param {string} table - nombre de la tabla
 * @param {string} col   - columna a comparar
 * @param {*}      val   - valor a buscar
 * @returns {boolean}
 */
exports.exists = async (table, col, val) => {
  const [[{ n }]] = await pool.query(
    \`SELECT COUNT(*) AS n FROM \\\`\${table}\\\` WHERE \\\`\${col}\\\` = ? LIMIT 1\`,
    [val]
  );
  return n > 0;
};

/**
 * Obtener contribuyente_id del usuario (patrón repetido en todo el sistema).
 * @param {number} userId - req.user.id
 * @param {string} [rfc]  - RFC opcional para filtrar
 * @returns {object|null} { id, rfc, nombre } o null
 */
exports.getContrib = async (userId, rfc) => {
  let q = 'SELECT id, rfc, nombre FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc.toUpperCase()); }
  else q += ' ORDER BY id LIMIT 1';
  const [rows] = await pool.query(q, p);
  return rows[0] || null;
};

/**
 * Construir cláusula WHERE de fecha para comprobantes.
 * @param {string} year - año o 'todos'
 * @param {string} mes  - mes o 'todos'
 * @param {string} [prefix] - alias de tabla (default 'c')
 * @returns {{ sql: string, params: Array }}
 */
exports.buildDateFilter = (year, mes, prefix = 'c') => {
  const parts = [], params = [];
  if (year && year !== 'todos') { parts.push(\`YEAR(\${prefix}.fecha) = ?\`); params.push(parseInt(year)); }
  if (mes  && mes  !== 'todos') { parts.push(\`MONTH(\${prefix}.fecha) = ?\`); params.push(parseInt(mes)); }
  return { sql: parts.length ? 'AND ' + parts.join(' AND ') : '', params };
};
`,
  },
];

function runImprovements() {
  for (const imp of IMPROVEMENTS) {
    const filePath = path.join(ROOT, imp.file);
    if (fs.existsSync(filePath)) {
      report.improved.push({ id: imp.id, file: imp.file, status: 'ya existe — omitido' });
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, imp.content, 'utf8');
    report.improved.push({ id: imp.id, file: imp.file, status: 'creado ✓', description: imp.description });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 4: GENERAR NUEVAS RUTAS/FEATURES
// ══════════════════════════════════════════════════════════════════════════════
function generateDashboardRoute() {
  const file = path.join(ROOT, 'routes', 'dashboard.js');
  if (fs.existsSync(file)) {
    report.generated.push({ id: 'dashboard', file: 'routes/dashboard.js', status: 'ya existe — omitido' });
    return;
  }

  const content = `/**
 * ================================================================
 * DASHBOARD EJECUTIVO — ETaxes+ Agente v2
 * ================================================================
 * Endpoint único que agrega KPIs fiscales de todo el sistema.
 * Ideal para la pantalla de inicio/resumen del usuario.
 *
 * GET /api/dashboard          — Resumen completo del contribuyente
 * GET /api/dashboard/alertas  — Alertas fiscales activas
 * GET /api/dashboard/timeline — Actividad reciente (últimos 30 días)
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { ok, fail, serverError } = require('../utils/respond');
const { getContrib } = require('../utils/dbHelpers');

// ── GET /api/dashboard ────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContrib(req.user.id, req.query.rfc);
    if (!contrib) return fail(res, 404, 'Contribuyente no encontrado. Regístralo primero.');

    const cid = contrib.id;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // Ejecutar consultas en paralelo para máximo rendimiento
    const [
      [cfdiStats],
      [ivaStats],
      [polizasStats],
      [activosStats],
      [alertasStats],
      [solicitudesStats],
    ] = await Promise.all([
      // 1. Estadísticas de CFDIs
      pool.query(\`
        SELECT
          COUNT(*) AS total_cfdis,
          COUNT(CASE WHEN tipo_de_comprobante = 'I' THEN 1 END) AS ingresos,
          COUNT(CASE WHEN tipo_de_comprobante = 'E' THEN 1 END) AS egresos,
          COUNT(CASE WHEN tipo_de_comprobante = 'P' THEN 1 END) AS pagos,
          COUNT(CASE WHEN tipo_de_comprobante = 'N' THEN 1 END) AS nomina,
          SUM(CASE WHEN tipo_de_comprobante = 'I' THEN total ELSE 0 END) AS monto_ingresos,
          SUM(CASE WHEN tipo_de_comprobante = 'E' THEN total ELSE 0 END) AS monto_egresos,
          COUNT(CASE WHEN estado = 'Cancelado' THEN 1 END) AS cancelados
        FROM comprobantes
        WHERE contribuyente_id = ? AND YEAR(fecha) = ?
      \`, [cid, year]),

      // 2. Resumen IVA
      pool.query(\`
        SELECT
          SUM(iva_trasladado_pue + iva_trasladado_ppd) AS iva_cobrado,
          SUM(iva_acreditable_pue + iva_acreditable_ppd) AS iva_pagado,
          SUM(saldo_iva) AS saldo_a_pagar
        FROM reportes_iva
        WHERE contribuyente_id = ? AND periodo_year = ?
      \`, [cid, year]),

      // 3. Pólizas contables
      pool.query(\`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN tipo_poliza = 'I' THEN 1 END) AS ingresos,
          COUNT(CASE WHEN tipo_poliza = 'E' THEN 1 END) AS egresos,
          COUNT(CASE WHEN tipo_poliza = 'D' THEN 1 END) AS diario
        FROM polizas
        WHERE contribuyente_id = ? AND ejercicio = ?
      \`, [cid, year]).catch(() => [[{ total: 0, ingresos: 0, egresos: 0, diario: 0 }]]),

      // 4. Activos fijos
      pool.query(\`
        SELECT
          COUNT(*) AS total,
          SUM(costo_adquisicion) AS valor_original,
          SUM(depreciacion_acumulada) AS depreciacion_acumulada,
          SUM(valor_en_libros) AS valor_libros
        FROM activos_fijos
        WHERE contribuyente_id = ? AND activo = 1
      \`, [cid]).catch(() => [[{ total: 0, valor_original: 0, depreciacion_acumulada: 0, valor_libros: 0 }]]),

      // 5. Alertas fiscales activas
      pool.query(\`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN severidad = 'critica' THEN 1 END) AS criticas,
          COUNT(CASE WHEN severidad = 'alta' THEN 1 END) AS altas
        FROM alertas_fiscales
        WHERE contribuyente_id = ? AND resuelta = 0
      \`, [cid]).catch(() => [[{ total: 0, criticas: 0, altas: 0 }]]),

      // 6. Solicitudes SAT
      pool.query(\`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN estado_solicitud = 'Terminada' THEN 1 END) AS completadas,
          COUNT(CASE WHEN estado_solicitud IN ('Aceptada','EnProceso','Aceptada') THEN 1 END) AS en_proceso,
          MAX(fecha_solicitud) AS ultima_solicitud
        FROM solicitudes_sat
        WHERE rfc = ?
      \`, [contrib.rfc]),
    ]);

    ok(res, {
      contribuyente: {
        id:     contrib.id,
        rfc:    contrib.rfc,
        nombre: contrib.nombre,
      },
      periodo: year,
      cfdis: {
        total:          cfdiStats[0]?.total_cfdis    || 0,
        ingresos:       cfdiStats[0]?.ingresos       || 0,
        egresos:        cfdiStats[0]?.egresos        || 0,
        pagos:          cfdiStats[0]?.pagos          || 0,
        nomina:         cfdiStats[0]?.nomina         || 0,
        monto_ingresos: parseFloat(cfdiStats[0]?.monto_ingresos || 0),
        monto_egresos:  parseFloat(cfdiStats[0]?.monto_egresos  || 0),
        cancelados:     cfdiStats[0]?.cancelados     || 0,
      },
      iva: {
        cobrado:     parseFloat(ivaStats[0]?.iva_cobrado   || 0),
        pagado:      parseFloat(ivaStats[0]?.iva_pagado    || 0),
        saldo_pagar: parseFloat(ivaStats[0]?.saldo_a_pagar || 0),
      },
      contabilidad: {
        polizas:         polizasStats[0]?.total     || 0,
        polizas_ingreso: polizasStats[0]?.ingresos  || 0,
        polizas_egreso:  polizasStats[0]?.egresos   || 0,
        polizas_diario:  polizasStats[0]?.diario    || 0,
      },
      activos: {
        total:                 activosStats[0]?.total                 || 0,
        valor_original:        parseFloat(activosStats[0]?.valor_original       || 0),
        depreciacion_acumulada:parseFloat(activosStats[0]?.depreciacion_acumulada|| 0),
        valor_libros:          parseFloat(activosStats[0]?.valor_libros          || 0),
      },
      alertas: {
        total:   alertasStats[0]?.total   || 0,
        criticas:alertasStats[0]?.criticas|| 0,
        altas:   alertasStats[0]?.altas   || 0,
      },
      sat: {
        solicitudes:      solicitudesStats[0]?.total           || 0,
        completadas:      solicitudesStats[0]?.completadas     || 0,
        en_proceso:       solicitudesStats[0]?.en_proceso      || 0,
        ultima_solicitud: solicitudesStats[0]?.ultima_solicitud|| null,
      },
    });
  } catch (e) {
    serverError(res, e, 'Dashboard');
  }
});

// ── GET /api/dashboard/alertas ────────────────────────────────────────────────
router.get('/alertas', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContrib(req.user.id, req.query.rfc);
    if (!contrib) return fail(res, 404, 'Contribuyente no encontrado');

    const [rows] = await pool.query(\`
      SELECT tipo, severidad, descripcion, monto, fecha_alerta, referencia_id
      FROM alertas_fiscales
      WHERE contribuyente_id = ? AND resuelta = 0
      ORDER BY
        FIELD(severidad, 'critica','alta','media','baja'),
        fecha_alerta DESC
      LIMIT 50
    \`, [contrib.id]);

    ok(res, { alertas: rows, total: rows.length });
  } catch (e) {
    serverError(res, e, 'Dashboard Alertas');
  }
});

// ── GET /api/dashboard/timeline ───────────────────────────────────────────────
router.get('/timeline', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContrib(req.user.id, req.query.rfc);
    if (!contrib) return fail(res, 404, 'Contribuyente no encontrado');

    // Actividad de los últimos 30 días
    const [rows] = await pool.query(\`
      SELECT
        DATE(fecha) AS dia,
        COUNT(*) AS cfdis,
        SUM(CASE WHEN tipo_de_comprobante = 'I' THEN total ELSE 0 END) AS ingresos,
        SUM(CASE WHEN tipo_de_comprobante = 'E' THEN total ELSE 0 END) AS egresos
      FROM comprobantes
      WHERE contribuyente_id = ?
        AND fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY DATE(fecha)
      ORDER BY dia ASC
    \`, [contrib.id]);

    ok(res, { timeline: rows, dias: rows.length });
  } catch (e) {
    serverError(res, e, 'Dashboard Timeline');
  }
});

module.exports = router;
`;

  fs.writeFileSync(file, content, 'utf8');
  report.generated.push({
    id: 'dashboard',
    file: 'routes/dashboard.js',
    status: 'creado ✓',
    description: 'Dashboard ejecutivo con KPIs fiscales (CFDIs, IVA, pólizas, activos, alertas)',
  });
}

function registerDashboardRoute() {
  const serverFile = path.join(ROOT, 'server.js');
  const src = fs.readFileSync(serverFile, 'utf8');
  if (src.includes("require('./routes/dashboard')")) return; // ya registrado

  // Insertar require
  const modified = src
    .replace(
      "const validacionRoutes         = require('./routes/validacion');",
      "const validacionRoutes         = require('./routes/validacion');\nconst dashboardRoutes          = require('./routes/dashboard');"
    )
    .replace(
      "app.use('/api/validacion', validacionRoutes);",
      "app.use('/api/validacion', validacionRoutes);\napp.use('/api/dashboard', dashboardRoutes);"
    );

  if (modified === src) return; // patrón no encontrado, no modificar
  fs.writeFileSync(serverFile, modified, 'utf8');
  report.generated.push({
    id: 'dashboard-register',
    file: 'server.js',
    status: 'actualizado ✓',
    description: 'Ruta /api/dashboard registrada en server.js',
  });
}

function runGenerate() {
  generateDashboardRoute();
  registerDashboardRoute();
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 5: PRUEBAS HTTP
// ══════════════════════════════════════════════════════════════════════════════
async function httpReq(method, url, payload) {
  return new Promise((resolve) => {
    const data = payload ? JSON.stringify(payload) : null;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    };
    const timeout = setTimeout(() => resolve({ status: 0, body: null, error: 'timeout' }), 5000);
    const parsed = new URL(url);
    const req = http.request({ ...opts, host: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search }, res => {
      clearTimeout(timeout);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body), error: null }); }
        catch { resolve({ status: res.statusCode, body, error: null }); }
      });
    });
    req.on('error', err => { clearTimeout(timeout); resolve({ status: 0, body: null, error: err.message }); });
    if (data) req.write(data);
    req.end();
  });
}

function pass(name) { report.tests.passed++; console.log(`  ${green('✓')} ${name}`); }
function fail(name, detail) { report.tests.failed++; report.tests.errors.push({ name, detail }); console.log(`  ${red('✗')} ${name} ${dim('→ ' + detail)}`); }

async function runTests() {
  console.log(bold('\n📡 Pruebas de endpoints HTTP...\n'));

  const health = await httpReq('GET', `${HOST}/api/health`);
  if (health.error) {
    fail('Health check', `Servidor no responde: ${health.error}. Iniciar con: npm start`);
    return;
  }
  if (health.status === 200 && health.body?.status === 'ok')
    pass(`Health check (DB:${health.body?.db}, uptime:${health.body?.uptime}s, mem:${health.body?.memory})`);
  else fail('Health check', `HTTP ${health.status}`);

  // Auth
  const r400 = await httpReq('POST', `${HOST}/api/auth/register`, {});
  if (r400.status === 400) pass('Auth register — valida campos requeridos (400)');
  else fail('Auth register — validación', `Esperado 400, recibido ${r400.status}`);

  const r401 = await httpReq('POST', `${HOST}/api/auth/login`, { username: '__no_existe__', password: 'x' });
  if (r401.status === 401) pass('Auth login — credenciales inválidas (401)');
  else fail('Auth login — credenciales inválidas', `Esperado 401, recibido ${r401.status}`);

  // Rutas protegidas sin token
  for (const route of ['/api/contribuyentes', '/api/comprobantes', '/api/dashboard', '/api/users']) {
    const r = await httpReq('GET', `${HOST}${route}`);
    if (r.status === 401) pass(`Protegida sin token → 401: ${route}`);
    else fail(`Protegida sin token: ${route}`, `Esperado 401, recibido ${r.status}`);
  }

  // Validaciones nuevas (contabilidad POST sin campos)
  const rCat = await httpReq('GET', `${HOST}/api/contabilidad/catalogo`);
  if (rCat.status === 401) pass('Contabilidad catalogo — autenticación requerida (401)');
  else fail('Contabilidad catalogo', `Esperado 401, recibido ${rCat.status}`);

  // Dashboard
  const rDash = await httpReq('GET', `${HOST}/api/dashboard`);
  if (rDash.status === 401) pass('Dashboard — autenticación requerida (401)');
  else fail('Dashboard', `Esperado 401, recibido ${rDash.status}`);

  // Frontend estático
  const rIdx = await httpReq('GET', `${HOST}/`);
  if (rIdx.status === 200) pass('Frontend index.html → 200');
  else fail('Frontend index.html', `HTTP ${rIdx.status}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO 6: DIAGNÓSTICO DB
// ══════════════════════════════════════════════════════════════════════════════
async function runDbDiag() {
  let pool;
  try { pool = require('../db'); } catch (e) {
    report.db = { status: 'error', error: 'No se pudo cargar db.js: ' + e.message };
    return;
  }
  try {
    await pool.query('SELECT 1');
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(t => Object.values(t)[0]);
    const required = ['usuarios', 'contribuyentes', 'comprobantes', 'solicitudes_sat',
      'papelera', 'catalogo_cuentas', 'polizas', 'poliza_movimientos',
      'balanza_verificacion', 'activos_fijos', 'diot_proveedores'];
    const missing = required.filter(t => !tableNames.includes(t));
    const counts = {};
    for (const t of ['usuarios', 'contribuyentes', 'comprobantes']) {
      if (tableNames.includes(t)) {
        const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
        counts[t] = n;
      }
    }
    report.db = { status: 'ok', tables: tableNames.length, missing, counts };
  } catch (e) {
    report.db = { status: 'error', error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORTE FINAL
// ══════════════════════════════════════════════════════════════════════════════
function printReport() {
  const elapsed = ((Date.now() - report.started) / 1000).toFixed(2);
  const SEV = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  console.log('\n' + bold(cyan('╔══════════════════════════════════════════════════════════╗')));
  console.log(bold(cyan('║      ETaxes+ AGENTE v2 — REPORTE FINAL                   ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════════════════════╝')));

  // ── AUDITORÍA
  if (MODE.audit) {
    const issues = [...report.audit.issues].sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9));
    const bySev = {};
    issues.forEach(i => { (bySev[i.severity] = bySev[i.severity] || []).push(i); });
    console.log('\n' + bold('── AUDITORÍA ────────────────────────────────────────────────'));
    console.log(dim(`   ${report.audit.scanned} archivos · ${report.audit.lines.toLocaleString()} líneas`));
    if (bySev.CRITICAL?.length) { console.log(red(`\n  🚨 CRÍTICOS (${bySev.CRITICAL.length})`)); bySev.CRITICAL.forEach(i => console.log(red(`     [${i.type}] ${i.file}:${i.line} — ${i.msg}`))); }
    if (bySev.HIGH?.length)     { console.log(yellow(`\n  ⚠️  ALTOS (${bySev.HIGH.length})`)); bySev.HIGH.forEach(i => console.log(yellow(`     [${i.type}] ${i.file}:${i.line} — ${i.msg}`))); }
    if (bySev.MEDIUM?.length)   { console.log(`\n  📋 MEDIOS (${bySev.MEDIUM.length})`); bySev.MEDIUM.forEach(i => console.log(`     [${i.type}] ${i.file}:${i.line} — ${i.msg}`)); }
    if (bySev.LOW?.length)      { console.log(dim(`\n  📌 BAJOS (${bySev.LOW.length}) — primeros 3:`)); bySev.LOW.slice(0,3).forEach(i => console.log(dim(`     ${i.file}:${i.line} — ${i.msg}`))); }
    if (issues.length === 0) console.log(green('  ✅ Sin issues detectados'));
  }

  // ── CORRECCIONES
  if (MODE.fix) {
    console.log('\n' + bold('── CORRECCIONES APLICADAS ───────────────────────────────────'));
    if (report.fixes.applied.length === 0 && report.fixes.skipped.length === 0)
      console.log(dim('  Sin correcciones ejecutadas'));
    report.fixes.applied.forEach(f  => console.log(green(`  ✓ [${f.id}] ${f.file} — ${f.description}`)));
    report.fixes.skipped.forEach(f  => console.log(dim(`  ⊘ [${f.id}] ${f.file} — ${f.reason}`)));
  }

  // ── MEJORAS
  if (MODE.improve) {
    console.log('\n' + bold('── UTILIDADES CREADAS ───────────────────────────────────────'));
    report.improved.forEach(i => {
      const icon = i.status.includes('✓') ? green('✓') : dim('⊘');
      console.log(`  ${icon} ${cyan(i.file)} — ${i.status}`);
      if (i.description) console.log(dim(`     ${i.description}`));
    });
  }

  // ── GENERACIÓN
  if (MODE.generate) {
    console.log('\n' + bold('── CÓDIGO GENERADO ──────────────────────────────────────────'));
    report.generated.forEach(g => {
      const icon = g.status.includes('✓') ? green('✓') : dim('⊘');
      console.log(`  ${icon} ${cyan(g.file)} — ${g.status}`);
      if (g.description) console.log(dim(`     ${g.description}`));
    });
  }

  // ── DB
  if (MODE.db) {
    console.log('\n' + bold('── BASE DE DATOS ────────────────────────────────────────────'));
    if (report.db.status === 'ok') {
      console.log(green(`  ✅ Conexión OK — ${report.db.tables} tablas`));
      if (report.db.counts) Object.entries(report.db.counts).forEach(([t,n]) => console.log(dim(`     ${t}: ${n} registros`)));
      if (report.db.missing?.length) { console.log(red(`  ❌ Tablas faltantes: ${report.db.missing.join(', ')}`)); console.log(yellow('     Ejecutar: npm run migrate')); }
    } else console.log(red(`  ❌ DB Error: ${report.db.error}`));
  }

  // ── TESTS
  if (MODE.test) {
    const total = report.tests.passed + report.tests.failed;
    const pct = total > 0 ? Math.round(report.tests.passed / total * 100) : 0;
    console.log('\n' + bold('── TESTS ────────────────────────────────────────────────────'));
    console.log((pct === 100 ? green : yellow)(`  ${report.tests.passed}/${total} tests pasaron (${pct}%)`));
    if (report.tests.errors.length) { console.log(red('\n  Fallos:')); report.tests.errors.forEach(e => console.log(red(`    ✗ ${e.name}: ${e.detail}`))); }
  }

  // ── RESUMEN
  const criticalAudit = report.audit.issues.filter(i => ['CRITICAL','HIGH'].includes(i.severity)).length;
  const healthy = criticalAudit === 0 && report.tests.failed === 0 && report.db.status !== 'error';
  console.log('\n' + bold('── RESUMEN ──────────────────────────────────────────────────'));
  if (healthy) console.log(green('  ✅ Sistema saludable'));
  else {
    if (criticalAudit > 0)         console.log(red(`  ⚠  ${criticalAudit} issue(s) crítico/alto en código`));
    if (report.tests.failed > 0)   console.log(red(`  ⚠  ${report.tests.failed} endpoint(s) fallando`));
    if (report.db.status === 'error') console.log(red(`  ⚠  Base de datos no disponible`));
  }
  if (MODE.fix && report.fixes.applied.length)
    console.log(cyan(`  🔧 ${report.fixes.applied.length} corrección(es) aplicada(s) automáticamente`));
  if (MODE.improve) {
    const created = report.improved.filter(i => i.status.includes('✓')).length;
    if (created > 0) console.log(cyan(`  📦 ${created} utilidad(es) nueva(s) creada(s)`));
  }
  if (MODE.generate) {
    const created = report.generated.filter(g => g.status.includes('✓')).length;
    if (created > 0) console.log(cyan(`  🚀 ${created} archivo(s) generado(s)`));
  }
  console.log(dim(`  Tiempo: ${elapsed}s`));
  console.log(bold(cyan('═══════════════════════════════════════════════════════════\n')));
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(bold(cyan('\n╔══════════════════════════════════════════════════════════╗')));
  console.log(bold(cyan('║   ETaxes+ AGENTE PODEROSO v2 — Iniciando...              ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════════════════════╝')));
  const modesActive = Object.entries(MODE).filter(([,v]) => v).map(([k]) => k).join(', ');
  console.log(dim(`  Modos activos: ${modesActive}\n`));

  if (MODE.audit)    { process.stdout.write(cyan('  [audit]    Escaneando código...')); runAudit(); console.log(green(' listo')); }
  if (MODE.fix)      { process.stdout.write(cyan('  [fix]      Aplicando correcciones...')); runFixes(); console.log(green(' listo')); }
  if (MODE.improve)  { process.stdout.write(cyan('  [improve]  Creando utilidades...')); runImprovements(); console.log(green(' listo')); }
  if (MODE.generate) { process.stdout.write(cyan('  [generate] Generando código nuevo...')); runGenerate(); console.log(green(' listo')); }
  if (MODE.db)       { process.stdout.write(cyan('  [db]       Diagnóstico de base de datos...')); await runDbDiag(); console.log(report.db.status === 'ok' ? green(' listo') : red(' error')); }
  if (MODE.test)     { await runTests(); }

  printReport();
  process.exit(0);
}

main().catch(err => {
  console.error(red('\n[FATAL] ' + err.message));
  console.error(err.stack);
  process.exit(1);
});
