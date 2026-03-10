/**
 * ================================================================
 * MOTOR FISCAL COMPLETO — ETX Tax Recovery
 * ================================================================
 * Basado en: Ley del IVA, LISR, CFF, CFDI 4.0, SAT 2025
 * ================================================================
 * GET /api/fiscal/resumen-iva        — Dashboard IVA mensual
 * GET /api/fiscal/estado-sat         — Semáforo de cumplimiento SAT
 * GET /api/fiscal/deducibilidad      — Análisis ISR deducibilidad
 * GET /api/fiscal/efos-check         — Verificar proveedores vs lista negra
 * GET /api/fiscal/declaracion-previa — Resumen tipo declaración mensual
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');

// ── Helper: obtener contribuyente_id del usuario ─────────────────────────────
async function getContribuyenteId(userId, rfc) {
  let query = 'SELECT id FROM contribuyentes WHERE usuario_id = ?';
  const params = [userId];
  if (rfc) { query += ' AND rfc = ?'; params.push(rfc); }
  else query += ' ORDER BY id LIMIT 1';
  const [rows] = await pool.query(query, params);
  return rows[0]?.id || null;
}

// ── Filtro de fecha ──────────────────────────────────────────────────────────
function buildDateFilter(year, mes, prefix = 'c') {
  const parts = [], params = [];
  if (year && year !== 'todos') { parts.push(`YEAR(${prefix}.fecha) = ?`); params.push(parseInt(year)); }
  if (mes  && mes  !== 'todos') { parts.push(`MONTH(${prefix}.fecha) = ?`); params.push(parseInt(mes)); }
  return {
    sql: parts.length ? 'AND ' + parts.join(' AND ') : '',
    params
  };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/fiscal/resumen-iva
// Dashboard completo de IVA: trasladado, acreditable, retenido, saldo
// ════════════════════════════════════════════════════════════════════════════
router.get('/resumen-iva', authMiddleware, async (req, res) => {
  try {
    const { year, mes, contribuyente_id, rfc } = req.query;
    const contribId = contribuyente_id
      || await getContribuyenteId(req.user.id, rfc);

    if (!contribId) return res.json({ error: 'Sin contribuyente registrado', data: null });

    const df = buildDateFilter(year, mes);

    // ── IVA Trasladado (facturas EMITIDAS tipo I vigentes) ──────────────────
    const [emitidas] = await pool.query(`
      SELECT
        YEAR(c.fecha)   AS anio,
        MONTH(c.fecha)  AS mes,
        COUNT(*)        AS facturas,
        ROUND(SUM(c.total),2)            AS subtotal_total,
        ROUND(SUM(
          CASE
            WHEN c.estado = 'Cancelado' THEN 0
            WHEN c.tipo_de_comprobante = 'E' THEN -1 * COALESCE(c.total_traslados,0)
            WHEN c.tipo_de_comprobante = 'I' AND c.metodo_pago = 'PPD' THEN
              ROUND(COALESCE(c.total_traslados,0)
                * LEAST(1.0, COALESCE(pd.total_pagado,0) / NULLIF(c.total,0)), 2)
            ELSE COALESCE(c.total_traslados,0)
          END
        ),2) AS iva_trasladado_real,
        ROUND(SUM(COALESCE(c.total_traslados,0)),2) AS iva_trasladado_nominal,
        ROUND(SUM(COALESCE(c.total_retenciones,0)),2) AS iva_retenido_emitido,
        COUNT(CASE WHEN c.estado='Cancelado' THEN 1 END) AS cancelados,
        COUNT(CASE WHEN c.metodo_pago='PPD'
              AND COALESCE(pd.total_pagado,0) < c.total * 0.99
              AND c.estado='Vigente' THEN 1 END) AS ppd_pendientes
      FROM comprobantes c
      LEFT JOIN (
        SELECT id_documento, SUM(monto_dr) AS total_pagado
        FROM pago_doctos GROUP BY id_documento
      ) pd ON pd.id_documento = c.uuid
      WHERE c.contribuyente_id = ?
        AND c.tipo_de_comprobante IN ('I','E')
        ${df.sql}
    `, [contribId, ...df.params]);

    // ── IVA Acreditable (facturas RECIBIDAS — si existen en DB) ─────────────
    // Nota: facturas recibidas tienen rfc_receptor = RFC del contribuyente
    const [[contrib]] = await pool.query('SELECT rfc FROM contribuyentes WHERE id = ?', [contribId]);
    const rfcPropio = contrib?.rfc;

    const [recibidas] = await pool.query(`
      SELECT
        COUNT(*)  AS facturas_recibidas,
        ROUND(SUM(COALESCE(c.total_traslados,0)),2) AS iva_acreditable_nominal,
        ROUND(SUM(
          CASE
            WHEN c.estado='Cancelado' THEN 0
            WHEN c.metodo_pago='PPD' THEN
              ROUND(COALESCE(c.total_traslados,0)
                * LEAST(1.0, COALESCE(pd.total_pagado,0)/NULLIF(c.total,0)),2)
            ELSE COALESCE(c.total_traslados,0)
          END
        ),2) AS iva_acreditable_real,
        ROUND(SUM(COALESCE(c.total_retenciones,0)),2) AS iva_retenido_recibido
      FROM comprobantes c
      LEFT JOIN (
        SELECT id_documento, SUM(monto_dr) AS total_pagado
        FROM pago_doctos GROUP BY id_documento
      ) pd ON pd.id_documento = c.uuid
      WHERE c.rfc_receptor = ?
        AND c.tipo_de_comprobante = 'I'
        AND c.estado != 'Cancelado'
        ${df.sql}
    `, [rfcPropio, ...df.params]);

    // ── Complementos de pago ─────────────────────────────────────────────────
    const [[compPago]] = await pool.query(`
      SELECT COUNT(*) AS total_complementos,
             ROUND(SUM(COALESCE(pd.monto_dr,0)),2) AS monto_pagado
      FROM comprobantes c
      JOIN pago_doctos pd ON pd.uuid = c.uuid
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante = 'P'
        ${df.sql}
    `, [contribId, ...df.params]);

    // ── Nómina (ISR deducible) ───────────────────────────────────────────────
    const [[nomina]] = await pool.query(`
      SELECT COUNT(*) AS total_nominas, ROUND(SUM(total),2) AS monto_nomina
      FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante = 'N'
        ${df.sql}
    `, [contribId, ...df.params]);

    // ── Calcular saldo IVA ───────────────────────────────────────────────────
    const ivaTrasladado   = parseFloat(emitidas[0]?.iva_trasladado_real   || 0);
    const ivaAcreditable  = parseFloat(recibidas[0]?.iva_acreditable_real  || 0);
    const ivaRetenido     = parseFloat(emitidas[0]?.iva_retenido_emitido   || 0)
                          + parseFloat(recibidas[0]?.iva_retenido_recibido  || 0);
    const ivaNeto         = Math.round((ivaTrasladado - ivaAcreditable - ivaRetenido) * 100) / 100;
    const tieneRecibidas  = parseFloat(recibidas[0]?.facturas_recibidas || 0) > 0;

    res.json({
      periodo: { year: year || 'Todos', mes: mes || 'Todos' },
      rfc: rfcPropio,
      emitidas: {
        total_facturas:         parseInt(emitidas[0]?.facturas || 0),
        iva_trasladado_real:    ivaTrasladado,
        iva_trasladado_nominal: parseFloat(emitidas[0]?.iva_trasladado_nominal || 0),
        cancelados:             parseInt(emitidas[0]?.cancelados || 0),
        ppd_pendientes:         parseInt(emitidas[0]?.ppd_pendientes || 0),
        subtotal_total:         parseFloat(emitidas[0]?.subtotal_total || 0),
      },
      recibidas: {
        total_facturas:         parseInt(recibidas[0]?.facturas_recibidas || 0),
        iva_acreditable_real:   ivaAcreditable,
        iva_acreditable_nominal:parseFloat(recibidas[0]?.iva_acreditable_nominal || 0),
        tiene_datos:            tieneRecibidas,
      },
      retenciones: {
        total_retenido:         Math.round(ivaRetenido * 100) / 100,
      },
      complementos_pago: {
        total:  parseInt(compPago?.total_complementos || 0),
        monto:  parseFloat(compPago?.monto_pagado || 0),
      },
      nomina: {
        total_nominas:  parseInt(nomina?.total_nominas || 0),
        monto_nomina:   parseFloat(nomina?.monto_nomina || 0),
      },
      saldo_iva: {
        iva_trasladado:  ivaTrasladado,
        iva_acreditable: ivaAcreditable,
        iva_retenido:    Math.round(ivaRetenido * 100) / 100,
        iva_neto:        ivaNeto,
        status:          ivaNeto > 0 ? 'A_PAGAR'
                       : ivaNeto < 0 ? 'SALDO_FAVOR'
                       : 'EQUILIBRADO',
        monto_abs:       Math.abs(ivaNeto),
        sin_recibidas:   !tieneRecibidas,
      }
    });

  } catch (e) {
    console.error('[Fiscal] resumen-iva:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/fiscal/estado-sat
// Semáforo de cumplimiento: detecta 10 tipos de alertas fiscales
// ════════════════════════════════════════════════════════════════════════════
router.get('/estado-sat', authMiddleware, async (req, res) => {
  try {
    const { contribuyente_id, rfc, year } = req.query;
    const contribId = contribuyente_id || await getContribuyenteId(req.user.id, rfc);
    if (!contribId) return res.json({ alertas: [], score: 100 });

    const yearVal = parseInt(year);
    const yearFilter = year && !isNaN(yearVal) ? `AND YEAR(c.fecha) = ${yearVal}` : '';
    const alertas = [];

    // 1. Facturas PPD sin complemento de pago
    const [[ppd]] = await pool.query(`
      SELECT COUNT(*) as n FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante='I'
        AND c.metodo_pago='PPD' AND c.estado='Vigente'
        AND NOT EXISTS (SELECT 1 FROM pago_doctos pd WHERE pd.id_documento = c.uuid)
        ${yearFilter}
    `, [contribId]);
    if (ppd.n > 0) alertas.push({
      tipo: 'PPD_SIN_COMPLEMENTO',
      nivel: 'error',
      titulo: 'Facturas PPD sin Complemento de Pago',
      detalle: `${ppd.n} factura(s) con método PPD no tienen complemento de pago registrado. El IVA de estas facturas NO es acreditable hasta recibir el complemento (Art. 1-B LIVA).`,
      cantidad: ppd.n, accion: 'Solicitar complementos de pago a tus clientes'
    });

    // 2. Facturas canceladas con alto monto (posible inconsistencia)
    const [[cancelAlto]] = await pool.query(`
      SELECT COUNT(*) as n, ROUND(SUM(total),2) as monto FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.estado='Cancelado'
        AND c.total > 50000 ${yearFilter}
    `, [contribId]);
    if (cancelAlto.n > 0) alertas.push({
      tipo: 'CANCELACIONES_ALTO_MONTO',
      nivel: 'warning',
      titulo: 'Cancelaciones de Alto Monto',
      detalle: `${cancelAlto.n} factura(s) canceladas por $${Number(cancelAlto.monto).toLocaleString('es-MX')} en total. Verificar que ya no se hayan acreditado en declaraciones previas.`,
      cantidad: cancelAlto.n, accion: 'Revisar en declaraciones mensuales'
    });

    // 3. Facturas sin nombre de receptor válido
    const [[sinReceptor]] = await pool.query(`
      SELECT COUNT(*) as n FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante='I'
        AND (c.rfc_receptor IS NULL OR c.rfc_receptor='XAXX010101000' OR c.nombre_receptor IS NULL)
        AND c.estado='Vigente' ${yearFilter}
    `, [contribId]);
    if (sinReceptor.n > 0) alertas.push({
      tipo: 'RFC_PUBLICO_GENERAL',
      nivel: 'info',
      titulo: 'Facturas a Público General (XAXX)',
      detalle: `${sinReceptor.n} factura(s) emitida(s) a RFC genérico XAXX010101000. Estas facturas tienen restricciones de deducibilidad para el receptor.`,
      cantidad: sinReceptor.n, accion: 'Verificar que el cliente no requiera factura nominativa'
    });

    // 4. Facturas en moneda extranjera sin tipo de cambio
    const [[sinTC]] = await pool.query(`
      SELECT COUNT(*) as n FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.moneda != 'MXN'
        AND (c.tipo_cambio IS NULL OR c.tipo_cambio <= 0 OR c.tipo_cambio = 1)
        AND c.estado='Vigente' ${yearFilter}
    `, [contribId]);
    if (sinTC.n > 0) alertas.push({
      tipo: 'MONEDA_EXTRANJERA_SIN_TC',
      nivel: 'warning',
      titulo: 'Facturas en Moneda Extranjera sin Tipo de Cambio',
      detalle: `${sinTC.n} factura(s) en moneda extranjera con tipo de cambio incorrecto. El IVA se calcula al tipo de cambio del día de emisión (Art. 20 CFF).`,
      cantidad: sinTC.n, accion: 'Verificar tipo de cambio en XMLs'
    });

    // 5. Período sin actividad (meses sin facturas en el año)
    if (year) {
      const [mesesConFacturas] = await pool.query(`
        SELECT DISTINCT MONTH(fecha) as mes FROM comprobantes
        WHERE contribuyente_id = ? AND YEAR(fecha) = ? AND estado='Vigente'
      `, [contribId, parseInt(year)]);
      const mesesActivos = mesesConFacturas.map(r => r.mes);
      const mesActual = new Date().getFullYear() === parseInt(year) ? new Date().getMonth() + 1 : 12;
      const mesesSinActividad = [];
      for (let m = 1; m <= mesActual; m++) {
        if (!mesesActivos.includes(m)) mesesSinActividad.push(m);
      }
      if (mesesSinActividad.length > 2) {
        const nombMeses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        alertas.push({
          tipo: 'MESES_SIN_ACTIVIDAD',
          nivel: 'info',
          titulo: 'Meses sin Actividad Registrada',
          detalle: `Sin facturas en: ${mesesSinActividad.map(m => nombMeses[m-1]).join(', ')}. Considera presentar declaraciones en cero si no hubo actividad.`,
          cantidad: mesesSinActividad.length, accion: 'Presentar declaraciones en cero'
        });
      }
    }

    // 6. Facturas de nómina (verificar pagos de ISR)
    const [[nomina]] = await pool.query(`
      SELECT COUNT(*) as n, ROUND(SUM(total),2) as monto FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante='N' ${yearFilter}
    `, [contribId]);
    if (nomina.n > 0) alertas.push({
      tipo: 'NOMINA_REGISTRADA',
      nivel: 'ok',
      titulo: 'Nómina Registrada Correctamente',
      detalle: `${nomina.n} CFDI(s) de nómina por $${Number(nomina.monto).toLocaleString('es-MX')}. Verificar retenciones ISR de trabajadores en la declaración mensual.`,
      cantidad: nomina.n, accion: 'Verificar entero de retenciones ISR'
    });

    // 7. Notas de crédito (egresos)
    const [[egresos]] = await pool.query(`
      SELECT COUNT(*) as n, ROUND(SUM(total),2) as monto FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante='E'
        AND c.estado='Vigente' ${yearFilter}
    `, [contribId]);
    if (egresos.n > 0) alertas.push({
      tipo: 'NOTAS_CREDITO',
      nivel: 'info',
      titulo: 'Notas de Crédito Emitidas',
      detalle: `${egresos.n} nota(s) de crédito por $${Number(egresos.monto).toLocaleString('es-MX')}. Estas reducen el IVA trasladado del período correspondiente.`,
      cantidad: egresos.n, accion: 'Aplicar en declaración correspondiente'
    });

    // 8. Sin facturas recibidas (no hay IVA acreditable)
    const [[recibidas]] = await pool.query(`
      SELECT COUNT(*) as n FROM comprobantes c
      WHERE c.rfc_receptor = (SELECT rfc FROM contribuyentes WHERE id = ?)
        AND c.tipo_de_comprobante='I' AND c.estado='Vigente' ${yearFilter}
    `, [contribId]);
    if (recibidas.n === 0) alertas.push({
      tipo: 'SIN_FACTURAS_RECIBIDAS',
      nivel: 'warning',
      titulo: 'Sin Facturas de Proveedores (Recibidas)',
      detalle: 'No hay facturas de proveedores en el sistema. Sin IVA acreditable registrado — esto significa que se está calculando solo el IVA trasladado. Descarga tus CFDIs Recibidos del SAT para un análisis completo.',
      cantidad: 0, accion: 'Descargar CFDIs Recibidos en el Paso 2'
    });

    // 9. Facturas con IVA 0 (posibles exentos no declarados)
    const [[ivaZero]] = await pool.query(`
      SELECT COUNT(*) as n FROM comprobantes c
      WHERE c.contribuyente_id = ? AND c.tipo_de_comprobante='I'
        AND c.estado='Vigente' AND c.total > 0
        AND (c.total_traslados IS NULL OR c.total_traslados = 0)
        ${yearFilter}
    `, [contribId]);
    if (ivaZero.n > 3) alertas.push({
      tipo: 'FACTURAS_IVA_CERO',
      nivel: 'info',
      titulo: 'Facturas sin IVA (Exentas o Tasa 0%)',
      detalle: `${ivaZero.n} factura(s) sin monto de IVA. Pueden ser actividades exentas (Art. 15 LIVA) o exportaciones (tasa 0%). Verificar régimen aplicable.`,
      cantidad: ivaZero.n, accion: 'Verificar si aplica IVA o actividad exenta'
    });

    // 10. Score de salud fiscal (0-100)
    const errores   = alertas.filter(a => a.nivel === 'error').length;
    const warnings  = alertas.filter(a => a.nivel === 'warning').length;
    const score     = Math.max(0, 100 - (errores * 20) - (warnings * 8));
    const estado    = score >= 80 ? 'VERDE' : score >= 50 ? 'AMARILLO' : 'ROJO';

    res.json({ alertas, score, estado, resumen: {
      errores, warnings,
      infos:   alertas.filter(a => a.nivel === 'info').length,
      oks:     alertas.filter(a => a.nivel === 'ok').length,
    }});

  } catch (e) {
    console.error('[Fiscal] estado-sat:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/fiscal/deducibilidad
// Análisis ISR: gastos deducibles, no deducibles, límites
// ════════════════════════════════════════════════════════════════════════════
router.get('/deducibilidad', authMiddleware, async (req, res) => {
  try {
    const { contribuyente_id, rfc, year } = req.query;
    const contribId = contribuyente_id || await getContribuyenteId(req.user.id, rfc);
    if (!contribId) return res.json({ error: 'Sin contribuyente' });

    const yearVal = parseInt(year);
    const yearFilter = year && !isNaN(yearVal) ? `AND YEAR(fecha) = ${yearVal}` : '';

    // Ingresos totales (emitidos)
    const [[ingresos]] = await pool.query(`
      SELECT ROUND(SUM(subtotal),2) as total_ingresos,
             COUNT(*) as facturas
      FROM comprobantes
      WHERE contribuyente_id = ? AND tipo_de_comprobante='I'
        AND estado='Vigente' ${yearFilter}
    `, [contribId]);

    // Gastos por tipo de comprobante recibido
    // (si tienes recibidos, si no, usamos nómina + notas)
    const [[rfcRow]] = await pool.query('SELECT rfc FROM contribuyentes WHERE id = ?', [contribId]);
    const rfcPropio = rfcRow?.rfc;

    const [gastos] = await pool.query(`
      SELECT
        tipo_de_comprobante,
        COUNT(*) as facturas,
        ROUND(SUM(subtotal),2) as subtotal,
        ROUND(SUM(total),2) as total,
        ROUND(SUM(COALESCE(total_traslados,0)),2) as iva
      FROM comprobantes
      WHERE rfc_receptor = ? AND estado='Vigente' ${yearFilter}
      GROUP BY tipo_de_comprobante
    `, [rfcPropio]);

    // Nómina propia
    const [[nominaPropia]] = await pool.query(`
      SELECT COUNT(*) as n, ROUND(SUM(total),2) as monto
      FROM comprobantes
      WHERE contribuyente_id = ? AND tipo_de_comprobante='N' ${yearFilter}
    `, [contribId]);

    // Facturas de arrendamiento recibidas (deducibles al 100%)
    // Facturas de servicios profesionales (deducibles al 100% con retención)
    const totalIngresos  = parseFloat(ingresos.total_ingresos || 0);
    const gastoTotal     = gastos.reduce((s, g) => s + parseFloat(g.subtotal || 0), 0);
    const nominaMonto    = parseFloat(nominaPropia.monto || 0);
    const totalDeducible = Math.round((gastoTotal + nominaMonto) * 100) / 100;

    // Límite deducibilidad (Art. 28 LISR):
    // - Gastos en efectivo > $2,000 NO deducibles
    // - Viáticos: 50% deducible
    // Nota: sin info de forma de pago detallada, estimamos conservadoramente

    const porcentajeDeducible = totalIngresos > 0
      ? Math.min(100, Math.round((totalDeducible / totalIngresos) * 100))
      : 0;

    // ISR estimado (tasa promedio 30% personas morales / 35% personas físicas)
    const baseGravable = Math.max(0, totalIngresos - totalDeducible);
    const isrEstimado  = Math.round(baseGravable * 0.30 * 100) / 100;

    res.json({
      ingresos: {
        total:    totalIngresos,
        facturas: parseInt(ingresos.facturas || 0)
      },
      gastos_deducibles: {
        total:              totalDeducible,
        por_tipo:           gastos,
        nomina:             nominaMonto,
        porcentaje_sobre_ingresos: porcentajeDeducible
      },
      estimacion_isr: {
        base_gravable:  baseGravable,
        isr_estimado:   isrEstimado,
        nota: 'Estimación con tasa 30%. Consulte a su contador para cálculo preciso.'
      },
      sin_datos_recibidas: gastos.length === 0
    });

  } catch (e) {
    console.error('[Fiscal] deducibilidad:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/fiscal/declaracion-previa
// Resumen estilo declaración mensual — todas las cifras clave
// ════════════════════════════════════════════════════════════════════════════
router.get('/declaracion-previa', authMiddleware, async (req, res) => {
  try {
    const { contribuyente_id, rfc, year } = req.query;
    const contribId = contribuyente_id || await getContribuyenteId(req.user.id, rfc);
    if (!contribId) return res.json({ error: 'Sin contribuyente' });

    const yearVal = parseInt(year);
    const yearFilter = year && !isNaN(yearVal) ? `AND YEAR(fecha) = ${yearVal}` : '';
    const [[contrib]] = await pool.query('SELECT rfc, nombre FROM contribuyentes WHERE id = ?', [contribId]);

    // Resumen mes a mes
    const [mensual] = await pool.query(`
      SELECT
        MONTH(c.fecha) as mes,
        YEAR(c.fecha)  as anio,
        COUNT(CASE WHEN c.tipo_de_comprobante='I' AND c.estado='Vigente' THEN 1 END) as facturas_emitidas,
        ROUND(SUM(CASE WHEN c.tipo_de_comprobante='I' AND c.estado='Vigente'
          THEN COALESCE(c.total_traslados,0) ELSE 0 END),2) AS iva_trasladado,
        ROUND(SUM(CASE WHEN c.tipo_de_comprobante='E' AND c.estado='Vigente'
          THEN COALESCE(c.total_traslados,0) ELSE 0 END),2) AS iva_notas_credito,
        ROUND(SUM(CASE WHEN c.tipo_de_comprobante='I' AND c.estado='Vigente'
          THEN c.subtotal ELSE 0 END),2) AS ingresos_subtotal,
        ROUND(SUM(CASE WHEN c.tipo_de_comprobante='N' THEN c.total ELSE 0 END),2) AS nomina,
        COUNT(CASE WHEN c.estado='Cancelado' THEN 1 END) as cancelados,
        COUNT(CASE WHEN c.tipo_de_comprobante='P' THEN 1 END) as comp_pago
      FROM comprobantes c
      WHERE c.contribuyente_id = ? ${yearFilter}
      GROUP BY YEAR(c.fecha), MONTH(c.fecha)
      ORDER BY anio, mes
    `, [contribId]);

    // Totales anuales
    const totales = mensual.reduce((acc, m) => ({
      facturas_emitidas:  acc.facturas_emitidas + parseInt(m.facturas_emitidas || 0),
      iva_trasladado:     acc.iva_trasladado    + parseFloat(m.iva_trasladado || 0),
      iva_notas_credito:  acc.iva_notas_credito + parseFloat(m.iva_notas_credito || 0),
      ingresos_subtotal:  acc.ingresos_subtotal + parseFloat(m.ingresos_subtotal || 0),
      nomina:             acc.nomina            + parseFloat(m.nomina || 0),
    }), { facturas_emitidas:0, iva_trasladado:0, iva_notas_credito:0, ingresos_subtotal:0, nomina:0 });

    const ivaTrasladadoNeto = Math.round((totales.iva_trasladado - totales.iva_notas_credito) * 100) / 100;

    const mesesNombre = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
                         'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

    res.json({
      contribuyente: contrib,
      year: year || 'Todos',
      mensual: mensual.map(m => ({
        ...m,
        mes_nombre: mesesNombre[m.mes],
        iva_neto_mes: Math.round((parseFloat(m.iva_trasladado||0) - parseFloat(m.iva_notas_credito||0)) * 100) / 100
      })),
      totales: {
        ...totales,
        iva_trasladado:       Math.round(totales.iva_trasladado * 100) / 100,
        iva_trasladado_neto:  ivaTrasladadoNeto,
        ingresos_subtotal:    Math.round(totales.ingresos_subtotal * 100) / 100,
      }
    });

  } catch (e) {
    console.error('[Fiscal] declaracion-previa:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/fiscal/efos-check
// Verifica proveedores contra patrones de riesgo EFOS/EDOS
// (sin conexión a internet — análisis local de patrones)
// ════════════════════════════════════════════════════════════════════════════
router.get('/efos-check', authMiddleware, async (req, res) => {
  try {
    const { contribuyente_id, rfc } = req.query;
    const contribId = contribuyente_id || await getContribuyenteId(req.user.id, rfc);
    if (!contribId) return res.json({ proveedores_riesgo: [], total_revisados: 0 });

    const [[contrib]] = await pool.query('SELECT rfc FROM contribuyentes WHERE id = ?', [contribId]);
    const rfcPropio = contrib?.rfc;

    // Obtener proveedores únicos de facturas recibidas
    const [proveedores] = await pool.query(`
      SELECT
        c.rfc_emisor,
        c.nombre_emisor,
        COUNT(*) as num_facturas,
        ROUND(SUM(c.total),2) as monto_total,
        ROUND(SUM(COALESCE(c.total_traslados,0)),2) as iva_total,
        MIN(c.fecha) as primera_factura,
        MAX(c.fecha) as ultima_factura
      FROM comprobantes c
      WHERE c.rfc_receptor = ? AND c.tipo_de_comprobante='I'
        AND c.estado='Vigente'
      GROUP BY c.rfc_emisor, c.nombre_emisor
      ORDER BY monto_total DESC
    `, [rfcPropio]);

    // Análisis de patrones de riesgo (sin base de datos EFOS externa)
    const rfc_regex = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
    const riesgo = [];

    for (const p of proveedores) {
      const alertas_prov = [];

      // RFC con formato inválido
      if (!p.rfc_emisor || !rfc_regex.test(p.rfc_emisor)) {
        alertas_prov.push({ tipo: 'RFC_INVALIDO', msg: 'RFC con formato incorrecto' });
      }
      // Sin nombre registrado
      if (!p.nombre_emisor || p.nombre_emisor.trim().length < 3) {
        alertas_prov.push({ tipo: 'SIN_NOMBRE', msg: 'Sin nombre de emisor en CFDI' });
      }
      // Monto muy alto con pocas facturas (patrón EFOS común)
      if (p.num_facturas <= 2 && parseFloat(p.monto_total) > 500000) {
        alertas_prov.push({ tipo: 'MONTO_ALTO_POCAS_FACTURAS', msg: `$${Number(p.monto_total).toLocaleString('es-MX')} en solo ${p.num_facturas} factura(s)` });
      }
      // IVA desproporcionado (>16.1% del total = error)
      const pctIva = parseFloat(p.monto_total) > 0
        ? (parseFloat(p.iva_total) / parseFloat(p.monto_total)) * 100 : 0;
      if (pctIva > 17.5) {
        alertas_prov.push({ tipo: 'IVA_EXCESIVO', msg: `IVA del ${pctIva.toFixed(1)}% (normal: 16%)` });
      }
      // RFC del proveedor mismo que el contribuyente (auto-facturas)
      if (p.rfc_emisor === rfcPropio) {
        alertas_prov.push({ tipo: 'AUTO_FACTURA', msg: 'Factura emitida y recibida por el mismo RFC' });
      }

      if (alertas_prov.length > 0) {
        riesgo.push({ ...p, alertas: alertas_prov,
          nivel_riesgo: alertas_prov.some(a => ['RFC_INVALIDO','AUTO_FACTURA'].includes(a.tipo)) ? 'ALTO' : 'MEDIO'
        });
      }
    }

    res.json({
      total_revisados:     proveedores.length,
      proveedores_riesgo:  riesgo,
      proveedores_ok:      proveedores.length - riesgo.length,
      nota: 'Análisis basado en patrones locales. Para verificación EFOS definitiva consulte: omawww.sat.gob.mx (Art. 69-B CFF)'
    });

  } catch (e) {
    console.error('[Fiscal] efos-check:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
