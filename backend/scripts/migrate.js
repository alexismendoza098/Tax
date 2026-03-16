/**
 * ETaxes+ — Script de Migración de Base de Datos
 * Ejecuta archivos SQL de migrations/ contra la DB configurada en .env
 *
 * Uso:
 *   node scripts/migrate.js                   → Ejecuta todas las migraciones
 *   node scripts/migrate.js fix_missing_tables → Ejecuta migración específica
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const green  = s => c.green + s + c.reset;
const red    = s => c.red + s + c.reset;
const yellow = s => c.yellow + s + c.reset;
const cyan   = s => c.cyan + s + c.reset;
const bold   = s => c.bold + s + c.reset;
const dim    = s => c.dim + s + c.reset;

async function runMigration(pool, sqlFile) {
  const content = fs.readFileSync(sqlFile, 'utf8');

  // Separar statements por ; — eliminar comentarios de línea pero mantener el SQL
  const stripComments = raw =>
    raw.split('\n')
       .map(line => line.replace(/\r$/, ''))           // strip \r (Windows)
       .filter(line => !line.trim().startsWith('--'))  // quitar líneas de comentario
       .filter(line => !/^\s*USE\s+\S/i.test(line))   // ignorar USE db — el pool ya apunta a la DB correcta
       .join('\n');

  const statements = stripComments(content)
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !/^\s*$/.test(s));

  let executed = 0;
  let errors   = 0;

  for (const stmt of statements) {
    if (!stmt || stmt.startsWith('--')) continue;
    try {
      await pool.query(stmt);
      executed++;
    } catch (e) {
      // Ignorar errores de "ya existe" (Duplicate entry para índices)
      if (e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_TABLE_EXISTS_ERROR' || e.errno === 1061 || e.errno === 1050) {
        // Ya existe — es OK
      } else {
        console.error(red(`  ✗ Error en statement: ${e.message}`));
        console.error(dim(`    SQL: ${stmt.slice(0, 120)}...`));
        errors++;
      }
    }
  }

  return { executed, errors };
}

async function main() {
  const pool = require('../db');
  const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
  const targetFile = process.argv[2];

  console.log(bold(cyan('\n╔══════════════════════════════════════════════╗')));
  console.log(bold(cyan('║   ETaxes+ — Migración de Base de Datos       ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════════╝')));
  console.log(dim(`  DB: ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT}\n`));

  let files = [];
  if (targetFile) {
    const f = path.join(MIGRATIONS_DIR, targetFile.endsWith('.sql') ? targetFile : targetFile + '.sql');
    if (!fs.existsSync(f)) {
      console.error(red(`Archivo no encontrado: ${f}`));
      process.exit(1);
    }
    files = [f];
  } else {
    files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort()
      .map(f => path.join(MIGRATIONS_DIR, f));
  }

  let totalErrors = 0;
  for (const file of files) {
    const name = path.basename(file);
    process.stdout.write(`  Ejecutando ${cyan(name)}... `);
    try {
      const result = await runMigration(pool, file);
      if (result.errors === 0) {
        console.log(green(`✓ (${result.executed} statements)`));
      } else {
        console.log(yellow(`⚠ (${result.executed} OK, ${result.errors} errores)`));
        totalErrors += result.errors;
      }
    } catch (e) {
      console.log(red(`✗ FALLÓ: ${e.message}`));
      totalErrors++;
    }
  }

  // Verificar tablas
  console.log('\n' + bold('  Verificando tablas...'));
  const required = [
    'usuarios', 'contribuyentes', 'comprobantes', 'solicitudes_sat',
    'papelera', 'catalogo_cuentas', 'polizas', 'poliza_movimientos',
    'balanza_verificacion', 'activos_fijos', 'diot_proveedores',
    'isr_pagos_provisionales', 'estados_cuenta', 'validaciones_cfdi',
  ];
  const [tables] = await pool.query('SHOW TABLES');
  const existing = new Set(tables.map(t => Object.values(t)[0]));
  let missingCount = 0;
  for (const t of required) {
    if (existing.has(t)) console.log(green(`    ✓ ${t}`));
    else { console.log(red(`    ✗ ${t} — FALTANTE`)); missingCount++; }
  }

  console.log();
  if (totalErrors === 0 && missingCount === 0) {
    console.log(green(bold('  ✅ Migración completada exitosamente.\n')));
  } else {
    if (missingCount > 0) console.log(red(`  ❌ ${missingCount} tabla(s) aún faltante(s).`));
    if (totalErrors > 0)  console.log(yellow(`  ⚠  ${totalErrors} error(es) durante migración.`));
    console.log();
  }

  await pool.end();
  process.exit(missingCount > 0 || totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\x1b[31m[FATAL]\x1b[0m', err.message);
  process.exit(1);
});
