const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/users — Lista todos los clientes con estadísticas ─────────────
router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT u.id, u.username, u.rfc, u.nombre, u.email, u.role, u.created_at,
                   COUNT(DISTINCT cp.uuid) AS total_cfdis,
                   ROUND(COALESCE(SUM(cp.total_traslados), 0), 2) AS iva_total,
                   MAX(cp.fecha) AS ultima_factura
            FROM usuarios u
            LEFT JOIN contribuyentes c ON c.usuario_id = u.id
            LEFT JOIN comprobantes cp ON cp.contribuyente_id = c.id
            GROUP BY u.id, u.username, u.rfc, u.nombre, u.email, u.role, u.created_at
            ORDER BY u.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── GET /api/users/:id/stats — Estadísticas individuales de un cliente ─────
router.get('/:id/stats', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const userId = req.params.id;
        const [[stats]] = await pool.query(`
            SELECT
                COUNT(DISTINCT cp.uuid)                              AS total_cfdis,
                ROUND(COALESCE(SUM(cp.total_traslados),0),2)        AS iva_total,
                COUNT(DISTINCT CASE WHEN cp.tipo_de_comprobante='I' AND cp.metodo_pago='PPD'
                    THEN cp.uuid END)                               AS facturas_ppd,
                COUNT(DISTINCT CASE WHEN cp.estado='Vigente'
                    THEN cp.uuid END)                               AS vigentes,
                COUNT(DISTINCT CASE WHEN cp.estado='Cancelado'
                    THEN cp.uuid END)                               AS cancelados,
                MAX(cp.fecha)                                        AS ultima_factura
            FROM usuarios u
            LEFT JOIN contribuyentes c  ON c.usuario_id = u.id
            LEFT JOIN comprobantes cp   ON cp.contribuyente_id = c.id
            WHERE u.id = ?
        `, [userId]);
        res.json(stats);
    } catch (err) {
        console.error('Error fetching user stats:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── POST /api/users — Crear nuevo cliente ───────────────────────────────────
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { username, password, role, rfc, nombre, email } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username y password son requeridos' });
        }

        // RFC es completamente opcional — normalizar a NULL si viene vacío
        const rfcUpper = (rfc && rfc.trim()) ? rfc.trim().toUpperCase() : null;

        // Validar formato RFC solo si se proporcionó
        if (rfcUpper) {
            const rfcRegex = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
            if (!rfcRegex.test(rfcUpper)) {
                return res.status(400).json({ error: 'Formato de RFC inválido (ejemplo: XAXX010101000)' });
            }
        }

        // Verificar username único
        const [existing] = await pool.query('SELECT id FROM usuarios WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'El nombre de usuario ya existe' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const [result] = await pool.query(
            'INSERT INTO usuarios (username, rfc, nombre, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
            [username, rfcUpper, nombre || null, email || null, password_hash, role || 'user']
        );

        const newUserId = result.insertId;

        // Auto-crear contribuyente si se proporcionó RFC
        if (rfcUpper) {
            await pool.query(
                'INSERT INTO contribuyentes (rfc, nombre, usuario_id) VALUES (?, ?, ?)',
                [rfcUpper, nombre || rfcUpper, newUserId]
            );
        }

        res.status(201).json({
            message: 'Usuario creado exitosamente',
            user: { id: newUserId, username, rfc: rfcUpper, nombre, email, role: role || 'user' }
        });
    } catch (err) {
        console.error('Error creating user:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── PUT /api/users/:id — Actualizar cliente ─────────────────────────────────
router.put('/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const userId = req.params.id;
        const { password, role, rfc, nombre, email } = req.body;

        const [existing] = await pool.query('SELECT id, rfc FROM usuarios WHERE id = ?', [userId]);
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const updates = [];
        const values = [];

        if (role !== undefined) { updates.push('role = ?');   values.push(role); }
        if (nombre !== undefined) { updates.push('nombre = ?'); values.push(nombre || null); }
        if (email !== undefined) { updates.push('email = ?');  values.push(email || null); }

        if (rfc !== undefined) {
            const rfcUpper = rfc ? rfc.trim().toUpperCase() : null;
            if (rfcUpper) {
                const rfcRegex = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
                if (!rfcRegex.test(rfcUpper)) {
                    return res.status(400).json({ error: 'Formato de RFC inválido' });
                }
            }
            updates.push('rfc = ?');
            values.push(rfcUpper || null);

            // Actualizar o crear contribuyente si RFC cambia
            if (rfcUpper) {
                const [existCont] = await pool.query(
                    'SELECT id FROM contribuyentes WHERE usuario_id = ? AND rfc = ?',
                    [userId, rfcUpper]
                );
                if (existCont.length === 0) {
                    await pool.query(
                        'INSERT INTO contribuyentes (rfc, nombre, usuario_id) VALUES (?, ?, ?)',
                        [rfcUpper, nombre || rfcUpper, userId]
                    );
                } else if (nombre) {
                    await pool.query(
                        'UPDATE contribuyentes SET nombre = ? WHERE usuario_id = ? AND rfc = ?',
                        [nombre, userId, rfcUpper]
                    );
                }
            }
        }

        if (password) {
            const hash = await bcrypt.hash(password, 10);
            updates.push('password_hash = ?');
            values.push(hash);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'Nada que actualizar' });
        }

        values.push(userId);
        await pool.query(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`, values);

        res.json({ message: 'Cliente actualizado exitosamente' });
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── PUT /api/users/:id/password — Cambiar contraseña (acceso rápido) ────────
router.put('/:id/password', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const userId = req.params.id;
        const { password } = req.body;

        if (!password || password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const [existing] = await pool.query('SELECT id FROM usuarios WHERE id = ?', [userId]);
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const hash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, userId]);

        res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (err) {
        console.error('Error updating password:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─── DELETE /api/users/:id — Eliminar cliente ────────────────────────────────
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const userId = req.params.id;

        if (parseInt(userId) === req.user.id) {
            return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
        }

        const [result] = await pool.query('DELETE FROM usuarios WHERE id = ?', [userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ message: 'Cliente eliminado exitosamente' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;
