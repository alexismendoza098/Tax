const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const pool = require('../../db');
const { runSatScript, getPaths, cleanTempPaths, getDateChunks, getWeeklyChunks } = require('../../utils/satHelpers');
const { randomUUID } = require('crypto');
const { authMiddleware } = require('../../middleware/auth');

// In-memory job store for async processing (survives as long as Node is running)
const jobs = new Map(); // jobId → { status, progress, total, message, error, data }

// GET /api/sat/job/:id — poll job status
router.get('/job/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    res.json(job);
});

// =====================================================
// POST /api/sat/request
// Responde INMEDIATAMENTE con un jobId.
// El procesamiento real ocurre en background.
// El frontend hace polling a GET /api/sat/job/:id
// Esto evita el timeout del proxy Apache (502).
// =====================================================
router.post('/request', authMiddleware, async (req, res) => {
    const { rfc, password, start, end, type, cfdi_type, status } = req.body;
    console.log(`[SAT] Nueva solicitud — RFC: ${rfc}, ${start} → ${end}, tipo: ${type}`);

    // --- Aislamiento: auto-registrar RFC si el usuario lo está usando por primera vez ---
    // Ya no bloqueamos con 403 — si el RFC no está en contribuyentes, se agrega automáticamente.
    // Esto permite que cualquier usuario opere con su RFC sin pasos de configuración previos.
    const rfcUpper = (rfc || '').toUpperCase();
    const [contribRows] = await pool.query(
        'SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?',
        [rfcUpper, req.user.id]
    );
    if (!contribRows.length) {
        try {
            await pool.query(
                'INSERT IGNORE INTO contribuyentes (rfc, nombre, usuario_id) VALUES (?, ?, ?)',
                [rfcUpper, rfcUpper, req.user.id]
            );
            console.log(`[SAT] RFC ${rfcUpper} auto-registrado para usuario ${req.user.id}`);
        } catch (autoErr) {
            console.warn(`[SAT] No se pudo auto-registrar RFC ${rfcUpper}:`, autoErr.message);
        }
    }

    const paths = getPaths(rfc);
    if (!paths) {
        return res.status(400).json({
            error: `Certificados no encontrados para RFC: ${rfc}. Configúralos en el Paso 1.`
        });
    }

    const startDate = new Date(start + 'T12:00:00');
    let   endDate   = new Date(end   + 'T12:00:00');
    if (isNaN(startDate) || isNaN(endDate)) {
        return res.status(400).json({ error: 'Fechas inválidas.' });
    }

    // SAT rechaza fechas futuras — capear la fecha final a hoy en México (UTC-6)
    const mexicoToday = new Date(Date.now() - 6 * 60 * 60 * 1000);
    mexicoToday.setUTCHours(12, 0, 0, 0);
    if (endDate > mexicoToday) {
        console.log(`[SAT] Fecha final ${end} está en el futuro — capeando a ${mexicoToday.toISOString().slice(0,10)}`);
        endDate = mexicoToday;
    }

    const effectiveEnd = endDate.toISOString().slice(0, 10);

    if (startDate > endDate) {
        return res.status(400).json({
            error: `La fecha inicial (${start}) no puede ser mayor que la final (${effectiveEnd}).`
        });
    }

    const dateChunks = getDateChunks(start, effectiveEnd);
    if (dateChunks.length === 0) {
        return res.status(400).json({ error: 'No se generaron períodos válidos para las fechas dadas.' });
    }

    // --- Crear job y responder inmediatamente ---
    const jobId = randomUUID();
    const groupId = randomUUID();

    jobs.set(jobId, {
        status: 'processing',
        progress: 0,
        total: dateChunks.length,
        message: `Iniciando — ${dateChunks.length} período(s) a procesar...`,
        groupId,
        data: [],
        error: null,
        startedAt: new Date().toISOString()
    });

    // Responder al cliente YA (evita 502 del proxy)
    const cappedMsg = effectiveEnd !== end
        ? ` (fecha final ajustada a ${effectiveEnd} — SAT no acepta fechas futuras)`
        : '';
    res.json({
        status: 'accepted',
        jobId,
        groupId,
        effectiveEnd,
        message: `Solicitud aceptada. Procesando ${dateChunks.length} período(s) en background.${cappedMsg}`,
        totalChunks: dateChunks.length
    });

    // --- Procesamiento en background (no bloquea la respuesta HTTP) ---
    processRequestInBackground({
        jobId, groupId, rfc, password, paths,
        start, end: effectiveEnd, type, cfdi_type, status,
        dateChunks,
        usuarioId: req.user.id  // ← propagado para guardar en solicitudes_sat
    });
});

