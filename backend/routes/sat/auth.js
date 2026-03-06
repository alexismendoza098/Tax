const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { runSatScript, getPaths } = require('../../utils/satHelpers');
const { scheduleCleanup, cleanupNow } = require('../../utils/fiel-cleanup');

// ── Raíz de uploads — configurable para Railway/cloud con Variable UPLOAD_DIR ─
const UPLOADS_ROOT = process.env.UPLOAD_DIR
  || path.join(__dirname, '..', '..', 'uploads');

// Configure upload to temp directory
// fileFilter: solo permite .cer y .key — rechaza cualquier otro tipo de archivo
const fielFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.cer', '.key'].includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de archivo no permitido: ${ext}. Solo se aceptan archivos .cer y .key de la e.Firma`));
  }
};

const upload = multer({
  dest: path.join(UPLOADS_ROOT, 'temp'),
  limits: { fileSize: 5 * 1024 * 1024 }, // Máximo 5MB por archivo de certificado
  fileFilter: fielFilter,
});

// ── POST /api/sat/config — Subir FIEL y autenticar con SAT ───────────────────
router.post('/config', upload.fields([{ name: 'cer', maxCount: 1 }, { name: 'key', maxCount: 1 }]), async (req, res) => {
    try {
        const { rfc, password } = req.body;

        if (!req.files || !req.files.cer || !req.files.key || !rfc || !password) {
            return res.status(400).json({ error: "Faltan archivos o credenciales (RFC/Contraseña)" });
        }

        // Prepare destination
        const rfcDir = path.join(UPLOADS_ROOT, 'certs', rfc);
        if (!fs.existsSync(rfcDir)) {
            fs.mkdirSync(rfcDir, { recursive: true });
        }

        const cerPath = path.join(rfcDir, 'cer.cer');
        const keyPath = path.join(rfcDir, 'key.key');

        // Move files from temp to final destination
        fs.renameSync(req.files.cer[0].path, cerPath);
        fs.renameSync(req.files.key[0].path, keyPath);

        // Test Authentication
        const args = [
            '--action', 'authenticate',
            '--rfc', rfc,
            '--cer', cerPath,
            '--key', keyPath,
            '--pwd', password
        ];

        const result = await runSatScript(args);

        // ── Programar eliminación de FIEL en 30 minutos ──────────────────────
        scheduleCleanup(rfc);

        res.json({
            success: true,
            token: result.token,
            fiel_expira_en: '30 minutos (se eliminará automáticamente del servidor)',
            message: "Configuración exitosa y autenticado correctamente con el SAT"
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || "Error interno del servidor" });
    }
});

// ── DELETE /api/sat/cleanup-fiel — Borrar FIEL inmediatamente (logout) ───────
router.delete('/cleanup-fiel', async (req, res) => {
    try {
        const { rfc } = req.query;
        if (!rfc) return res.status(400).json({ error: 'RFC requerido' });
        cleanupNow(rfc);
        res.json({ success: true, message: `Archivos FIEL eliminados para ${rfc}` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ── GET /api/sat/verif — Verificar si existen certificados ───────────────────
router.get('/verif', async (req, res) => {
    try {
        const { rfc } = req.query;

        if (!rfc) {
            return res.status(400).json({ error: "Se requiere parámetro RFC" });
        }

        const paths = getPaths(rfc);

        const certExists = paths ? fs.existsSync(paths.cer) : false;
        const keyExists  = paths ? fs.existsSync(paths.key) : false;

        res.json({
            rfc,
            configured: certExists && keyExists,
            certificate_exists: certExists,
            key_exists: keyExists,
            certificate_path: paths ? paths.cer : null,
            key_path: paths ? paths.key : null
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || "Error al verificar certificados" });
    }
});

module.exports = router;
