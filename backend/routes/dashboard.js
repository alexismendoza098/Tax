/**
 * ================================================================
 * DASHBOARD EJECUTIVO — ETaxes+ Agente v2
 * ================================================================
 * Endpoint único que agrega KPIs fiscales de todo el sistema.
 * Ideal para la pantalla de inicio/resumen del usuario.
 *
 * GET /api/dashboard          — Resumen completo del contribuyente
 * GET /api/dashboard/alertas  — Alertas fiscales activas
 * GET /api/dashboard/timeline — Actividad reciente (últimos 30 días)
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { ok, fail, serverError } = require('../utils/respond');
const { getContrib } = require('../utils/dbHelpers');

// ── GET /api/dashboard ────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContrib(req.user.id, req.query.rfc);
    if (!contrib) return fail(res, 404, 'Contribuyente no encontrado. Regístralo primero.');

    const cid = contrib.id;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // Ejecutar consultas en paralelo para máximo rendimiento
    const [
      [cfdiStats],
      [ivaStats],
      [polizasStats],
      [activosStats],
      [alertasStats],
      [solicitudesStats],
    ] = await Promise.all([
      // 1. Estadísticas de CFDIs
      pool.query(`
        SELECT
          COUNT(*) AS total_cfdis,
          COUNT(CASE WHEN tipo_de_comprobante = 'I' THEN 1 END) AS ingresos,
          COUNT(CASE WHEN tipo_de_comprobante = 'E' THEN 1 END) AS egresos,
          COUNT(CASE WHEN tipo_de_comprobante = 'P' THEN 1 END) AS pagos,
          COUNT(CASE WHEN tipo_de_comprobante = 'N' THEN 1 END) AS nomina,
          SUM(CASE WHEN tipo_de_comprobante = 'I' THEN total ELSE 0 END) AS monto_ingresos,
          SUM(CASE WHEN tipo_de_comprobante = 'E' THEN total ELSE 0 END) AS monto_egresos,
          COUNT(CASE WHEN estado = 'Cancelado' THEN 1 END) AS cancelados
        FROM comprobantes
        WHERE contribuyente_id = ? AND YEAR(fecha) = ?
      `, [cid, year]),

      // 2. Resumen IVA
      pool.query(`
        SELECT
          SUM(iva_trasladado_pue + iva_trasladado_ppd) AS iva_cobrado,
          SUM(iva_acreditable_pue + iva_acreditable_ppd) AS iva_pagado,
          SUM(saldo_iva) AS saldo_a_pagar
        FROM reportes_iva
        WHERE contribuyente_id = ? AND periodo_year = ?
      `, [cid, year]),

      // 3. Pólizas contables
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN tipo_poliza = 'I' THEN 1 END) AS ingresos,
          COUNT(CASE WHEN tipo_poliza = 'E' THEN 1 END) AS egresos,
          COUNT(CASE WHEN tipo_poliza = 'D' THEN 1 END) AS diario
        FROM polizas
        WHERE contribuyente_id = ? AND ejercicio = ?
      `, [cid, year]).catch(() => [[{ total: 0, ingresos: 0, egresos: 0, diario: 0 }]]),

      // 4. Activos fijos
      pool.query(`
        SELECT
          COUNT(*) AS total,
          SUM(costo_adquisicion) AS valor_original,
          SUM(depreciacion_acumulada) AS depreciacion_acumulada,
          SUM(valor_en_libros) AS valor_libros
        FROM activos_fijos
        WHERE contribuyente_id = ? AND activo = 1
      `, [cid]).catch(() => [[{ total: 0, valor_original: 0, depreciacion_acumulada: 0, valor_libros: 0 }]]),

      // 5. Alertas fiscales activas
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN severidad = 'critica' THEN 1 END) AS criticas,
          COUNT(CASE WHEN severidad = 'alta' THEN 1 END) AS altas
        FROM alertas_fiscales
        WHERE contribuyente_id = ? AND resuelta = 0
      `, [cid]).catch(() => [[{ total: 0, criticas: 0, altas: 0 }]]),

      // 6. Solicitudes SAT
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN estado_solicitud = 'Terminada' THEN 1 END) AS completadas,
          COUNT(CASE WHEN estado_solicitud IN ('Aceptada','EnProceso','Aceptada') THEN 1 END) AS en_proceso,
          MAX(fecha_solicitud) AS ultima_solicitud
        FROM solicitudes_sat
        WHERE rfc = ?
      `, [contrib.rfc]),
    ]);

    ok(res, {
      contribuyente: {
        id:     contrib.id,
        rfc:    contrib.rfc,
        nombre: contrib.nombre,
      },
      periodo: year,
      cfdis: {
        total:          cfdiStats[0]?.total_cfdis    || 0,
        ingresos:       cfdiStats[0]?.ingresos       || 0,
        egresos:        cfdiStats[0]?.egresos        || 0,
        pagos:          cfdiStats[0]?.pagos          || 0,
        nomina:         cfdiStats[0]?.nomina         || 0,
        monto_ingresos: parseFloat(cfdiStats[0]?.monto_ingresos || 0),
        monto_egresos:  parseFloat(cfdiStats[0]?.monto_egresos  || 0),
        cancelados:     cfdiStats[0]?.cancelados     || 0,
      },
      iva: {
        cobrado:     parseFloat(ivaStats[0]?.iva_cobrado   || 0),
        pagado:      parseFloat(ivaStats[0]?.iva_pagado    || 0),
        saldo_pagar: parseFloat(ivaStats[0]?.saldo_a_pagar || 0),
      },
      contabilidad: {
        polizas:         polizasStats[0]?.total     || 0,
        polizas_ingreso: polizasStats[0]?.ingresos  || 0,
        polizas_egreso:  polizasStats[0]?.egresos   || 0,
        polizas_diario:  polizasStats[0]?.diario    || 0,
      },
      activos: {
        total:                 activosStats[0]?.total                 || 0,
        valor_original:        parseFloat(activosStats[0]?.valor_original       || 0),
        depreciacion_acumulada:parseFloat(activosStats[0]?.depreciacion_acumulada|| 0),
        valor_libros:          parseFloat(activosStats[0]?.valor_libros          || 0),
      },
      alertas: {
        total:   alertasStats[0]?.total   || 0,
        criticas:alertasStats[0]?.criticas|| 0,
        altas:   alertasStats[0]?.altas   || 0,
      },
      sat: {
        solicitudes:      solicitudesStats[0]?.total           || 0,
        completadas:      solicitudesStats[0]?.completadas     || 0,
        en_proceso:       solicitudesStats[0]?.en_proceso      || 0,
        ultima_solicitud: solicitudesStats[0]?.ultima_solicitud|| null,
      },
    });
  } catch (e) {
    serverError(res, e, 'Dashboard');
  }
});

// ── GET /api/dashboard/alertas ────────────────────────────────────────────────
router.get('/alertas', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContrib(req.user.id, req.query.rfc);
    if (!contrib) return fail(res, 404, 'Contribuyente no encontrado');

    const [rows] = await pool.query(`
      SELECT tipo, severidad, descripcion, monto, fecha_alerta, referencia_id
      FROM alertas_fiscales
      WHERE contribuyente_id = ? AND resuelta = 0
      ORDER BY
        FIELD(severidad, 'critica','alta','media','baja'),
        fecha_alerta DESC
      LIMIT 50
    `, [contrib.id]);

    ok(res, { alertas: rows, total: rows.length });
  } catch (e) {
    serverError(res, e, 'Dashboard Alertas');
  }
});

// ── GET /api/dashboard/timeline ───────────────────────────────────────────────
router.get('/timeline', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContrib(req.user.id, req.query.rfc);
    if (!contrib) return fail(res, 404, 'Contribuyente no encontrado');

    // Actividad de los últimos 30 días
    const [rows] = await pool.query(`
      SELECT
        DATE(fecha) AS dia,
        COUNT(*) AS cfdis,
        SUM(CASE WHEN tipo_de_comprobante = 'I' THEN total ELSE 0 END) AS ingresos,
        SUM(CASE WHEN tipo_de_comprobante = 'E' THEN total ELSE 0 END) AS egresos
      FROM comprobantes
      WHERE contribuyente_id = ?
        AND fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY DATE(fecha)
      ORDER BY dia ASC
    `, [contrib.id]);

    ok(res, { timeline: rows, dias: rows.length });
  } catch (e) {
    serverError(res, e, 'Dashboard Timeline');
  }
});

module.exports = router;
