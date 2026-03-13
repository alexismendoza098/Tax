#!/usr/bin/env node
/**
 * Script de arranque para producción
 * Ejecuta migraciones, luego inicia el servidor
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🔄 [PROD] Iniciando procedimiento de arranque...');

// Ejecutar migraciones primero
const migrate = spawn('node', [path.join(__dirname, 'backend', 'scripts', 'migrate.js')], {
  stdio: 'inherit',
  cwd: __dirname,
});

migrate.on('close', (code) => {
  if (code === 0) {
    console.log('✅ [PROD] Migraciones completadas, iniciando servidor...');
    // Ahora iniciar el servidor
    const server = spawn('node', [path.join(__dirname, 'backend', 'server.js')], {
      stdio: 'inherit',
      cwd: __dirname,
    });

    server.on('error', (err) => {
      console.error('❌ Error al iniciar servidor:', err);
      process.exit(1);
    });
  } else {
    console.error('❌ [PROD] Las migraciones fallaron con código:', code);
    process.exit(1);
  }
});

migrate.on('error', (err) => {
  console.error('❌ Error al ejecutar migraciones:', err);
  process.exit(1);
});
