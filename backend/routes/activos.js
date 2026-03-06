/**
 * ================================================================
 * ACTIVOS FIJOS Y DEPRECIACIONES — ETX Tax Recovery
 * ================================================================
 * Art. 34 LISR — Tasas de depreciación por tipo de bien
 * Art. 31 LISR — Requisitos deducción
 *
 * GET    /api/activos                    — Listar activos
 * POST   /api/activos                    — Registrar activo
 * PUT    /api/activos/:id                — Actualizar activo
 * DELETE /api/activos/:id                — Dar de baja activo
 * POST   /api/activos/calcular-dep       — Calcular depreciaciones del periodo
 * GET    /api/activos/:id/depreciaciones — Historial de depreciaciones
 * GET    /api/activos/resumen/:year      — Resumen anual de depreciaciones
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Tasas Art. 34 LISR
const TASAS_LISR = {
  'Edificio':         0.05,
  'Mobiliario':       0.10,
  'Equipo':           0.10,
  'Vehiculo':         0.25,
  'Computacion':      0.30,
  'Maquinaria':       0.10,
  'Otro':             0.10,
};

async function getContribId(userId, rfc) {
  let q = 'SELECT id FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc); } else q += ' ORDER BY id LIMIT 1';
  const [r] = await pool.query(q, p);
  return r[0]?.id || null;
}

// ─── GET /api/activos ──────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [rows] = await pool.query(`
      SELECT a.*,
        ROUND(a.costo_adquisicion * a.tasa_depreciacion, 2) AS depreciacion_anual,
        ROUND(a.costo_adquisicion * a.tasa_depreciacion / 12, 2) AS depreciacion_mensual,
        ROUND(a.costo_adquisicion - a.depreciacion_acumulada, 2) AS valor_en_libros,
        cc.numero_cuenta, cc.descripcion AS cuenta_desc
      FROM activos_fijos a
      LEFT JOIN catalogo_cuentas cc ON cc.id = a.cuenta_id
      WHERE a.contribuyente_id = ?
      ORDER BY a.fecha_adquisicion DESC
    `, [contribId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/activos ─────────────────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    const contribId = req.body.contribuyente_id || await getContribId(req.user.id, req.body.rfc);
    const { descripcion, tipo, fecha_adquisicion, costo_adquisicion,
            uuid_cfdi, vida_util_anios, tasa_depreciacion, metodo, cuenta_id } = req.body;

    const tasa = tasa_depreciacion || TASAS_LISR[tipo] || 0.10;
    const vida = vida_util_anios || Math.round(1 / tasa);

    const [r] = await pool.query(
      `INSERT INTO activos_fijos (contribuyente_id, descripcion, tipo, fecha_adquisicion, costo_adquisicion,
         uuid_cfdi, vida_util_anios, tasa_depreciacion, metodo, cuenta_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [contribId, descripcion, tipo, fecha_adquisicion, costo_adquisicion,
       uuid_cfdi || null, vida, tasa, metodo || 'lineal', cuenta_id || null]
    );
    res.json({ success: true, id: r.insertId, tasa_aplicada: tasa, vida_util: vida });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/activos/:id ──────────────────────────────────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { descripcion, tipo, vida_util_anios, tasa_depreciacion, cuenta_id } = req.body;
    await pool.query(
      `UPDATE activos_fijos SET descripcion=?, tipo=?, vida_util_anios=?, tasa_depreciacion=?, cuenta_id=?
       WHERE id = ?`,
      [descripcion, tipo, vida_util_anios, tasa_depreciacion, cuenta_id || null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/activos/:id — Dar de baja ─────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { motivo_baja, fecha_baja } = req.body;
    await pool.query(
      `UPDATE activos_fijos SET activo = 0, fecha_baja = ?, motivo_baja = ? WHERE id = ?`,
      [fecha_baja || new Date().toISOString().slice(0,10), motivo_baja || 'Baja', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/activos/calcular-dep ───────────────────────────────────────────
router.post('/calcular-dep', authMiddleware, async (req, res) => {
  try {
    const contribId = req.body.contribuyente_id || await getContribId(req.user.id, req.body.rfc);
    const { year, mes } = req.body;
    if (!year || !mes) return res.status(400).json({ error: 'year y mes requeridos' });

    const [activos] = await pool.query(
      `SELECT * FROM activos_fijos WHERE contribuyente_id = ? AND activo = 1
       AND fecha_adquisicion <= LAST_DAY(?)`,
      [contribId, `${year}-${String(mes).padStart(2,'0')}-01`]
    );

    let calculados = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const activo of activos) {
        const costoAdq   = parseFloat(activo.costo_adquisicion);
        const tasa       = parseFloat(activo.tasa_depreciacion);
        const depAnual   = costoAdq * tasa;
        const depMens    = depAnual / 12;

        // Depreciación acumulada hasta el periodo anterior
        const [[prev]] = await conn.query(
          `SELECT COALESCE(SUM(depreciacion_periodo),0) AS dep_acum
           FROM depreciaciones WHERE activo_id = ? AND (ejercicio < ? OR (ejercicio = ? AND periodo < ?))`,
          [activo.id, year, year, mes]
        );
        const depAcumPrev = parseFloat(prev.dep_acum || 0);
        const saldoPorDep = Math.max(0, costoAdq - depAcumPrev);

        if (saldoPorDep <= 0) continue; // Totalmente depreciado

        const depPeriodo = Math.min(depMens, saldoPorDep);
        const depAcumTotal = depAcumPrev + depPeriodo;

        await conn.query(`
          INSERT INTO depreciaciones (activo_id, ejercicio, periodo, depreciacion_periodo, depreciacion_acumulada_al_periodo, saldo_por_depreciar)
          VALUES (?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            depreciacion_periodo = VALUES(depreciacion_periodo),
            depreciacion_acumulada_al_periodo = VALUES(depreciacion_acumulada_al_periodo),
            saldo_por_depreciar = VALUES(saldo_por_depreciar)
        `, [activo.id, year, mes, depPeriodo.toFixed(2), depAcumTotal.toFixed(2), (costoAdq - depAcumTotal).toFixed(2)]);

        // Actualizar depreciación acumulada en activo
        await conn.query(
          `UPDATE activos_fijos SET depreciacion_acumulada = ? WHERE id = ?`,
          [depAcumTotal.toFixed(2), activo.id]
        );
        calculados++;
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }

    // Total depreciación del periodo
    const [[totDep]] = await pool.query(
      `SELECT COALESCE(SUM(d.depreciacion_periodo),0) AS total
       FROM depreciaciones d JOIN activos_fijos af ON af.id = d.activo_id
       WHERE af.contribuyente_id = ? AND d.ejercicio = ? AND d.periodo = ?`,
      [contribId, year, mes]
    );

    res.json({
      success: true,
      activos_calculados: calculados,
      total_depreciacion_periodo: parseFloat(totDep.total).toFixed(2)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/activos/:id/depreciaciones ──────────────────────────────────────
router.get('/:id/depreciaciones', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM depreciaciones WHERE activo_id = ? ORDER BY ejercicio, periodo`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/activos/resumen/:year ───────────────────────────────────────────
router.get('/resumen/:year', authMiddleware, async (req, res) => {
  try {
    const contribId = req.query.contribuyente_id || await getContribId(req.user.id, req.query.rfc);
    const [resumen] = await pool.query(`
      SELECT
        d.periodo,
        COUNT(DISTINCT d.activo_id) AS activos,
        ROUND(SUM(d.depreciacion_periodo),2) AS depreciacion_mes,
        ROUND(SUM(d.depreciacion_acumulada_al_periodo),2) AS dep_acumulada
      FROM depreciaciones d
      JOIN activos_fijos af ON af.id = d.activo_id
      WHERE af.contribuyente_id = ? AND d.ejercicio = ?
      GROUP BY d.periodo ORDER BY d.periodo
    `, [contribId, req.params.year]);

    const [[totales]] = await pool.query(`
      SELECT
        COUNT(*) AS total_activos,
        SUM(costo_adquisicion) AS costo_total,
        SUM(depreciacion_acumulada) AS dep_acumulada_total,
        SUM(valor_en_libros) AS valor_libros_total
      FROM activos_fijos WHERE contribuyente_id = ? AND activo = 1
    `, [contribId]);

    res.json({ por_mes: resumen, totales });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