// Pausa controlada entre peticiones al SAT para evitar rate limiting
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helper: detectar código SAT en un error
const getSatCode = (err) =>
    err?.cod_estatus || err?.data?.[0]?.cod_estatus || err?.data?.[0]?.code || '';

// Helper: extraer mensaje legible del error
const getErrMsg = (err) =>
    err?.message || err?.data?.[0]?.message || err?.data?.[0]?.error
    || (err?.data ? `SAT: ${JSON.stringify(err.data).substring(0, 150)}` : '')
    || 'Error desconocido';

// Guarda en DB el resultado de un chunk
async function saveChunkToDB({ data, chunk, rfc, type, cfdi_type, groupId, usuarioId, jobId }) {
    const dataArr = Array.isArray(data) ? data : (data ? [data] : []);
    for (const row of dataArr) {
        if (!row || !row.id_solicitud || typeof row.id_solicitud !== 'string') continue;
        try {
            await pool.query(`
                INSERT INTO solicitudes_sat
                (id_solicitud, rfc, fecha_inicio, fecha_fin, tipo_solicitud, tipo_comprobante,
                 estado_solicitud, codigo_estado_solicitud, mensaje, group_id, usuario_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                  estado_solicitud = VALUES(estado_solicitud),
                  codigo_estado_solicitud = VALUES(codigo_estado_solicitud),
                  mensaje = VALUES(mensaje),
                  group_id = VALUES(group_id),
                  usuario_id = COALESCE(solicitudes_sat.usuario_id, VALUES(usuario_id))
            `, [
                row.id_solicitud, rfc,
                row.fecha_inicio || chunk.start,
                row.fecha_fin    || chunk.end,
                type, cfdi_type || 'Issued',
                row.estado_solicitud || 0,
                row.codigo_estado_solicitud || '',
                row.mensaje || '',
                groupId,
                usuarioId || null
            ]);
        } catch (dbErr) {
            console.error(`[SAT Job ${jobId}] DB error:`, dbErr.message);
        }
    }
    return dataArr;
}

// Envía una sola petición al SAT para un chunk de fechas
async function requestChunk({ rfc, paths, password, type, cfdi_type, status, chunk }) {
    const cfdiTypeNorm = (cfdi_type || 'Issued').charAt(0).toUpperCase()
                       + (cfdi_type || 'Issued').slice(1).toLowerCase();
    const args = [
        '--action', 'request',
        '--rfc', rfc,
        '--cer', paths.cer,
        '--key', paths.key,
        '--pwd', password,
        '--start', chunk.start,
        '--end',   chunk.end,
        '--type',  type || 'Metadata',
        '--cfdi_type', cfdiTypeNorm,
        '--status', status || 'Todos'
    ];
    return runSatScript(args, 120000); // 2 min por chunk
}

