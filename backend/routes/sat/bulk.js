/**
 * bulk.js — Descarga Masiva Anual / Multi-año
 * POST /api/sat/bulk-year
 *
 * Genera automáticamente 1 solicitud mensual por cada mes del año,
 * espera a que todas estén listas (polling) y entrega un ZIP consolidado.
 *
 * Estrategia basada en la investigación SAT (2025):
 *   - Máx 200k CFDIs / solicitud → dividir por mes
 *   - No repetir el mismo periodo exacto (error 5002)
 *   - Tiempo máx de procesamiento SAT: 72 h
 *   - Usar Node @nodecfdi v1.5 (Mayo 2025)
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const AdmZip   = require('adm-zip');
const pool     = require('../../db');
const { randomUUID } = require('crypto');
const { runSatScript, getPaths, SAT_STATUS_CODES } = require('../../utils/satHelpers');
const { authMiddleware } = require('../../middleware/auth');

// In-memory jobs (same pattern as requests.js)
const bulkJobs = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sat/bulk-job/:id — poll bulk job status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/bulk-job/:id', (req, res) => {
  const job = bulkJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sat/bulk-year — iniciar descarga masiva anual
// Body: { rfc, password, yearFrom, yearTo?, type, cfdi_type, status, autoConsolidate }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/bulk-year', authMiddleware, async (req, res) => {
  const { rfc, password, yearFrom, yearTo, type, cfdi_type, status, autoConsolidate = true } = req.body;

  if (!rfc || !password)   return res.status(400).json({ error: 'RFC y contraseña son requeridos' });
  if (!yearFrom)           return res.status(400).json({ error: 'yearFrom es requerido (ej. 2024)' });

  const paths = getPaths(rfc);
  if (!paths) return res.status(400).json({ error: `Certificados no encontrados para RFC: ${rfc}` });

  const fromYear = parseInt(yearFrom);
  const toYear   = parseInt(yearTo   || yearFrom);
  const currentY = new Date().getFullYear();

  if (fromYear < 2014 || fromYear > currentY) {
    return res.status(400).json({ error: `Año inválido: ${fromYear}. Rango permitido: 2014-${currentY}` });
  }

  // Build month chunks for all requested years
  const months = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      // Skip future months
      const now = new Date();
      if (y === now.getFullYear() && m > now.getMonth() + 1) break;

      const pad    = String(m).padStart(2, '0');
      const start  = `${y}-${pad}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const end    = `${y}-${pad}-${String(lastDay).padStart(2, '0')}`;
      months.push({ year: y, month: m, start, end, label: `${y}/${pad}` });
    }
  }

  if (months.length === 0) return res.status(400).json({ error: 'No hay meses válidos para descargar' });

  // Create bulk job
  const jobId  = randomUUID();
  const groupId = randomUUID();   // agrupa todas las solicitudes mensuales de esta descarga
  const job   = {
    status:        'processing',
    phase:         'requesting',   // requesting → verifying → downloading → consolidating → done
    progress:      0,
    totalMonths:   months.length,
    rfc:           rfc.toUpperCase(),
    yearFrom,
    yearTo,
    type:          type || 'Metadata',
    cfdi_type:     cfdi_type || 'RECEIVED',
    months,
    requests:      [],   // { month, id_solicitud, status, packages, error }
    packages:      [],   // all package IDs collected
    zipPath:       null,
    zipSize:       0,
    downloadUrl:   null,
    message:       `Iniciando ${months.length} solicitudes mensuales...`,
    errors:        [],
    startedAt:     new Date().toISOString(),
    finishedAt:    null,
    autoConsolidate,
    groupId,
  };

  bulkJobs.set(jobId, job);

  // Respond immediately with jobId
  res.json({
    status:      'accepted',
    jobId,
    groupId,
    message:     `Descarga anual iniciada. Procesando ${months.length} meses.`,
    totalMonths: months.length,
  });

  // Start background processing
  processBulkYear(jobId, job, rfc, password, paths).catch(err => {
    console.error(`[BulkYear ${jobId}] Fatal:`, err);
    job.status  = 'error';
    job.message = err.message || 'Error fatal en descarga anual';
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Background processor
// ─────────────────────────────────────────────────────────────────────────────
async function processBulkYear(jobId, job, rfc, password, paths) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── PHASE 1: Request all months ──────────────────────────────────────────
  job.phase   = 'requesting';
  job.message = `Solicitando ${job.totalMonths} meses al SAT...`;

  for (let i = 0; i < job.months.length; i++) {
    const { start, end, label } = job.months[i];
    job.progress = Math.round((i / job.months.length) * 30); // 0-30%
    job.message  = `Solicitando periodo ${label} (${i + 1}/${job.totalMonths})...`;

    const cfdiTypeNorm = (job.cfdi_type || 'Received').charAt(0).toUpperCase()
                       + (job.cfdi_type || 'Received').slice(1).toLowerCase();
    const args = [
      '--action', 'request',
      '--rfc', rfc,
      '--cer', paths.cer,
      '--key', paths.key,
      '--pwd', password,
      '--start', start,
      '--end',   end,
      '--type',  job.type,
      '--cfdi_type', cfdiTypeNorm,
      '--status', job.status || 'Todos',
    ];

    try {
      const result  = await runSatScript(args, 60000);
      const dataArr = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);

      for (const d of dataArr) {
        if (d.id_solicitud) {
          job.requests.push({ month: label, id_solicitud: d.id_solicitud, status: '1', packages: [] });

          // Save to DB
          try {
            await pool.query(`
              INSERT INTO solicitudes_sat (id_solicitud, rfc, fecha_inicio, fecha_fin, tipo_solicitud, tipo_comprobante, estado_solicitud, codigo_estado_solicitud, mensaje, group_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE estado_solicitud = VALUES(estado_solicitud), group_id = VALUES(group_id)
            `, [d.id_solicitud, rfc, start, end, job.type, job.cfdi_type, '1', '5000', 'Solicitud bulk year', job.groupId]);
          } catch (_) { /* non-fatal */ }
        } else if (d.error) {
          job.errors.push(`${label}: ${d.error}`);
          job.requests.push({ month: label, id_solicitud: null, status: 'error', error: d.error });
        }
      }
    } catch (err) {
      job.errors.push(`${label}: ${err.message || err}`);
      job.requests.push({ month: label, id_solicitud: null, status: 'error', error: String(err.message || err) });
    }

    await sleep(1200); // Respect SAT rate limit between requests
  }

  const pendingRequests = job.requests.filter(r => r.id_solicitud);

  if (pendingRequests.length === 0) {
    job.status  = 'error';
    job.message = `No se pudo solicitar ningún mes. Errores: ${job.errors.slice(0, 3).join(' | ')}`;
    job.finishedAt = new Date().toISOString();
    return;
  }

  // ── PHASE 2: Poll until all requests are ready ───────────────────────────
  job.phase    = 'verifying';
  job.message  = `Esperando que el SAT prepare los paquetes (${pendingRequests.length} solicitudes)...`;
  job.progress = 30;

  const MAX_POLL_MINUTES = 240; // 4 hours max (SAT can take up to 72h but we limit here)
  const POLL_INTERVAL_MS = 30000; // Check every 30 seconds
  const maxPolls = (MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS;
  let   pollCount = 0;

  while (pollCount < maxPolls) {
    const notReady = pendingRequests.filter(r => r.status !== '3' && r.status !== 'error');
    if (notReady.length === 0) break;

    job.message  = `Verificando ${notReady.length} solicitudes pendientes... (intento ${pollCount + 1})`;
    job.progress = 30 + Math.min(30, pollCount * 0.5); // 30-60%

    for (const req of notReady) {
      const verifyArgs = [
        '--action', 'verify',
        '--rfc',    rfc,
        '--cer',    paths.cer,
        '--key',    paths.key,
        '--pwd',    password,
        '--id',     req.id_solicitud,
      ];

      try {
        const res = await runSatScript(verifyArgs, 30000);
        const d   = res.data || res;
        req.status    = String(d.estado_solicitud || d.estado || '2');
        req.packages  = Array.isArray(d.paquetes) ? d.paquetes : [];

        // Update DB
        try {
          await pool.query(`
            UPDATE solicitudes_sat
            SET estado_solicitud = ?, paquetes = ?
            WHERE id_solicitud = ?
          `, [req.status, JSON.stringify(req.packages), req.id_solicitud]);
        } catch (_) { /* non-fatal */ }
      } catch (err) {
        console.warn(`[BulkYear] Verify error for ${req.id_solicitud}:`, err.message);
      }

      await sleep(500);
    }

    pollCount++;
    if (notReady.filter(r => r.status !== '3').length > 0) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // Collect all package IDs from ready requests
  for (const req of pendingRequests) {
    if (req.packages && req.packages.length > 0) {
      job.packages.push(...req.packages);
    }
  }

  if (job.packages.length === 0) {
    job.status  = 'partial';
    job.message = 'Las solicitudes no generaron paquetes descargables. Puede que no haya CFDIs en esos periodos.';
    job.finishedAt = new Date().toISOString();
    return;
  }

  // ── PHASE 3: Download all packages ───────────────────────────────────────
  job.phase    = 'downloading';
  job.message  = `Descargando ${job.packages.length} paquetes ZIP del SAT...`;
  job.progress = 60;

  const downloadedFiles = [];

  for (let i = 0; i < job.packages.length; i++) {
    const pkgId = job.packages[i];
    job.progress = 60 + Math.round((i / job.packages.length) * 30); // 60-90%
    job.message  = `Descargando paquete ${i + 1}/${job.packages.length}: ${pkgId.substring(0, 16)}...`;

    const dlArgs = [
      '--action', 'download',
      '--rfc',    rfc,
      '--cer',    paths.cer,
      '--key',    paths.key,
      '--pwd',    password,
      '--id',     pkgId,
    ];

    try {
      const dlResult = await runSatScript(dlArgs, 120000);
      if (dlResult.file && fs.existsSync(dlResult.file)) {
        downloadedFiles.push(dlResult.file);
      }
    } catch (err) {
      job.errors.push(`Paquete ${pkgId.substring(0, 8)}: ${err.message || err}`);
    }

    await sleep(500);
  }

  if (downloadedFiles.length === 0) {
    job.status  = 'error';
    job.message = 'No se pudo descargar ningún paquete. ' + job.errors.slice(0, 2).join(' | ');
    job.finishedAt = new Date().toISOString();
    return;
  }

  // ── PHASE 4: Consolidate into one ZIP ────────────────────────────────────
  if (job.autoConsolidate) {
    job.phase    = 'consolidating';
    job.message  = `Consolidando ${downloadedFiles.length} ZIPs en un archivo final...`;
    job.progress = 90;

    try {
      const consolidatedZip = new AdmZip();
      let   metaContent     = '';
      let   isMetadata      = false;

      for (const filePath of downloadedFiles) {
        try {
          const pkg     = new AdmZip(filePath);
          const entries = pkg.getEntries();

          entries.forEach(entry => {
            if (entry.isDirectory) return;
            if (entry.entryName.endsWith('.txt')) {
              isMetadata = true;
              const text = pkg.readAsText(entry);
              if (!metaContent) {
                metaContent += text;
              } else {
                const lines = text.split('\n');
                if (lines[0]?.includes('~')) {
                  metaContent += lines.slice(1).join('\n');
                } else {
                  metaContent += '\n' + text;
                }
              }
            } else {
              // Deduplicate XML files by UUID filename
              const existing = consolidatedZip.getEntry(entry.entryName);
              if (!existing) consolidatedZip.addFile(entry.entryName, entry.getData());
            }
          });
        } catch (zipErr) {
          console.warn(`[BulkYear] Error leyendo ${filePath}:`, zipErr.message);
        }
      }

      if (isMetadata && metaContent) {
        const label = `Metadata_${rfc.toUpperCase()}_${job.yearFrom}${job.yearTo !== job.yearFrom ? `-${job.yearTo}` : ''}.txt`;
        consolidatedZip.addFile(label, Buffer.from(metaContent, 'utf8'));
      }

      // Write consolidated ZIP
      const outDir     = path.join(__dirname, '..', '..', 'downloads', rfc.toUpperCase());
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      const zipName    = `ANUAL_${rfc.toUpperCase()}_${job.yearFrom}${job.yearTo !== job.yearFrom ? `-${job.yearTo}` : ''}_${Date.now()}.zip`;
      const zipPath    = path.join(outDir, zipName);
      consolidatedZip.writeZip(zipPath);

      job.zipPath    = zipPath;
      job.zipSize    = fs.statSync(zipPath).size;
      job.downloadUrl = `/api/sat/bulk-download/${encodeURIComponent(zipName)}?rfc=${encodeURIComponent(rfc)}`;
    } catch (consolidateErr) {
      console.error('[BulkYear] Consolidation error:', consolidateErr);
      job.errors.push(`Consolidación: ${consolidateErr.message}`);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  job.status     = job.errors.length > 0 ? 'done_with_errors' : 'done';
  job.progress   = 100;
  job.finishedAt = new Date().toISOString();
  job.message    = job.zipPath
    ? `✅ ${downloadedFiles.length} paquetes consolidados en 1 ZIP (${(job.zipSize / 1024 / 1024).toFixed(1)} MB)`
    : `✅ ${downloadedFiles.length} paquetes descargados (sin consolidar)`;

  if (job.errors.length > 0) {
    job.message += ` | ⚠️ ${job.errors.length} advertencias`;
  }

  // Auto-cleanup after 2 hours
  setTimeout(() => bulkJobs.delete(jobId), 2 * 60 * 60 * 1000);
  console.log(`[BulkYear ${jobId}] ${job.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sat/bulk-download/:filename — serve consolidated ZIP
// ─────────────────────────────────────────────────────────────────────────────
router.get('/bulk-download/:filename', (req, res) => {
  const { filename } = req.params;
  const { rfc } = req.query;

  // Security: only allow safe filenames
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..')) {
    return res.status(400).send('Nombre de archivo inválido');
  }

  const rfcSafe = (rfc || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const baseDir = path.join(__dirname, '..', '..', 'downloads');
  const filePath = rfcSafe
    ? path.join(baseDir, rfcSafe, filename)
    : path.join(baseDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Archivo no encontrado');
  }

  res.download(filePath, filename);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sat/status-codes — devuelve el diccionario de códigos SAT
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status-codes', (_, res) => {
  res.json(SAT_STATUS_CODES);
});

module.exports = router;
module.exports.bulkJobs = bulkJobs;
