/**
 * MOTOR DE AUDITORÍA FISCAL — ETX Tax Recovery
 * Detecta 7 tipos de errores humanos en CFDIs y genera DIOT
 */
const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// =====================================================================
// HELPERS
// =====================================================================
const fmt = (n) => parseFloat((n || 0).toFixed(2));

// =====================================================================
// GET /api/auditoria/salud?contribuyente_id=X&year=Y&mes=M
// Corre las 7 detecciones y devuelve el reporte de salud fiscal
// =====================================================================
router.get('/salud', async (req, res) => {
  try {
    const { contribuyente_id, year, mes } = req.query;
    if (!contribuyente_id) {
      return res.status(400).json({ error: 'contribuyente_id es requerido' });
    }

    // Obtener RFC del contribuyente
    const [contribRows] = await pool.query(
      'SELECT rfc, nombre FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contribRows.length === 0) {
      return res.status(404).json({ error: 'Contribuyente no encontrado' });
    }
    const { rfc, nombre } = contribRows[0];

    // Filtros de fecha reutilizables — SIN prefijo de alias para ser
    // reutilizables en queries con/sin alias de tabla.
    // Para queries con alias específico se parchea inline (ver ERROR 2).
    let dateFilter = '';
    let dateParams = [];
    if (year) { dateFilter += ' AND YEAR(fecha) = ?'; dateParams.push(year); }
    if (mes)  { dateFilter += ' AND MONTH(fecha) = ?'; dateParams.push(mes); }

    // ─────────────────────────────────────────────────────────────────
    // ERROR 1: UUID DUPLICADO
    // ─────────────────────────────────────────────────────────────────
    const [duplicados] = await pool.query(`
      SELECT
        uuid,
        COUNT(*) AS veces,
        MAX(rfc_emisor) AS rfc_emisor,
        MAX(nombre_emisor) AS nombre_emisor,
        MAX(total) AS total,
        MAX(tipo_de_comprobante) AS tipo,
        SUM(total) - MAX(total) AS monto_duplicado
      FROM comprobantes
      WHERE contribuyente_id = ? ${dateFilter}
      GROUP BY uuid
      HAVING COUNT(*) > 1
      ORDER BY veces DESC
    `, [contribuyente_id, ...dateParams]);

    const iva_duplicada = duplicados.reduce((s, r) => s + fmt(r.monto_duplicado * 0.16), 0);

    // ─────────────────────────────────────────────────────────────────
    // ERROR 2: COMPLEMENTO DE PAGO DUPLICADO / EXCEDE FACTURA
    // ─────────────────────────────────────────────────────────────────
    const [compPago] = await pool.query(`
      SELECT
        pd.id_documento AS uuid_factura,
        c_orig.rfc_emisor,
        c_orig.nombre_emisor,
        c_orig.total AS total_factura,
        COALESCE(c_orig.total_traslados, 0) AS iva_factura,
        SUM(pd.monto_dr) AS total_pagado_acumulado,
        COUNT(*) AS num_pagos,
        ROUND(SUM(pd.monto_dr) - c_orig.total, 2) AS excedente
      FROM pago_doctos pd
      JOIN comprobantes c_orig ON pd.id_documento = c_orig.uuid
      WHERE c_orig.contribuyente_id = ? ${dateFilter.replace(/\bfecha\b/g, 'c_orig.fecha')}
      GROUP BY pd.id_documento, c_orig.total, c_orig.total_traslados, c_orig.rfc_emisor, c_orig.nombre_emisor
      HAVING SUM(pd.monto_dr) > c_orig.total * 1.005
      ORDER BY excedente DESC
    `, [contribuyente_id, ...dateParams]);

    const iva_comp_excedente = compPago.reduce((s, r) => {
      const ratio = Math.min(r.total_pagado_acumulado / r.total_factura, 1);
      return s + fmt(r.iva_factura * (ratio - 1));
    }, 0);

    // ─────────────────────────────────────────────────────────────────
    // ERROR 3: PPD SIN COMPLEMENTO DE PAGO (IVA fantasma)
    // ─────────────────────────────────────────────────────────────────
    const [ppd_sin_comp] = await pool.query(`
      SELECT
        c.uuid,
        c.fecha,
        c.rfc_emisor,
        c.nombre_emisor,
        c.total,
        COALESCE(c.total_traslados, 0) AS iva_en_riesgo,
        DATEDIFF(NOW(), c.fecha) AS dias_sin_pago
      FROM comprobantes c
      WHERE c.tipo_de_comprobante = 'I'
        AND c.metodo_pago = 'PPD'
        AND c.contribuyente_id = ?
        ${dateFilter}
        AND NOT EXISTS (
          SELECT 1 FROM pago_doctos pd WHERE pd.id_documento = c.uuid
        )
      ORDER BY c.total DESC
    `, [contribuyente_id, ...dateParams]);

    const iva_ppd_riesgo = ppd_sin_comp.reduce((s, r) => s + fmt(r.iva_en_riesgo), 0);

    // ─────────────────────────────────────────────────────────────────
    // ERROR 4: DESCUADRE MATEMÁTICO (total ≠ subtotal + IVA - retenciones)
    // ─────────────────────────────────────────────────────────────────
    const [descuadres] = await pool.query(`
      SELECT
        uuid,
        rfc_emisor,
        nombre_emisor,
        fecha,
        subtotal,
        COALESCE(total_traslados, 0) AS iva,
        COALESCE(total_retenciones, 0) AS retenciones,
        total,
        ROUND(total - (subtotal + COALESCE(total_traslados,0) - COALESCE(total_retenciones,0)), 2) AS diferencia
      FROM comprobantes
      WHERE contribuyente_id = ? ${dateFilter}
        AND ABS(total - (subtotal + COALESCE(total_traslados,0) - COALESCE(total_retenciones,0))) > 0.10
      ORDER BY ABS(total - (subtotal + COALESCE(total_traslados,0) - COALESCE(total_retenciones,0))) DESC
    `, [contribuyente_id, ...dateParams]);

    // ─────────────────────────────────────────────────────────────────
    // ERROR 5: NOTA DE CRÉDITO SIN CFDI RELACIONADO
    // ─────────────────────────────────────────────────────────────────
    const [notas_sin_rel] = await pool.query(`
      SELECT
        c.uuid,
        c.fecha,
        c.rfc_emisor,
        c.nombre_emisor,
        c.total,
        COALESCE(c.total_traslados, 0) AS iva_afectado
      FROM comprobantes c
      WHERE c.tipo_de_comprobante = 'E'
        AND c.contribuyente_id = ?
        ${dateFilter}
        AND NOT EXISTS (
          SELECT 1 FROM cfdi_relacionados cr WHERE cr.uuid = c.uuid
        )
    `, [contribuyente_id, ...dateParams]);

    const iva_notas = notas_sin_rel.reduce((s, r) => s + fmt(r.iva_afectado), 0);

    // ─────────────────────────────────────────────────────────────────
    // ERROR 6: NÓMINAS CON ISR IMPOSIBLE (0, negativo o >35%)
    // ─────────────────────────────────────────────────────────────────
    const [nominas_error] = await pool.query(`
      SELECT * FROM (
        SELECT
          c.uuid,
          c.fecha,
          c.rfc_receptor AS empleado_rfc,
          c.nombre_receptor AS empleado_nombre,
          c.subtotal AS monto_nomina,
          COALESCE(ir.total_isr, 0) AS isr_retenido,
          ROUND(COALESCE(ir.total_isr, 0) / NULLIF(c.subtotal, 0) * 100, 2) AS pct_isr,
          CASE
            WHEN COALESCE(ir.total_isr, 0) = 0                                THEN 'SIN_ISR'
            WHEN COALESCE(ir.total_isr, 0) < 0                                THEN 'ISR_NEGATIVO'
            WHEN COALESCE(ir.total_isr, 0) / NULLIF(c.subtotal,0) > 0.35     THEN 'ISR_EXCESIVO'
            ELSE 'OK'
          END AS diagnostico
        FROM comprobantes c
        LEFT JOIN (
          SELECT uuid, SUM(importe) AS total_isr
          FROM impuesto_retenciones
          WHERE impuesto = '001'
          GROUP BY uuid
        ) ir ON c.uuid = ir.uuid
        WHERE c.tipo_de_comprobante = 'N'
          AND c.contribuyente_id = ?
          ${dateFilter}
      ) sub
      WHERE sub.diagnostico != 'OK'
      ORDER BY sub.fecha DESC
    `, [contribuyente_id, ...dateParams]);

    // ─────────────────────────────────────────────────────────────────
    // ERROR 7: COMPLEMENTO SIN FACTURA ORIGINAL EN DB
    // ─────────────────────────────────────────────────────────────────
    const [comp_huerfanos] = await pool.query(`
      SELECT
        pd.uuid AS uuid_pago,
        pd.id_documento AS uuid_factura_faltante,
        pd.monto_dr AS imp_pagado,
        p.fecha_pago AS fecha_pago
      FROM pago_doctos pd
      JOIN pagos p ON pd.uuid = p.uuid
      JOIN comprobantes cp ON cp.uuid = pd.uuid AND cp.contribuyente_id = ?
      WHERE NOT EXISTS (
        SELECT 1 FROM comprobantes c WHERE c.uuid = pd.id_documento
      )
      ORDER BY p.fecha_pago DESC
    `, [contribuyente_id]);

    // ─────────────────────────────────────────────────────────────────
    // TOTALES REALES DEL PERÍODO (base de comparación)
    // ─────────────────────────────────────────────────────────────────
    const [totales] = await pool.query(`
      SELECT
        COUNT(*) AS total_cfdi,
        SUM(CASE WHEN rfc_emisor = ? THEN 1 ELSE 0 END) AS emitidos,
        SUM(CASE WHEN rfc_receptor = ? THEN 1 ELSE 0 END) AS recibidos,
        SUM(CASE WHEN rfc_receptor = ? THEN COALESCE(total_traslados,0) ELSE 0 END) AS iva_acreditable_bruto,
        SUM(CASE WHEN rfc_emisor = ? THEN COALESCE(total_traslados,0) ELSE 0 END) AS iva_trasladado_bruto,
        SUM(CASE WHEN tipo_de_comprobante = 'N' THEN 1 ELSE 0 END) AS nominas
      FROM comprobantes
      WHERE contribuyente_id = ? ${dateFilter}
    `, [rfc, rfc, rfc, rfc, contribuyente_id, ...dateParams]);

    const base = totales[0];

    // ─────────────────────────────────────────────────────────────────
    // CALCULAR SCORE DE SALUD (0-100)
    // ─────────────────────────────────────────────────────────────────
    let penalizacion = 0;
    const total_cfdi = base.total_cfdi || 1;

    if (duplicados.length > 0)    penalizacion += Math.min(40, duplicados.length * 8);
    if (ppd_sin_comp.length > 0)  penalizacion += Math.min(25, ppd_sin_comp.length * 3);
    if (compPago.length > 0)      penalizacion += Math.min(20, compPago.length * 5);
    if (descuadres.length > 0)    penalizacion += Math.min(10, descuadres.length * 2);
    if (notas_sin_rel.length > 0) penalizacion += Math.min(10, notas_sin_rel.length * 3);
    if (nominas_error.length > 0) penalizacion += Math.min(15, nominas_error.length * 5);
    if (comp_huerfanos.length > 0) penalizacion += Math.min(10, comp_huerfanos.length * 2);

    const score = Math.max(0, 100 - penalizacion);

    // Clasificar nivel
    let nivel, color;
    if (score >= 90) { nivel = 'EXCELENTE'; color = 'green'; }
    else if (score >= 70) { nivel = 'BUENO'; color = 'yellow'; }
    else if (score >= 50) { nivel = 'ATENCIÓN'; color = 'orange'; }
    else { nivel = 'CRÍTICO'; color = 'red'; }

    // ─────────────────────────────────────────────────────────────────
    // IVA CORREGIDO (descontando errores)
    // ─────────────────────────────────────────────────────────────────
    const iva_acreditable_real = fmt(
      (base.iva_acreditable_bruto || 0)
      - iva_duplicada
      - iva_ppd_riesgo
      - iva_comp_excedente
      - iva_notas
    );
    const iva_balance = fmt((base.iva_trasladado_bruto || 0) - iva_acreditable_real);

    res.json({
      meta: {
        contribuyente_id: parseInt(contribuyente_id),
        rfc,
        nombre,
        year: year || null,
        mes: mes || null,
        generado_en: new Date().toISOString(),
      },
      score,
      nivel,
      color,
      resumen: {
        total_cfdi: base.total_cfdi,
        emitidos: base.emitidos,
        recibidos: base.recibidos,
        nominas: base.nominas,
        iva_trasladado_bruto: fmt(base.iva_trasladado_bruto),
        iva_acreditable_bruto: fmt(base.iva_acreditable_bruto),
        iva_acreditable_real,
        iva_balance,
        iva_en_riesgo: fmt(iva_duplicada + iva_ppd_riesgo + iva_comp_excedente + iva_notas),
      },
      errores: {
        criticos: [
          {
            id: 'uuid_duplicado',
            titulo: 'UUID Duplicados',
            descripcion: 'El mismo CFDI fue importado más de una vez',
            severidad: 'critico',
            count: duplicados.length,
            impacto_iva: fmt(iva_duplicada),
            accion: 'Eliminar los duplicados del sistema',
            datos: duplicados.slice(0, 50),
          },
          {
            id: 'ppd_sin_complemento',
            titulo: 'Facturas PPD Sin Complemento de Pago',
            descripcion: 'IVA acreditado de facturas que aún no tienen comprobante de pago del SAT',
            severidad: 'critico',
            count: ppd_sin_comp.length,
            impacto_iva: iva_ppd_riesgo,
            accion: 'Descargar complementos de pago o mover a "pendiente"',
            datos: ppd_sin_comp.slice(0, 50),
          },
          {
            id: 'complemento_excede_factura',
            titulo: 'Complementos de Pago que Exceden la Factura',
            descripcion: 'Los pagos registrados superan el total de la factura original',
            severidad: 'critico',
            count: compPago.length,
            impacto_iva: fmt(Math.abs(iva_comp_excedente)),
            accion: 'Revisar y corregir los importes en el complemento de pago',
            datos: compPago.slice(0, 50),
          },
        ],
        advertencias: [
          {
            id: 'descuadre_matematico',
            titulo: 'Descuadre Matemático en CFDI',
            descripcion: 'El total no coincide con subtotal + IVA - retenciones (diferencia > $0.10)',
            severidad: 'advertencia',
            count: descuadres.length,
            impacto_iva: 0,
            accion: 'Revisar el XML original, puede estar mal parseado',
            datos: descuadres.slice(0, 50),
          },
          {
            id: 'nota_credito_sin_relacionada',
            titulo: 'Notas de Crédito Sin CFDI Relacionado',
            descripcion: 'CFDI tipo E sin referencia a la factura original que cancela',
            severidad: 'advertencia',
            count: notas_sin_rel.length,
            impacto_iva: iva_notas,
            accion: 'Solicitar al proveedor el UUID de la factura original',
            datos: notas_sin_rel.slice(0, 50),
          },
          {
            id: 'nomina_isr_invalido',
            titulo: 'Nóminas con ISR Inválido',
            descripcion: 'Retención ISR = 0, negativa, o mayor al 35% del monto de nómina',
            severidad: 'advertencia',
            count: nominas_error.length,
            impacto_iva: 0,
            accion: 'Validar con contador si aplica exención o si hay error de carga',
            datos: nominas_error.slice(0, 50),
          },
          {
            id: 'complemento_huerfano',
            titulo: 'Complementos Sin Factura Original en Sistema',
            descripcion: 'Existe el complemento de pago pero la factura original no está descargada',
            severidad: 'advertencia',
            count: comp_huerfanos.length,
            impacto_iva: 0,
            accion: 'Descargar del SAT el período donde se emitió la factura',
            datos: comp_huerfanos.slice(0, 50),
          },
        ],
      },
    });
  } catch (err) {
    console.error('[AUDITORIA] Error en salud:', err);
    res.status(500).json({ error: 'Error interno en motor de auditoría', detail: err.message });
  }
});

