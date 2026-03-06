const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const pool = require('../../db');
const { runSatScript, getPaths, getDateChunks } = require('../../utils/satHelpers');
const { randomUUID } = require('crypto');

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
router.post('/request', async (req, res) => {
    const { rfc, password, start, end, type, cfdi_type, status } = req.body;
    console.log(`[SAT] Nueva solicitud — RFC: ${rfc}, ${start} → ${end}, tipo: ${type}`);

    // --- Validaciones síncronas (rápidas) ---
    const paths = getPaths(rfc);
    if (!paths) {
        return res.status(400).json({
            error: `Certificados no encontrados para RFC: ${rfc}. Configúralos en el Paso 1.`
        });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (isNaN(startDate) || isNaN(endDate)) {
        return res.status(400).json({ error: 'Fechas inválidas.' });
    }
    if (startDate > endDate) {
        return res.status(400).json({
            error: `La fecha inicial (${start}) no puede ser mayor que la final (${end}).`
        });
    }

    const dateChunks = getDateChunks(start, end);
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
    res.json({
        status: 'accepted',
        jobId,
        groupId,
        message: `Solicitud aceptada. Procesando ${dateChunks.length} período(s) en background.`,
        totalChunks: dateChunks.length
    });

    // --- Procesamiento en background (no bloquea la respuesta HTTP) ---
    processRequestInBackground({
        jobId, groupId, rfc, password, paths,
        start, end, type, cfdi_type, status,
        dateChunks
    });
});

// Background processing function
async function processRequestInBackground({ jobId, groupId, rfc, password, paths, start, end, type, cfdi_type, status, dateChunks }) {
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
                         estado_solicitud, codigo_estado_solicitud, mensaje, group_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                          estado_solicitud = VALUES(estado_solicitud),
                          codigo_estado_solicitud = VALUES(codigo_estado_solicitud),
                          mensaje = VALUES(mensaje),
                          group_id = VALUES(group_id)
                    `, [
                        data.id_solicitud, rfc,
                        data.fecha_inicio || chunk.start,  // ← chunk en scope aquí
                        data.fecha_fin   || chunk.end,
                        type, cfdi_type || 'Issued',
                        data.estado_solicitud || 0,
                        data.codigo_estado_solicitud || '',
                        data.mensaje || '',
                        groupId
                    ]);
                } catch (dbErr) {
                    console.error(`[SAT Job ${jobId}] DB error:`, dbErr.message);
                }
            }

        } catch (chunkErr) {
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

    // Auto-cleanup job after 30 min
    setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);
}

// 3. Verify
router.post('/verify', async (req, res) => {
    try {
        const { rfc, password, id } = req.body;
        const paths = getPaths(rfc);
        if (!paths) return res.status(400).json({ error: "Certificados no encontrados" });

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
    }
});

router.delete('/history/:rfc', async (req, res) => {
    try {
        const { rfc } = req.params;
        await pool.query('DELETE FROM solicitudes_sat WHERE rfc = ?', [rfc]);
        res.json({ message: 'Historial eliminado correctamente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /history — todos los RFCs (admin)
router.get('/history', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT * FROM solicitudes_sat
            ORDER BY fecha_solicitud DESC
            LIMIT 1000
        `);
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
        res.status(500).json({ error: 'Error obteniendo historial global' });
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
router.post('/delete', async (req, res) => {
    try {
        const { ids, rfc, deleteFiles } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: "No se proporcionaron IDs para eliminar" });
        }

        const placeholders = ids.map(() => '?').join(',');
        const query = `DELETE FROM solicitudes_sat WHERE id_solicitud IN (${placeholders})`;
        
        const [result] = await pool.query(query, ids);
        const affectedRows = result.affectedRows;
        let deletedFilesCount = 0;

        if (deleteFiles) {
            const baseDir = path.join(__dirname, '..', '..', 'downloads');
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

router.delete('/clean-requests/:rfc', async (req, res) => {
    try {
        const { rfc } = req.params;
        const [result] = await pool.query(`DELETE FROM solicitudes_sat WHERE rfc = ?`, [rfc]);
        res.json({ success: true, message: `Se eliminaron ${result.affectedRows} solicitudes`, deletedCount: result.affectedRows });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error limpiando solicitudes", details: error.message });
    }
});

router.delete('/clean-all', async (req, res) => {
    try {
        const [result] = await pool.query(`DELETE FROM solicitudes_sat`);
        res.json({ success: true, message: `Se eliminaron ${result.affectedRows} solicitudes del sistema`, deletedCount: result.affectedRows });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error limpiando todas las solicitudes", details: error.message });
    }
});

module.exports = router;
