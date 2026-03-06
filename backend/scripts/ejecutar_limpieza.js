/**
 * ================================================================
 * LIMPIEZA COMPLETA + REIMPORTACIÓN DE XMLs — ETX Tax Recovery
 * ================================================================
 * Ejecutar: node backend/scripts/ejecutar_limpieza.js
 *
 * ACCIONES QUE REALIZA:
 *  1. Muestra estado ANTES
 *  2. Elimina registros de METADATA (estado='1' o '0') y sus tablas hijo
 *  3. Unifica todos los CFDIs de MESP980407UD4 bajo contribuyente_id=9 (cesar)
 *  4. Reimporta los XMLs de temp_extract bajo contribuyente_id=9
 *  5. Muestra estado FINAL
 * ================================================================
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool   = require('../db');
const fs     = require('fs');
const path   = require('path');
const { parseXML }    = require('../utils/xmlParser');
const { insertCFDI }  = require('../utils/cfdiInserter');

// ── Configuración ──────────────────────────────────────────────
const RFC_OBJETIVO       = 'MESP980407UD4';
const CONTRIBUYENTE_DEST = 9;   // usuario 'cesar'
const XML_DIR = path.join(__dirname, '..', 'downloads', RFC_OBJETIVO, 'temp_extract');

// ── Helpers ────────────────────────────────────────────────────
const hr  = (char = '─', n = 60) => char.repeat(n);
const log = (msg) => console.log(msg);
const sep = (title) => {
  log('');
  log(hr('═'));
  log(`  ${title}`);
  log(hr('═'));
};

async function estadoActual(etiqueta) {
  const [[tot]] = await pool.query('SELECT COUNT(*) as n FROM comprobantes');
  const [[meta]] = await pool.query("SELECT COUNT(*) as n FROM comprobantes WHERE estado NOT IN ('Vigente','Cancelado')");
  const [[vig]]  = await pool.query("SELECT COUNT(*) as n FROM comprobantes WHERE estado='Vigente'");
  const [[can]]  = await pool.query("SELECT COUNT(*) as n FROM comprobantes WHERE estado='Cancelado'");
  const [[conIva]] = await pool.query("SELECT COUNT(*) as n FROM comprobantes WHERE total_traslados > 0");
  const [[sumaIva]] = await pool.query("SELECT ROUND(SUM(total_traslados),2) as s FROM comprobantes WHERE contribuyente_id=?", [CONTRIBUYENTE_DEST]);

  const [contribs] = await pool.query(`
    SELECT c.id, c.rfc, u.username, COUNT(cp.uuid) as cfdis
    FROM contribuyentes c
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN comprobantes cp ON cp.contribuyente_id = c.id
    WHERE c.rfc = ?
    GROUP BY c.id, c.rfc, u.username
    ORDER BY cfdis DESC
  `, [RFC_OBJETIVO]);

  log('');
  log(`  [${etiqueta}]`);
  log(`  Total CFDIs      : ${tot.n}`);
  log(`  ├─ Vigentes      : ${vig.n}`);
  log(`  ├─ Cancelados    : ${can.n}`);
  log(`  ├─ Metadata/inv  : ${meta.n}  ${meta.n > 0 ? '⚠️  (sin IVA real)' : '✅'}`);
  log(`  └─ Con IVA > 0   : ${conIva.n}`);
  log(`  IVA acumulado (contrib ${CONTRIBUYENTE_DEST}): $${sumaIva.s || 0}`);
  log('');
  log('  Distribución por contribuyente:');
  contribs.forEach(r => log(`    contrib_id=${r.id}  usuario=${r.username}  cfdis=${r.cfdis}`));
}

// ── PASO 1: Eliminar registros de metadata ─────────────────────
async function eliminarMetadata() {
  sep('PASO 1: Eliminar registros de Metadata (estado 1/0)');

  // Obtener UUIDs de metadata
  const [metaRows] = await pool.query(
    "SELECT uuid FROM comprobantes WHERE estado NOT IN ('Vigente','Cancelado')"
  );
  log(`  Encontrados: ${metaRows.length} registros de metadata`);
  if (metaRows.length === 0) { log('  ✅ Nada que eliminar'); return 0; }

  const uuids = metaRows.map(r => r.uuid);

  // Borrar en tablas hijo primero
  const tablas = [
    'impuesto_traslados',
    'impuesto_retenciones',
    'cfdi_relacionados',
    'conceptos',
    'concepto_traslados',
    'concepto_retenciones',
    'pagos',
    'pago_doctos',
    'pago_traslados',
  ];

  for (const tabla of tablas) {
    try {
      const [res] = await pool.query(
        `DELETE FROM ${tabla} WHERE uuid IN (?)`, [uuids]
      );
      log(`  🗑  ${tabla}: ${res.affectedRows} filas eliminadas`);
    } catch (e) {
      log(`  ⚠️  ${tabla}: ${e.message} (puede no existir — continúa)`);
    }
  }

  // Borrar comprobantes de metadata
  const [res] = await pool.query(
    "DELETE FROM comprobantes WHERE estado NOT IN ('Vigente','Cancelado')"
  );
  log(`  🗑  comprobantes (metadata): ${res.affectedRows} eliminados`);
  return res.affectedRows;
}

// ── PASO 2: Unificar contribuyentes ───────────────────────────
async function unificarContribuyentes() {
  sep('PASO 2: Unificar CFDIs bajo contribuyente_id=' + CONTRIBUYENTE_DEST);

  // Buscar contribuyentes del mismo RFC distintos al destino
  const [otros] = await pool.query(
    `SELECT c.id, u.username, COUNT(cp.uuid) as cfdis
     FROM contribuyentes c
     LEFT JOIN usuarios u ON u.id = c.usuario_id
     LEFT JOIN comprobantes cp ON cp.contribuyente_id = c.id
     WHERE c.rfc = ? AND c.id != ?
     GROUP BY c.id, u.username`,
    [RFC_OBJETIVO, CONTRIBUYENTE_DEST]
  );

  let total = 0;
  for (const contrib of otros) {
    if (contrib.cfdis === 0) { log(`  (contrib_id=${contrib.id} ${contrib.username}: ya vacío)`); continue; }
    const [res] = await pool.query(
      'UPDATE comprobantes SET contribuyente_id = ? WHERE contribuyente_id = ?',
      [CONTRIBUYENTE_DEST, contrib.id]
    );
    log(`  ✅ Movidos ${res.affectedRows} CFDIs de contrib_id=${contrib.id} (${contrib.username}) → ${CONTRIBUYENTE_DEST}`);
    total += res.affectedRows;
  }
  if (total === 0) log('  ✅ Todos los CFDIs ya estaban en contrib_id=' + CONTRIBUYENTE_DEST);
  return total;
}

// ── PASO 3: Reimportar XMLs desde temp_extract ─────────────────
async function reimportarXMLs() {
  sep('PASO 3: Reimportar XMLs desde temp_extract');

  if (!fs.existsSync(XML_DIR)) {
    log(`  ⚠️  Directorio no encontrado: ${XML_DIR}`);
    return { importados: 0, omitidos: 0, errores: 0 };
  }

  const archivos = fs.readdirSync(XML_DIR).filter(f => f.toLowerCase().endsWith('.xml'));
  log(`  Archivos XML encontrados: ${archivos.length}`);

  let importados = 0, omitidos = 0, errores = 0;
  const listaErrores = [];

  for (const archivo of archivos) {
    const fullPath = path.join(XML_DIR, archivo);
    try {
      const contenido = fs.readFileSync(fullPath, 'utf8');
      const parsed    = await parseXML(contenido);
      const result    = await insertCFDI(parsed, CONTRIBUYENTE_DEST);
      if (result.inserted) {
        importados++;
        process.stdout.write(`\r  Importando... ${importados} nuevos, ${omitidos} ya existían, ${errores} errores`);
      } else if (result.skipped) {
        omitidos++;
        process.stdout.write(`\r  Importando... ${importados} nuevos, ${omitidos} ya existían, ${errores} errores`);
      }
    } catch (e) {
      errores++;
      listaErrores.push({ archivo, error: e.message });
    }
  }

  log('');
  log(`  ✅ Importados  : ${importados}`);
  log(`  ⏩ Ya existían : ${omitidos}`);
  log(`  ❌ Errores     : ${errores}`);

  if (listaErrores.length > 0) {
    log('');
    log('  Detalle de errores:');
    listaErrores.forEach(({ archivo, error }) => log(`    ${archivo}: ${error}`));
  }

  return { importados, omitidos, errores };
}

// ── PASO 4: Corregir cualquier estado numérico residual ────────
async function corregirEstados() {
  sep('PASO 4: Corregir estados numéricos residuales');
  const [r1] = await pool.query("UPDATE comprobantes SET estado='Vigente' WHERE estado='1'");
  const [r2] = await pool.query("UPDATE comprobantes SET estado='Cancelado' WHERE estado='0'");
  log(`  Corregidos: ${r1.affectedRows} '1'→Vigente, ${r2.affectedRows} '0'→Cancelado`);
}

// ── MAIN ───────────────────────────────────────────────────────
(async () => {
  try {
    log('');
    log(hr('═'));
    log('  ETX TAX RECOVERY — LIMPIEZA Y REIMPORTACIÓN COMPLETA');
    log(`  RFC: ${RFC_OBJETIVO}  |  Destino: contribuyente_id=${CONTRIBUYENTE_DEST}`);
    log(hr('═'));

    await estadoActual('ESTADO INICIAL (ANTES)');

    const metaEliminados  = await eliminarMetadata();
    const movidosUnif     = await unificarContribuyentes();
    const { importados }  = await reimportarXMLs();
    await corregirEstados();

    sep('RESULTADO FINAL');
    await estadoActual('ESTADO FINAL (DESPUÉS)');

    log('');
    log('  RESUMEN DE ACCIONES:');
    log(`  ├─ Metadata eliminados : ${metaEliminados}`);
    log(`  ├─ CFDIs unificados    : ${movidosUnif}`);
    log(`  └─ XMLs importados     : ${importados}`);
    log('');
    log('  ✅ Limpieza completada. Ahora inicia sesión como "cesar"');
    log('     y ejecuta la Auditoría Fiscal para ver los datos reales.');
    log('');

  } catch (e) {
    console.error('\n❌ ERROR FATAL:', e.message);
    console.error(e.stack);
  }
  process.exit(0);
})();
