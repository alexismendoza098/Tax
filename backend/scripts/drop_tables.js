require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('../db');

async function dropTables() {
  const tables = [
    'validaciones_cfdi',
    'reportes_iva',
    'poliza_movimientos',
    'polizas',
    'papelera',
    'nomina_resumen',
    'movimientos_bancarios',
    'isr_pagos_provisionales',
    'estados_cuenta',
    'diot_proveedores',
    'depreciaciones',
    'config_fiscal',
    'catalogo_cuentas',
    'balanza_verificacion',
    'alertas_fiscales',
    'activos_fijos'
  ];

  const conn = await pool.getConnection();
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    try {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      console.log('DROPPED:', t);
    } catch (e) {
      console.error('ERROR dropping', t, ':', e.message);
    }
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  conn.release();
  console.log('DONE - todas las tablas no usadas eliminadas');
  process.exit(0);
}

dropTables().catch(e => { console.error(e); process.exit(1); });
