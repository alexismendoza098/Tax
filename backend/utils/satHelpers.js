/**
 * satHelpers.js
 * Utilidades para integración SAT.
 *
 * Motor preferido: sat_wrapper.mjs (Node.js + @nodecfdi — v1.5 Mayo 2025)
 * Fallback:        sat_wrapper.py  (Python + cfdiclient)
 *
 * La elección se hace automáticamente:
 *   1. Se intenta con Node.js primero (más rápido, sin subprocess Python)
 *   2. Si falla, se reintenta con Python como respaldo
 */

const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');
const { PythonShell } = require('python-shell');

// ── Códigos de estado SAT (para enriquecer respuestas en el frontend) ────────
const SAT_STATUS_CODES = {
  '5000': { label: 'Solicitud recibida',        ok: true,  color: 'green',  icon: '✅' },
  '5001': { label: 'En proceso',                ok: true,  color: 'yellow', icon: '⏳' },
  '5002': { label: 'Límite de por vida',         ok: false, color: 'red',   icon: '🚫', tip: 'Cambia la fecha en ±1 segundo para crear un periodo diferente.' },
  '5003': { label: 'Tope máximo (>200k CFDIs)', ok: false, color: 'orange', icon: '⚠️', tip: 'Divide el rango de fechas en periodos más cortos (máx. 1 mes).' },
  '5004': { label: 'Sin información',           ok: false, color: 'gray',   icon: 'ℹ️', tip: 'No hay CFDIs para ese periodo y tipo.' },
  '5005': { label: 'Solicitud duplicada',       ok: false, color: 'orange', icon: '🔁', tip: 'Ya existe una solicitud vigente con los mismos parámetros.' },
  '5011': { label: 'Límite diario alcanzado',   ok: false, color: 'red',   icon: '⛔', tip: 'Espera 24 horas antes de descargar más.' },
  '300':  { label: 'Usuario no válido',         ok: false, color: 'red',   icon: '❌', tip: 'FIEL vencida o datos incorrectos. Actualiza tu e.Firma.' },
  '301':  { label: 'XML mal formado',           ok: false, color: 'red',   icon: '❌', tip: 'El sistema necesita actualizar la librería SAT a v1.5 (Mayo 2025).' },
  // Estados de verificación (estado_solicitud)
  '1':    { label: 'Aceptada',     ok: true,  color: 'green'  },
  '2':    { label: 'En proceso',   ok: true,  color: 'yellow' },
  '3':    { label: 'Terminada ✅', ok: true,  color: 'green'  },
  '4':    { label: 'Error SAT',    ok: false, color: 'red'    },
  '5':    { label: 'Rechazada',    ok: false, color: 'red'    },
  '6':    { label: 'Vencida',      ok: false, color: 'gray'   },
};

module.exports.SAT_STATUS_CODES = SAT_STATUS_CODES;

// ── Run Node.js SAT Wrapper (preferred — @nodecfdi v1.5) ─────────────────────
const runSatNodeScript = (args, timeout = 300000) => {
  return new Promise((resolve, reject) => {
    const wrapperPath = path.join(__dirname, '..', 'sat_wrapper.mjs');
    if (!fs.existsSync(wrapperPath)) {
      return reject({ message: 'sat_wrapper.mjs no encontrado' });
    }

    const argList = [];
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null && v !== '') {
        argList.push(`--${k}`, String(v));
      }
    }

    const proc = spawn('node', [wrapperPath, ...argList], {
      cwd: path.join(__dirname, '..'),
      timeout,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // Parse last JSON line from stdout
      const jsonLines = stdout.split('\n').filter(l => {
        const t = l.trim();
        return t.startsWith('{') || t.startsWith('[');
      });

      if (jsonLines.length > 0) {
        const last = jsonLines[jsonLines.length - 1];
        try {
          const json = JSON.parse(last);
          if (json.status === 'error' || json.error) return reject(json);
          return resolve(json);
        } catch (_) { /* fall through */ }
      }

      if (stderr && !stderr.includes('ExperimentalWarning')) {
        console.warn('[SAT Node] stderr:', stderr.substring(0, 300));
      }

      reject({
        message: 'Sin salida JSON del wrapper Node.js',
        stdout:  stdout.substring(0, 300),
        stderr:  stderr.substring(0, 300),
        code,
      });
    });

    proc.on('error', err => reject({ message: `Error al lanzar node: ${err.message}` }));
  });
};