// Background processing function — soporta rangos de 10+ años
async function processRequestInBackground({ jobId, groupId, rfc, password, paths, start, end, type, cfdi_type, status, dateChunks, usuarioId }) {
    const job = jobs.get(jobId);
    const allData      = [];
    const chunkErrors  = [];
    const skippedCodes = []; // 5002/5005/5004 — no son errores reales
    let processedCount = 0;
    let subChunkCount  = 0; // chunks extra generados por auto-subdivisión 5003

    for (let i = 0; i < dateChunks.length; i++) {
        const chunk = dateChunks[i];
        const totalVisible = dateChunks.length + subChunkCount;
        job.progress = i;
        job.message  = `Período ${i + 1}/${totalVisible}: ${chunk.start} → ${chunk.end} (${type} ${cfdi_type})`;
        console.log(`[SAT Job ${jobId}] ${job.message}`);

        // ── Delay controlado entre peticiones para no saturar al SAT ──────────
        // Primer chunk: sin delay. Resto: 1.5 segundos
        if (i > 0) await sleep(1500);

        try {
            const result = await requestChunk({ rfc, paths, password, type, cfdi_type, status, chunk });
            const saved  = await saveChunkToDB({ data: result.data, chunk, rfc, type, cfdi_type, groupId, usuarioId, jobId });
            allData.push(...saved);
            processedCount++;

        } catch (chunkErr) {
            const code = getSatCode(chunkErr);
            const msg  = getErrMsg(chunkErr);

            // ── Códigos que NO son errores reales — saltar silenciosamente ────
            if (code === '404' || code === '5004') {
                // Sin CFDIs en este período — resultado vacío, no es fallo
                processedCount++;
                console.log(`[SAT Job ${jobId}] Período vacío (${code}): ${chunk.start}→${chunk.end}`);

            } else if (code === '5002') {
                // Límite de por vida para esta combinación exacta de fechas — saltar
                processedCount++;
                skippedCodes.push(`${chunk.start}: límite de por vida (5002)`);
                console.log(`[SAT Job ${jobId}] 5002 límite de por vida: ${chunk.start}→${chunk.end} — saltando`);

            } else if (code === '5005') {
                // Solicitud duplicada aún vigente — ya existe en SAT, no necesita reenviar
                processedCount++;
                skippedCodes.push(`${chunk.start}: solicitud duplicada (5005)`);
                console.log(`[SAT Job ${jobId}] 5005 duplicado: ${chunk.start}→${chunk.end} — saltando`);

            } else if (code === '5003') {
                // ── AUTO-SUBDIVISIÓN: >200k CFDIs en el mes → dividir en semanas ─
                console.log(`[SAT Job ${jobId}] 5003 tope máximo en ${chunk.start}→${chunk.end} — subdividiendo en semanas`);
                job.message = `Subdiviendo ${chunk.start} en semanas (>200k CFDIs)...`;

                const weekChunks = getWeeklyChunks(chunk.start.substring(0, 4));
                // Filtrar solo las semanas que caen dentro del chunk original
                const filtered   = weekChunks.filter(w => w.start >= chunk.start && w.end <= chunk.end);
                subChunkCount   += filtered.length - 1; // -1 porque este chunk ya estaba contado

                for (let wi = 0; wi < filtered.length; wi++) {
                    const wChunk = filtered[wi];
                    if (wi > 0) await sleep(1500); // delay entre semanas también
                    job.message = `Semana ${wi + 1}/${filtered.length}: ${wChunk.start}→${wChunk.end}`;
                    console.log(`[SAT Job ${jobId}] Semana: ${wChunk.start}→${wChunk.end}`);
                    try {
                        const wResult = await requestChunk({ rfc, paths, password, type, cfdi_type, status, chunk: wChunk });
                        const saved   = await saveChunkToDB({ data: wResult.data, chunk: wChunk, rfc, type, cfdi_type, groupId, usuarioId, jobId });
                        allData.push(...saved);
                        processedCount++;
                    } catch (wErr) {
                        const wCode = getSatCode(wErr);
                        if (wCode === '5002' || wCode === '5005' || wCode === '5004' || wCode === '404') {
                            processedCount++; // saltar silenciosamente
                        } else {
                            chunkErrors.push(`[semana ${wChunk.start}→${wChunk.end}]: ${getErrMsg(wErr)}`);
                        }
                    }
                }

            } else if (code === '5011') {
                // ── Límite DIARIO alcanzado — no tiene sentido seguir hoy ──────
                console.error(`[SAT Job ${jobId}] 5011 límite diario alcanzado — deteniendo job`);
                job.status = 'error';
                job.error  = `Límite diario del SAT alcanzado (5011). Espera 24 horas antes de continuar. Se procesaron ${processedCount}/${dateChunks.length} períodos.`;
                job.finishedAt = new Date().toISOString();
                cleanTempPaths(paths);
                setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);
                return; // abortar el job completo

            } else {
                // Error genuino — registrar y continuar con el siguiente período
                console.error(`[SAT Job ${jobId}] Error en ${chunk.start}→${chunk.end} (${code}):`, msg);
                chunkErrors.push(`[${chunk.start}→${chunk.end}] (${code}): ${msg}`);
            }
        }
    }

    // ── Marcar job como completado ──────────────────────────────────────────
    if (processedCount === 0 && chunkErrors.length > 0) {
        job.status = 'error';
        job.error  = `Fallaron todos los períodos. ${chunkErrors.slice(0, 5).join(' | ')}`;
        job.message = 'Error en la solicitud';
    } else {
        job.status    = 'done';
        job.progress  = dateChunks.length;
        job.data      = allData;
        job.savedCount = allData.length;
        const skipNote = skippedCodes.length > 0 ? ` (${skippedCodes.length} periodos saltados por límite/duplicado)` : '';
        job.message = `Completado — ${processedCount}/${dateChunks.length + subChunkCount} períodos, ${allData.length} solicitudes registradas.${skipNote}`;
        if (chunkErrors.length > 0) job.warnings = chunkErrors;
        if (skippedCodes.length > 0) job.skipped = skippedCodes;
    }

    job.finishedAt = new Date().toISOString();
    console.log(`[SAT Job ${jobId}] ${job.message}`);

    cleanTempPaths(paths);
    setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);
}

