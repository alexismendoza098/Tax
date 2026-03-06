/**
 * ================================================================
 * PAPELERA / ARCHIVO HISTÓRICO — ETX Tax Recovery
 * ================================================================
 * Conforme Art. 30 CFF — retención mínima 5 años
 *
 * GET  /api/papelera              — Listar registros en papelera
 * GET  /api/papelera/stats        — Estadísticas de la papelera
 * POST /api/papelera/restaurar/:id — Restaurar un registro
 * DELETE /api/papelera/:id        — Eliminar definitivamente (solo admin + expirado)
 * POST /api/papelera/purgar       — Purgar registros expirados (>5 años)
 *
 * DELETE /api/papelera/solicitud/:id_solicitud — Eliminar solicitud SAT + mover a papelera
 * DELETE /api/papelera/cfdi/:uuid              — Eliminar CFDI + mover a papelera
 * ================================================================
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const fs      = require('fs');
const path    = require('path');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const DOWNLOADS_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads');

// ─── Helper: registrar en papelera ───────────────────────────────────────────
async function moverAPapelera(conn, { tipo, id, datos, contribuyente_id, rfc, eliminado_por, motivo }) {
  await conn.query(
    `INSERT INTO papelera (tipo_registro, registro_id, datos_json, contribuyente_id, rfc, eliminado_por, motivo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tipo, String(id), JSON.stringify(datos), contribuyente_id || null, rfc || null, eliminado_por || null, motivo || null]
  );
}

// ─── GET /api/papelera ────────────────────────────────────────────────────────
router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { tipo, rfc, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '1=1';
    const params = [];
    if (tipo) { where += ' AND tipo_registro = ?'; params.push(tipo); }
    if (rfc)  { where += ' AND rfc = ?'; params.push(rfc); }

    const [rows] = await pool.query(
      `SELECT id, tipo_registro, registro_id, contribuyente_id, rfc,
              eliminado_por, motivo, fecha_eliminacion, fecha_expiracion,
              (fecha_expiracion < CURDATE()) AS expirado
       FROM papelera WHERE ${where}
       ORDER BY fecha_eliminacion DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM papelera WHERE ${where}`, params
    );
    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/papelera/stats ──────────────────────────────────────────────────
router.get('/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(tipo_registro = 'cfdi') AS cfdis,
        SUM(tipo_registro = 'solicitud_sat') AS solicitudes,
        SUM(tipo_registro = 'estado_cuenta') AS estados_cuenta,
        SUM(fecha_expiracion < CURDATE()) AS expirados
      FROM papelera
    `);
    const [porTipo] = await pool.query(
      `SELECT tipo_registro, COUNT(*) as cantidad FROM papelera GROUP BY tipo_registro`
    );
    res.json({ resumen: stats, por_tipo: porTipo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/papelera/:id — detalle con datos completos ─────────────────────
router.get('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM papelera WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    row.datos = JSON.parse(row.datos_json);
    delete row.datos_json;
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/papelera/purgar — eliminar expirados (>5 años) ─────────────────
router.post('/purgar', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [result] = await pool.query(
      `DELETE FROM papelera WHERE fecha_expiracion < CURDATE()`
    );
    res.json({ success: true, eliminados: result.affectedRows,
      mensaje: `${result.affectedRows} registros expirados eliminados definitivamente` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/papelera/solicitud/:id_solicitud ────────────────────────────
// Elimina solicitud SAT: mueve a papelera → borra CFDIs relacionados → borra archivo físico
router.delete('/solicitud/:id_solicitud', authMiddleware, adminMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { id_solicitud } = req.params;
    const { motivo = 'Eliminado por admin' } = req.body;

    // 1. Obtener solicitud
    const [[sol]] = await conn.query(
      'SELECT * FROM solicitudes_sat WHERE id_solicitud = ?', [id_solicitud]
    );
    if (!sol) { await conn.rollback(); return res.status(404).json({ error: 'Solicitud no encontrada' }); }

    // 2. Archivar CFDIs relacionados (por rfc y fechas de la solicitud)
    const [cfdis] = await conn.query(
      `SELECT * FROM comprobantes
       WHERE (rfc_emisor = ? OR rfc_receptor = ?)
       AND fecha BETWEEN ? AND ?`,
      [sol.rfc, sol.rfc, sol.fecha_inicio, sol.fecha_fin]
    );

    for (const cfdi of cfdis) {
      await moverAPapelera(conn, {
        tipo: 'cfdi',
        id: cfdi.uuid,
        datos: cfdi,
        rfc: sol.rfc,
        eliminado_por: req.user.id,
        motivo: `Eliminado junto con solicitud ${id_solicitud} — ${motivo}`
      });
    }

    // 3. Archivar la solicitud misma
    await moverAPapelera(conn, {
      tipo: 'solicitud_sat',
      id: id_solicitud,
      datos: { ...sol, cfdis_asociados: cfdis.length },
      rfc: sol.rfc,
      eliminado_por: req.user.id,
      motivo
    });

    // 4. Borrar CFDIs de DB (cascada borra conceptos, traslados, etc.)
    if (cfdis.length > 0) {
      const uuids = cfdis.map(c => c.uuid);
      await conn.query(
        `DELETE FROM comprobantes WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
        uuids
      );
    }

    // 5. Borrar solicitud
    await conn.query('DELETE FROM solicitudes_sat WHERE id_solicitud = ?', [id_solicitud]);

    // 6. Borrar archivos físicos (paquetes ZIP)
    let archivosEliminados = 0;
    try {
      const paquetes = sol.paquetes ? JSON.parse(sol.paquetes) : [];
      for (const pkgId of paquetes) {
        const zipPath = path.join(DOWNLOADS_DIR, `${pkgId}.zip`);
        if (fs.existsSync(zipPath)) { fs.unlinkSync(zipPath); archivosEliminados++; }
        const dirPath = path.join(DOWNLOADS_DIR, pkgId);
        if (fs.existsSync(dirPath)) { fs.rmSync(dirPath, { recursive: true, force: true }); archivosEliminados++; }
      }
    } catch (fsErr) {
      console.warn('[Papelera] No se pudieron eliminar archivos físicos:', fsErr.message);
    }

    await conn.commit();
    res.json({
      success: true,
      mensaje: `Solicitud archivada en papelera`,
      cfdis_archivados: cfdis.length,
      archivos_eliminados: archivosEliminados
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ─── DELETE /api/papelera/cfdi/:uuid ─────────────────────────────────────────
router.delete('/cfdi/:uuid', authMiddleware, adminMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[cfdi]] = await conn.query('SELECT * FROM comprobantes WHERE uuid = ?', [req.params.uuid]);
    if (!cfdi) { await conn.rollback(); return res.status(404).json({ error: 'CFDI no encontrado' }); }

    await moverAPapelera(conn, {
      tipo: 'cfdi',
      id: cfdi.uuid,
      datos: cfdi,
      contribuyente_id: cfdi.contribuyente_id,
      rfc: cfdi.rfc_emisor,
      eliminado_por: req.user.id,
      motivo: req.body.motivo || 'Eliminado manualmente'
    });

    await conn.query('DELETE FROM comprobantes WHERE uuid = ?', [req.params.uuid]);
    await conn.commit();
    res.json({ success: true, mensaje: 'CFDI movido a papelera' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ─── DELETE /api/papelera/:id — eliminar definitivo (solo si expirado) ───────
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT *, (fecha_expiracion < CURDATE()) AS expirado FROM papelera WHERE id = ?',
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    if (!row.expirado && !req.body.forzar) {
      return res.status(403).json({
        error: `No se puede eliminar: el registro expira el ${row.fecha_expiracion} (Art. 30 CFF)`,
        expira: row.fecha_expiracion
      });
    }
    await pool.query('DELETE FROM papelera WHERE id = ?', [req.params.id]);
    res.json({ success: true, mensaje: 'Eliminado definitivamente del archivo' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
