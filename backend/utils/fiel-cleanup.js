/**
 * fiel-cleanup.js
 * Gestiona la limpieza automática de archivos FIEL (e.Firma) del servidor.
 * Los archivos .cer y .key son sensibles y se eliminan automáticamente
 * 30 minutos después de la última autenticación.
 */

const fs   = require('fs');
const path = require('path');

const UPLOADS_ROOT = process.env.UPLOAD_DIR
  || path.join(__dirname, '..', 'uploads');

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

// Map de timers activos: rfc → NodeJS.Timeout
const timers = new Map();

/**
 * Registra (o renueva) el timer de borrado para un RFC.
 * Cada llamada reinicia el contador de 30 minutos.
 * @param {string} rfc
 */
function scheduleCleanup(rfc) {
  // Cancelar timer previo si existe
  if (timers.has(rfc)) {
    clearTimeout(timers.get(rfc));
  }

  const timer = setTimeout(() => {
    deleteFielFiles(rfc);
    timers.delete(rfc);
  }, TIMEOUT_MS);

  timers.set(rfc, timer);
  console.log(`[FIEL] ⏰ Limpieza programada para ${rfc} en 30 minutos`);
}

/**
 * Elimina inmediatamente los archivos FIEL de un RFC.
 * @param {string} rfc
 */
function deleteFielFiles(rfc) {
  const rfcDir = path.join(UPLOADS_ROOT, 'certs', rfc);
  if (!fs.existsSync(rfcDir)) {
    console.log(`[FIEL] ℹ️  No hay archivos FIEL para ${rfc}`);
    return;
  }
  try {
    fs.rmSync(rfcDir, { recursive: true, force: true });
    console.log(`[FIEL] 🗑  Archivos FIEL eliminados para ${rfc}`);
  } catch (e) {
    console.error(`[FIEL] ❌ Error eliminando FIEL para ${rfc}:`, e.message);
  }
}

/**
 * Cancela el timer programado y borra inmediatamente (para logout).
 * @param {string} rfc
 */
function cleanupNow(rfc) {
  if (timers.has(rfc)) {
    clearTimeout(timers.get(rfc));
    timers.delete(rfc);
  }
  deleteFielFiles(rfc);
}

/**
 * Limpia archivos FIEL huérfanos al arrancar el servidor
 * (archivos que quedaron de sesiones anteriores).
 */
function cleanupOnStartup() {
  const certsDir = path.join(UPLOADS_ROOT, 'certs');
  if (!fs.existsSync(certsDir)) return;

  const rfcs = fs.readdirSync(certsDir);
  if (rfcs.length === 0) return;

  console.log(`[FIEL] 🧹 Limpiando ${rfcs.length} carpeta(s) FIEL huérfana(s) del arranque anterior...`);
  rfcs.forEach(rfc => deleteFielFiles(rfc));
}

module.exports = { scheduleCleanup, cleanupNow, cleanupOnStartup };
