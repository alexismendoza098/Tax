/**
 * ================================================================
 * ESTADOS FINANCIEROS — ETX Tax Recovery
 * ================================================================
 * GET /api/estados-financieros/balance          — Balance General
 * GET /api/estados-financieros/resultados       — Estado de Resultados
 * GET /api/estados-financieros/flujo            — Flujo de Efectivo (método indirecto)
 * GET /api/estados-financieros/dashboard        — Dashboard ejecutivo KPIs
 * GET /api/estados-financieros/kpis             — Razones financieras
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');

async function getContribId(userId, rfc) {
  let q = 'SELECT id, rfc, nombre FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc); } else q += ' ORDER BY id LIMIT 1';
  const [r] = await pool.query(q, p);
  return r[0] || null;
}

// Helper: suma de saldos de cuentas por tipo
async function saldosCuentas(contribId, year, mes) {
  const [rows] = await pool.query(`
    SELECT cc.tipo, cc.naturaleza, cc.numero_cuenta, cc.descripcion,
           COALESCE(bc.saldo_final_debe,0)  AS saldo_debe,
           COALESCE(bc.saldo_final_haber,0) AS saldo_haber
    FROM catalogo_cuentas cc
    LEFT JOIN balanza_verificacion bc ON bc.cuenta_id = cc.id
      AND bc.ejercicio = ? AND bc.periodo = ?
    WHERE cc.contribuyente_id = ? AND cc.activa = 1
    ORDER BY cc.numero_cuenta
  `, [year, mes, contribId]);
  return rows;
}

function calcSaldo(row) {
  // Cuentas de naturaleza Deudora: saldo = Debe - Haber (positivo si activo/gasto)
  // Cuentas de naturaleza Acreedora: saldo = Haber - Debe (positivo si pasivo/ingreso/capital)
  const debe  = parseFloat(row.saldo_debe  || 0);
  const haber = parseFloat(row.saldo_haber || 0);
  return row.naturaleza === 'D' ? debe - haber : haber - debe;
}

// ─── GET /api/estados-financieros/balance ─────────────────────────────────────
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    if (!contrib) return res.status(400).json({ error: 'Contribuyente no encontrado' });
    const year = req.query.year || new Date().getFullYear();
    const mes  = req.query.mes  || new Date().getMonth() + 1;

    const cuentas = await saldosCuentas(contrib.id, year, mes);

    const activo   = { circulante: [], no_circulante: [], total: 0 };
    const pasivo   = { corto_plazo: [], largo_plazo: [], total: 0 };
    const capital  = { cuentas: [], total: 0 };

    for (const c of cuentas) {
      const saldo = calcSaldo(c);
      if (saldo === 0) continue;
      const item = { cuenta: c.numero_cuenta, descripcion: c.descripcion, saldo };

      if (c.tipo === 'Activo') {
        if (c.sub_tipo?.includes('No Circulante') || c.sub_tipo?.includes('Fijo')) {
          activo.no_circulante.push(item);
        } else {
          activo.circulante.push(item);
        }
        activo.total += saldo;
      } else if (c.tipo === 'Pasivo') {
        if (c.sub_tipo?.includes('LP') || c.sub_tipo?.includes('Largo')) {
          pasivo.largo_plazo.push(item);
        } else {
          pasivo.corto_plazo.push(item);
        }
        pasivo.total += saldo;
      } else if (c.tipo === 'Capital') {
        capital.cuentas.push(item);
        capital.total += saldo;
      }
    }

    const cuadra = Math.abs(activo.total - (pasivo.total + capital.total)) < 1;
    res.json({
      periodo: `${year}-${String(mes).padStart(2,'0')}`,
      contribuyente: contrib.nombre,
      rfc: contrib.rfc,
      activo, pasivo, capital,
      ecuacion_contable: {
        activo: activo.total.toFixed(2),
        pasivo_mas_capital: (pasivo.total + capital.total).toFixed(2),
        cuadra
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/estados-financieros/resultados ──────────────────────────────────
router.get('/resultados', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    if (!contrib) return res.status(400).json({ error: 'Contribuyente no encontrado' });
    const year = req.query.year || new Date().getFullYear();
    const mes  = req.query.mes  || 12;

    // Usar datos de CFDIs directamente si no hay pólizas
    const [[ventas]] = await pool.query(`
      SELECT COALESCE(SUM(subtotal),0) AS total
      FROM comprobantes
      WHERE rfc_emisor = ? AND tipo_de_comprobante = 'I' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);

    const [[notas]] = await pool.query(`
      SELECT COALESCE(SUM(subtotal),0) AS total
      FROM comprobantes
      WHERE rfc_emisor = ? AND tipo_de_comprobante = 'E' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);

    const [[gastos]] = await pool.query(`
      SELECT COALESCE(SUM(subtotal),0) AS total
      FROM comprobantes
      WHERE rfc_receptor = ? AND tipo_de_comprobante = 'I' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
        AND rfc_emisor NOT LIKE 'XEX%'
    `, [contrib.rfc, year, mes]);

    const [[nomina]] = await pool.query(`
      SELECT COALESCE(SUM(total),0) AS total
      FROM comprobantes
      WHERE rfc_emisor = ? AND tipo_de_comprobante = 'N' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);

    const [[depRow]] = await pool.query(`
      SELECT COALESCE(SUM(depreciacion_periodo),0) AS total
      FROM depreciaciones d
      JOIN activos_fijos af ON af.id = d.activo_id
      WHERE af.contribuyente_id = ? AND d.ejercicio = ? AND d.periodo <= ?
    `, [contrib.id, year, mes]);

    const ingresos_netos  = parseFloat(ventas.total) - parseFloat(notas.total);
    const total_gastos    = parseFloat(gastos.total);
    const total_nomina    = parseFloat(nomina.total);
    const total_deprec    = parseFloat(depRow.total || 0);
    const utilidad_bruta  = ingresos_netos;
    const utilidad_operativa = ingresos_netos - total_gastos - total_nomina - total_deprec;
    const impuesto_estimado  = Math.max(0, utilidad_operativa * 0.30);
    const utilidad_neta      = utilidad_operativa - impuesto_estimado;

    // Por mes (para gráfica)
    const [porMes] = await pool.query(`
      SELECT MONTH(fecha) AS mes,
        ROUND(SUM(CASE WHEN tipo_de_comprobante='I' THEN subtotal ELSE 0 END),2) AS ingresos,
        ROUND(SUM(CASE WHEN tipo_de_comprobante='E' THEN subtotal ELSE 0 END),2) AS notas
      FROM comprobantes
      WHERE rfc_emisor = ? AND estado != 'Cancelado' AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
      GROUP BY MONTH(fecha) ORDER BY mes
    `, [contrib.rfc, year, mes]);

    res.json({
      periodo: `${year} enero-${mes_nombre(mes)}`,
      ingresos: {
        ventas: parseFloat(ventas.total).toFixed(2),
        notas_credito: parseFloat(notas.total).toFixed(2),
        netos: ingresos_netos.toFixed(2)
      },
      costos_gastos: {
        gastos_operativos: total_gastos.toFixed(2),
        nomina: total_nomina.toFixed(2),
        depreciacion: total_deprec.toFixed(2),
        total: (total_gastos + total_nomina + total_deprec).toFixed(2)
      },
      resultados: {
        utilidad_bruta: utilidad_bruta.toFixed(2),
        utilidad_operativa: utilidad_operativa.toFixed(2),
        impuesto_estimado_30pct: impuesto_estimado.toFixed(2),
        utilidad_neta: utilidad_neta.toFixed(2),
        margen_utilidad_pct: ingresos_netos > 0
          ? ((utilidad_neta / ingresos_netos) * 100).toFixed(2)
          : '0.00'
      },
      por_mes: porMes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/estados-financieros/flujo ───────────────────────────────────────
// Flujo de efectivo (método indirecto — simplificado)
router.get('/flujo', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    const year = req.query.year || new Date().getFullYear();
    const mes  = req.query.mes  || 12;

    const [[ingresos]] = await pool.query(`
      SELECT COALESCE(SUM(total),0) AS total FROM comprobantes
      WHERE rfc_emisor = ? AND tipo_de_comprobante = 'I' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);

    const [[egresos]] = await pool.query(`
      SELECT COALESCE(SUM(total),0) AS total FROM comprobantes
      WHERE rfc_receptor = ? AND tipo_de_comprobante = 'I' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);

    const [[nomina]] = await pool.query(`
      SELECT COALESCE(SUM(total),0) AS total FROM comprobantes
      WHERE rfc_emisor = ? AND tipo_de_comprobante = 'N' AND estado != 'Cancelado'
        AND YEAR(fecha) = ? AND MONTH(fecha) <= ?
    `, [contrib.rfc, year, mes]);

    const [[activos_comp]] = await pool.query(`
      SELECT COALESCE(SUM(costo_adquisicion),0) AS total FROM activos_fijos
      WHERE contribuyente_id = ? AND YEAR(fecha_adquisicion) = ? AND MONTH(fecha_adquisicion) <= ?
    `, [contrib.id, year, mes]);

    const [[isr_prov]] = await pool.query(`
      SELECT COALESCE(SUM(isr_a_pagar),0) AS total FROM isr_pagos_provisionales
      WHERE contribuyente_id = ? AND ejercicio = ? AND periodo <= ? AND estado IN ('pagado','declarado')
    `, [contrib.id, year, mes]);

    const ingresosNum = parseFloat(ingresos.total);
    const egresosNum  = parseFloat(egresos.total);
    const nominaNum   = parseFloat(nomina.total);
    const activosNum  = parseFloat(activos_comp.total);
    const isrNum      = parseFloat(isr_prov.total);

    const flujoOper = ingresosNum - egresosNum - nominaNum;
    const flujoInv  = -activosNum;
    const flujoFin  = -isrNum;
    const flujoNeto = flujoOper + flujoInv + flujoFin;

    res.json({
      periodo: `${year} acumulado`,
      actividades_operacion: {
        cobros_clientes: ingresosNum.toFixed(2),
        pagos_proveedores: (-egresosNum).toFixed(2),
        pagos_nomina: (-nominaNum).toFixed(2),
        flujo_operativo: flujoOper.toFixed(2)
      },
      actividades_inversion: {
        adquisicion_activos: (-activosNum).toFixed(2),
        flujo_inversion: flujoInv.toFixed(2)
      },
      actividades_financiamiento: {
        isr_pagado: (-isrNum).toFixed(2),
        flujo_financiamiento: flujoFin.toFixed(2)
      },
      flujo_neto: flujoNeto.toFixed(2),
      alerta: flujoNeto < 0 ? 'FLUJO NEGATIVO: Revisar liquidez' : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/estados-financieros/dashboard ───────────────────────────────────
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    if (!contrib) return res.status(400).json({ error: 'Sin contribuyente' });
    const year = req.query.year || new Date().getFullYear();
    const mes  = req.query.mes  || new Date().getMonth() + 1;

    const [[cfdis]]    = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS vol FROM comprobantes WHERE contribuyente_id = ? AND YEAR(fecha)=?`, [contrib.id, year]);
    const [[vigentes]] = await pool.query(`SELECT COUNT(*) AS n FROM comprobantes WHERE contribuyente_id=? AND estado='Vigente' AND YEAR(fecha)=?`, [contrib.id, year]);
    const [[cancelados]] = await pool.query(`SELECT COUNT(*) AS n FROM comprobantes WHERE contribuyente_id=? AND estado='Cancelado' AND YEAR(fecha)=?`, [contrib.id, year]);
    const [[ivaTras]]  = await pool.query(`SELECT COALESCE(SUM(total_traslados),0) AS iva FROM comprobantes WHERE rfc_emisor=? AND estado!='Cancelado' AND YEAR(fecha)=?`, [contrib.rfc, year]);
    const [[ivaActed]] = await pool.query(`SELECT COALESCE(SUM(total_traslados),0) AS iva FROM comprobantes WHERE rfc_receptor=? AND estado!='Cancelado' AND YEAR(fecha)=?`, [contrib.rfc, year]);
    const [[isrRow]]   = await pool.query(`SELECT COALESCE(SUM(isr_a_pagar),0) AS total FROM isr_pagos_provisionales WHERE contribuyente_id=? AND ejercicio=?`, [contrib.id, year]);
    const [[activos]]  = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(valor_en_libros),0) AS valor FROM activos_fijos WHERE contribuyente_id=? AND activo=1`, [contrib.id]);
    const [[alertasRow]] = await pool.query(`SELECT COUNT(*) AS n FROM alertas_fiscales WHERE contribuyente_id=? AND resuelta=0`, [contrib.id]);
    const [[papeleraRow]] = await pool.query(`SELECT COUNT(*) AS n FROM papelera WHERE contribuyente_id=?`, [contrib.id]);

    const ivaSaldo = parseFloat(ivaTras.iva) - parseFloat(ivaActed.iva);

    // Tendencia últimos 6 meses
    const [tendencia] = await pool.query(`
      SELECT YEAR(fecha) AS anio, MONTH(fecha) AS mes,
        ROUND(SUM(CASE WHEN rfc_emisor=? AND tipo_de_comprobante='I' THEN total ELSE 0 END),2) AS ingresos,
        ROUND(SUM(CASE WHEN rfc_receptor=? AND tipo_de_comprobante='I' THEN total ELSE 0 END),2) AS egresos
      FROM comprobantes WHERE contribuyente_id=? AND estado!='Cancelado'
        AND fecha >= DATE_SUB(LAST_DAY(CONCAT(?,'-',LPAD(?,2,'0'),'-01')), INTERVAL 6 MONTH)
      GROUP BY YEAR(fecha), MONTH(fecha) ORDER BY anio, mes
    `, [contrib.rfc, contrib.rfc, contrib.id, year, mes]);

    res.json({
      contribuyente: contrib.nombre,
      rfc: contrib.rfc,
      periodo: `${year}`,
      kpis: {
        total_cfdis: cfdis.n,
        volumen_operaciones: parseFloat(cfdis.vol).toFixed(2),
        vigentes: vigentes.n,
        cancelados: cancelados.n,
        iva_trasladado: parseFloat(ivaTras.iva).toFixed(2),
        iva_acreditable: parseFloat(ivaActed.iva).toFixed(2),
        saldo_iva: ivaSaldo.toFixed(2),
        isr_acumulado: parseFloat(isrRow.total).toFixed(2),
        activos_fijos: activos.n,
        valor_activos: parseFloat(activos.valor).toFixed(2),
        alertas_activas: alertasRow.n,
        registros_papelera: papeleraRow.n
      },
      tendencia
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/estados-financieros/kpis — Razones financieras ─────────────────
router.get('/kpis', authMiddleware, async (req, res) => {
  try {
    const contrib = await getContribId(req.user.id, req.query.rfc);
    const year = req.query.year || new Date().getFullYear();
    const mes  = req.query.mes  || 12;

    const [[ingresos]] = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS t FROM comprobantes WHERE rfc_emisor=? AND tipo_de_comprobante='I' AND estado!='Cancelado' AND YEAR(fecha)=? AND MONTH(fecha)<=?`,
      [contrib.rfc, year, mes]
    );
    const [[egresos]] = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS t FROM comprobantes WHERE rfc_receptor=? AND tipo_de_comprobante='I' AND estado!='Cancelado' AND YEAR(fecha)=? AND MONTH(fecha)<=?`,
      [contrib.rfc, year, mes]
    );
    const [[clientes]] = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS t FROM comprobantes WHERE rfc_emisor=? AND tipo_de_comprobante='I' AND metodo_pago='PPD' AND estado!='Cancelado' AND YEAR(fecha)=?`,
      [contrib.rfc, year]
    );
    const [[proveedores]] = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS t FROM comprobantes WHERE rfc_receptor=? AND tipo_de_comprobante='I' AND estado!='Cancelado' AND YEAR(fecha)=?`,
      [contrib.rfc, year]
    );

    const i = parseFloat(ingresos.t);
    const e = parseFloat(egresos.t);
    const utilidad = i - e;

    res.json({
      razon_eficiencia: e > 0 ? (i / e).toFixed(4) : null,
      margen_utilidad_pct: i > 0 ? ((utilidad / i) * 100).toFixed(2) : '0',
      rotacion_cuentas_cobrar: i > 0 ? (i / Math.max(1, parseFloat(clientes.t))).toFixed(2) : null,
      ratio_deuda_ingreso: i > 0 ? (parseFloat(proveedores.t) / i).toFixed(4) : null,
      cobertura_gastos: e > 0 ? (i / e).toFixed(2) : null,
      interpretacion: {
        eficiencia: e > 0 && i/e > 1 ? 'Genera más de lo que gasta' : 'Gastos superan ingresos',
        margen: utilidad > 0 ? 'Rentable' : 'Pérdida en el periodo',
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function mes_nombre(n) {
  return ['','enero','febrero','marzo','abril','mayo','junio',
          'julio','agosto','septiembre','octubre','noviembre','diciembre'][parseInt(n)] || n;
}

module.exports = router;
