/**
 * ================================================================
 * CONTABILIDAD ELECTRÓNICA SAT — ETX Tax Recovery
 * ================================================================
 * Conforme a: Resolución Miscelánea Fiscal (RMF) 2025
 * Anexo 24 — Catálogo de cuentas, Balanza, Pólizas
 *
 * --- CATÁLOGO DE CUENTAS ---
 * GET    /api/contabilidad/catalogo           — Listar cuentas
 * POST   /api/contabilidad/catalogo           — Crear cuenta
 * PUT    /api/contabilidad/catalogo/:id       — Actualizar cuenta
 * DELETE /api/contabilidad/catalogo/:id       — Eliminar cuenta
 * POST   /api/contabilidad/catalogo/inicializar — Cargar catálogo SAT estándar
 * GET    /api/contabilidad/catalogo/xml        — Exportar XML SAT
 *
 * --- PÓLIZAS ---
 * GET    /api/contabilidad/polizas            — Listar pólizas
 * POST   /api/contabilidad/polizas            — Crear póliza manual
 * GET    /api/contabilidad/polizas/:id        — Detalle póliza
 * DELETE /api/contabilidad/polizas/:id        — Eliminar póliza
 * POST   /api/contabilidad/polizas/generar-cfdi — Generar pólizas desde CFDIs
 * GET    /api/contabilidad/polizas/xml        — Exportar XML SAT
 *
 * --- BALANZA ---
 * GET    /api/contabilidad/balanza            — Consultar balanza
 * POST   /api/contabilidad/balanza/calcular   — Recalcular balanza
 * GET    /api/contabilidad/balanza/xml        — Exportar XML SAT
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

async function getContribId(userId, rfc) {
  let q = 'SELECT id, rfc, nombre FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc); } else q += ' ORDER BY id LIMIT 1';
  const [r] = await pool.query(q, p);
  return r[0] || null;
}

// ════════════════════════════════════════════════════════
// CATÁLOGO DE CUENTAS
// ════════════════════════════════════════════════════════

// GET /api/contabilidad/catalogo
router.get('/catalogo', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    if (!contrib) return res.status(400).json({ error: 'Contribuyente no encontrado' });

    const [rows] = await pool.query(`
      SELECT c.*, p.numero_cuenta AS cuenta_padre_numero, p.descripcion AS cuenta_padre_desc
      FROM catalogo_cuentas c
      LEFT JOIN catalogo_cuentas p ON p.id = c.cuenta_padre_id
      WHERE c.contribuyente_id = ?
      ORDER BY c.numero_cuenta
    `, [contrib.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/contabilidad/catalogo
router.post('/catalogo', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.body.rfc);
    const { numero_cuenta, descripcion, naturaleza, tipo, sub_tipo, nivel,
            cuenta_padre_id, codigo_agrupador } = req.body;
    if (!numero_cuenta || !descripcion || !naturaleza || !tipo)
      return res.status(400).json({ error: 'Campos requeridos: numero_cuenta, descripcion, naturaleza, tipo' });
    if (!['D', 'A'].includes(naturaleza))
      return res.status(400).json({ error: "naturaleza debe ser 'D' (Deudora) o 'A' (Acreedora)" });
    const [r] = await pool.query(
      `INSERT INTO catalogo_cuentas
         (contribuyente_id, numero_cuenta, descripcion, naturaleza, tipo, sub_tipo, nivel, cuenta_padre_id, codigo_agrupador)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [contrib.id, numero_cuenta, descripcion, naturaleza, tipo, sub_tipo || null,
       nivel || 2, cuenta_padre_id || null, codigo_agrupador || null]
    );
    res.json({ success: true, id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/contabilidad/catalogo/:id
router.put('/catalogo/:id', authMiddleware, async (req, res) => {
  try {
    const { descripcion, naturaleza, tipo, sub_tipo, codigo_agrupador, activa } = req.body;
    if (!descripcion || !naturaleza || !tipo)
      return res.status(400).json({ error: 'Campos requeridos: descripcion, naturaleza, tipo' });
    if (!['D', 'A'].includes(naturaleza))
      return res.status(400).json({ error: "naturaleza debe ser 'D' (Deudora) o 'A' (Acreedora)" });
    await pool.query(
      `UPDATE catalogo_cuentas SET descripcion=?, naturaleza=?, tipo=?, sub_tipo=?, codigo_agrupador=?, activa=?
       WHERE id = ?`,
      [descripcion, naturaleza, tipo, sub_tipo || null, codigo_agrupador || null, activa ?? 1, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/contabilidad/catalogo/:id
router.delete('/catalogo/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [[used]] = await pool.query(
      'SELECT COUNT(*) AS n FROM poliza_movimientos WHERE cuenta_id = ?', [req.params.id]
    );
    if (used.n > 0) return res.status(400).json({ error: `Cuenta en uso por ${used.n} movimientos de póliza` });
    await pool.query('DELETE FROM catalogo_cuentas WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/contabilidad/catalogo/inicializar — Catálogo SAT estándar
router.post('/catalogo/inicializar', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.body.rfc);
    const cid = contrib.id;
    const [[existente]] = await pool.query(
      'SELECT COUNT(*) as n FROM catalogo_cuentas WHERE contribuyente_id = ?', [cid]
    );
    if (existente.n > 0 && !req.body.forzar) {
      return res.status(400).json({ error: 'Ya existe catálogo. Usa forzar:true para reinicializar.' });
    }
    if (req.body.forzar) {
      await pool.query('DELETE FROM catalogo_cuentas WHERE contribuyente_id = ?', [cid]);
    }

    // Catálogo básico SAT (resumido — grupos principales)
    const cuentas = [
      // ACTIVOS
      ['1', 'ACTIVO', 'D', 'Activo', 'Circulante', 1, null, '100'],
      ['1.1', 'ACTIVO CIRCULANTE', 'D', 'Activo', 'Circulante', 2, null, '100'],
      ['1.1.01', 'Caja', 'D', 'Activo', 'Circulante', 3, null, '102.01'],
      ['1.1.02', 'Bancos nacionales', 'D', 'Activo', 'Circulante', 3, null, '102.01'],
      ['1.1.03', 'Clientes', 'D', 'Activo', 'Circulante', 3, null, '105.01'],
      ['1.1.04', 'Documentos por cobrar', 'D', 'Activo', 'Circulante', 3, null, '106.01'],
      ['1.1.05', 'IVA por acreditar', 'D', 'Activo', 'Circulante', 3, null, '119.01'],
      ['1.1.06', 'IVA acreditable pagado', 'D', 'Activo', 'Circulante', 3, null, '119.02'],
      ['1.1.07', 'Pagos anticipados ISR', 'D', 'Activo', 'Circulante', 3, null, '120.01'],
      ['1.2', 'ACTIVO NO CIRCULANTE', 'D', 'Activo', 'No Circulante', 2, null, '100'],
      ['1.2.01', 'Terrenos', 'D', 'Activo', 'No Circulante', 3, null, '161.01'],
      ['1.2.02', 'Edificios', 'D', 'Activo', 'No Circulante', 3, null, '162.01'],
      ['1.2.03', 'Maquinaria y equipo', 'D', 'Activo', 'No Circulante', 3, null, '163.01'],
      ['1.2.04', 'Equipo de transporte', 'D', 'Activo', 'No Circulante', 3, null, '164.01'],
      ['1.2.05', 'Equipo de cómputo', 'D', 'Activo', 'No Circulante', 3, null, '165.01'],
      ['1.2.06', 'Depreciación acumulada', 'A', 'Activo', 'No Circulante', 3, null, '175.01'],
      // PASIVOS
      ['2', 'PASIVO', 'A', 'Pasivo', 'Corto Plazo', 1, null, '200'],
      ['2.1', 'PASIVO CORTO PLAZO', 'A', 'Pasivo', 'Corto Plazo', 2, null, '200'],
      ['2.1.01', 'Proveedores', 'A', 'Pasivo', 'Corto Plazo', 3, null, '201.01'],
      ['2.1.02', 'Documentos por pagar CP', 'A', 'Pasivo', 'Corto Plazo', 3, null, '202.01'],
      ['2.1.03', 'IVA trasladado', 'A', 'Pasivo', 'Corto Plazo', 3, null, '213.01'],
      ['2.1.04', 'IVA por pagar', 'A', 'Pasivo', 'Corto Plazo', 3, null, '213.02'],
      ['2.1.05', 'ISR por pagar', 'A', 'Pasivo', 'Corto Plazo', 3, null, '215.01'],
      ['2.1.06', 'Retenciones ISR empleados', 'A', 'Pasivo', 'Corto Plazo', 3, null, '216.01'],
      ['2.1.07', 'IMSS por pagar', 'A', 'Pasivo', 'Corto Plazo', 3, null, '216.02'],
      ['2.1.08', 'INFONAVIT por pagar', 'A', 'Pasivo', 'Corto Plazo', 3, null, '216.03'],
      ['2.1.09', 'Acreedores diversos', 'A', 'Pasivo', 'Corto Plazo', 3, null, '210.01'],
      // CAPITAL
      ['3', 'CAPITAL CONTABLE', 'A', 'Capital', null, 1, null, '300'],
      ['3.1.01', 'Capital social', 'A', 'Capital', null, 3, null, '301.01'],
      ['3.1.02', 'Resultados de ejercicios anteriores', 'A', 'Capital', null, 3, null, '305.01'],
      ['3.1.03', 'Resultado del ejercicio', 'A', 'Capital', null, 3, null, '306.01'],
      // INGRESOS
      ['4', 'INGRESOS', 'A', 'Ingreso', null, 1, null, '400'],
      ['4.1.01', 'Ventas', 'A', 'Ingreso', null, 3, null, '401.01'],
      ['4.1.02', 'Descuentos sobre ventas', 'D', 'Ingreso', null, 3, null, '401.02'],
      ['4.1.03', 'Devoluciones sobre ventas', 'D', 'Ingreso', null, 3, null, '401.03'],
      ['4.2.01', 'Productos financieros', 'A', 'Ingreso', null, 3, null, '402.01'],
      ['4.2.02', 'Otros ingresos', 'A', 'Ingreso', null, 3, null, '499.01'],
      // COSTOS
      ['5', 'COSTOS', 'D', 'Costo', null, 1, null, '500'],
      ['5.1.01', 'Costo de ventas', 'D', 'Costo', null, 3, null, '501.01'],
      // GASTOS
      ['6', 'GASTOS', 'D', 'Gasto', null, 1, null, '600'],
      ['6.1.01', 'Sueldos y salarios', 'D', 'Gasto', null, 3, null, '601.01'],
      ['6.1.02', 'Honorarios', 'D', 'Gasto', null, 3, null, '601.02'],
      ['6.1.03', 'Arrendamientos', 'D', 'Gasto', null, 3, null, '602.01'],
      ['6.1.04', 'Servicios profesionales', 'D', 'Gasto', null, 3, null, '603.01'],
      ['6.1.05', 'Gastos de viaje', 'D', 'Gasto', null, 3, null, '604.01'],
      ['6.1.06', 'Fletes y acarreos', 'D', 'Gasto', null, 3, null, '605.01'],
      ['6.1.07', 'Comisiones', 'D', 'Gasto', null, 3, null, '606.01'],
      ['6.1.08', 'Publicidad y propaganda', 'D', 'Gasto', null, 3, null, '612.01'],
      ['6.1.09', 'Comunicaciones', 'D', 'Gasto', null, 3, null, '613.01'],
      ['6.1.10', 'Combustible y lubricantes', 'D', 'Gasto', null, 3, null, '614.01'],
      ['6.1.11', 'Depreciación del ejercicio', 'D', 'Gasto', null, 3, null, '615.01'],
      ['6.1.12', 'Gastos no deducibles', 'D', 'Gasto', null, 3, null, '699.01'],
      ['6.2.01', 'Gastos financieros', 'D', 'Gasto', null, 3, null, '623.01'],
    ];

    const insertRows = cuentas.map(c => [cid, ...c, 1]);
    await pool.query(
      `INSERT IGNORE INTO catalogo_cuentas
         (contribuyente_id, numero_cuenta, descripcion, naturaleza, tipo, sub_tipo, nivel, cuenta_padre_id, codigo_agrupador, activa)
       VALUES ?`,
      [insertRows]
    );
    res.json({ success: true, cuentas_creadas: cuentas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contabilidad/catalogo/xml — Exportar XML SAT
router.get('/catalogo/xml', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(
      `SELECT * FROM catalogo_cuentas WHERE contribuyente_id = ? AND activa = 1 ORDER BY numero_cuenta`,
      [contrib.id]
    );
    const mes  = req.query.mes  || new Date().getMonth() + 1;
    const anio = req.query.anio || new Date().getFullYear();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" `;
    xml += `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `;
    xml += `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd" `;
    xml += `RFC="${contrib.rfc}" Mes="${String(mes).padStart(2,'0')}" Anio="${anio}" TipoEnvio="N" Version="1.3">\n`;

    for (const c of rows) {
      xml += `  <catalogocuentas:Ctas NumCta="${c.numero_cuenta}" Desc="${xmlEsc(c.descripcion)}" `;
      xml += `CodAgrup="${c.codigo_agrupador || ''}" Natur="${c.naturaleza}" Nivel="${c.nivel}" `;
      if (c.cuenta_padre_id) {
        const [[padre]] = await pool.query('SELECT numero_cuenta FROM catalogo_cuentas WHERE id = ?', [c.cuenta_padre_id]);
        if (padre) xml += `SubCtaDe="${padre.numero_cuenta}" `;
      }
      xml += `/>\n`;
    }
    xml += `</catalogocuentas:Catalogo>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="CatalogoCuentas_${contrib.rfc}_${anio}_${String(mes).padStart(2,'0')}.xml"`);
    res.send(xml);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function xmlEsc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ════════════════════════════════════════════════════════
// PÓLIZAS
// ════════════════════════════════════════════════════════

// GET /api/contabilidad/polizas
router.get('/polizas', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    const { year, mes, tipo } = req.query;
    let where = 'p.contribuyente_id = ?';
    const params = [contrib.id];
    if (year) { where += ' AND p.ejercicio = ?'; params.push(year); }
    if (mes)  { where += ' AND p.periodo = ?'; params.push(mes); }
    if (tipo) { where += ' AND p.tipo_poliza = ?'; params.push(tipo); }

    const [rows] = await pool.query(`
      SELECT p.*, COUNT(pm.id) AS num_movimientos
      FROM polizas p
      LEFT JOIN poliza_movimientos pm ON pm.poliza_id = p.id
      WHERE ${where}
      GROUP BY p.id
      ORDER BY p.fecha DESC, p.tipo_poliza, p.numero
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contabilidad/polizas/:id
router.get('/polizas/:id', authMiddleware, async (req, res) => {
  try {
    const [[poliza]] = await pool.query('SELECT * FROM polizas WHERE id = ?', [req.params.id]);
    if (!poliza) return res.status(404).json({ error: 'No encontrada' });
    const [movimientos] = await pool.query(
      'SELECT * FROM poliza_movimientos WHERE poliza_id = ? ORDER BY id', [req.params.id]
    );
    res.json({ ...poliza, movimientos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/contabilidad/polizas — Crear póliza manual
router.post('/polizas', authMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const contrib = await getContribId(req.user.id, req.body.rfc);
    const { ejercicio, periodo, tipo_poliza, concepto, fecha, movimientos } = req.body;

    if (!movimientos?.length) throw new Error('La póliza requiere al menos un movimiento');
    const totalDebe  = movimientos.reduce((s, m) => s + parseFloat(m.debe  || 0), 0);
    const totalHaber = movimientos.reduce((s, m) => s + parseFloat(m.haber || 0), 0);
    if (Math.abs(totalDebe - totalHaber) > 0.01) throw new Error(`Póliza descuadrada: Debe ${totalDebe.toFixed(2)} ≠ Haber ${totalHaber.toFixed(2)}`);

    const [[numRow]] = await conn.query(
      `SELECT COALESCE(MAX(numero),0)+1 AS siguiente FROM polizas
       WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ? AND tipo_poliza = ?`,
      [contrib.id, ejercicio, periodo, tipo_poliza]
    );

    const [rp] = await conn.query(
      `INSERT INTO polizas (contribuyente_id, ejercicio, periodo, tipo_poliza, numero, concepto, fecha, total_debe, total_haber, creada_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [contrib.id, ejercicio, periodo, tipo_poliza, numRow.siguiente, concepto, fecha, totalDebe.toFixed(2), totalHaber.toFixed(2), req.user.id]
    );

    for (const m of movimientos) {
      await conn.query(
        `INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi)
         VALUES (?,?,?,?,?,?,?)`,
        [rp.insertId, m.cuenta_id, m.numero_cuenta, m.descripcion || concepto,
         parseFloat(m.debe||0).toFixed(2), parseFloat(m.haber||0).toFixed(2), m.uuid_cfdi || null]
      );
    }

    await conn.commit();
    res.json({ success: true, poliza_id: rp.insertId, numero: numRow.siguiente });
  } catch (e) { await conn.rollback(); res.status(500).json({ error: e.message }); }
  finally { conn.release(); }
});

// POST /api/contabilidad/polizas/generar-cfdi — Auto-pólizas desde CFDIs
router.post('/polizas/generar-cfdi', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.body.rfc);
    const { year, mes } = req.body;

    // Buscar cuentas clave del catálogo
    async function getCuenta(numCuenta) {
      const [[r]] = await pool.query(
        'SELECT id, numero_cuenta FROM catalogo_cuentas WHERE contribuyente_id = ? AND numero_cuenta = ?',
        [contrib.id, numCuenta]
      );
      return r;
    }

    const ctaVentas    = await getCuenta('4.1.01');
    const ctaClientes  = await getCuenta('1.1.03');
    const ctaIVATras   = await getCuenta('2.1.03');
    const ctaProveed   = await getCuenta('2.1.01');
    const ctaGastos    = await getCuenta('6.1.04');
    const ctaIVAActed  = await getCuenta('1.1.05');

    if (!ctaVentas || !ctaClientes) {
      return res.status(400).json({ error: 'Catálogo incompleto. Inicializa el catálogo de cuentas primero.' });
    }

    const [emitidas] = await pool.query(`
      SELECT uuid, fecha, total, subtotal, total_traslados, nombre_receptor
      FROM comprobantes
      WHERE rfc_emisor = ? AND tipo_de_comprobante IN ('I') AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) = ?
        AND uuid NOT IN (SELECT referencia_uuid FROM polizas WHERE referencia_uuid IS NOT NULL AND contribuyente_id = ?)
    `, [contrib.rfc, year, mes, contrib.id]);

    const [recibidas] = await pool.query(`
      SELECT uuid, fecha, total, subtotal, total_traslados, nombre_emisor
      FROM comprobantes
      WHERE rfc_receptor = ? AND tipo_de_comprobante IN ('I') AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) = ?
        AND uuid NOT IN (SELECT referencia_uuid FROM polizas WHERE referencia_uuid IS NOT NULL AND contribuyente_id = ?)
    `, [contrib.rfc, year, mes, contrib.id]);

    let generadas = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const cfdi of emitidas) {
        const subtotal = parseFloat(cfdi.subtotal || 0);
        const iva      = parseFloat(cfdi.total_traslados || 0);
        const total    = parseFloat(cfdi.total || 0);
        const [[numRow]] = await conn.query(
          `SELECT COALESCE(MAX(numero),0)+1 AS n FROM polizas
           WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ? AND tipo_poliza = 'I'`,
          [contrib.id, year, mes]
        );
        const [rp] = await conn.query(
          `INSERT INTO polizas (contribuyente_id, ejercicio, periodo, tipo_poliza, numero, concepto, fecha, total_debe, total_haber, origen, referencia_uuid, generada_auto, creada_por)
           VALUES (?,?,?,'I',?,?,?,?,?,'cfdi_emitido',?,1,?)`,
          [contrib.id, year, mes, numRow.n, `Venta: ${cfdi.nombre_receptor || cfdi.uuid}`,
           cfdi.fecha.toISOString().slice(0,10), total.toFixed(2), total.toFixed(2), cfdi.uuid, req.user.id]
        );
        // Movimientos: Debe=Clientes, Haber=Ventas + IVA trasladado
        await conn.query(`INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi) VALUES (?,?,?,?,?,?,?)`,
          [rp.insertId, ctaClientes.id, ctaClientes.numero_cuenta, 'Clientes', total.toFixed(2), '0.00', cfdi.uuid]);
        await conn.query(`INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi) VALUES (?,?,?,?,?,?,?)`,
          [rp.insertId, ctaVentas.id, ctaVentas.numero_cuenta, 'Ventas', '0.00', subtotal.toFixed(2), cfdi.uuid]);
        if (iva > 0 && ctaIVATras) {
          await conn.query(`INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi) VALUES (?,?,?,?,?,?,?)`,
            [rp.insertId, ctaIVATras.id, ctaIVATras.numero_cuenta, 'IVA trasladado', '0.00', iva.toFixed(2), cfdi.uuid]);
        }
        generadas++;
      }

      for (const cfdi of recibidas) {
        const subtotal = parseFloat(cfdi.subtotal || 0);
        const iva      = parseFloat(cfdi.total_traslados || 0);
        const total    = parseFloat(cfdi.total || 0);
        const [[numRow]] = await conn.query(
          `SELECT COALESCE(MAX(numero),0)+1 AS n FROM polizas
           WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ? AND tipo_poliza = 'E'`,
          [contrib.id, year, mes]
        );
        const ctaGastoUso = ctaGastos || ctaProveed;
        const [rp] = await conn.query(
          `INSERT INTO polizas (contribuyente_id, ejercicio, periodo, tipo_poliza, numero, concepto, fecha, total_debe, total_haber, origen, referencia_uuid, generada_auto, creada_por)
           VALUES (?,?,?,'E',?,?,?,?,?,'cfdi_recibido',?,1,?)`,
          [contrib.id, year, mes, numRow.n, `Compra/Gasto: ${cfdi.nombre_emisor || cfdi.uuid}`,
           cfdi.fecha.toISOString().slice(0,10), total.toFixed(2), total.toFixed(2), cfdi.uuid, req.user.id]
        );
        await conn.query(`INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi) VALUES (?,?,?,?,?,?,?)`,
          [rp.insertId, ctaGastoUso.id, ctaGastoUso.numero_cuenta, 'Gasto/Compra', subtotal.toFixed(2), '0.00', cfdi.uuid]);
        if (iva > 0 && ctaIVAActed) {
          await conn.query(`INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi) VALUES (?,?,?,?,?,?,?)`,
            [rp.insertId, ctaIVAActed.id, ctaIVAActed.numero_cuenta, 'IVA acreditable', iva.toFixed(2), '0.00', cfdi.uuid]);
        }
        await conn.query(`INSERT INTO poliza_movimientos (poliza_id, cuenta_id, numero_cuenta, descripcion, debe, haber, uuid_cfdi) VALUES (?,?,?,?,?,?,?)`,
          [rp.insertId, ctaProveed.id, ctaProveed.numero_cuenta, 'Proveedor por pagar', '0.00', total.toFixed(2), cfdi.uuid]);
        generadas++;
      }

      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }

    res.json({ success: true, polizas_generadas: generadas,
      emitidas: emitidas.length, recibidas: recibidas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/contabilidad/polizas/:id
router.delete('/polizas/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM polizas WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════
// BALANZA DE COMPROBACIÓN
// ════════════════════════════════════════════════════════

// POST /api/contabilidad/balanza/calcular
router.post('/balanza/calcular', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.body.rfc);
    const { year, mes } = req.body;

    // Obtener todas las cuentas con movimientos en el periodo
    const [movs] = await pool.query(`
      SELECT pm.cuenta_id, cc.numero_cuenta, cc.descripcion,
             SUM(pm.debe) AS total_debe, SUM(pm.haber) AS total_haber
      FROM poliza_movimientos pm
      JOIN polizas p ON p.id = pm.poliza_id
      JOIN catalogo_cuentas cc ON cc.id = pm.cuenta_id
      WHERE p.contribuyente_id = ? AND p.ejercicio = ? AND p.periodo = ?
      GROUP BY pm.cuenta_id, cc.numero_cuenta, cc.descripcion
    `, [contrib.id, year, mes]);

    // Saldos del mes anterior
    const perAnterior = mes > 1 ? mes - 1 : 12;
    const yearAnterior = mes > 1 ? year : year - 1;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'DELETE FROM balanza_comprobacion WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ?',
        [contrib.id, year, mes]
      );

      for (const m of movs) {
        const [[saldoAnt]] = await conn.query(
          `SELECT saldo_final_debe, saldo_final_haber FROM balanza_comprobacion
           WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ? AND cuenta_id = ?`,
          [contrib.id, yearAnterior, perAnterior, m.cuenta_id]
        );
        const si_debe  = parseFloat(saldoAnt?.saldo_final_debe  || 0);
        const si_haber = parseFloat(saldoAnt?.saldo_final_haber || 0);
        const td = parseFloat(m.total_debe  || 0);
        const th = parseFloat(m.total_haber || 0);

        await conn.query(
          `INSERT INTO balanza_comprobacion
             (contribuyente_id, ejercicio, periodo, cuenta_id, numero_cuenta, descripcion,
              saldo_inicial_debe, saldo_inicial_haber, movimientos_debe, movimientos_haber,
              saldo_final_debe, saldo_final_haber)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [contrib.id, year, mes, m.cuenta_id, m.numero_cuenta, m.descripcion,
           si_debe.toFixed(2), si_haber.toFixed(2), td.toFixed(2), th.toFixed(2),
           (si_debe + td).toFixed(2), (si_haber + th).toFixed(2)]
        );
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }

    res.json({ success: true, cuentas_en_balanza: movs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contabilidad/balanza
router.get('/balanza', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    const { year, mes } = req.query;
    const [rows] = await pool.query(
      `SELECT * FROM balanza_comprobacion WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ?
       ORDER BY numero_cuenta`,
      [contrib.id, year, mes]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/contabilidad/balanza/xml — XML SAT
router.get('/balanza/xml', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    const { year, mes } = req.query;
    const [rows] = await pool.query(
      `SELECT * FROM balanza_comprobacion WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ?
       ORDER BY numero_cuenta`,
      [contrib.id, year, mes]
    );

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" `;
    xml += `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `;
    xml += `xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd" `;
    xml += `RFC="${contrib.rfc}" Mes="${String(mes).padStart(2,'0')}" Anio="${year}" TipoEnvio="N" Version="1.3">\n`;

    for (const r of rows) {
      xml += `  <BCE:Ctas NumCta="${r.numero_cuenta}" SaldoIni="${r.saldo_inicial_debe}" `;
      xml += `Debe="${r.movimientos_debe}" Haber="${r.movimientos_haber}" `;
      xml += `SaldoFin="${r.saldo_final_debe}" />\n`;
    }
    xml += `</BCE:Balanza>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="Balanza_${contrib.rfc}_${year}_${String(mes).padStart(2,'0')}.xml"`);
    res.send(xml);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
