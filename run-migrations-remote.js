#!/usr/bin/env node
/**
 * Script para ejecutar migraciones en Railway directamente
 * Uso: node run-migrations-remote.js
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// URL de Railway (cópiala de los logs)
const RAILWAY_DB_URL = 'mysql://root:SRJHbBHKUeAlSwCNXDUFbrGQTUkOCMbB@mysql.railway.internal:3306/railway';

async function parseUrl(url) {
  const match = url.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!match) throw new Error('Invalid MySQL URL format');

  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: parseInt(match[4]),
    database: match[5],
  };
}

async function runMigrations() {
  let connection;

  try {
    console.log('🔄 Parseando URL de Railway...');
    const config = await parseUrl(RAILWAY_DB_URL);
    console.log(`✅ Conectando a ${config.host}:${config.port}/${config.database}...`);

    // Conectar a MySQL
    connection = await mysql.createConnection(config);
    console.log('✅ Conectado a MySQL\n');

    // Seleccionar base de datos correcta (ETaxes2_0, no railway)
    await connection.execute('USE ETaxes2_0');
    console.log('✅ Usando base de datos: ETaxes2_0\n');

    // Leer archivos de migración
    const migrationsDir = path.join(__dirname, 'backend', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`📁 Encontradas ${files.length} migraciones\n`);

    // Ejecutar cada migración
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      // Dividir por ; y ejecutar cada sentencia
      const statements = sql.split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      console.log(`📝 Ejecutando ${file}...`);

      for (const stmt of statements) {
        try {
          await connection.execute(stmt);
        } catch (err) {
          console.error(`  ⚠️  Error en statement: ${err.message.substring(0, 80)}`);
        }
      }

      console.log(`  ✅ ${file} completado\n`);
    }

    console.log('🎉 ¡Migraciones completadas!\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

runMigrations();
