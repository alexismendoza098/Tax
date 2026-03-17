const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const pool = require('../../db');
const { runSatScript, getPaths, cleanTempPaths, getDateChunks } = require('../../utils/satHelpers');
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

// Background processing function
async function processRequestInBackground({ jobId, groupId, rfc, password, paths, start, end, type, cfdi_type, status, dateChunks, usuarioId }) {
    const job = jobs.get(jobId);
    const allData = [];
    const chunkErrors = [];
    let processedCount = 0;

    for (let i = 0; i < dateChunks.length; i++) {
        const chunk = dateChunks[i];
        // Update progress
        job.progress = i;
        job.message = `Procesando período ${i + 1}/${dateChunks.length}: ${chunk.start} → ${chunk.end}`;
        console.log(`[SAT Job ${jobId}] ${job.message}`);

        const cfdiTypeNorm = (cfdi_type || 'Issued').charAt(0).toUpperCase() + (cfdi_type || 'Issued').slice(1).toLowerCase();

        const args = [
            '--action', 'request',
            '--rfc', rfc,
            '--cer', paths.cer,
            '--key', paths.key,
            '--pwd', password,
            '--start', chunk.start,
            '--end', chunk.end,
            '--type', type || 'Metadata',
            '--cfdi_type', cfdiTypeNorm,
            '--status', status || 'Todos'
        ];

        try {
            const result = await runSatScript(args, 120000); // 2 min per chunk
            const rawData = result.data;
            const dataArr = Array.isArray(rawData) ? rawData : (rawData ? [rawData] : []);
            allData.push(...dataArr);
            processedCount++;

            // Save each chunk result to DB immediately
            for (const data of dataArr) {
                if (!data || !data.id_solicitud || typeof data.id_solicitud !== 'string') continue;
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
                        data.id_solicitud, rfc,
                        data.fecha_inicio || chunk.start,  // ← chunk en scope aquí
                        data.fecha_fin   || chunk.end,
                        type, cfdi_type || 'Issued',
                        data.estado_solicitud || 0,
                        data.codigo_estado_solicitud || '',
                        data.mensaje || '',
                        groupId,
                        usuarioId || null  // ← aislamiento multi-tenant
                    ]);
                } catch (dbErr) {
                    console.error(`[SAT Job ${jobId}] DB error:`, dbErr.message);
                }
            }

        } catch (chunkErr) {
            const errCode = chunkErr.data?.[0]?.code;
            if (errCode === '404') {
                // SAT código 404 = sin CFDIs en este período (resultado vacío, no es un error real)
                processedCount++;
                console.log(`[SAT Job ${jobId}] Sin CFDIs en ${chunk.start}→${chunk.end} (período vacío)`);
            } else {
                // Error real del SAT o del sistema
                console.error(`[SAT Job ${jobId}] Chunk error ${chunk.start}-${chunk.end}:`, JSON.stringify(chunkErr).substring(0, 500));
                // El sat_wrapper puede devolver { status:'error', data:[{message,error,code}] } sin .message raíz
                let msg = chunkErr.message
                       || chunkErr.data?.[0]?.message
                       || chunkErr.data?.[0]?.error
                       || (chunkErr.data ? `SAT: ${JSON.stringify(chunkErr.data).substring(0, 150)}` : '')
                       || 'Error desconocido';
                if (chunkErr.error && !msg.includes(chunkErr.error)) msg += `: ${chunkErr.error}`;
                chunkErrors.push(`[${chunk.start}→${chunk.end}]: ${msg}`);
            }
        }
    }

    // Mark job complete
    if (processedCount === 0) {
        job.status = 'error';
        job.error = `Fallaron todos los períodos. ${chunkErrors.join(' | ')}`;
        job.message = 'Error en la solicitud';
    } else {
        job.status = 'done';
        job.progress = dateChunks.length;
        job.data = allData;
        job.savedCount = allData.length;
        job.message = `Completado — ${processedCount}/${dateChunks.length} períodos procesados, ${allData.length} solicitudes registradas.`;
        if (chunkErrors.length > 0) {
            job.warnings = chunkErrors;
        }
    }

    job.finishedAt = new Date().toISOString();
    console.log(`[SAT Job ${jobId}] ${job.message}`);

    // Limpiar archivos FIEL temporales de /tmp
    cleanTempPaths(paths);

    // Auto-cleanup job after 30 min
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

// GET /history — solicitudes del usuario autenticado (aislamiento multi-tenant)
router.get('/history', authMiddleware, async (req, res) => {
    try {
        // Filtrar por usuario_id (solicitudes guardadas con el nuevo campo)
        // O por RFC que pertenezca al usuario (migración de datos históricos)
        const [rows] = await pool.query(`
            SELECT s.* FROM solicitudes_sat s
            WHERE s.usuario_id = ?
               OR (s.usuario_id IS NULL AND s.rfc IN (
                     SELECT rfc FROM contribuyentes WHERE usuario_id = ?
                   ))
            ORDER BY s.fecha_solicitud DESC
            LIMIT 1000
        `, [req.user.id, req.user.id]);
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

router.get('/history/:rfc', async (req, res) => {
    try {
        const { rfc } = req.params;
        const [rows] = await pool.query(`
            SELECT * FROM solicitudes_sat 
            WHERE rfc = ? 
            ORDER BY fecha_solicitud DESC
        `, [rfc]);
        
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
