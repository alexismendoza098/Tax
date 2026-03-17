const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { runSatScript } = require('../../utils/satHelpers');
const { saveFiel, deleteFiel, hasFiel } = require('../../utils/fielStore');
const os = require('os');

// Multer: guarda en /tmp del SO (nunca en uploads/ del proyecto)
const fielFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.cer', '.key'].includes(ext)) cb(null, true);
  else cb(new Error(`Solo se aceptan .cer y .key — recibido: ${ext}`));
};

const upload = multer({
  dest: os.tmpdir(),               // /tmp — efímero por definición
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fielFilter,
});

// ── POST /api/sat/config — Autenticar FIEL (sin guardar en disco) ─────────────
router.post('/config', upload.fields([{ name: 'cer', maxCount: 1 }, { name: 'key', maxCount: 1 }]), async (req, res) => {
  const tmpPaths = [];
  try {
    const { rfc, password } = req.body;

    if (!req.files?.cer || !req.files?.key || !rfc || !password) {
      return res.status(400).json({ error: 'Faltan archivos o credenciales (RFC/Contraseña)' });
    }

    const cerTmp = req.files.cer[0].path;
    const keyTmp = req.files.key[0].path;
    tmpPaths.push(cerTmp, keyTmp);

    // Leer buffers en memoria
    const cerBuf = fs.readFileSync(cerTmp);
    const keyBuf = fs.readFileSync(keyTmp);

    // Autenticar con SAT usando los archivos temporales de /tmp
    const args = [
      '--action', 'authenticate',
      '--rfc',    rfc,
      '--cer',    cerTmp,
      '--key',    keyTmp,
      '--pwd',    password,
    ];

    const result = await runSatScript(args);

    // Solo si la autenticación fue exitosa → guardar en memoria
    saveFiel(rfc.toUpperCase(), cerBuf, keyBuf);

    res.json({
      success:        true,
      token:          result.token,
      fiel_expira_en: '30 minutos (en memoria, no se guarda en disco)',
      message:        'Configuración exitosa y autenticado correctamente con el SAT',
    });

  } catch (error) {
    console.error('[SAT Auth]', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  } finally {
    // Borrar archivos temporales de /tmp inmediatamente
    for (const p of tmpPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
  }
});

// ── DELETE /api/sat/cleanup-fiel — Borrar FIEL de memoria (logout) ───────────
router.delete('/cleanup-fiel', async (req, res) => {
  try {
    const { rfc } = req.query;
    if (!rfc) return res.status(400).json({ error: 'RFC requerido' });
    deleteFiel(rfc.toUpperCase());
    res.json({ success: true, message: `Credenciales FIEL eliminadas de memoria para ${rfc}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/sat/verif — Verificar si existe FIEL en memoria ─────────────────
router.get('/verif', async (req, res) => {
  try {
    const { rfc } = req.query;
    if (!rfc) return res.status(400).json({ error: 'Se requiere parámetro RFC' });
    const configured = hasFiel(rfc.toUpperCase());
    res.json({ rfc, configured, certificate_exists: configured, key_exists: configured });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
