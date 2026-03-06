const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/contribuyentes
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM contribuyentes WHERE usuario_id = ? ORDER BY nombre',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listando contribuyentes:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/contribuyentes
router.post('/', async (req, res) => {
  try {
    const { rfc, nombre, regimen_fiscal } = req.body;
    if (!rfc || !nombre) {
      return res.status(400).json({ error: 'RFC y nombre son requeridos' });
    }

    const [result] = await pool.query(
      'INSERT INTO contribuyentes (rfc, nombre, regimen_fiscal, usuario_id) VALUES (?, ?, ?, ?)',
      [rfc.toUpperCase(), nombre, regimen_fiscal || null, req.user.id]
    );

    res.status(201).json({ id: result.insertId, rfc: rfc.toUpperCase(), nombre, regimen_fiscal });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Este RFC ya está registrado para tu usuario' });
    }
    console.error('Error creando contribuyente:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PUT /api/contribuyentes/:id
router.put('/:id', async (req, res) => {
  try {
    const { rfc, nombre, regimen_fiscal } = req.body;
    const [existing] = await pool.query(
      'SELECT * FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [req.params.id, req.user.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Contribuyente no encontrado' });
    }

    await pool.query(
      'UPDATE contribuyentes SET rfc = ?, nombre = ?, regimen_fiscal = ? WHERE id = ? AND usuario_id = ?',
      [rfc || existing[0].rfc, nombre || existing[0].nombre, regimen_fiscal || existing[0].regimen_fiscal, req.params.id, req.user.id]
    );

    res.json({ message: 'Contribuyente actualizado' });
  } catch (err) {
    console.error('Error actualizando contribuyente:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/contribuyentes/:id
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contribuyente no encontrado' });
    }
    res.json({ message: 'Contribuyente eliminado' });
  } catch (err) {
    console.error('Error eliminando contribuyente:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