// 3. Verify
router.post('/verify', async (req, res) => {
    const { rfc, password, id } = req.body;
    const paths = getPaths(rfc);
    if (!paths) return res.status(400).json({ error: "Certificados no encontrados" });

    try {
        const args = [
            '--action', 'verify',
            '--rfc', rfc,
            '--cer', paths.cer,
            '--key', paths.key,
            '--pwd', password,
            '--id', id
        ];

        const result = await runSatScript(args);

        // Update DB
        const data = result.data || {};
        if (data.estado_solicitud !== undefined || data.codigo_estado_solicitud) {
             await pool.query(`
                INSERT INTO solicitudes_sat
                (id_solicitud, rfc, estado_solicitud, codigo_estado_solicitud, mensaje, paquetes)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                estado_solicitud = VALUES(estado_solicitud),
                codigo_estado_solicitud = VALUES(codigo_estado_solicitud),
                mensaje = VALUES(mensaje),
                paquetes = VALUES(paquetes)
            `, [
                id,
                rfc,
                data.estado_solicitud,
                data.codigo_estado_solicitud,
                data.mensaje,
                JSON.stringify(data.paquetes || [])
            ]);
        }

        res.json(result);

    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        cleanTempPaths(paths);
    }
});

router.delete('/history/:rfc', authMiddleware, async (req, res) => {
    try {
        const { rfc } = req.params;
        // Validar que el RFC pertenezca al usuario antes de borrar
        const [owns] = await pool.query(
            'SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?',
            [rfc.toUpperCase(), req.user.id]
        );
        if (!owns.length) {
            return res.status(403).json({ error: 'RFC no pertenece a tu cuenta' });
        }
        await pool.query(
            'DELETE FROM solicitudes_sat WHERE rfc = ? AND (usuario_id = ? OR usuario_id IS NULL)',
            [rfc, req.user.id]
        );
        res.json({ message: 'Historial eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /history — solicitudes del usuario autenticado (aislamiento estricto)
router.get('/history', authMiddleware, async (req, res) => {
    try {
        // AISLAMIENTO ESTRICTO: solo solicitudes de este usuario.
        // Se eliminó el fallback "OR usuario_id IS NULL" porque causaba que
        // usuarios distintos vieran solicitudes ajenas cuando compartían RFC.
        const [rows] = await pool.query(`
            SELECT s.* FROM solicitudes_sat s
            WHERE s.usuario_id = ?
            ORDER BY s.fecha_solicitud DESC
            LIMIT 1000
        `, [req.user.id]);
        const history = rows.map(row => {
            let packets = [];
            try {
                if (typeof row.paquetes === 'string') packets = JSON.parse(row.paquetes);
                else if (Array.isArray(row.paquetes)) packets = row.paquetes;
                else if (typeof row.paquetes === 'object' && row.paquetes !== null) packets = Object.values(row.paquetes);
            } catch (e) { packets = []; }
            return { ...row, paquetes: packets };
        });
        res.json(history);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo historial' });
    }
});

// GET /history/:rfc — aislamiento estricto: solo el propio usuario puede ver su historial por RFC
router.get('/history/:rfc', authMiddleware, async (req, res) => {
    try {
        const { rfc } = req.params;
        const [rows] = await pool.query(`
            SELECT * FROM solicitudes_sat
            WHERE rfc = ? AND usuario_id = ?
            ORDER BY fecha_solicitud DESC
        `, [rfc, req.user.id]);
        
        // Parse packets back to JSON
        const history = rows.map(row => {
            let packets = [];
            try {
                if (typeof row.paquetes === 'string') {
                    packets = JSON.parse(row.paquetes);
                } else if (Array.isArray(row.paquetes)) {
                    packets = row.paquetes;
                } else if (typeof row.paquetes === 'object' && row.paquetes !== null) {
                    packets = Object.values(row.paquetes);
                    if (!Array.isArray(packets)) packets = [packets];
                }
            } catch (e) {
                console.error("Error parsing packets for row:", row.id_solicitud, e);
                packets = [];
            }
            return {
                ...row,
                paquetes: packets
            };
        });

        res.json(history);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error obteniendo historial" });
    }
});

// Delete Requests
router.post('/delete', authMiddleware, async (req, res) => {
    try {
        const { ids, rfc, deleteFiles } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: "No se proporcionaron IDs para eliminar" });
        }

        // Aislamiento: solo borrar solicitudes que pertenezcan al usuario autenticado
        const placeholders = ids.map(() => '?').join(',');
        const query = `DELETE FROM solicitudes_sat
                       WHERE id_solicitud IN (${placeholders})
                         AND (usuario_id = ? OR (usuario_id IS NULL AND rfc IN (
                               SELECT rfc FROM contribuyentes WHERE usuario_id = ?)))`;

        const [result] = await pool.query(query, [...ids, req.user.id, req.user.id]);
        const affectedRows = result.affectedRows;
        let deletedFilesCount = 0;

        if (deleteFiles) {
            const baseDir = process.env.DOWNLOAD_DIR
                || path.join(__dirname, '..', '..', 'downloads');
            const rfcDir = rfc ? path.join(baseDir, rfc) : null;

            ids.forEach(id => {
                let safeId = id;
                if (safeId.toLowerCase().endsWith('.zip')) safeId = safeId.slice(0, -4);
                
                if (rfcDir) {
                    const rfcPath = path.join(rfcDir, `${safeId}.zip`);
                    if (fs.existsSync(rfcPath)) {
                        try { fs.unlinkSync(rfcPath); deletedFilesCount++; } catch(e) { console.error(e); }
                    }
                }
                
                const basePath = path.join(baseDir, `${safeId}.zip`);
                if (fs.existsSync(basePath)) {
                    try { fs.unlinkSync(basePath); deletedFilesCount++; } catch(e) { console.error(e); }
                }
            });
        }

        res.json({ 
            success: true, 
            affectedRows: affectedRows,
            message: `Eliminados ${affectedRows} registros y ${deletedFilesCount} archivos.` 
        });

    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: error.message || "Error al eliminar registros" });
    }
});

