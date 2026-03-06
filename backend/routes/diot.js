/**
 * ================================================================
 * DIOT — Declaración Informativa de Operaciones con Terceros
 * ================================================================
 * Conforme al formato SAT DIOT — Anexo 8, A-29
 *
 * POST /api/diot/generar              — Calcular DIOT del periodo
 * GET  /api/diot                      — Listar periodos calculados
 * GET  /api/diot/:year/:mes           — Detalle de un periodo
 * GET  /api/diot/:year/:mes/archivo   — Descargar archivo .txt SAT
 * GET  /api/diot/:year/:mes/excel     — Descargar Excel de revisión
 * DELETE /api/diot/:year/:mes         — Eliminar cálculo del periodo
 * ================================================================
 */

const express    = require('express');
const router     = express.Router();
const pool       = require('../db');
const fs         = require('fs');
const path       = require('path');
const ExcelJS    = require('exceljs');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const DOWNLOADS_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads');

async function getContribId(userId, rfc) {
  let q = 'SELECT id FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc); } else q += ' ORDER BY id LIMIT 1';
  const [r] = await pool.query(q, p);
  return r[0]?.id || null;
}

// ─── POST /api/diot/generar ────────────────────────────────────────────────────
router.post('/generar', authMiddleware, async (req, res) => {
  try {
    const { year, mes, rfc, contribuyente_id } = req.body;
    if (!year || !mes) return res.status(400).json({ error: 'year y mes requeridos' });

    const contribId = contribuyente_id || await getContribId(req.user.id, rfc);
    if (!contribId) return res.status(400).json({ error: 'Contribuyente no encontrado' });

    const [[contrib]] = await pool.query('SELECT rfc FROM contribuyentes WHERE id = ?', [contribId]);

    // Obtener CFDIs recibidos del periodo (tipo I, E) con datos de proveedor
    const [cfdis] = await pool.query(`
      SELECT
        c.uuid,
        c.rfc_emisor            AS rfc_proveedor,
        c.nombre_emisor         AS nombre_proveedor,
        c.subtotal,
        c.total,
        c.total_traslados       AS iva_total,
        c.total_retenciones     AS iva_retenido,
        c.metodo_pago,
        c.estado,
        COALESCE(it.importe, 0) AS iva_16,
        COALESCE(it8.importe, 0) AS iva_8,
        COALESCE(it0.importe, 0) AS iva_0,
        COALESCE(it_ex.importe, 0) AS iva_exento
      FROM comprobantes c
      LEFT JOIN impuesto_traslados it  ON it.uuid = c.uuid AND it.impuesto = '002' AND it.tasa_o_cuota = 0.160000
      LEFT JOIN impuesto_traslados it8 ON it8.uuid = c.uuid AND it8.impuesto = '002' AND it8.tasa_o_cuota = 0.080000
      LEFT JOIN impuesto_traslados it0 ON it0.uuid = c.uuid AND it0.impuesto = '002' AND it0.tasa_o_cuota = 0.000000
      LEFT JOIN impuesto_traslados it_ex ON it_ex.uuid = c.uuid AND it_ex.impuesto = '002' AND it_ex.tipo_factor = 'Exento'
      LEFT JOIN impuesto_retenciones ir ON ir.uuid = c.uuid AND ir.impuesto = '002'
      WHERE c.rfc_receptor = ?
        AND c.tipo_de_comprobante IN ('I','E')
        AND c.estado != 'Cancelado'
        AND YEAR(c.fecha) = ? AND MONTH(c.fecha) = ?
      ORDER BY c.rfc_emisor
    `, [contrib.rfc, year, mes]);

    // Agrupar por proveedor
    const proveedores = {};
    for (const cfdi of cfdis) {
      const key = cfdi.rfc_proveedor || 'XAXX010101000';
      if (!proveedores[key]) {
        proveedores[key] = {
          rfc_proveedor: key,
          nombre_proveedor: cfdi.nombre_proveedor || 'OPERACIONES CON EL PUBLICO EN GENERAL',
          tipo_tercero: key === 'XAXX010101000' ? '15' : (key.match(/^[A-Z]{3,4}\d{6}[A-Z0-9]{3}$/) ? '04' : '05'),
          tipo_operacion: '85',
          valor_actos_16: 0, valor_actos_8: 0, valor_actos_tasa0: 0, valor_actos_exentos: 0,
          iva_pagado_16: 0, iva_pagado_8: 0, iva_no_acreditable: 0,
          iva_importacion: 0, iva_retenido: 0, isr_retenido: 0,
          num_cfdis: 0
        };
      }
      const p = proveedores[key];
      p.num_cfdis++;
      p.valor_actos_16   += parseFloat(cfdi.iva_16  > 0 ? cfdi.subtotal : 0);
      p.valor_actos_8    += parseFloat(cfdi.iva_8   > 0 ? cfdi.subtotal : 0);
      p.valor_actos_tasa0+= parseFloat(cfdi.iva_0   > 0 ? cfdi.subtotal : 0);
      p.valor_actos_exentos += parseFloat(cfdi.iva_exento > 0 ? cfdi.subtotal : 0);
      p.iva_pagado_16    += parseFloat(cfdi.iva_16  || 0);
      p.iva_pagado_8     += parseFloat(cfdi.iva_8   || 0);
      p.iva_retenido     += parseFloat(cfdi.iva_retenido || 0);
    }

    // Insertar / actualizar en BD
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'DELETE FROM diot_proveedores WHERE contribuyente_id = ? AND periodo_year = ? AND periodo_mes = ?',
        [contribId, year, mes]
      );
      for (const p of Object.values(proveedores)) {
        await conn.query(`
          INSERT INTO diot_proveedores
            (contribuyente_id, periodo_year, periodo_mes, rfc_proveedor, nombre_proveedor,
             tipo_tercero, tipo_operacion, valor_actos_tasa0, valor_actos_exentos,
             valor_actos_16, valor_actos_8, iva_pagado_16, iva_pagado_8,
             iva_no_acreditable, iva_importacion, iva_retenido, isr_retenido, num_cfdis, estado)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'calculado')`,
          [contribId, year, mes, p.rfc_proveedor, p.nombre_proveedor,
           p.tipo_tercero, p.tipo_operacion,
           p.valor_actos_tasa0.toFixed(2), p.valor_actos_exentos.toFixed(2),
           p.valor_actos_16.toFixed(2), p.valor_actos_8.toFixed(2),
           p.iva_pagado_16.toFixed(2), p.iva_pagado_8.toFixed(2),
           p.iva_no_acreditable.toFixed(2), p.iva_importacion.toFixed(2),
           p.iva_retenido.toFixed(2), p.isr_retenido.toFixed(2),
           p.num_cfdis]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback(); throw e;
    } finally { conn.release(); }

    res.json({
      success: true,
      periodo: `${year}-${String(mes).padStart(2,'0')}`,
      proveedores: Object.values(proveedores).length,
      cfdis_procesados: cfdis.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/diot — Listar periodos ─────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(`
      SELECT periodo_year, periodo_mes, COUNT(*) AS proveedores,
             SUM(num_cfdis) AS total_cfdis,
             SUM(valor_actos_16 + valor_actos_8 + valor_actos_tasa0 + valor_actos_exentos) AS valor_total,
             SUM(iva_pagado_16 + iva_pagado_8) AS iva_total,
             MAX(generado_at) AS generado_at, MAX(estado) AS estado
      FROM diot_proveedores WHERE contribuyente_id = ?
      GROUP BY periodo_year, periodo_mes ORDER BY periodo_year DESC, periodo_mes DESC
    `, [contribId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/diot/:year/:mes — Detalle ──────────────────────────────────────
router.get('/:year/:mes', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(
      `SELECT * FROM diot_proveedores WHERE contribuyente_id = ? AND periodo_year = ? AND periodo_mes = ?
       ORDER BY rfc_proveedor`,
      [contribId, req.params.year, req.params.mes]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/diot/:year/:mes/archivo — TXT formato SAT ──────────────────────
router.get('/:year/:mes/archivo', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(
      `SELECT * FROM diot_proveedores WHERE contribuyente_id = ? AND periodo_year = ? AND periodo_mes = ?`,
      [contribId, req.params.year, req.params.mes]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sin datos para este periodo' });

    // Formato DIOT SAT: pipe-delimited, campos fijos
    const lines = rows.map(r => [
      r.tipo_tercero,                               // 1. Tipo Tercero
      r.tipo_operacion,                             // 2. Tipo Operación
      r.rfc_proveedor || '',                        // 3. RFC
      '',                                           // 4. ID Fiscal (extranjeros)
      r.nombre_proveedor || '',                     // 5. Nombre/Razón Social
      montoSAT(r.valor_actos_16),                   // 6. Valor actos 16%
      montoSAT(r.valor_actos_8),                    // 7. Valor actos 8%
      montoSAT(r.valor_actos_tasa0),                // 8. Valor actos 0%
      montoSAT(r.valor_actos_exentos),              // 9. Valor actos exentos
      montoSAT(r.iva_no_acreditable),               // 10. IVA no acreditable
      montoSAT(r.iva_importacion),                  // 11. IVA importación
      montoSAT(r.iva_pagado_16),                    // 12. IVA pagado 16%
      montoSAT(r.iva_pagado_8),                     // 13. IVA pagado 8%
      montoSAT(r.iva_retenido),                     // 14. IVA retenido
      montoSAT(r.isr_retenido),                     // 15. ISR retenido
    ].join('|'));

    const filename = `DIOT_${req.params.year}_${String(req.params.mes).padStart(2,'0')}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function montoSAT(val) {
  const n = parseFloat(val) || 0;
  return n === 0 ? '' : Math.round(n).toString();
}

// ─── GET /api/diot/:year/:mes/excel ──────────────────────────────────────────
router.get('/:year/:mes/excel', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [[contrib]] = await pool.query('SELECT rfc, nombre FROM contribuyentes WHERE id = ?', [contribId]);
    const [rows] = await pool.query(
      `SELECT * FROM diot_proveedores WHERE contribuyente_id = ? AND periodo_year = ? AND periodo_mes = ?
       ORDER BY rfc_proveedor`,
      [contribId, req.params.year, req.params.mes]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ETX Tax Recovery';
    const ws = wb.addWorksheet('DIOT');

    ws.columns = [
      { header: 'Tipo Tercero', key: 'tipo_tercero', width: 14 },
      { header: 'RFC Proveedor', key: 'rfc_proveedor', width: 16 },
      { header: 'Nombre', key: 'nombre_proveedor', width: 40 },
      { header: 'Tipo Operación', key: 'tipo_operacion', width: 14 },
      { header: 'Valor Actos 16%', key: 'valor_actos_16', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'Valor Actos 8%', key: 'valor_actos_8', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'Valor Actos 0%', key: 'valor_actos_tasa0', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'Valor Exento', key: 'valor_actos_exentos', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'IVA Pagado 16%', key: 'iva_pagado_16', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'IVA Pagado 8%', key: 'iva_pagado_8', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'IVA Retenido', key: 'iva_retenido', width: 18, style: { numFmt: '#,##0.00' } },
      { header: 'ISR Retenido', key: 'isr_retenido', width: 18, style: { numFmt: '#,##0.00' } },
      { header: '# CFDIs', key: 'num_cfdis', width: 10 },
    ];

    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    rows.forEach(r => ws.addRow(r));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const fname = `DIOT_${contrib.rfc}_${req.params.year}_${String(req.params.mes).padStart(2,'0')}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