// =====================================================================
// GET /api/auditoria/iva-ppd-correcto?contribuyente_id=X&year=Y&mes=M
// Calcula el IVA acreditable CORRECTO de facturas PPD usando proporción
// =====================================================================
router.get('/iva-ppd-correcto', async (req, res) => {
  try {
    const { contribuyente_id, year, mes } = req.query;
    if (!contribuyente_id) return res.status(400).json({ error: 'contribuyente_id requerido' });

    let dateFilter = '';
    let dateParams = [];
    if (year) { dateFilter += ' AND YEAR(c.fecha) = ?'; dateParams.push(year); }
    if (mes)  { dateFilter += ' AND MONTH(c.fecha) = ?'; dateParams.push(mes); }

    // Facturas PPD con sus complementos de pago
    const [ppd_facturas] = await pool.query(`
      SELECT
        c.uuid,
        c.fecha AS fecha_factura,
        c.rfc_emisor,
        c.nombre_emisor,
        c.total AS total_factura,
        COALESCE(c.total_traslados, 0) AS iva_original,
        COALESCE(SUM(pd.monto_dr), 0) AS total_pagado,
        COUNT(*) AS num_complementos,
        LEAST(
          COALESCE(c.total_traslados,0),
          COALESCE(c.total_traslados,0) * (COALESCE(SUM(pd.monto_dr),0) / NULLIF(c.total,0))
        ) AS iva_acreditable_correcto,
        COALESCE(c.total_traslados,0) - LEAST(
          COALESCE(c.total_traslados,0),
          COALESCE(c.total_traslados,0) * (COALESCE(SUM(pd.monto_dr),0) / NULLIF(c.total,0))
        ) AS iva_pendiente
      FROM comprobantes c
      LEFT JOIN pago_doctos pd ON pd.id_documento = c.uuid
      WHERE c.tipo_de_comprobante = 'I'
        AND c.metodo_pago = 'PPD'
        AND c.contribuyente_id = ?
        ${dateFilter}
      GROUP BY c.uuid, c.fecha, c.rfc_emisor, c.nombre_emisor, c.total, c.total_traslados
      ORDER BY c.fecha DESC
    `, [contribuyente_id, ...dateParams]);

    const totales = ppd_facturas.reduce((acc, r) => ({
      iva_original: acc.iva_original + fmt(r.iva_original),
      iva_correcto: acc.iva_correcto + fmt(r.iva_acreditable_correcto),
      iva_pendiente: acc.iva_pendiente + fmt(r.iva_pendiente),
      total_facturas: acc.total_facturas + 1,
    }), { iva_original: 0, iva_correcto: 0, iva_pendiente: 0, total_facturas: 0 });

    res.json({
      facturas: ppd_facturas,
      totales,
      diferencia_iva: fmt(totales.iva_original - totales.iva_correcto),
      mensaje: 'El IVA correcto solo considera el IVA proporcional a lo efectivamente pagado mediante complementos de pago',
    });
  } catch (err) {
    console.error('[AUDITORIA] Error IVA PPD:', err);
    res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

// =====================================================================
// GET /api/auditoria/diot?contribuyente_id=X&year=Y&mes=M
// Genera el archivo DIOT en formato SAT (pipe-delimited)
// =====================================================================
router.get('/diot', async (req, res) => {
  try {
    const { contribuyente_id, year, mes } = req.query;
    if (!contribuyente_id || !year || !mes) {
      return res.status(400).json({ error: 'contribuyente_id, year y mes son requeridos' });
    }

    const [contribRows] = await pool.query(
      'SELECT rfc, nombre FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contribRows.length === 0) return res.status(404).json({ error: 'Contribuyente no encontrado' });
    const { rfc: rfc_propio } = contribRows[0];

    // Agrupar compras por proveedor en el período
    const [proveedores] = await pool.query(`
      SELECT
        c.rfc_emisor AS rfc,
        MAX(c.nombre_emisor) AS nombre,
        SUM(c.subtotal) AS importe_operacion,
        SUM(CASE
          WHEN it.tasa_o_cuota = '0.160000' OR it.tasa_o_cuota = '0.16' THEN COALESCE(it.importe, 0)
          ELSE 0
        END) AS iva_16,
        SUM(CASE
          WHEN it.tasa_o_cuota = '0.080000' OR it.tasa_o_cuota = '0.08' THEN COALESCE(it.importe, 0)
          ELSE 0
        END) AS iva_8,
        SUM(CASE
          WHEN (it.tasa_o_cuota = '0.000000' OR it.tasa_o_cuota = '0.00' OR it.tasa_o_cuota IS NULL)
            AND c.total_traslados IS NOT NULL THEN COALESCE(it.importe, 0)
          ELSE 0
        END) AS iva_0,
        SUM(CASE WHEN ir.impuesto = '002' THEN COALESCE(ir.importe, 0) ELSE 0 END) AS iva_retenido
      FROM comprobantes c
      LEFT JOIN impuesto_traslados it ON it.uuid = c.uuid AND it.impuesto = '002'
      LEFT JOIN impuesto_retenciones ir ON ir.uuid = c.uuid AND ir.impuesto = '002'
      WHERE c.rfc_receptor = ?
        AND c.tipo_de_comprobante IN ('I','E')
        AND YEAR(c.fecha) = ?
        AND MONTH(c.fecha) = ?
      GROUP BY c.rfc_emisor
      ORDER BY importe_operacion DESC
    `, [rfc_propio, year, mes]);

    // Formato DIOT SAT
    // tipo_tercero|tipo_relacion|rfc|rfc_pais_resid|pais_resid|nacioanlidad|
    // nombre|codigo_pais|importe_15|iva_15|iva_15_noac|iva_exento|
    // iva_16|iva_16_noac|iva_imp15|iva_imp16|iva_0|iva_retenido|ieps
    const lineas = proveedores.map(p => {
      const tipoTercero = '04'; // proveedor nacional
      const tipoRelacion = '85'; // proveedor
      const rfcPais = '';
      const paisResid = '';
      const nacionalidad = '';
      const codigoPais = '';
      const iva15 = '0';
      const iva15noac = '0';
      const ivaExento = '0';
      const ivaImp15 = '0';
      const ivaImp16 = '0';
      const ieps = '0';

      return [
        tipoTercero,
        tipoRelacion,
        p.rfc,
        rfcPais,
        paisResid,
        nacionalidad,
        p.nombre ? p.nombre.replace(/\|/g, ' ') : '',
        codigoPais,
        iva15,
        iva15noac,
        ivaExento,
        fmt(p.iva_16).toFixed(2),
        '0', // iva_16_noac
        ivaImp15,
        ivaImp16,
        fmt(p.iva_0).toFixed(2),
        fmt(p.iva_retenido).toFixed(2),
        ieps,
      ].join('|');
    });

    const diotContent = lineas.join('\n');
    const filename = `DIOT_${rfc_propio}_${year}_${String(mes).padStart(2,'0')}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(diotContent);

  } catch (err) {
    console.error('[AUDITORIA] Error DIOT:', err);
    res.status(500).json({ error: 'Error generando DIOT', detail: err.message });
  }
});

// =====================================================================
// GET /api/auditoria/libro-mayor?contribuyente_id=X&year=Y&mes=M
// Tabla Dinámica Fiscal — detalle CFDI a CFDI con regla IVA aplicada
// =====================================================================
router.get('/libro-mayor', async (req, res) => {
  try {
    const { contribuyente_id, year, mes } = req.query;
    if (!contribuyente_id) return res.status(400).json({ error: 'contribuyente_id requerido' });

    const [contribRows] = await pool.query(
      'SELECT rfc, nombre FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contribRows.length === 0) return res.status(404).json({ error: 'Contribuyente no encontrado' });

    let dateFilter = '';
    let dateParams = [];
    if (year) { dateFilter += ' AND YEAR(c.fecha) = ?'; dateParams.push(year); }
    if (mes)  { dateFilter += ' AND MONTH(c.fecha) = ?'; dateParams.push(mes); }

    const [rows] = await pool.query(`
      SELECT
        c.uuid,
        c.fecha,
        c.tipo_de_comprobante AS tipo,
        c.metodo_pago,
        c.forma_pago,
        c.rfc_emisor,
        c.nombre_emisor,
        c.rfc_receptor,
        c.nombre_receptor,
        c.subtotal,
        COALESCE(c.descuento, 0)         AS descuento,
        COALESCE(c.total_traslados, 0)   AS iva_cfdi,
        COALESCE(c.total_retenciones, 0) AS retenciones,
        c.total,
        c.estado,
        c.moneda,
        COALESCE(c.tipo_cambio, 1)       AS tipo_cambio,
        COALESCE(pd_agg.total_pagado, 0)      AS total_pagado,
        COALESCE(pd_agg.num_complementos, 0)  AS num_complementos,

        /* IVA REAL ACREDITABLE según regla fiscal */
        CASE
          WHEN c.estado = 'Cancelado'                     THEN 0
          WHEN c.tipo_de_comprobante IN ('P','T','N')     THEN 0
          WHEN c.tipo_de_comprobante = 'E'                THEN -1 * COALESCE(c.total_traslados, 0)
          WHEN c.tipo_de_comprobante = 'I'
            AND c.metodo_pago = 'PPD'                     THEN
              ROUND(
                COALESCE(c.total_traslados, 0) *
                LEAST(1.0, COALESCE(pd_agg.total_pagado, 0) / NULLIF(c.total, 0)),
              2)
          ELSE COALESCE(c.total_traslados, 0)
        END AS iva_real,

        /* ETIQUETA DE REGLA APLICADA */
        CASE
          WHEN c.estado = 'Cancelado'                                                                 THEN 'CANCELADO'
          WHEN c.tipo_de_comprobante = 'P'                                                            THEN 'COMP_PAGO'
          WHEN c.tipo_de_comprobante = 'E'                                                            THEN 'NOTA_CREDITO'
          WHEN c.tipo_de_comprobante = 'N'                                                            THEN 'NOMINA'
          WHEN c.tipo_de_comprobante = 'T'                                                            THEN 'TRASLADO'
          WHEN c.tipo_de_comprobante = 'I' AND c.metodo_pago = 'PPD'
            AND COALESCE(pd_agg.total_pagado,0) >= c.total * 0.99                                   THEN 'PPD_LIQUIDADO'
          WHEN c.tipo_de_comprobante = 'I' AND c.metodo_pago = 'PPD'
            AND COALESCE(pd_agg.total_pagado,0) > 0                                                  THEN 'PPD_PARCIAL'
          WHEN c.tipo_de_comprobante = 'I' AND c.metodo_pago = 'PPD'                                 THEN 'PPD_PENDIENTE'
          WHEN c.tipo_de_comprobante = 'I'
            AND (c.metodo_pago = 'PUE' OR c.metodo_pago IS NULL)                                     THEN 'PUE'
          ELSE 'OTRO'
        END AS regla_iva

      FROM comprobantes c
      LEFT JOIN (
        SELECT id_documento,
               SUM(monto_dr)   AS total_pagado,
               COUNT(*)        AS num_complementos
        FROM pago_doctos
        GROUP BY id_documento
      ) pd_agg ON pd_agg.id_documento = c.uuid
      WHERE c.contribuyente_id = ? ${dateFilter}
      ORDER BY c.rfc_emisor, c.fecha DESC
    `, [contribuyente_id, ...dateParams]);

    // Build summary by regla_iva
    const summary = {};
    let totalIvaReal = 0, totalIvaCfdi = 0, totalSubtotal = 0;

    for (const r of rows) {
      const key = r.regla_iva;
      if (!summary[key]) summary[key] = { count: 0, iva_cfdi: 0, iva_real: 0, subtotal: 0 };
      summary[key].count++;
      summary[key].iva_cfdi   += parseFloat(r.iva_cfdi)  || 0;
      summary[key].iva_real   += parseFloat(r.iva_real)  || 0;
      summary[key].subtotal   += parseFloat(r.subtotal)  || 0;
      totalIvaReal   += parseFloat(r.iva_real)  || 0;
      totalIvaCfdi   += parseFloat(r.iva_cfdi)  || 0;
      totalSubtotal  += parseFloat(r.subtotal)  || 0;
    }

    // Round summary values
    for (const k of Object.keys(summary)) {
      summary[k].iva_cfdi  = fmt(summary[k].iva_cfdi);
      summary[k].iva_real  = fmt(summary[k].iva_real);
      summary[k].subtotal  = fmt(summary[k].subtotal);
    }

    res.json({
      meta: {
        contribuyente_id: parseInt(contribuyente_id),
        rfc:    contribRows[0].rfc,
        nombre: contribRows[0].nombre,
        year:   year  || null,
        mes:    mes   || null,
        generado_en: new Date().toISOString(),
      },
      cfdi: rows,
      summary,
      totales: {
        total_cfdi:  rows.length,
        iva_real:    fmt(totalIvaReal),
        iva_cfdi:    fmt(totalIvaCfdi),
        diferencia:  fmt(totalIvaCfdi - totalIvaReal),
        subtotal:    fmt(totalSubtotal),
      },
    });
  } catch (err) {
    console.error('[AUDITORIA] Error libro-mayor:', err);
    res.status(500).json({ error: 'Error interno en libro mayor', detail: err.message });
  }
});

// =====================================================================
// DELETE /api/auditoria/duplicados/:uuid — elimina el duplicado
// (mantiene 1, borra los extras)
// =====================================================================
router.delete('/duplicados/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const { contribuyente_id } = req.query;
    if (!contribuyente_id) return res.status(400).json({ error: 'contribuyente_id requerido' });

    // Verificar que el contribuyente le pertenece al usuario
    const [contrib] = await pool.query(
      'SELECT id FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contrib.length === 0) return res.status(403).json({ error: 'No autorizado' });

    // Obtener todos los IDs duplicados, conservar el de menor ID (primero importado)
    const [rows] = await pool.query(
      'SELECT id FROM comprobantes WHERE uuid = ? AND contribuyente_id = ? ORDER BY id ASC',
      [uuid, contribuyente_id]
    );

    if (rows.length <= 1) {
      return res.json({ message: 'No hay duplicados para este UUID', eliminados: 0 });
    }

    const idsToDelete = rows.slice(1).map(r => r.id);
    await pool.query(
      `DELETE FROM comprobantes WHERE id IN (${idsToDelete.map(() => '?').join(',')})`,
      idsToDelete
    );

    res.json({
      message: `${idsToDelete.length} duplicado(s) eliminado(s). Se conservó el registro original (id=${rows[0].id}).`,
      eliminados: idsToDelete.length,
    });
  } catch (err) {
    console.error('[AUDITORIA] Error eliminando duplicados:', err);
    res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

// =====================================================================
// GET /api/auditoria/resumen-datos?contribuyente_id=X
// Resumen de CFDIs en BD: total, vigentes, cancelados, por período
// =====================================================================
router.get('/resumen-datos', async (req, res) => {
  try {
    const { contribuyente_id } = req.query;
    if (!contribuyente_id) return res.status(400).json({ error: 'contribuyente_id requerido' });

    // Verificar pertenencia al usuario
    const [contrib] = await pool.query(
      'SELECT id, rfc, nombre FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contrib.length === 0) return res.status(403).json({ error: 'No autorizado' });

    // Totales globales
    const [[totales]] = await pool.query(`
      SELECT
        COUNT(*)                                                      AS total,
        SUM(CASE WHEN LOWER(estado) = 'vigente'   THEN 1 ELSE 0 END) AS vigentes,
        SUM(CASE WHEN LOWER(estado) = 'cancelado' THEN 1 ELSE 0 END) AS cancelados,
        SUM(CASE WHEN tipo_de_comprobante = 'I'   THEN 1 ELSE 0 END) AS ingresos,
        SUM(CASE WHEN tipo_de_comprobante = 'E'   THEN 1 ELSE 0 END) AS egresos,
        SUM(CASE WHEN tipo_de_comprobante = 'P'   THEN 1 ELSE 0 END) AS pagos,
        SUM(CASE WHEN tipo_de_comprobante = 'N'   THEN 1 ELSE 0 END) AS nominas,
        MAX(fecha)                                                    AS ultima_fecha,
        SUM(CASE WHEN LOWER(estado) = 'vigente' AND rfc_receptor = ? THEN total ELSE 0 END)  AS monto_recibido,
        SUM(CASE WHEN LOWER(estado) = 'vigente' AND rfc_emisor  = ? THEN total ELSE 0 END)   AS monto_emitido
      FROM comprobantes
      WHERE contribuyente_id = ?
    `, [contrib[0].rfc, contrib[0].rfc, contribuyente_id]);

    // Desglose por año/mes
    const [periodos] = await pool.query(`
      SELECT
        YEAR(fecha)  AS year,
        MONTH(fecha) AS mes,
        COUNT(*)     AS total,
        SUM(CASE WHEN LOWER(estado) = 'vigente'   THEN 1 ELSE 0 END) AS vigentes,
        SUM(CASE WHEN LOWER(estado) = 'cancelado' THEN 1 ELSE 0 END) AS cancelados,
        SUM(CASE WHEN LOWER(estado) = 'vigente' AND tipo_de_comprobante = 'I' THEN total ELSE 0 END) AS monto_ingresos,
        SUM(CASE WHEN LOWER(estado) = 'vigente' AND tipo_de_comprobante = 'E' THEN total ELSE 0 END) AS monto_egresos
      FROM comprobantes
      WHERE contribuyente_id = ?
      GROUP BY YEAR(fecha), MONTH(fecha)
      ORDER BY year DESC, mes DESC
      LIMIT 36
    `, [contribuyente_id]);

    res.json({
      contribuyente: { id: contrib[0].id, rfc: contrib[0].rfc, nombre: contrib[0].nombre },
      totales: {
        total:         parseInt(totales.total)     || 0,
        vigentes:      parseInt(totales.vigentes)  || 0,
        cancelados:    parseInt(totales.cancelados)|| 0,
        ingresos:      parseInt(totales.ingresos)  || 0,
        egresos:       parseInt(totales.egresos)   || 0,
        pagos:         parseInt(totales.pagos)     || 0,
        nominas:       parseInt(totales.nominas)   || 0,
        ultima_fecha:  totales.ultima_fecha,
        monto_recibido: fmt(totales.monto_recibido),
        monto_emitido:  fmt(totales.monto_emitido),
      },
      periodos,
    });
  } catch (err) {
    console.error('[AUDITORIA] Error resumen-datos:', err);
    res.status(500).json({ error: 'Error obteniendo resumen de datos', detail: err.message });
  }
});

// =====================================================================
// GET /api/auditoria/limpiar/preview?contribuyente_id=X&fecha_ini=&fecha_fin=
// Vista previa de lo que se borrará antes de ejecutar la limpieza
// =====================================================================
router.get('/limpiar/preview', async (req, res) => {
  try {
    const { contribuyente_id, fecha_ini, fecha_fin } = req.query;
    if (!contribuyente_id) return res.status(400).json({ error: 'contribuyente_id requerido' });

    const [contrib] = await pool.query(
      'SELECT id, rfc FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contrib.length === 0) return res.status(403).json({ error: 'No autorizado' });

    // Construir filtro de fechas
    let dateWhere = 'WHERE contribuyente_id = ?';
    const params  = [contribuyente_id];
    if (fecha_ini) { dateWhere += ' AND fecha >= ?'; params.push(fecha_ini + ' 00:00:00'); }
    if (fecha_fin) { dateWhere += ' AND fecha <= ?'; params.push(fecha_fin + ' 23:59:59'); }

    const [[cnts]] = await pool.query(`
      SELECT
        COUNT(*) AS comprobantes,
        SUM(CASE WHEN LOWER(estado) = 'vigente'   THEN 1 ELSE 0 END) AS vigentes,
        SUM(CASE WHEN LOWER(estado) = 'cancelado' THEN 1 ELSE 0 END) AS cancelados,
        MIN(fecha) AS fecha_min,
        MAX(fecha) AS fecha_max
      FROM comprobantes ${dateWhere}
    `, params);

    // Conteos de tablas hijo (aproximados con INNER JOIN por uuid)
    const uuidSubquery = `SELECT uuid FROM comprobantes ${dateWhere}`;
    const [[conceptosCnt]] = await pool.query(
      `SELECT COUNT(*) AS n FROM conceptos WHERE uuid IN (${uuidSubquery})`, params
    );
    const [[impuestosCnt]] = await pool.query(
      `SELECT COUNT(*) AS n FROM impuesto_traslados WHERE uuid IN (${uuidSubquery})`, params
    );
    const [[pagosCnt]] = await pool.query(
      `SELECT COUNT(*) AS n FROM pagos WHERE uuid IN (${uuidSubquery})`, params
    );

    const totalRegistros = parseInt(cnts.comprobantes || 0)
      + parseInt(conceptosCnt.n || 0)
      + parseInt(impuestosCnt.n || 0)
      + parseInt(pagosCnt.n    || 0);

    // Lista de períodos afectados
    const [periodos] = await pool.query(`
      SELECT DISTINCT YEAR(fecha) AS y, MONTH(fecha) AS m, COUNT(*) AS n
      FROM comprobantes ${dateWhere}
      GROUP BY y, m ORDER BY y DESC, m DESC
    `, params);

    res.json({
      comprobantes:    parseInt(cnts.comprobantes)  || 0,
      vigentes:        parseInt(cnts.vigentes)      || 0,
      cancelados:      parseInt(cnts.cancelados)    || 0,
      conceptos:       parseInt(conceptosCnt.n)     || 0,
      impuestos:       parseInt(impuestosCnt.n)     || 0,
      pagos:           parseInt(pagosCnt.n)         || 0,
      total_registros: totalRegistros,
      fecha_min:       cnts.fecha_min,
      fecha_max:       cnts.fecha_max,
      periodos,
    });
  } catch (err) {
    console.error('[AUDITORIA] Error preview limpieza:', err);
    res.status(500).json({ error: 'Error calculando preview', detail: err.message });
  }
});

// =====================================================================
// DELETE /api/auditoria/limpiar — Limpieza selectiva de CFDIs
// Body: { contribuyente_id, fecha_ini, fecha_fin, confirmar: true }
// Si no hay fechas → borra TODOS los CFDIs del contribuyente
// =====================================================================
router.delete('/limpiar', async (req, res) => {
  try {
    const { contribuyente_id, fecha_ini, fecha_fin, confirmar } = req.body;
    if (!contribuyente_id) return res.status(400).json({ error: 'contribuyente_id requerido' });
    if (!confirmar) return res.status(400).json({ error: 'Se requiere confirmar: true para ejecutar la limpieza' });

    const [contrib] = await pool.query(
      'SELECT id, rfc FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contrib.length === 0) return res.status(403).json({ error: 'No autorizado' });

    // Construir filtro de fechas
    let dateWhere = 'contribuyente_id = ?';
    const params  = [contribuyente_id];
    if (fecha_ini) { dateWhere += ' AND fecha >= ?'; params.push(fecha_ini + ' 00:00:00'); }
    if (fecha_fin) { dateWhere += ' AND fecha <= ?'; params.push(fecha_fin + ' 23:59:59'); }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Obtener UUIDs a eliminar
      const [uuids] = await conn.query(
        `SELECT uuid FROM comprobantes WHERE ${dateWhere}`, params
      );
      if (uuids.length === 0) {
        await conn.commit();
        conn.release();
        return res.json({ message: 'No se encontraron CFDIs en el rango especificado.', eliminados: 0 });
      }

      const uuidList = uuids.map(r => r.uuid);
      const placeholders = uuidList.map(() => '?').join(',');

      // Borrar tablas hijo en orden correcto (FK constraints)
      await conn.query(`DELETE FROM pago_traslados    WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM pago_doctos        WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM pagos              WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM impuesto_retenciones WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM impuesto_traslados WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM concepto_retenciones WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM concepto_traslados  WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM conceptos           WHERE uuid IN (${placeholders})`, uuidList);
      await conn.query(`DELETE FROM cfdi_relacionados   WHERE uuid IN (${placeholders})`, uuidList);

      // Borrar comprobantes
      const [result] = await conn.query(
        `DELETE FROM comprobantes WHERE ${dateWhere}`, params
      );

      // Limpiar reportes de IVA del período si aplica
      if (fecha_ini || fecha_fin) {
        let ivaWhere = 'contribuyente_id = ?';
        const ivaParams = [contribuyente_id];
        if (fecha_ini) { ivaWhere += ' AND CONCAT(periodo_year,"-",LPAD(periodo_mes,2,"0")) >= ?'; ivaParams.push(fecha_ini.substring(0, 7)); }
        if (fecha_fin) { ivaWhere += ' AND CONCAT(periodo_year,"-",LPAD(periodo_mes,2,"0")) <= ?'; ivaParams.push(fecha_fin.substring(0, 7)); }
        await conn.query(`DELETE FROM reportes_iva WHERE ${ivaWhere}`, ivaParams);
      } else {
        await conn.query('DELETE FROM reportes_iva WHERE contribuyente_id = ?', [contribuyente_id]);
      }

      await conn.commit();
      res.json({
        success:   true,
        eliminados: result.affectedRows,
        uuids_eliminados: uuidList.length,
        message:   `Se eliminaron ${result.affectedRows} CFDIs del período ${fecha_ini || 'inicio'} → ${fecha_fin || 'fin'}. Los cálculos de IVA del período también fueron limpiados.`,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[AUDITORIA] Error limpieza:', err);
    res.status(500).json({ error: 'Error ejecutando limpieza', detail: err.message });
  }
});

module.exports = router;
