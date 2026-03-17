/**
 * fielStore.js — Almacén en memoria para archivos FIEL
 *
 * Los buffers del .cer y .key NUNCA se escriben en disco de forma permanente.
 * Se guardan en un Map en la RAM del proceso Node.js y se eliminan
 * automáticamente después de 30 minutos (o al reiniciar el servidor).
 */

const store = new Map(); // rfc → { cerBuf, keyBuf, expiry, timer }

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutos

/**
 * Guarda los buffers de la FIEL en memoria.
 * @param {string} rfc
 * @param {Buffer} cerBuf
 * @param {Buffer} keyBuf
 */
function saveFiel(rfc, cerBuf, keyBuf) {
  // Cancelar timer anterior si existe
  const existing = store.get(rfc);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    store.delete(rfc);
    console.log(`[FIEL] Credenciales de ${rfc} eliminadas de memoria (30 min).`);
  }, EXPIRY_MS);

  store.set(rfc, {
    cerBuf: Buffer.from(cerBuf),
    keyBuf: Buffer.from(keyBuf),
    expiry: Date.now() + EXPIRY_MS,
    timer,
  });
  console.log(`[FIEL] Credenciales de ${rfc} cargadas en memoria (expiran en 30 min).`);
}

/**
 * Obtiene los buffers de la FIEL desde memoria.
 * @param {string} rfc
 * @returns {{ cerBuf: Buffer, keyBuf: Buffer } | null}
 */
function getFiel(rfc) {
  const entry = store.get(rfc);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    store.delete(rfc);
    return null;
  }
  return { cerBuf: entry.cerBuf, keyBuf: entry.keyBuf };
}

/**
 * Elimina la FIEL de memoria inmediatamente.
 * @param {string} rfc
 */
function deleteFiel(rfc) {
  const entry = store.get(rfc);
  if (entry?.timer) clearTimeout(entry.timer);
  store.delete(rfc);
  console.log(`[FIEL] Credenciales de ${rfc} eliminadas de memoria.`);
}

/**
 * Verifica si existe FIEL en memoria para el RFC.
 * @param {string} rfc
 * @returns {boolean}
 */
function hasFiel(rfc) {
  const entry = store.get(rfc);
  if (!entry) return false;
  if (Date.now() > entry.expiry) { store.delete(rfc); return false; }
  return true;
}

module.exports = { saveFiel, getFiel, deleteFiel, hasFiel };