router.delete('/clean-requests/:rfc', authMiddleware, async (req, res) => {
    try {
        const rfc = req.params.rfc.toUpperCase();
        // Verificar que el RFC pertenezca al usuario antes de borrar
        const [owns] = await pool.query(
            'SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?',
            [rfc, req.user.id]
        );
        if (!owns.length) {
            return res.status(403).json({ success: false, error: 'RFC no pertenece a tu cuenta' });
        }
        const [result] = await pool.query(
            `DELETE FROM solicitudes_sat WHERE rfc = ? AND (usuario_id = ? OR usuario_id IS NULL)`,
            [rfc, req.user.id]
        );
        res.json({ success: true, message: `Se eliminaron ${result.affectedRows} solicitudes`, deletedCount: result.affectedRows });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error limpiando solicitudes", details: error.message });
    }
});

router.delete('/clean-all', authMiddleware, async (req, res) => {
    try {
        // Solo borrar solicitudes del usuario autenticado
        const [result] = await pool.query(
            `DELETE FROM solicitudes_sat
             WHERE usuario_id = ?
                OR (usuario_id IS NULL AND rfc IN (
                      SELECT rfc FROM contribuyentes WHERE usuario_id = ?))`,
            [req.user.id, req.user.id]
        );
        res.json({ success: true, message: `Se eliminaron ${result.affectedRows} solicitudes`, deletedCount: result.affectedRows });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error limpiando solicitudes", details: error.message });
    }
});

module.exports = router;
