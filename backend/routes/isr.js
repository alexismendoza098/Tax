/**
 * ================================================================
 * ISR — PAGOS PROVISIONALES MENSUALES
 * ================================================================
 * Art. 14 LISR — Personas Morales (PM): tasa fija 30%
 * Art. 106 LISR — Personas Físicas (PF): tabla progresiva
 *
 * POST /api/isr/calcular           — Calcular ISR del periodo
 * GET  /api/isr                    — Listar periodos calculados
 * GET  /api/isr/:year/:mes         — Detalle pago provisional
 * PUT  /api/isr/:year/:mes         — Actualizar (pagado, referencia)
 * GET  /api/isr/anual/:year        — Resumen anual
 * POST /api/isr/config             — Guardar configuración fiscal
 * GET  /api/isr/config             — Obtener configuración fiscal
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');

// ─── Tabla ISR PF (Art. 96 LISR) — ingresos mensuales ───────────────────────
const TABLA_ISR_PF = [
  { hasta: 746.04,   cuota: 0,       tasa: 0.0192 },
  { hasta: 6332.05,  cuota: 14.32,   tasa: 0.0640 },
  { hasta: 11128.01, cuota: 371.83,  tasa: 0.1088 },
  { hasta: 12935.82, cuota: 893.63,  tasa: 0.1600 },
  { hasta: 15487.71, cuota: 1182.88, tasa: 0.1792 },
  { hasta: 31236.49, cuota: 1640.18, tasa: 0.2136 },
  { hasta: 49233.00, cuota: 5004.12, tasa: 0.2352 },
  { hasta: 93993.90, cuota: 9236.89, tasa: 0.3000 },
  { hasta: 125325.20,cuota: 20582.76,tasa: 0.3200 },
  { hasta: 375975.61,cuota: 30613.76,tasa: 0.3400 },
  { hasta: Infinity,  cuota: 115985.35,tasa:0.3500 },
];

function calcularISR_PF(ingresosAcumulados) {
  const row = TABLA_ISR_PF.find(r => ingresosAcumulados <= r.hasta);
  if (!row) return ingresosAcumulados * 0.35;
  const anterior = TABLA_ISR_PF[TABLA_ISR_PF.indexOf(row) - 1];
  const base = ingresosAcumulados - (anterior?.hasta || 0);
  return row.cuota + base * row.tasa;
}

async function getContribId(userId, rfc) {
  let q = 'SELECT id FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc); } else q += ' ORDER BY id LIMIT 1';
  const [r] = await pool.query(q, p);
  return r[0]?.id || null;
}

// ─── GET /api/isr/config ──────────────────────────────────────────────────────
router.get('/config', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [[cfg]] = await pool.query(
      'SELECT * FROM config_fiscal WHERE contribuyente_id = ?', [contribId]
    );
    res.json(cfg || { tipo_persona: 'PM', tasa_isr: 30, coeficiente_utilidad: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/isr/config ─────────────────────────────────────────────────────
router.post('/config', authMiddleware, async (req, res) => {
  try {
    const contribId = req.body.contribuyente_id || await getContribId(req.user.id, req.body.rfc);
    const { tipo_persona = 'PM', tasa_isr = 30, coeficiente_utilidad = 0,
            aplica_resico = 0, periodicidad_pagos = 'mensual',
            ejercicio_base_coef, regimen_fiscal } = req.body;

    await pool.query(`
      INSERT INTO config_fiscal
        (contribuyente_id, tipo_persona, tasa_isr, coeficiente_utilidad, aplica_resico, periodicidad_pagos, ejercicio_base_coef, regimen_fiscal)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        tipo_persona = VALUES(tipo_persona),
        tasa_isr = VALUES(tasa_isr),
        coeficiente_utilidad = VALUES(coeficiente_utilidad),
        aplica_resico = VALUES(aplica_resico),
        periodicidad_pagos = VALUES(periodicidad_pagos),
        ejercicio_base_coef = VALUES(ejercicio_base_coef),
        regimen_fiscal = VALUES(regimen_fiscal)
    `, [contribId, tipo_persona, tasa_isr, coeficiente_utilidad, aplica_resico, periodicidad_pagos, ejercicio_base_coef || null, regimen_fiscal || null]);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/isr/calcular ───────────────────────────────────────────────────
router.post('/calcular', authMiddleware, async (req, res) => {
  try {
    const { year, mes, contribuyente_id, rfc } = req.body;
    if (!year || !mes) return res.status(400).json({ error: 'year y mes requeridos' });
    const y = parseInt(year), m = parseInt(mes);
    if (isNaN(y) || y < 2000 || y > 2100) return res.status(400).json({ error: `año inválido: ${year}` });
    if (isNaN(m) || m < 1 || m > 12)      return res.status(400).json({ error: `mes inválido: ${mes} (debe ser 1-12)` });

    const contribId = contribuyente_id || await getContribId(req.user.id, rfc);
    if (!contribId) return res.status(400).json({ error: 'Contribuyente no encontrado' });

    const [[contrib]] = await pool.query('SELECT rfc FROM contribuyentes WHERE id = ?', [contribId]);
    const [[cfg]] = await pool.query(
      'SELECT * FROM config_fiscal WHERE contribuyente_id = ?', [contribId]
    );
    const tipoPers   = cfg?.tipo_persona || 'PM';
    const tasaISR    = parseFloat(cfg?.tasa_isr || 30) / 100;
    const coefUtil   = parseFloat(cfg?.coeficiente_utilidad || 0);

    // ── Ingresos acumulados del año hasta este mes ──
    const [ingRows] = await pool.query(`
      SELECT COALESCE(SUM(c.total),0) AS ingresos
      FROM comprobantes c
      WHERE c.rfc_emisor = ?
        AND c.tipo_de_comprobante IN ('I','E')
        AND c.estado != 'Cancelado'
        AND YEAR(c.fecha) = ? AND MONTH(c.fecha) <= ?
    `, [contrib.rfc, year, mes]);
    const ingresosAcum = parseFloat(ingRows[0].ingresos || 0);

    // Ingresos solo este mes
    const [ingMesRows] = await pool.query(`
      SELECT COALESCE(SUM(total),0) AS ingresos
      FROM comprobantes
      WHERE rfc_emisor = ?
        AND tipo_de_comprobante IN ('I','E') AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) = ?
    `, [contrib.rfc, year, mes]);
    const ingresosPeriodo = parseFloat(ingMesRows[0].ingresos || 0);

    // ── Deducciones (CFDIs recibidos) ──
    const [dedRows] = await pool.query(`
      SELECT COALESCE(SUM(subtotal),0) AS deducciones
      FROM comprobantes
      WHERE rfc_receptor = ?
        AND tipo_de_comprobante IN ('I','E') AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);
    const deduccionesAcum = parseFloat(dedRows[0].deducciones || 0);

    const [dedMesRows] = await pool.query(`
      SELECT COALESCE(SUM(subtotal),0) AS deducciones
      FROM comprobantes
      WHERE rfc_receptor = ?
        AND tipo_de_comprobante IN ('I','E') AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) = ?
    `, [contrib.rfc, year, mes]);
    const deduccionesPeriodo = parseFloat(dedMesRows[0].deducciones || 0);

    // ── Depreciaciones del periodo ──
    const [[depRow]] = await pool.query(`
      SELECT COALESCE(SUM(depreciacion_periodo),0) AS dep_periodo,
             COALESCE(SUM(depreciacion_acumulada_al_periodo),0) AS dep_acum
      FROM depreciaciones d
      JOIN activos_fijos af ON af.id = d.activo_id
      WHERE af.contribuyente_id = ? AND d.ejercicio = ? AND d.periodo <= ?
    `, [contribId, year, mes]);
    const depreciacionPer  = parseFloat(depRow?.dep_periodo || 0);
    const depreciacionAcum = parseFloat(depRow?.dep_acum || 0);

    // ── ISR Retenido por clientes ──
    const [[retRow]] = await pool.query(`
      SELECT COALESCE(SUM(ir.importe),0) AS isr_retenido
      FROM impuesto_retenciones ir
      JOIN comprobantes c ON c.uuid = ir.uuid
      WHERE c.rfc_emisor = ? AND ir.impuesto = '001'
        AND c.estado != 'Cancelado'
        AND YEAR(c.fecha) = ? AND MONTH(c.fecha) <= ?
    `, [contrib.rfc, year, mes]);
    const isrRetenido = parseFloat(retRow?.isr_retenido || 0);

    // ── Pagos provisionales anteriores (mismo año, meses anteriores) ──
    const [[pagAntRow]] = await pool.query(`
      SELECT COALESCE(SUM(isr_a_pagar),0) AS pagos_ant
      FROM isr_pagos_provisionales
      WHERE contribuyente_id = ? AND ejercicio = ? AND periodo < ? AND estado != 'borrador'
    `, [contribId, year, mes]);
    const pagosPrevios = parseFloat(pagAntRow?.pagos_ant || 0);

    // ── Cálculo ISR ──
    let isrCausado = 0;
    let utilidadFiscal = 0;
    let baseISR = 0;

    if (tipoPers === 'PM') {
      // PM: Art. 14 LISR — Ingresos acumulados × Coef. Utilidad × 30%
      baseISR       = coefUtil > 0
        ? ingresosAcum * coefUtil
        : Math.max(0, ingresosAcum - deduccionesAcum - depreciacionAcum);
      utilidadFiscal = baseISR;
      isrCausado    = baseISR * tasaISR;
    } else {
      // PF: tabla progresiva Art. 96 LISR
      utilidadFiscal = Math.max(0, ingresosAcum - deduccionesAcum - depreciacionAcum);
      baseISR        = utilidadFiscal;
      isrCausado     = calcularISR_PF(utilidadFiscal);
    }

    const isrAPagar = Math.max(0, isrCausado - isrRetenido - pagosPrevios);

    const datos = {
      contribuyente_id: contribId,
      ejercicio: year,
      periodo: mes,
      ingresos_periodo: ingresosPeriodo.toFixed(2),
      ingresos_acumulados: ingresosAcum.toFixed(2),
      deducciones_periodo: deduccionesPeriodo.toFixed(2),
      deducciones_acumuladas: deduccionesAcum.toFixed(2),
      depreciacion_periodo: depreciacionPer.toFixed(2),
      depreciacion_acumulada: depreciacionAcum.toFixed(2),
      ptu_pagada: 0,
      utilidad_fiscal: utilidadFiscal.toFixed(2),
      coeficiente_utilidad: coefUtil,
      base_isr: baseISR.toFixed(2),
      isr_causado: isrCausado.toFixed(2),
      isr_retenido: isrRetenido.toFixed(2),
      isr_pagos_anteriores: pagosPrevios.toFixed(2),
      isr_a_pagar: isrAPagar.toFixed(2),
      tasa_isr: (tasaISR * 100).toFixed(2),
      tipo_persona: tipoPers,
      estado: 'calculado',
    };

    await pool.query(`
      INSERT INTO isr_pagos_provisionales SET ?
      ON DUPLICATE KEY UPDATE
        ingresos_periodo = VALUES(ingresos_periodo),
        ingresos_acumulados = VALUES(ingresos_acumulados),
        deducciones_periodo = VALUES(deducciones_periodo),
        deducciones_acumuladas = VALUES(deducciones_acumuladas),
        depreciacion_periodo = VALUES(depreciacion_periodo),
        depreciacion_acumulada = VALUES(depreciacion_acumulada),
        utilidad_fiscal = VALUES(utilidad_fiscal),
        base_isr = VALUES(base_isr),
        isr_causado = VALUES(isr_causado),
        isr_retenido = VALUES(isr_retenido),
        isr_pagos_anteriores = VALUES(isr_pagos_anteriores),
        isr_a_pagar = VALUES(isr_a_pagar),
        estado = VALUES(estado)
    `, datos);

    res.json({ success: true, datos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/isr ─────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(
      `SELECT ejercicio, periodo, ingresos_periodo, ingresos_acumulados,
              utilidad_fiscal, isr_causado, isr_a_pagar, estado, fecha_pago, tipo_persona
       FROM isr_pagos_provisionales WHERE contribuyente_id = ?
       ORDER BY ejercicio DESC, periodo DESC`,
      [contribId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/isr/anual/:year — DEBE ir ANTES de /:year/:mes ─────────────────
router.get('/anual/:year', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(`
      SELECT *,
        ROUND(isr_causado - isr_retenido - isr_pagos_anteriores, 2) AS verificacion_pagar
      FROM isr_pagos_provisionales
      WHERE contribuyente_id = ? AND ejercicio = ?
      ORDER BY periodo
    `, [contribId, req.params.year]);

    const [[totales]] = await pool.query(`
      SELECT
        ROUND(SUM(ingresos_periodo),2)    AS total_ingresos,
        ROUND(SUM(deducciones_periodo),2) AS total_deducciones,
        ROUND(SUM(isr_causado),2)         AS total_isr_causado,
        ROUND(SUM(isr_a_pagar),2)         AS total_isr_pagado,
        ROUND(SUM(isr_retenido),2)        AS total_isr_retenido
      FROM isr_pagos_provisionales
      WHERE contribuyente_id = ? AND ejercicio = ?
    `, [contribId, req.params.year]);

    res.json({ periodos: rows, totales });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/isr/:year/:mes ──────────────────────────────────────────────────
router.get('/:year/:mes', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [[row]] = await pool.query(
      `SELECT * FROM isr_pagos_provisionales WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ?`,
      [contribId, req.params.year, req.params.mes]
    );
    if (!row) return res.status(404).json({ error: 'No calculado para este periodo' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/isr/:year/:mes — Marcar pagado ─────────────────────────────────
router.put('/:year/:mes', authMiddleware, async (req, res) => {
  try {
    const contribId = req.body.contribuyente_id || await getContribId(req.user.id, req.body.rfc);
    const { estado, fecha_pago, referencia_pago, observaciones } = req.body;
    await pool.query(`
      UPDATE isr_pagos_provisionales
      SET estado = ?, fecha_pago = ?, referencia_pago = ?, observaciones = ?
      WHERE contribuyente_id = ? AND ejercicio = ? AND periodo = ?
    `, [estado || 'pagado', fecha_pago || null, referencia_pago || null,
        observaciones || null, contribId, req.params.year, req.params.mes]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