// ── Run Python SAT Wrapper (fallback) ────────────────────────────────────────
const runSatPythonScript = (argsArray, timeout = 300000) => {
  return new Promise((resolve, reject) => {
    const options = {
      mode:       'text',
      pythonPath: process.platform === 'win32' ? 'python' : 'python3',
      scriptPath: path.join(__dirname, '..'),
      args:       argsArray,
      timeout,
    };

    PythonShell.run('sat_wrapper.py', options).then(results => {
      console.log('[SAT Python] stdout:', results.join('\n').substring(0, 300));

      const jsonLines = results.filter(l => {
        const t = l.trim();
        return t.startsWith('{') || t.startsWith('[');
      });

      if (jsonLines.length > 0) {
        const last = jsonLines[jsonLines.length - 1];
        try {
          const json = JSON.parse(last);
          if (json.status === 'error' || json.error) return reject(json);
          return resolve(json);
        } catch (e) { /* fall through */ }
      }

      const combined = results.join('\n');
      reject({ message: 'Script Python — sin salida JSON válida', output: combined.substring(0, 300) });
    }).catch(err => {
      const msg = err.message || err.toString();
      if (msg.includes('TIMEDOUT') || msg.includes('timeout')) {
        return reject({ message: 'Tiempo de espera agotado — El SAT no respondió a tiempo.' });
      }
      reject({ message: 'Script Python falló', error: msg.substring(0, 300) });
    });
  });
};

// ── runSatScript: intenta Node primero, luego Python ────────────────────────
/**
 * @param {string[]} argsArray  Array estilo CLI: ['--action','request','--rfc','ABC...',...]
 * @param {number}   timeout    ms antes de abortar (default 5 min)
 */
const runSatScript = async (argsArray, timeout = 300000) => {
  // Convert argsArray to object for Node runner
  const argsObj = {};
  for (let i = 0; i < argsArray.length; i += 2) {
    const k = argsArray[i].replace(/^--/, '');
    argsObj[k] = argsArray[i + 1];
  }

  // Try Node.js wrapper first
  try {
    console.log('[SAT] Usando motor Node.js (@nodecfdi v1.5)');
    const result = await runSatNodeScript(argsObj, timeout);
    return result;
  } catch (nodeErr) {
    console.warn('[SAT] Motor Node.js falló, intentando Python:', nodeErr.message || nodeErr);
    // Fallback to Python
    try {
      const result = await runSatPythonScript(argsArray, timeout);
      return result;
    } catch (pyErr) {
      // Both failed — throw most informative error
      throw pyErr.message ? pyErr : nodeErr;
    }
  }
};

const os = require('os');
const { randomUUID } = require('crypto');
const { getFiel } = require('./fielStore');

// ── getPaths: escribe buffers desde memoria a /tmp solo cuando se necesitan ───
// Los archivos se crean en /tmp (efímero), se usan para la llamada al SAT,
// y el llamador es responsable de borrarlos con cleanTempPaths().
const getPaths = (rfc) => {
  const cleanRfc = rfc.toUpperCase().trim();
  const fiel = getFiel(cleanRfc);
  if (!fiel) return null;

  // Escribir en /tmp con nombre único para evitar colisiones
  const uid    = randomUUID();
  const cerPath = path.join(os.tmpdir(), `fiel_${uid}.cer`);
  const keyPath = path.join(os.tmpdir(), `fiel_${uid}.key`);
  fs.writeFileSync(cerPath, fiel.cerBuf);
  fs.writeFileSync(keyPath, fiel.keyBuf);

  return { cer: cerPath, key: keyPath, _tmp: true };
};

// ── cleanTempPaths: borra archivos temporales de /tmp después de usarlos ──────
const cleanTempPaths = (paths) => {
  if (!paths?._tmp) return;
  try { if (fs.existsSync(paths.cer)) fs.unlinkSync(paths.cer); } catch (_) {}
  try { if (fs.existsSync(paths.key)) fs.unlinkSync(paths.key); } catch (_) {}
};

// ── Split date range into monthly chunks ─────────────────────────────────────
const getDateChunks = (startStr, endStr) => {
  const chunks   = [];
  let current    = new Date(startStr + 'T12:00:00');
  const endDate  = new Date(endStr   + 'T12:00:00');

  if (isNaN(current.getTime()) || isNaN(endDate.getTime())) return [];
  if (current > endDate) return [];

  while (current <= endDate) {
    const chunkStart = current.toISOString().slice(0, 10);
    const lastDay    = new Date(current.getFullYear(), current.getMonth() + 1, 0, 12, 0, 0);
    const chunkEnd   = lastDay > endDate ? endDate : lastDay;

    chunks.push({ start: chunkStart, end: chunkEnd.toISOString().slice(0, 10) });

    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }
  return chunks;
};

// ── Split a full year into weekly chunks (for high-volume contributors) ───────
const getWeeklyChunks = (year) => {
  const chunks = [];
  let current  = new Date(`${year}-01-01T12:00:00`);
  const end    = new Date(`${year}-12-31T12:00:00`);

  while (current <= end) {
    const chunkStart = current.toISOString().slice(0, 10);
    const chunkEndD  = new Date(current);
    chunkEndD.setDate(chunkEndD.getDate() + 6);
    const chunkEnd   = chunkEndD > end ? end : chunkEndD;

    chunks.push({ start: chunkStart, end: chunkEnd.toISOString().slice(0, 10) });

    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }
  return chunks;
};

module.exports = {
  runSatScript,
  runSatNodeScript,
  runSatPythonScript,
  getPaths,
  cleanTempPaths,
  getDateChunks,
  getWeeklyChunks,
  SAT_STATUS_CODES,
};
