/**
 * ================================================================
 * RUTAS DE ADMINISTRACIÓN — ETX Tax Recovery
 * ================================================================
 * POST /api/admin/cleanup          — Limpieza completa del sistema
 * GET  /api/admin/cleanup/preview  — Vista previa de lo que se borrará
 * GET  /api/admin/system-info      — Estadísticas generales del sistema
 * ================================================================
 */

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const pool     = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const DOWNLOADS_DIR = process.env.DOWNLOAD_DIR
  || path.join(__dirname, '..', 'downloads');
const UPLOADS_ROOT  = process.env.UPLOAD_DIR
  || path.join(__dirname, '..', 'uploads');

// ── Helper: tamaño recursivo de carpeta ──────────────────────────────────────
function folderSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    for (const f of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, f.name);
      if (f.isDirectory()) total += folderSize(full);
      else total += fs.statSync(full).size;
    }
  } catch (_) { /* dir inaccesible — retorna lo calculado hasta ahora */ }
  return total;
}

function countFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let count = 0;
  try {
    for (const f of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (f.isDirectory()) count += countFiles(path.join(dirPath, f.name));
      else count++;
    }
  } catch (_) { /* dir inaccesible — retorna lo calculado hasta ahora */ }
  return count;
}

function fmtBytes(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(2) + ' MB';
}

// ── GET /api/admin/cleanup/preview ──────────────────────────────────────────
router.get('/cleanup/preview', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // DB counts
    const [[cfdis]]     = await pool.query('SELECT COUNT(*) as n FROM comprobantes');
    const [[contribs]]  = await pool.query('SELECT COUNT(*) as n FROM contribuyentes');
    const [[sols]]      = await pool.query('SELECT COUNT(*) as n FROM solicitudes_sat');
    const [[conceptos]] = await pool.query('SELECT COUNT(*) as n FROM conceptos');
    const [[impTras]]   = await pool.query('SELECT COUNT(*) as n FROM impuesto_traslados');
    const [[pagos]]     = await pool.query('SELECT COUNT(*) as n FROM pagos');

    // File counts
    const dlFiles   = countFiles(DOWNLOADS_DIR);
    const dlSize    = folderSize(DOWNLOADS_DIR);
    const certFiles = countFiles(path.join(UPLOADS_ROOT, 'certs'));
    const tempFiles = countFiles(path.join(UPLOADS_ROOT, 'temp'));

    res.json({
      db: {
        comprobantes:       cfdis.n,
        contribuyentes:     contribs.n,
        solicitudes_sat:    sols.n,
        conceptos:          conceptos.n,
        impuesto_traslados: impTras.n,
        pagos:              pagos.n,
      },
      files: {
        downloads: { count: dlFiles, size: fmtBytes(dlSize) },
        certs:     { count: certFiles },
        temp:      { count: tempFiles },
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/cleanup — Limpieza completa ──────────────────────────────
router.post('/cleanup', authMiddleware, adminMiddleware, async (req, res) => {
  const {
    limpiar_db        = true,
    limpiar_downloads = true,
    limpiar_certs     = true,
    limpiar_reportes  = true,
    mantener_usuarios = true   // siempre true por seguridad
  } = req.body;

  const log = [];

  try {
    // ── 1. Limpiar base de datos ────────────────────────────────────────────
    if (limpiar_db) {
      const tablas = [
        'pago_traslados','pago_doctos','pagos',
        'impuesto_retenciones','impuesto_traslados',
        'concepto_retenciones','concepto_traslados','conceptos',
        'cfdi_relacionados','comprobantes',
        'reportes_iva','solicitudes_sat',
        'contribuyentes'
      ];
      for (const tabla of tablas) {
        try {
          const [r] = await pool.query(`DELETE FROM ${tabla}`);
          log.push(`🗑  DB ${tabla}: ${r.affectedRows} filas eliminadas`);
        } catch (e) {
          log.push(`⚠️  DB ${tabla}: ${e.message}`);
        }
      }

      // Recrear contribuyentes para usuarios con RFC registrado
      if (mantener_usuarios) {
        const [users] = await pool.query('SELECT id, rfc, nombre FROM usuarios WHERE rfc IS NOT NULL AND rfc != ""');
        for (const u of users) {
          await pool.query(
            'INSERT INTO contribuyentes (rfc, nombre, usuario_id) VALUES (?, ?, ?)',
            [u.rfc, u.nombre || u.rfc, u.id]
          );
          log.push(`✅ Contribuyente recreado: ${u.rfc} → usuario_id=${u.id}`);
        }
      }
    }

    // ── 2. Limpiar carpeta de descargas (ZIPs, XMLs, TXTs) ─────────────────
    if (limpiar_downloads && fs.existsSync(DOWNLOADS_DIR)) {
      let countDel = 0;
      for (const entry of fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })) {
        const full = path.join(DOWNLOADS_DIR, entry.name);
        // Conservar reportes si no se pidió limpiar
        if (!limpiar_reportes && entry.name.startsWith('Reporte_')) continue;
        try {
          if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
          else fs.unlinkSync(full);
          countDel++;
        } catch (e) {
          log.push(`⚠️  ${entry.name}: ${e.message}`);
        }
      }
      log.push(`🗑  Downloads: ${countDel} entradas eliminadas`);
    }

    // ── 3. Limpiar certificados FIEL ────────────────────────────────────────
    if (limpiar_certs) {
      const certsDir = path.join(UPLOADS_ROOT, 'certs');
      if (fs.existsSync(certsDir)) {
        fs.rmSync(certsDir, { recursive: true, force: true });
        log.push('🗑  Certificados FIEL eliminados');
      }
      const tempDir = path.join(UPLOADS_ROOT, 'temp');
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        log.push('🗑  Archivos temporales eliminados');
      }
    }

    res.json({ success: true, log });

  } catch (e) {
    res.status(500).json({ error: e.message, log });
  }
});

// ── GET /api/admin/system-info ───────────────────────────────────────────────
router.get('/system-info', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [[users]]  = await pool.query('SELECT COUNT(*) as n FROM usuarios');
    const [[cfdis]]  = await pool.query('SELECT COUNT(*) as n FROM comprobantes');
    const [[vigentes]]= await pool.query("SELECT COUNT(*) as n FROM comprobantes WHERE estado='Vigente'");
    const [[ivaRow]] = await pool.query('SELECT ROUND(SUM(total_traslados),2) as iva FROM comprobantes');
    const [[sols]]   = await pool.query('SELECT COUNT(*) as n FROM solicitudes_sat');
    const dlSize     = fmtBytes(folderSize(DOWNLOADS_DIR));

    res.json({
      usuarios:     users.n,
      total_cfdis:  cfdis.n,
      vigentes:     vigentes.n,
      iva_total:    ivaRow.iva || 0,
      solicitudes:  sols.n,
      storage:      dlSize
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
