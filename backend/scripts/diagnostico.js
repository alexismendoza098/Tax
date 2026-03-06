/**
 * DIAGNÓSTICO COMPLETO — ETX Tax Recovery
 * Ejecutar: node backend/scripts/diagnostico.js
 */
const pool = require('../db');
const fs = require('fs');
const path = require('path');

(async () => {
  try {
    // 1. Fragmentación de contribuyentes por RFC
    const [detail] = await pool.query(`
      SELECT c.id, c.rfc, c.usuario_id, u.username,
             COUNT(cp.uuid) as total_cfdis,
             SUM(CASE WHEN cp.total_traslados > 0 THEN 1 ELSE 0 END) as con_iva,
             SUM(CASE WHEN cp.estado='Vigente' THEN 1 ELSE 0 END) as vigente,
             ROUND(SUM(cp.total_traslados),2) as iva_total
      FROM contribuyentes c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      LEFT JOIN comprobantes cp ON cp.contribuyente_id = c.id
      GROUP BY c.id, c.rfc, c.usuario_id, u.username
      ORDER BY total_cfdis DESC
    `);
    console.log('\n=== CONTRIBUYENTES (FRAGMENTACIÓN DE DATOS) ===');
    console.table(detail);

    // 2. Estado de los CFDIs
    const [estados] = await pool.query(`
      SELECT tipo_de_comprobante, estado, metodo_pago, COUNT(*) as n,
             ROUND(SUM(total_traslados),2) as iva_total,
             ROUND(SUM(total),2) as monto_total
      FROM comprobantes
      GROUP BY tipo_de_comprobante, estado, metodo_pago
      ORDER BY tipo_de_comprobante, n DESC
    `);
    console.log('\n=== TIPOS Y ESTADOS DE CFDI ===');
    console.table(estados);

    // 3. Solicitudes SAT registradas
    const [pkgs] = await pool.query(`
      SELECT id_solicitud, rfc, fecha_inicio, fecha_fin, tipo_solicitud,
             tipo_comprobante, estado_solicitud,
             CASE WHEN paquetes IS NULL OR paquetes='[]' THEN 'Sin paquetes'
                  ELSE CONCAT(JSON_LENGTH(paquetes), ' paquetes') END as paquetes_info
      FROM solicitudes_sat
      ORDER BY id DESC LIMIT 30
    `);
    console.log('\n=== SOLICITUDES SAT ===');
    console.table(pkgs);

    // 4. ZIPs en disco
    const dlDir = path.join(__dirname, '..', 'downloads');
    console.log('\n=== ARCHIVOS EN backend/downloads ===');
    let totalZips = 0, totalMB = 0;
    const listDir = (dir, prefix) => {
      if (!fs.existsSync(dir)) { console.log('  (directorio no existe: ' + dir + ')'); return; }
      const items = fs.readdirSync(dir);
      items.forEach(f => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          listDir(full, prefix + f + '/');
        } else {
          const mb = (stat.size / 1024 / 1024).toFixed(2);
          console.log(`  ${prefix}${f}  (${mb} MB)  ${stat.mtime.toISOString().substring(0,10)}`);
          if (f.endsWith('.zip')) { totalZips++; totalMB += stat.size / 1024 / 1024; }
        }
      });
    };
    listDir(dlDir, '');
    console.log(`  TOTAL: ${totalZips} ZIPs = ${totalMB.toFixed(1)} MB`);

    // 5. Resumen diagnóstico
    const [[tot]] = await pool.query('SELECT COUNT(*) as n FROM comprobantes');
    const [[metaRec]] = await pool.query("SELECT COUNT(*) as n FROM comprobantes WHERE estado NOT IN ('Vigente','Cancelado')");
    const [[sinIVA]] = await pool.query('SELECT COUNT(*) as n FROM comprobantes WHERE (total_traslados IS NULL OR total_traslados=0) AND tipo_de_comprobante="I"');
    const [[noPagos]] = await pool.query('SELECT COUNT(*) as n FROM pagos');
    const [[noNominas]] = await pool.query('SELECT COUNT(*) as n FROM comprobantes WHERE tipo_de_comprobante="N"');

    console.log('\n=== DIAGNÓSTICO RÁPIDO ===');
    console.log(`  Total CFDIs en DB:          ${tot.n}`);
    console.log(`  CFDIs de metadata (sin IVA): ${metaRec.n}  ← ESTOS NO SIRVEN PARA AUDITORÍA`);
    console.log(`  Ingresos sin IVA (tipo I):   ${sinIVA.n}`);
    console.log(`  Complementos de pago:        ${noPagos.n}`);
    console.log(`  Nóminas:                     ${noNominas.n}`);
    console.log('');
    if (metaRec.n > 0) {
      console.log('  ⚠️  PROBLEMA: Tienes registros de METADATA en la DB.');
      console.log('     Estos no tienen IVA real. Necesitas re-descargar como CFDI (XML).');
    }
    if (sinIVA.n > 5) {
      console.log('  ⚠️  PROBLEMA: Muchas facturas tipo I sin IVA registrado.');
    }

  } catch (e) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
})();
