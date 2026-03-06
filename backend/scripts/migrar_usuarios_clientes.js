/**
 * Migración: agrega rfc, nombre, email a la tabla usuarios
 * Ejecutar: node backend/scripts/migrar_usuarios_clientes.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../db');

(async () => {
  try {
    console.log('🔄 Iniciando migración de usuarios...\n');

    // 1. Agregar columnas si no existen
    const checks = [
      { col: 'rfc',    sql: "ALTER TABLE usuarios ADD COLUMN rfc VARCHAR(13) AFTER username" },
      { col: 'nombre', sql: "ALTER TABLE usuarios ADD COLUMN nombre VARCHAR(255) AFTER rfc" },
      { col: 'email',  sql: "ALTER TABLE usuarios ADD COLUMN email VARCHAR(100) AFTER nombre" },
    ];

    for (const { col, sql } of checks) {
      const [cols] = await pool.query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='usuarios' AND COLUMN_NAME=?",
        [col]
      );
      if (cols.length === 0) {
        await pool.query(sql);
        console.log(`  ✅ Columna '${col}' agregada`);
      } else {
        console.log(`  ⏩ Columna '${col}' ya existe`);
      }
    }

    // 2. Mostrar usuarios actuales
    const [users] = await pool.query('SELECT id, username, role, rfc, nombre, email FROM usuarios');
    console.log('\n  Usuarios actuales:');
    users.forEach(u => console.log(`    id=${u.id}  username=${u.username}  role=${u.role}  rfc=${u.rfc || '(sin RFC)'}  nombre=${u.nombre || '(sin nombre)'}`));

    console.log('\n✅ Migración completada.');
    console.log('   Ahora puede agregar RFC/nombre/email a los usuarios desde el panel de administración.\n');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error en migración:', e.message);
    process.exit(1);
  }
})();
