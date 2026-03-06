const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { calcularIVAPeriodo } = require('../utils/ivaCalculator');

const router = express.Router();
router.use(authMiddleware);

// GET /api/calculo-iva — get existing IVA report for a contributor/period
router.get('/', async (req, res) => {
  try {
    let { contribuyente_id, rfc, year, mes } = req.query;

    if (!contribuyente_id && rfc) {
       const [c] = await pool.query('SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?', [rfc, req.user.id]);
       if (c.length > 0) contribuyente_id = c[0].id;
    }

    if (!contribuyente_id) {
      return res.status(400).json({ error: 'contribuyente_id o rfc es requerido' });
    }

    let where = ['r.contribuyente_id = ?'];
    let params = [contribuyente_id];

    if (year) {
      where.push('r.periodo_year = ?');
      params.push(year);
    }
    if (mes) {
      where.push('r.periodo_mes = ?');
      params.push(mes);
    }

    const [rows] = await pool.query(
      `SELECT r.*, c.rfc, c.nombre
       FROM reportes_iva r
       JOIN contribuyentes c ON r.contribuyente_id = c.id
       WHERE ${where.join(' AND ')}
       ORDER BY r.periodo_year DESC, r.periodo_mes DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error('Error obteniendo reporte IVA:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/calculo-iva/generar — calculate IVA for a period
router.post('/generar', async (req, res) => {
  try {
    let { contribuyente_id, rfc, year, mes } = req.body;

    if (!contribuyente_id && rfc) {
       const [c] = await pool.query('SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?', [rfc, req.user.id]);
       if (c.length > 0) contribuyente_id = c[0].id;
       else {
           // Auto-create if not exists, similar to flatten?
           // For now, let's create it to ensure smooth flow
           const [newC] = await pool.query('INSERT INTO contribuyentes (rfc, usuario_id) VALUES (?, ?)', [rfc, req.user.id]);
           contribuyente_id = newC.insertId;
       }
    }

    if (!contribuyente_id || !year || !mes) {
      return res.status(400).json({ error: 'contribuyente_id (o rfc), year y mes son requeridos' });
    }

    // Verify contributor belongs to user
    const [contrib] = await pool.query(
      'SELECT * FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contrib.length === 0) {
      return res.status(404).json({ error: 'Contribuyente no encontrado' });
    }

    // Calculate IVA
    const resultado = await calcularIVAPeriodo(contribuyente_id, year, mes);

    // Upsert report
    await pool.query(
      `INSERT INTO reportes_iva (contribuyente_id, periodo_year, periodo_mes,
        iva_trasladado_pue, iva_trasladado_ppd, iva_acreditable_pue, iva_acreditable_ppd,
        retencion_iva, retencion_isr, saldo_iva)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        iva_trasladado_pue = VALUES(iva_trasladado_pue),
        iva_trasladado_ppd = VALUES(iva_trasladado_ppd),
        iva_acreditable_pue = VALUES(iva_acreditable_pue),
        iva_acreditable_ppd = VALUES(iva_acreditable_ppd),
        retencion_iva = VALUES(retencion_iva),
        retencion_isr = VALUES(retencion_isr),
        saldo_iva = VALUES(saldo_iva),
        created_at = CURRENT_TIMESTAMP`,
      [contribuyente_id, year, mes,
       resultado.iva_trasladado_pue, resultado.iva_trasladado_ppd,
       resultado.iva_acreditable_pue, resultado.iva_acreditable_ppd,
       resultado.retencion_iva, resultado.retencion_isr,
       resultado.saldo_iva]
    );

    res.json({
      contribuyente: contrib[0],
      periodo: { year: parseInt(year), mes: parseInt(mes) },
      ...resultado
    });
  } catch (err) {
    console.error('Error calculando IVA:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
