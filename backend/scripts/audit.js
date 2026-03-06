/**
 * ETaxes+ — Agente de Auditoría y Diagnóstico
 * Escanea rutas, utils y middleware en busca de:
 *   - Datos sensibles en logs
 *   - Posible SQL injection
 *   - Uso de eval()
 *   - TODOs / FIXMEs
 *   - Rutas async sin try-catch
 *   - Variables de entorno faltantes
 */

const fs   = require('fs');
const path = require('path');

// ─── COLORES ──────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
};
const red    = s => C.red    + s + C.reset;
const yellow = s => C.yellow + s + C.reset;
const green  = s => C.green  + s + C.reset;
const cyan   = s => C.cyan   + s + C.reset;
const bold   = s => C.bold   + s + C.reset;

// ─── SCAN DE ARCHIVOS ────────────────────────────────
const issues = [];
const stats  = { files: 0, lines: 0 };

function addIssue(file, line, type, severity, msg) {
  issues.push({ file, line, type, severity, msg });
}

function scanFile(fullPath) {
  const rel     = path.relative(process.cwd(), fullPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines   = content.split('\n');
  stats.files++;
  stats.lines += lines.length;

  // Detectar bloques de funciones async para verificar try-catch
  let inAsyncRoute = false;
  let tryCatchDepth = 0;
  let routeLineStart = 0;

  lines.forEach((line, idx) => {
    const i = idx + 1; // 1-based

    // 1. Logs con datos sensibles
    if (/console\.(log|warn|error).*(password|passwd|secret|token|clave|key|pin)/i.test(line)) {
      addIssue(rel, i, 'SECURITY', 'HIGH', 'Datos sensibles en log: ' + line.trim().slice(0, 90));
    }

    // 2. SQL injection por concatenación de strings
    if (/\bquery\s*\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE|DROP)/i.test(line) && /\+\s*(req\.|body\.|params\.|query\.)/.test(line)) {
      addIssue(rel, i, 'SQL_INJECT', 'CRITICAL', 'SQL injection por concatenación: ' + line.trim().slice(0, 90));
    }

    // 3. eval()
    if (/\beval\s*\(/.test(line)) {
      addIssue(rel, i, 'SECURITY', 'CRITICAL', 'Uso de eval(): ' + line.trim().slice(0, 90));
    }

    // 4. child_process exec con variables no sanitizadas
    if (/exec\s*\(.*\+\s*(req\.|body\.|params\.)/.test(line)) {
      addIssue(rel, i, 'SECURITY', 'CRITICAL', 'Command injection riesgo: ' + line.trim().slice(0, 90));
    }

    // 5. TODO / FIXME / HACK
    if (/\b(TODO|FIXME|HACK|BUG)\b/.test(line)) {
      addIssue(rel, i, 'MAINTAINABILITY', 'LOW', line.trim().slice(0, 90));
    }

    // 6. res.send sin status code en catch blocks
    if (/catch.*\{/.test(line) || (/catch/.test(line) && /\{/.test(lines[idx + 1] || ''))) {
      // Check next few lines for res.json without status
      const block = lines.slice(idx, idx + 5).join(' ');
      if (/res\.(send|json)\s*\(/.test(block) && !/res\.status/.test(block)) {
        addIssue(rel, i, 'RESPONSE', 'MEDIUM', 'catch block sin res.status(): línea ~' + i);
      }
    }

    // 7. Rutas async sin try-catch (check simple de contexto)
    if (/router\.(get|post|put|delete|patch)\s*\(.*async/.test(line)) {
      inAsyncRoute = true;
      tryCatchDepth = 0;
      routeLineStart = i;
    }
    if (inAsyncRoute) {
      if (/\btry\s*\{/.test(line)) tryCatchDepth++;
      if (tryCatchDepth === 0 && i > routeLineStart + 30) {
        // Llegó a 30 líneas sin try-catch
        addIssue(rel, routeLineStart, 'ERROR_HANDLING', 'MEDIUM', 'Ruta async posiblemente sin try-catch en línea ' + routeLineStart);
        inAsyncRoute = false;
      }
      if (/^\s*\}\s*\)/.test(line) && tryCatchDepth === 0) inAsyncRoute = false;
      if (/^\s*\}\s*\)/.test(line) && tryCatchDepth > 0) { inAsyncRoute = false; }
    }
  });
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory() && !['node_modules', '__pycache__', '.git'].includes(entry)) {
      walkDir(full);
    } else if (entry.endsWith('.js') && !entry.includes('.bak')) {
      scanFile(full);
    }
  }
}

// ─── RUTAS A ESCANEAR ────────────────────────────────
const ROOT = path.join(__dirname, '..');
['routes', 'utils', 'middleware', 'scripts'].forEach(d => walkDir(path.join(ROOT, d)));

// ─── VERIFICAR ENV VARS CRÍTICAS ────────────────────
const requiredEnv = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'JWT_SECRET', 'PORT'];
require('dotenv').config({ path: path.join(ROOT, '.env') });
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    issues.push({ file: '.env', line: 0, type: 'CONFIG', severity: 'HIGH', msg: `Variable de entorno faltante: ${envVar}` });
  }
}

// ─── REPORTE ────────────────────────────────────────
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
issues.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
for (const issue of issues) {
  (bySeverity[issue.severity] = bySeverity[issue.severity] || []).push(issue);
}

console.log('\n' + bold('═══════════════════════════════════════════════════'));
console.log(bold('  ETaxes+ Agente de Auditoría — Reporte de Issues'));
console.log(bold('═══════════════════════════════════════════════════'));
console.log(cyan(`  Archivos escaneados: ${stats.files} | Líneas: ${stats.lines}`));
console.log();

if (bySeverity.CRITICAL?.length) {
  console.log(red(bold('🚨 CRÍTICOS (' + bySeverity.CRITICAL.length + ')')));
  bySeverity.CRITICAL.forEach(i => console.log(red(`  [${i.type}] ${i.file}:${i.line} — ${i.msg}`)));
  console.log();
}
if (bySeverity.HIGH?.length) {
  console.log(yellow(bold('⚠️  ALTOS (' + bySeverity.HIGH.length + ')')));
  bySeverity.HIGH.forEach(i => console.log(yellow(`  [${i.type}] ${i.file}:${i.line} — ${i.msg}`)));
  console.log();
}
if (bySeverity.MEDIUM?.length) {
  console.log(bold('📋 MEDIOS (' + bySeverity.MEDIUM.length + ')'));
  bySeverity.MEDIUM.forEach(i => console.log(`  [${i.type}] ${i.file}:${i.line} — ${i.msg}`));
  console.log();
}
if (bySeverity.LOW?.length) {
  console.log('📌 BAJOS (' + bySeverity.LOW.length + ')');
  bySeverity.LOW.slice(0, 10).forEach(i => console.log(`  [${i.type}] ${i.file}:${i.line} — ${i.msg}`));
  if (bySeverity.LOW.length > 10) console.log(`  ... y ${bySeverity.LOW.length - 10} más`);
  console.log();
}

const total = issues.length;
if (total === 0) {
  console.log(green('✅ Sin issues detectados.\n'));
} else {
  console.log(bold(`Total: ${total} issue(s) encontrado(s).`));
}
console.log(bold('═══════════════════════════════════════════════════\n'));
