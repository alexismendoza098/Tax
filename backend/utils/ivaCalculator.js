const pool = require('../db');

/**
 * Helper to get RFC from contribuyenteId
 */
async function getRfc(contribuyenteId) {
  const [rows] = await pool.query('SELECT rfc FROM contribuyentes WHERE id = ?', [contribuyenteId]);
  return rows.length > 0 ? rows[0].rfc : null;
}

/**
 * Calculate IVA Trasladado PUE for a contributor/period.
 * Sum IVA from comprobantes tipo I (Ingreso) - E (Egreso) with metodo_pago PUE
 * where the contributor is the EMISOR.
 * Only valid (Vigente) invoices.
 */
async function calcularIvaTrasladadoPUE(contribuyenteId, year, mes) {
  const rfc = await getRfc(contribuyenteId);
  if (!rfc) return 0;

  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(
      CASE WHEN c.tipo_de_comprobante = 'E' THEN -it.importe ELSE it.importe END
    ), 0) as total
    FROM impuesto_traslados it
    JOIN comprobantes c ON it.uuid = c.uuid
    WHERE c.rfc_emisor = ?
      AND c.tipo_de_comprobante IN ('I', 'E')
      AND c.metodo_pago = 'PUE'
      AND c.estado = 'Vigente'
      AND it.impuesto = '002'
      AND YEAR(c.fecha) = ?
      AND MONTH(c.fecha) = ?
  `, [rfc, year, mes]);

  return parseFloat(rows[0].total);
}

/**
 * Calculate IVA Trasladado PPD for a contributor/period.
 * Supports both CFDI 4.0 (Pagos 2.0) via pago_traslados
 * and CFDI 3.3 (Pagos 1.0) via proportional calculation.
 */
async function calcularIvaTrasladadoPPD(contribuyenteId, year, mes) {
  const rfc = await getRfc(contribuyenteId);
  if (!rfc) return 0;

  const query = `
    SELECT SUM(total_iva) as total FROM (
      -- 1. Direct taxes from Pagos 2.0 (pago_traslados)
      SELECT pt.importe as total_iva
      FROM pago_traslados pt
      JOIN pagos p ON pt.uuid = p.uuid AND pt.pago_index = p.pago_index
      JOIN comprobantes c ON p.uuid = c.uuid
      WHERE c.rfc_emisor = ?
        AND c.tipo_de_comprobante = 'P'
        AND c.estado = 'Vigente'
        AND pt.impuesto = '002'
        AND YEAR(p.fecha_pago) = ?
        AND MONTH(p.fecha_pago) = ?

      UNION ALL

      -- 2. Calculated taxes from Pagos 1.0 (proportional)
      -- Logic: (Amount Paid / Invoice Total) * Invoice IVA
      SELECT (pd.monto_dr / c_orig.total) * it_orig.importe as total_iva
      FROM pago_doctos pd
      JOIN pagos p ON pd.uuid = p.uuid AND pd.pago_index = p.pago_index
      JOIN comprobantes c_pago ON p.uuid = c_pago.uuid
      JOIN comprobantes c_orig ON pd.id_documento = c_orig.uuid
      JOIN impuesto_traslados it_orig ON c_orig.uuid = it_orig.uuid
      WHERE c_pago.rfc_emisor = ?
        AND c_pago.tipo_de_comprobante = 'P'
        AND c_pago.estado = 'Vigente'
        AND it_orig.impuesto = '002'
        AND YEAR(p.fecha_pago) = ?
        AND MONTH(p.fecha_pago) = ?
        -- Exclude if we already have direct tax records for this payment index
        AND NOT EXISTS (
          SELECT 1 FROM pago_traslados pt2 
          WHERE pt2.uuid = p.uuid AND pt2.pago_index = p.pago_index
        )
    ) as combined
  `;

  // We need to pass params twice (once for each part of UNION)
  const params = [
    rfc, year, mes,
    rfc, year, mes
  ];

  const [rows] = await pool.query(query, params);
  return parseFloat(rows[0].total || 0);
}

/**
 * Calculate IVA Acreditable PUE for a contributor/period.
 * Sum IVA from comprobantes where contributor is the RECEPTOR,
 * tipo I (Ingreso) - E (Egreso), metodo_pago PUE.
 * Only valid (Vigente) invoices.
 */
async function calcularIvaAcreditablePUE(contribuyenteId, year, mes) {
  const rfc = await getRfc(contribuyenteId);
  if (!rfc) return 0;

  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(
      CASE WHEN c.tipo_de_comprobante = 'E' THEN -it.importe ELSE it.importe END
    ), 0) as total
    FROM impuesto_traslados it
    JOIN comprobantes c ON it.uuid = c.uuid
    WHERE c.rfc_receptor = ?
      AND c.tipo_de_comprobante IN ('I', 'E')
      AND c.metodo_pago = 'PUE'
      AND c.estado = 'Vigente'
      AND it.impuesto = '002'
      AND YEAR(c.fecha) = ?
      AND MONTH(c.fecha) = ?
  `, [rfc, year, mes]);

  return parseFloat(rows[0].total);
}

/**
 * Calculate IVA Acreditable PPD for a contributor/period.
 * Supports both CFDI 4.0 (Pagos 2.0) via pago_traslados
 * and CFDI 3.3 (Pagos 1.0) via proportional calculation.
 */
