/**
 * ================================================================
 * ESTADOS DE CUENTA BANCARIOS — ETX Tax Recovery
 * ================================================================
 * POST /api/estados-cuenta/upload     — Subir y parsear estado de cuenta
 * GET  /api/estados-cuenta            — Listar estados de cuenta del usuario
 * GET  /api/estados-cuenta/:id        — Detalle + movimientos
 * POST /api/estados-cuenta/:id/conciliar — Ejecutar conciliación vs CFDIs
 * GET  /api/estados-cuenta/:id/reporte  — Reporte de conciliación
 * DELETE /api/estados-cuenta/:id      — Eliminar estado de cuenta
 * ================================================================
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { parseBankStatement } = require('../utils/bankParsers');

router.use(authMiddleware);

// ─── Multer — guardar en memoria (max 20MB) ───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls', '.txt'].includes(ext)) cb(null, true);
    else cb(new Error('Formato no soportado. Usa CSV o Excel (.xlsx)'));
  },
});

// ─── Helper: obtener contribuyente_id del usuario ─────────────────────────────
async function getContribId(userId, rfc) {
  if (rfc) {
    const [r] = await pool.query(
      'SELECT id FROM contribuyentes WHERE usuario_id = ? AND rfc = ?', [userId, rfc]);
    return r[0]?.id || null;
  }
  const [r] = await pool.query(
    'SELECT id FROM contribuyentes WHERE usuario_id = ? ORDER BY id LIMIT 1', [userId]);
  return r[0]?.id || null;
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estados-cuenta/upload
// Sube, parsea y almacena un estado de cuenta bancario
// ════════════════════════════════════════════════════════════════════════════
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const { rfc } = req.body;
    const contribId = await getContribId(req.user.id, rfc);
    if (!contribId) return res.status(400).json({ error: 'Contribuyente no encontrado. Descarga CFDIs primero.' });

    // Parsear el archivo
    const result = await parseBankStatement(
      req.file.buffer, req.file.mimetype, req.file.originalname
    );

    const { banco, cuenta, titular, formato, movimientos, stats } = result;

    // Verificar solapamiento de periodo (evitar duplicados)
    if (stats.periodo_inicio && stats.periodo_fin) {
      const [exist] = await pool.query(`
        SELECT id, periodo_inicio, periodo_fin FROM estados_cuenta
        WHERE contribuyente_id = ? AND banco = ?
          AND periodo_inicio <= ? AND periodo_fin >= ?
        LIMIT 1
      `, [contribId, banco, stats.periodo_fin, stats.periodo_inicio]);

      if (exist.length > 0) {
        return res.status(409).json({
          error: `Ya existe un estado de ${banco} que cubre este período (${exist[0].periodo_inicio} a ${exist[0].periodo_fin}).`,
          existing_id: exist[0].id,
        });
      }
    }

    // Insertar cabecera del estado de cuenta
    const [ecResult] = await pool.query(`
      INSERT INTO estados_cuenta
        (contribuyente_id, banco, cuenta, titular, periodo_inicio, periodo_fin,
         total_movimientos, total_cargos, total_abonos,
         saldo_inicial, saldo_final, archivo_nombre, formato)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contribId,
      banco,
      cuenta || null,
      titular || null,
      stats.periodo_inicio || null,
      stats.periodo_fin    || null,
      stats.total_movimientos,
      stats.total_cargos,
      stats.total_abonos,
      stats.saldo_inicial  || null,
      stats.saldo_final    || null,
      req.file.originalname,
      formato,
    ]);

    const ecId = ecResult.insertId;

    // Insertar movimientos en lotes de 500
    const BATCH = 500;
    for (let i = 0; i < movimientos.length; i += BATCH) {
      const chunk = movimientos.slice(i, i + BATCH);
      const vals  = chunk.map(m => [
        ecId, m.fecha, m.concepto || '', m.referencia || '',
        m.cargo, m.abono, m.saldo || null, m.tipo,
      ]);
      await pool.query(`
        INSERT INTO movimientos_bancarios
          (estado_cuenta_id, fecha, concepto, referencia, cargo, abono, saldo, tipo)
        VALUES ?
      `, [vals]);
    }

    // Actualizar total_movimientos real (por si el conteo difirió)
    await pool.query('UPDATE estados_cuenta SET total_movimientos = ? WHERE id = ?',
      [movimientos.length, ecId]);

    res.json({
      ok:            true,
      estado_cuenta_id: ecId,
      banco,
      cuenta:        cuenta || '—',
      titular:       titular || '—',
      formato,
      periodo:       { inicio: stats.periodo_inicio, fin: stats.periodo_fin },
      total_movimientos: movimientos.length,
      total_cargos:  stats.total_cargos,
      total_abonos:  stats.total_abonos,
      saldo_final:   stats.saldo_final,
    });

  } catch (err) {
    console.error('[EstadosCuenta] upload:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/estados-cuenta
// Listar todos los estados de cuenta del contribuyente
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { rfc } = req.query;
    const contribId = await getContribId(req.user.id, rfc);
    if (!contribId) return res.json([]);

    const [rows] = await pool.query(`
      SELECT ec.*,
        (SELECT COUNT(*) FROM movimientos_bancarios mb
         WHERE mb.estado_cuenta_id = ec.id AND mb.conciliado = 1) AS movimientos_conciliados
      FROM estados_cuenta ec
      WHERE ec.contribuyente_id = ?
      ORDER BY ec.periodo_inicio DESC, ec.created_at DESC
    `, [contribId]);

    res.json(rows);
  } catch (err) {
    console.error('[EstadosCuenta] list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/estados-cuenta/:id
// Detalle + primeros 200 movimientos
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const ecId = parseInt(req.params.id);
    const [[ec]] = await pool.query(`
      SELECT ec.*, c.rfc, c.nombre AS contrib_nombre
      FROM estados_cuenta ec
      JOIN contribuyentes c ON ec.contribuyente_id = c.id
      WHERE ec.id = ? AND c.usuario_id = ?
    `, [ecId, req.user.id]);

    if (!ec) return res.status(404).json({ error: 'Estado de cuenta no encontrado' });

    const [movimientos] = await pool.query(`
      SELECT * FROM movimientos_bancarios
      WHERE estado_cuenta_id = ?
      ORDER BY fecha, id
      LIMIT 200
    `, [ecId]);

    const [[concStats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(conciliado) AS conciliados,
        SUM(CASE WHEN tipo='ABONO' AND conciliado=0 THEN 1 ELSE 0 END) AS abonos_sin_cfdi,
        SUM(CASE WHEN tipo='CARGO' AND conciliado=0 THEN 1 ELSE 0 END) AS cargos_sin_cfdi,
        ROUND(SUM(CASE WHEN tipo='ABONO' AND conciliado=0 THEN abono ELSE 0 END),2) AS monto_abonos_sin_cfdi,
        ROUND(SUM(CASE WHEN tipo='CARGO' AND conciliado=0 THEN cargo ELSE 0 END),2) AS monto_cargos_sin_cfdi
      FROM movimientos_bancarios
      WHERE estado_cuenta_id = ?
    `, [ecId]);

    res.json({ ...ec, movimientos, conciliacion: concStats });
  } catch (err) {
    console.error('[EstadosCuenta] detail:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estados-cuenta/:id/conciliar
// Motor de conciliación: cruza movimientos bancarios vs CFDIs
//
// Lógica:
//   ABONO → buscar en comprobantes emitidos (tipo I/E)
//   CARGO → buscar en comprobantes recibidos (rfc_receptor = RFC propio)
//
// Criterios de match:
//   1. Monto idéntico (diferencia < 0.50)
//   2. Fecha ±7 días
//   Confianza alta si ambos. Media si solo monto. Baja si solo fecha.
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/conciliar', async (req, res) => {
  try {
    const ecId = parseInt(req.params.id);

    // Verificar pertenencia
    const [[ec]] = await pool.query(`
      SELECT ec.*, c.rfc, c.id AS contrib_id
      FROM estados_cuenta ec
      JOIN contribuyentes c ON ec.contribuyente_id = c.id
      WHERE ec.id = ? AND c.usuario_id = ?
    `, [ecId, req.user.id]);

    if (!ec) return res.status(404).json({ error: 'Estado de cuenta no encontrado' });

    // Resetear conciliación previa de este estado de cuenta
    await pool.query(
      'UPDATE movimientos_bancarios SET conciliado=0, cfdi_uuid=NULL, confianza=NULL, nota_conciliacion=NULL WHERE estado_cuenta_id=?',
      [ecId]
    );

    // ── Obtener movimientos a conciliar ────────────────────────────────────
    const [movimientos] = await pool.query(`
      SELECT * FROM movimientos_bancarios WHERE estado_cuenta_id = ? ORDER BY fecha
    `, [ecId]);

    if (movimientos.length === 0) {
      return res.json({ ok: true, conciliados: 0, sin_match: 0, mensaje: 'Sin movimientos' });
    }

    // ── Cargar CFDIs del periodo del estado de cuenta ──────────────────────
    const periodoInicio = ec.periodo_inicio || '2000-01-01';
    const periodoFin    = ec.periodo_fin    || '2099-12-31';
    const contribId     = ec.contrib_id;
    const rfcPropio     = ec.rfc;

    // CFDIs emitidos (facturas de ingresos → corresponden a ABONOS en banco)
    const [cfdiEmitidos] = await pool.query(`
      SELECT uuid, fecha, total, total_traslados, metodo_pago, estado, rfc_receptor, nombre_receptor
      FROM comprobantes
      WHERE contribuyente_id = ? AND tipo_de_comprobante IN ('I','E')
        AND estado = 'Vigente'
        AND fecha BETWEEN DATE_SUB(?, INTERVAL 15 DAY) AND DATE_ADD(?, INTERVAL 15 DAY)
      ORDER BY fecha
    `, [contribId, periodoInicio, periodoFin]);

    // CFDIs recibidos (facturas de gastos → corresponden a CARGOS en banco)
    const [cfdiRecibidos] = await pool.query(`
      SELECT uuid, fecha, total, total_traslados, metodo_pago, estado, rfc_emisor, nombre_emisor
      FROM comprobantes
      WHERE rfc_receptor = ? AND tipo_de_comprobante = 'I'
        AND estado = 'Vigente'
        AND fecha BETWEEN DATE_SUB(?, INTERVAL 15 DAY) AND DATE_ADD(?, INTERVAL 15 DAY)
      ORDER BY fecha
    `, [rfcPropio, periodoInicio, periodoFin]);

    // Set de UUIDs ya usados (un CFDI solo se concilia con un movimiento)
    const usedCFDIs = new Set();

    // ── Función de match ────────────────────────────────────────────────────
    const DIAS_TOLERANCIA    = 7;
    const MONTO_TOLERANCIA   = 0.50; // hasta 50 centavos de diferencia

    function diffDays(d1, d2) {
      return Math.abs((new Date(d1) - new Date(d2)) / 86400000);
    }

    function buscarMatch(monto, fecha, lista) {
      let best = null, bestScore = -1;

      for (const cfdi of lista) {
        if (usedCFDIs.has(cfdi.uuid)) continue;
        const diff  = Math.abs(parseFloat(cfdi.total) - monto);
        const dias  = diffDays(cfdi.fecha, fecha);

        if (diff > 100) continue;  // monto muy diferente, descartar rápido

        const montoOk = diff <= MONTO_TOLERANCIA;
        const fechaOk = dias <= DIAS_TOLERANCIA;

        let score = 0;
        if (montoOk) score += 70;
        if (fechaOk) score += 30;
        // Bonus por monto exacto
        if (diff === 0) score += 20;
        // Penalizar por días lejanos
        score -= dias * 2;

        if (score > bestScore && score >= 30) {
          bestScore = score;
          best = { cfdi, confianza: Math.min(100, score), diff, dias };
        }
      }
      return best;
    }

    // ── Conciliar cada movimiento ───────────────────────────────────────────
    let conciliados = 0, sinMatch = 0;

    for (const mov of movimientos) {
      const monto = mov.tipo === 'ABONO' ? mov.abono : mov.cargo;
      const lista = mov.tipo === 'ABONO' ? cfdiEmitidos : cfdiRecibidos;

      const match = buscarMatch(monto, mov.fecha, lista);

      if (match) {
        usedCFDIs.add(match.cfdi.uuid);
        const nota = `CFDI ${match.cfdi.uuid.substring(0,8)}… | Δmonto $${match.diff.toFixed(2)} | Δdías ${match.dias}`;
        await pool.query(`
          UPDATE movimientos_bancarios
          SET conciliado=1, cfdi_uuid=?, confianza=?, nota_conciliacion=?
          WHERE id=?
        `, [match.cfdi.uuid, match.confianza, nota, mov.id]);
        conciliados++;
      } else {
        sinMatch++;
      }
    }

    // ── Actualizar resumen en estados_cuenta ────────────────────────────────
    await pool.query(`
      UPDATE estados_cuenta
      SET total_movimientos = ?
      WHERE id = ?
    `, [movimientos.length, ecId]);

    // ── Estadísticas del resultado ──────────────────────────────────────────
    const [[stats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(conciliado) AS conciliados,
        SUM(CASE WHEN tipo='ABONO' AND conciliado=0 THEN 1 ELSE 0 END) AS abonos_sin_cfdi,
        SUM(CASE WHEN tipo='CARGO' AND conciliado=0 THEN 1 ELSE 0 END) AS cargos_sin_cfdi,
        ROUND(SUM(CASE WHEN tipo='ABONO' AND conciliado=0 THEN abono ELSE 0 END),2) AS monto_abonos_sin_cfdi,
        ROUND(SUM(CASE WHEN tipo='CARGO' AND conciliado=0 THEN cargo ELSE 0 END),2) AS monto_cargos_sin_cfdi,
        ROUND(AVG(CASE WHEN conciliado=1 THEN confianza END),1) AS confianza_promedio
      FROM movimientos_bancarios WHERE estado_cuenta_id = ?
    `, [ecId]);

    res.json({
      ok:              true,
      conciliados,
      sin_match:       sinMatch,
      total:           movimientos.length,
      pct_conciliado:  movimientos.length > 0 ? Math.round((conciliados / movimientos.length) * 100) : 0,
      abonos_sin_cfdi: parseInt(stats.abonos_sin_cfdi || 0),
      cargos_sin_cfdi: parseInt(stats.cargos_sin_cfdi || 0),
      monto_abonos_sin_cfdi: parseFloat(stats.monto_abonos_sin_cfdi || 0),
      monto_cargos_sin_cfdi: parseFloat(stats.monto_cargos_sin_cfdi || 0),
      confianza_promedio: parseFloat(stats.confianza_promedio || 0),
      riesgo_fiscal: {
        ingresos_sin_cfdi: parseFloat(stats.monto_abonos_sin_cfdi || 0) > 0,
        monto:             parseFloat(stats.monto_abonos_sin_cfdi || 0),
        descripcion:       'Ingresos bancarios sin CFDI correspondiente — posible omisión fiscal (Art. 34 CFF)',
      },
    });

  } catch (err) {
    console.error('[EstadosCuenta] conciliar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/estados-cuenta/:id/reporte
// Reporte completo de conciliación (para dashboard)
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/reporte', async (req, res) => {
  try {
    const ecId = parseInt(req.params.id);

    const [[ec]] = await pool.query(`
      SELECT ec.*, c.rfc, c.nombre AS contrib_nombre
      FROM estados_cuenta ec
      JOIN contribuyentes c ON ec.contribuyente_id = c.id
      WHERE ec.id = ? AND c.usuario_id = ?
    `, [ecId, req.user.id]);

    if (!ec) return res.status(404).json({ error: 'Estado de cuenta no encontrado' });

    // Resumen general
    const [[resumen]] = await pool.query(`
      SELECT
        COUNT(*) AS total_movimientos,
        SUM(conciliado) AS conciliados,
        COUNT(*) - SUM(conciliado) AS sin_conciliar,
        ROUND(SUM(abono),2) AS total_abonos,
        ROUND(SUM(cargo),2) AS total_cargos,
        ROUND(SUM(CASE WHEN tipo='ABONO' AND conciliado=0 THEN abono ELSE 0 END),2) AS abonos_sin_cfdi,
        ROUND(SUM(CASE WHEN tipo='CARGO' AND conciliado=0 THEN cargo ELSE 0 END),2) AS cargos_sin_cfdi,
        ROUND(SUM(CASE WHEN conciliado=1 THEN (CASE WHEN tipo='ABONO' THEN abono ELSE cargo END) ELSE 0 END),2) AS monto_conciliado
      FROM movimientos_bancarios WHERE estado_cuenta_id = ?
    `, [ecId]);

    // Movimientos sin CFDI — riesgo fiscal (top 20 por monto)
    const [sinCFDI] = await pool.query(`
      SELECT id, fecha, concepto, referencia, tipo,
             CASE WHEN tipo='ABONO' THEN abono ELSE cargo END AS monto
      FROM movimientos_bancarios
      WHERE estado_cuenta_id = ? AND conciliado = 0
      ORDER BY monto DESC LIMIT 20
    `, [ecId]);

    // Distribución mensual
    const [porMes] = await pool.query(`
      SELECT
        DATE_FORMAT(fecha, '%Y-%m') AS periodo,
        COUNT(*) AS movimientos,
        ROUND(SUM(abono),2) AS abonos,
        ROUND(SUM(cargo),2) AS cargos,
        SUM(conciliado) AS conciliados
      FROM movimientos_bancarios
      WHERE estado_cuenta_id = ?
      GROUP BY DATE_FORMAT(fecha, '%Y-%m')
      ORDER BY periodo
    `, [ecId]);

    res.json({
      estado_cuenta:  ec,
      resumen,
      sin_cfdi:       sinCFDI,
      por_mes:        porMes,
      alertas_fiscales: buildAlertas(resumen, sinCFDI),
    });

  } catch (err) {
    console.error('[EstadosCuenta] reporte:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Generar alertas fiscales del reporte ─────────────────────────────────────
function buildAlertas(resumen, sinCFDI) {
  const alertas = [];
  const abonosSinCFDI  = parseFloat(resumen.abonos_sin_cfdi || 0);
  const cargosSinCFDI  = parseFloat(resumen.cargos_sin_cfdi || 0);
  const total          = parseInt(resumen.total_movimientos || 0);
  const conciliados    = parseInt(resumen.conciliados || 0);
  const pct            = total > 0 ? Math.round((conciliados / total) * 100) : 0;

  if (abonosSinCFDI > 5000) {
    alertas.push({
      nivel:   'error',
      titulo:  'Ingresos sin CFDI',
      detalle: `$${abonosSinCFDI.toLocaleString('es-MX')} en depósitos sin factura correspondiente. El SAT puede considerar estos ingresos como omitidos (Art. 34 CFF).`,
      accion:  'Emitir CFDI retroactivo o aclarar el origen de los depósitos',
    });
  }

  if (cargosSinCFDI > 5000) {
    alertas.push({
      nivel:   'warning',
      titulo:  'Pagos sin Factura de Proveedor',
      detalle: `$${cargosSinCFDI.toLocaleString('es-MX')} en pagos a proveedores sin CFDI recibido. Estos gastos NO son deducibles para ISR (Art. 28 LISR).`,
      accion:  'Solicitar factura CFDI 4.0 a proveedores',
    });
  }

  if (pct < 50 && total > 10) {
    alertas.push({
      nivel:   'warning',
      titulo:  'Baja Conciliación',
      detalle: `Solo el ${pct}% de los movimientos bancarios tiene CFDI correspondiente. Descarga todos tus CFDIs del SAT para mejorar la conciliación.`,
      accion:  'Descargar CFDIs recibidos en el Paso 2',
    });
  } else if (pct >= 90) {
    alertas.push({
      nivel:   'ok',
      titulo:  'Excelente Conciliación',
      detalle: `El ${pct}% de los movimientos bancarios concilian con CFDIs. Cumplimiento fiscal óptimo.`,
      accion:  null,
    });
  }

  return alertas;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/estados-cuenta/resumen/global
// Resumen de todos los estados de cuenta del contribuyente
// ════════════════════════════════════════════════════════════════════════════
router.get('/resumen/global', async (req, res) => {
  try {
    const { rfc, year } = req.query;
    const contribId = await getContribId(req.user.id, rfc);
    if (!contribId) return res.json({ sin_datos: true });

    const yearFilter = year ? `AND YEAR(mb.fecha) = ${parseInt(year)}` : '';

    const [[global]] = await pool.query(`
      SELECT
        COUNT(DISTINCT ec.id) AS estados_cargados,
        COUNT(mb.id) AS total_movimientos,
        SUM(mb.conciliado) AS conciliados,
        ROUND(SUM(mb.abono),2) AS total_abonos,
        ROUND(SUM(mb.cargo),2) AS total_cargos,
        ROUND(SUM(CASE WHEN mb.tipo='ABONO' AND mb.conciliado=0 THEN mb.abono ELSE 0 END),2) AS abonos_sin_cfdi,
        ROUND(SUM(CASE WHEN mb.tipo='CARGO' AND mb.conciliado=0 THEN mb.cargo ELSE 0 END),2) AS cargos_sin_cfdi
      FROM estados_cuenta ec
      JOIN movimientos_bancarios mb ON mb.estado_cuenta_id = ec.id
      WHERE ec.contribuyente_id = ? ${yearFilter}
    `, [contribId]);

    const [porBanco] = await pool.query(`
      SELECT ec.banco,
        COUNT(DISTINCT ec.id) AS estados,
        COUNT(mb.id) AS movimientos,
        ROUND(SUM(mb.abono),2) AS total_abonos,
        ROUND(SUM(mb.cargo),2) AS total_cargos
      FROM estados_cuenta ec
      JOIN movimientos_bancarios mb ON mb.estado_cuenta_id = ec.id
      WHERE ec.contribuyente_id = ? ${yearFilter}
      GROUP BY ec.banco
      ORDER BY total_abonos DESC
    `, [contribId]);

    const total = parseInt(global?.total_movimientos || 0);
    const conc  = parseInt(global?.conciliados || 0);

    res.json({
      ...global,
      pct_conciliado: total > 0 ? Math.round((conc / total) * 100) : 0,
      por_banco: porBanco,
      sin_datos: total === 0,
    });

  } catch (err) {
    console.error('[EstadosCuenta] resumen/global:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/estados-cuenta/:id
// ════════════════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const ecId = parseInt(req.params.id);

    const [[ec]] = await pool.query(`
      SELECT ec.id FROM estados_cuenta ec
      JOIN contribuyentes c ON ec.contribuyente_id = c.id
      WHERE ec.id = ? AND c.usuario_id = ?
    `, [ecId, req.user.id]);

    if (!ec) return res.status(404).json({ error: 'No encontrado' });

    await pool.query('DELETE FROM movimientos_bancarios WHERE estado_cuenta_id = ?', [ecId]);
    await pool.query('DELETE FROM estados_cuenta WHERE id = ?', [ecId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[EstadosCuenta] delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
