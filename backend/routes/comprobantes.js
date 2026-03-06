const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// GET /api/comprobantes — list with filters
router.get('/', async (req, res) => {
  try {
    const { contribuyente_id, tipo, metodo_pago, fecha_inicio, fecha_fin, rfc, search, page = 1, limit = 50 } = req.query;

    let where = ['1=1'];
    let params = [];

    if (contribuyente_id) {
      where.push('c.contribuyente_id = ?');
      params.push(contribuyente_id);
    }
    if (tipo) {
      where.push('c.tipo_de_comprobante = ?');
      params.push(tipo);
    }
    if (metodo_pago) {
      where.push('c.metodo_pago = ?');
      params.push(metodo_pago);
    }
    if (fecha_inicio) {
      where.push('c.fecha >= ?');
      params.push(fecha_inicio);
    }
    if (fecha_fin) {
      where.push('c.fecha <= ?');
      params.push(fecha_fin + ' 23:59:59');
    }
    if (rfc) {
      where.push('(c.rfc_emisor = ? OR c.rfc_receptor = ?)');
      params.push(rfc, rfc);
    }
    if (search) {
      where.push('(c.uuid LIKE ? OR c.rfc_emisor LIKE ? OR c.rfc_receptor LIKE ? OR c.nombre_emisor LIKE ? OR c.nombre_receptor LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Count total
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM comprobantes c WHERE ${where.join(' AND ')}`,
      params
    );

    // Fetch page
    const [rows] = await pool.query(
      `SELECT c.* FROM comprobantes c WHERE ${where.join(' AND ')} ORDER BY c.fecha DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      data: rows,
      total: countResult[0].total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(countResult[0].total / parseInt(limit))
    });
  } catch (err) {
    console.error('Error listando comprobantes:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/comprobantes/:uuid — full detail
router.get('/:uuid', async (req, res) => {
  try {
    const uuid = req.params.uuid;

    const [comprobante] = await pool.query('SELECT * FROM comprobantes WHERE uuid = ?', [uuid]);
    if (comprobante.length === 0) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    const [conceptos] = await pool.query('SELECT * FROM conceptos WHERE uuid = ? ORDER BY concepto_index', [uuid]);
    const [conceptoTraslados] = await pool.query('SELECT * FROM concepto_traslados WHERE uuid = ?', [uuid]);
    const [conceptoRetenciones] = await pool.query('SELECT * FROM concepto_retenciones WHERE uuid = ?', [uuid]);
    const [impuestoTraslados] = await pool.query('SELECT * FROM impuesto_traslados WHERE uuid = ?', [uuid]);
    const [impuestoRetenciones] = await pool.query('SELECT * FROM impuesto_retenciones WHERE uuid = ?', [uuid]);
    const [pagos] = await pool.query('SELECT * FROM pagos WHERE uuid = ? ORDER BY pago_index', [uuid]);
    const [pagoDoctos] = await pool.query('SELECT * FROM pago_doctos WHERE uuid = ?', [uuid]);
    const [pagoTraslados] = await pool.query('SELECT * FROM pago_traslados WHERE uuid = ?', [uuid]);
    const [cfdiRelacionados] = await pool.query('SELECT * FROM cfdi_relacionados WHERE uuid = ?', [uuid]);

    res.json({
      ...comprobante[0],
      conceptos,
      concepto_traslados: conceptoTraslados,
      concepto_retenciones: conceptoRetenciones,
      impuesto_traslados: impuestoTraslados,
      impuesto_retenciones: impuestoRetenciones,
      pagos,
      pago_doctos: pagoDoctos,
      pago_traslados: pagoTraslados,
      cfdi_relacionados: cfdiRelacionados
    });
  } catch (err) {
    console.error('Error obteniendo comprobante:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/comprobantes/:uuid — cascade delete
router.delete('/:uuid', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM comprobantes WHERE uuid = ?', [req.params.uuid]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }
    res.json({ message: 'Comprobante eliminado' });
  } catch (err) {
    console.error('Error eliminando comprobante:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