async function calcularIvaAcreditablePPD(contribuyenteId, year, mes) {
  const rfc = await getRfc(contribuyenteId);
  if (!rfc) return 0;

  const query = `
    SELECT SUM(total_iva) as total FROM (
      -- 1. Direct taxes from Pagos 2.0 (pago_traslados)
      SELECT pt.importe as total_iva
      FROM pago_traslados pt
      JOIN pagos p ON pt.uuid = p.uuid AND pt.pago_index = p.pago_index
      JOIN comprobantes c ON p.uuid = c.uuid
      WHERE c.rfc_receptor = ?
        AND c.tipo_de_comprobante = 'P'
        AND c.estado = 'Vigente'
        AND pt.impuesto = '002'
        AND YEAR(p.fecha_pago) = ?
        AND MONTH(p.fecha_pago) = ?

      UNION ALL

      -- 2. Calculated taxes from Pagos 1.0 (proportional)
      SELECT (pd.monto_dr / c_orig.total) * it_orig.importe as total_iva
      FROM pago_doctos pd
      JOIN pagos p ON pd.uuid = p.uuid AND pd.pago_index = p.pago_index
      JOIN comprobantes c_pago ON p.uuid = c_pago.uuid
      JOIN comprobantes c_orig ON pd.id_documento = c_orig.uuid
      JOIN impuesto_traslados it_orig ON c_orig.uuid = it_orig.uuid
      WHERE c_pago.rfc_receptor = ?
        AND c_pago.tipo_de_comprobante = 'P'
        AND c_pago.estado = 'Vigente'
        AND it_orig.impuesto = '002'
        AND YEAR(p.fecha_pago) = ?
        AND MONTH(p.fecha_pago) = ?
        AND NOT EXISTS (
          SELECT 1 FROM pago_traslados pt2 
          WHERE pt2.uuid = p.uuid AND pt2.pago_index = p.pago_index
        )
    ) as combined
  `;

  const params = [
    rfc, year, mes,
    rfc, year, mes
  ];

  const [rows] = await pool.query(query, params);
  return parseFloat(rows[0].total || 0);
}

/**
 * Calculate IVA retention for the period.
 * IVA Retenido AL contribuyente (Sales).
 * Where I am the EMISOR.
 * Only valid (Vigente) invoices.
 */
async function calcularRetencionIVA(contribuyenteId, year, mes) {
  const rfc = await getRfc(contribuyenteId);
  if (!rfc) return 0;

  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(ir.importe), 0) as total
    FROM impuesto_retenciones ir
    JOIN comprobantes c ON ir.uuid = c.uuid
    WHERE c.rfc_emisor = ?
      AND c.estado = 'Vigente'
      AND ir.impuesto = '002'
      AND YEAR(c.fecha) = ?
      AND MONTH(c.fecha) = ?
  `, [rfc, year, mes]);

  return parseFloat(rows[0].total);
}

/**
 * Calculate ISR retention for the period.
 * ISR Retenido AL contribuyente (Sales).
 * Where I am the EMISOR.
 * Only valid (Vigente) invoices.
 */
async function calcularRetencionISR(contribuyenteId, year, mes) {
  const rfc = await getRfc(contribuyenteId);
  if (!rfc) return 0;

  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(ir.importe), 0) as total
    FROM impuesto_retenciones ir
    JOIN comprobantes c ON ir.uuid = c.uuid
    WHERE c.rfc_emisor = ?
      AND c.estado = 'Vigente'
      AND ir.impuesto = '001'
      AND YEAR(c.fecha) = ?
      AND MONTH(c.fecha) = ?
  `, [rfc, year, mes]);

  return parseFloat(rows[0].total);
}

/**
 * Full IVA calculation for a period.
 */
async function calcularIVAPeriodo(contribuyenteId, year, mes) {
  const [
    ivaTrasladadoPUE,
    ivaTrasladadoPPD,
    ivaAcreditablePUE,
    ivaAcreditablePPD,
    retencionIVA,
    retencionISR
  ] = await Promise.all([
    calcularIvaTrasladadoPUE(contribuyenteId, year, mes),
    calcularIvaTrasladadoPPD(contribuyenteId, year, mes),
    calcularIvaAcreditablePUE(contribuyenteId, year, mes),
    calcularIvaAcreditablePPD(contribuyenteId, year, mes),
    calcularRetencionIVA(contribuyenteId, year, mes),
    calcularRetencionISR(contribuyenteId, year, mes)
  ]);

  const totalTrasladado = ivaTrasladadoPUE + ivaTrasladadoPPD;
  const totalAcreditable = ivaAcreditablePUE + ivaAcreditablePPD;
  
  // Saldo = Trasladado - Acreditable - Retenciones (que me hicieron)
  const saldoIVA = totalTrasladado - totalAcreditable - retencionIVA;

  return {
    iva_trasladado_pue: ivaTrasladadoPUE,
    iva_trasladado_ppd: ivaTrasladadoPPD,
    iva_acreditable_pue: ivaAcreditablePUE,
    iva_acreditable_ppd: ivaAcreditablePPD,
    retencion_iva: retencionIVA,
    retencion_isr: retencionISR,
    total_trasladado: totalTrasladado,
    total_acreditable: totalAcreditable,
    saldo_iva: saldoIVA
  };
}

module.exports = {
  calcularIvaTrasladadoPUE,
  calcularIvaTrasladadoPPD,
  calcularIvaAcreditablePUE,
  calcularIvaAcreditablePPD,
  calcularRetencionIVA,
  calcularRetencionISR,
  calcularIVAPeriodo
};
