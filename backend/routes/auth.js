const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password son requeridos' });
    }

    const [existing] = await pool.query('SELECT id FROM usuarios WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'El usuario ya existe' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const assignedRole = 'user'; // El rol siempre es 'user' en auto-registro

    // FIX: Solo insertar columnas que existen en la tabla usuarios
    const [result] = await pool.query(
      'INSERT INTO usuarios (username, password_hash, role) VALUES (?, ?, ?)',
      [username, password_hash, assignedRole]
    );

    const newId = result.insertId;

    const token = jwt.sign(
      { id: newId, username, role: assignedRole },
      JWT_SECRET, { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Usuario creado',
      token,
      user: { id: newId, username, role: assignedRole }
    });
  } catch (err) {
    console.error('Error en register:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password son requeridos' });
    }

    // FIX: Solo seleccionar columnas que existen en la tabla usuarios
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, role FROM usuarios WHERE username = ?',
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET, { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id:       user.id,
        username: user.username,
        role:     user.role
      }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/auth/session
router.get('/session', authMiddleware, async (req, res) => {
  try {
    // FIX: Solo seleccionar columnas que existen en la tabla usuarios
    const [rows] = await pool.query(
      'SELECT id, username, role FROM usuarios WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
    res.json({ valid: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
