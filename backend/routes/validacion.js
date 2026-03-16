// ============================================================
//  Módulo Validación SAT — Metadata vs CFDI
//  Compara UUIDs/montos/RFC entre metadata descargada y XMLs
// ============================================================
const express   = require('express');
const router    = express.Router();
const path      = require('path');
const fs        = require('fs');
const AdmZip    = require('adm-zip');
const xml2js    = require('xml2js');
const pool      = require('../db');
const { authMiddleware } = require('../middleware/auth');

const DOWNLOADS_DIR = process.env.DOWNLOAD_DIR
  || path.join(__dirname, '..', 'downloads');
const CHUNK_SIZE    = 500; // líneas de metadata por chunk

// ── Utilidades ────────────────────────────────────────────────

/** Parsea una línea de metadata SAT (separada por |) */
function parseMetadataLine(line) {
    const parts = line.split('|');
    if (parts.length < 8) return null;
    return {
        uuid:             (parts[0] || '').trim().toUpperCase(),
        rfc_emisor:       (parts[1] || '').trim().toUpperCase(),
        nombre_emisor:    (parts[2] || '').trim(),
        rfc_receptor:     (parts[3] || '').trim().toUpperCase(),
        nombre_receptor:  (parts[4] || '').trim(),
        rfc_pac:          (parts[5] || '').trim(),
        fecha_emision:    (parts[6] || '').trim(),
        efecto:           (parts[7] || '').trim(),   // I/E/T/N/P
        estado:           (parts[8] || '').trim(),   // Vigente/Cancelado
        fecha_cancelacion:(parts[9] || '').trim()
    };
}

/** Extrae UUID y campos clave de un XML CFDI */
async function parseCfdiXml(xmlContent) {
    try {
        const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
        const result = await parser.parseStringPromise(xmlContent);
        const comp   = result['cfdi:Comprobante'] || result['cfdi:comprobante'] || {};
        const attrs  = comp['$'] || {};
        // Buscar UUID en TimbreFiscalDigital
        let uuid = '';
        try {
            const compl = comp['cfdi:Complemento'] || {};
            const tfd   = compl['tfd:TimbreFiscalDigital'] || {};
            uuid = (tfd['$'] || {})['UUID'] || (tfd['$'] || {})['uuid'] || '';
        } catch (_) { /* TimbreFiscalDigital ausente — UUID queda vacío */ }
        return {
            uuid:         uuid.toUpperCase(),
            rfc_emisor:   ((comp['cfdi:Emisor']   || {})['$'] || {})['Rfc'] || '',
            rfc_receptor: ((comp['cfdi:Receptor'] || {})['$'] || {})['Rfc'] || '',
            fecha:        (attrs['Fecha'] || '').substring(0, 10),
            total:        parseFloat(attrs['Total'] || '0'),
            tipo:         attrs['TipoDeComprobante'] || ''
        };
    } catch (_) {
        return null;
    }
}

/** Lee todos los ZIPs de un directorio y extrae entradas según tipo */
function getZipsForSolicitudes(rfcDir, solicitudes) {
    const zips = [];
    for (const sol of solicitudes) {
        if (!sol.paquetes) continue;
        let paquetes = [];
        try { paquetes = typeof sol.paquetes === 'string' ? JSON.parse(sol.paquetes) : sol.paquetes; } catch (_) { /* JSON inválido — omitir solicitud */ }
        for (const pkg of paquetes) {
            const pkgId  = typeof pkg === 'string' ? pkg : pkg.id || pkg;
            const glob   = fs.readdirSync(rfcDir).find(f =>
                f.toUpperCase().startsWith(pkgId.toUpperCase()) && f.endsWith('.zip')
            );
            if (glob) zips.push(path.join(rfcDir, glob));
        }
    }
    return zips;
}

/** Extrae Map<UUID → datos> de ZIPs de metadata */
async function buildMetadataMap(zipPaths) {
    const map = new Map();
    for (const zipPath of zipPaths) {
        try {
            const zip = new AdmZip(zipPath);
            for (const entry of zip.getEntries()) {
                if (entry.isDirectory) continue;
                const content = entry.getData().toString('utf8');
                const lines   = content.split('\n');
                for (const line of lines) {
                    const trimmed = line.trim().replace(/^\uFEFF/, ''); // quitar BOM
                    if (!trimmed || trimmed.startsWith('UUID')) continue; // saltar cabecera
                    const parsed = parseMetadataLine(trimmed);
                    if (parsed && parsed.uuid) map.set(parsed.uuid, parsed);
                }
            }
        } catch (e) {
            console.error('[Validacion] Error leyendo ZIP metadata:', zipPath, e.message);
        }
    }
    return map;
}

/** Extrae Map<UUID → datos> de ZIPs de CFDI (XML) */
async function buildCfdiMap(zipPaths) {
    const map = new Map();
    for (const zipPath of zipPaths) {
        try {
            const zip     = new AdmZip(zipPath);
            const entries = zip.getEntries().filter(e => !e.isDirectory && e.entryName.endsWith('.xml'));
            for (const entry of entries) {
                // UUID puede estar en el nombre del archivo
                const fileUuid = path.basename(entry.entryName, '.xml').toUpperCase();
                const content  = entry.getData().toString('utf8');
                const parsed   = await parseCfdiXml(content);
                if (parsed) {
                    const uuid = parsed.uuid || fileUuid;
                    map.set(uuid, parsed);
                }
            }
        } catch (e) {
            console.error('[Validacion] Error leyendo ZIP CFDI:', zipPath, e.message);
        }
    }
    // También buscar XMLs sueltos en la carpeta del RFC
    return map;
}

// ── POST /api/validacion/iniciar ─────────────────────────────
router.post('/iniciar', authMiddleware, async (req, res) => {
    const { rfc, periodo_inicio, periodo_fin } = req.body;
    if (!rfc || !periodo_inicio || !periodo_fin)
        return res.status(400).json({ error: 'Faltan parámetros: rfc, periodo_inicio, periodo_fin' });

    const rfcDir = path.join(DOWNLOADS_DIR, rfc);
    if (!fs.existsSync(rfcDir))
        return res.status(404).json({ error: `No hay descargas para el RFC ${rfc}` });

    // Crear registro de validación en status "procesando"
    const [ins] = await pool.query(
        `INSERT INTO validaciones_sat (rfc, periodo_inicio, periodo_fin, status)
         VALUES (?, ?, ?, 'procesando')`,
        [rfc, periodo_inicio, periodo_fin]
    );
    const validacionId = ins.insertId;

    // Responde inmediatamente con el ID para que el frontend pueda hacer polling
    res.json({ validacion_id: validacionId, message: 'Validación iniciada' });

    // Procesa en segundo plano
    setImmediate(async () => {
        try {
            // 1. Obtener solicitudes del RFC en el periodo
            const [solicitudes] = await pool.query(
                `SELECT * FROM solicitudes_sat
                 WHERE rfc = ?
                   AND fecha_inicio >= ? AND fecha_fin <= ?
                   AND estado_solicitud = 3
                 ORDER BY fecha_solicitud DESC`,
                [rfc, periodo_inicio, periodo_fin]
            );

            // Separar por tipo_solicitud y tipo_comprobante
            const metaEmitidos  = solicitudes.filter(s => s.tipo_solicitud?.toLowerCase().includes('metadata') && s.tipo_comprobante === 'ISSUED');
            const metaRecibidos = solicitudes.filter(s => s.tipo_solicitud?.toLowerCase().includes('metadata') && s.tipo_comprobante === 'RECEIVED');
            const cfdiEmitidos  = solicitudes.filter(s => !s.tipo_solicitud?.toLowerCase().includes('metadata') && s.tipo_comprobante === 'ISSUED');
            const cfdiRecibidos = solicitudes.filter(s => !s.tipo_solicitud?.toLowerCase().includes('metadata') && s.tipo_comprobante === 'RECEIVED');

            // 2. Construir mapas de UUIDs
            const zipMetaEmi  = getZipsForSolicitudes(rfcDir, metaEmitidos);
            const zipMetaRec  = getZipsForSolicitudes(rfcDir, metaRecibidos);
            const zipCfdiEmi  = getZipsForSolicitudes(rfcDir, cfdiEmitidos);
            const zipCfdiRec  = getZipsForSolicitudes(rfcDir, cfdiRecibidos);

            const mapMetaEmi  = await buildMetadataMap(zipMetaEmi);
            const mapMetaRec  = await buildMetadataMap(zipMetaRec);
            const mapCfdiEmi  = await buildCfdiMap(zipCfdiEmi);
            const mapCfdiRec  = await buildCfdiMap(zipCfdiRec);

            // 3. Comparar y encontrar incongruencias
            const incongruencias = [];

            const comparar = (metaMap, cfdiMap, direccion) => {
                for (const [uuid, meta] of metaMap) {
                    const cfdi = cfdiMap.get(uuid);

                    if (!cfdi) {
                        // FALTANTE: está en metadata pero no tenemos el XML
                        incongruencias.push({
                            validacion_id:  validacionId,
                            tipo:           'faltante',
                            direccion,
                            uuid,
                            rfc_emisor:     meta.rfc_emisor,
                            rfc_receptor:   meta.rfc_receptor,
                            fecha_emision:  meta.fecha_emision,
                            monto_metadata: null,
                            monto_cfdi:     null,
                            dato_metadata:  meta.estado,
                            dato_cfdi:      null
                        });
                        continue;
                    }

                    // CANCELADO: vigente en XML pero cancelado en metadata
                    if ((meta.estado || '').toLowerCase().includes('cancelado')) {
                        incongruencias.push({
                            validacion_id:  validacionId,
                            tipo:           'cancelado',
                            direccion,
                            uuid,
                            rfc_emisor:     meta.rfc_emisor,
                            rfc_receptor:   meta.rfc_receptor,
                            fecha_emision:  meta.fecha_emision,
                            monto_metadata: null,
                            monto_cfdi:     cfdi.total,
                            dato_metadata:  'Cancelado en SAT',
                            dato_cfdi:      'XML existe'
                        });
                    }
                }
            };

            comparar(mapMetaEmi, mapCfdiEmi, 'emitido');
            comparar(mapMetaRec, mapCfdiRec, 'recibido');

            // 4. Calcular estadísticas
            const faltantesEmi     = incongruencias.filter(i => i.tipo === 'faltante'  && i.direccion === 'emitido').length;
            const faltantesRec     = incongruencias.filter(i => i.tipo === 'faltante'  && i.direccion === 'recibido').length;
            const canceladosEmi    = incongruencias.filter(i => i.tipo === 'cancelado' && i.direccion === 'emitido').length;
            const canceladosRec    = incongruencias.filter(i => i.tipo === 'cancelado' && i.direccion === 'recibido').length;

            const totalMeta        = mapMetaEmi.size + mapMetaRec.size;
            const totalProblemas   = faltantesEmi + faltantesRec;
            const completitud      = totalMeta > 0
                ? (((totalMeta - totalProblemas) / totalMeta) * 100).toFixed(2)
                : 100;

            // 5. Guardar incongruencias en BD en chunks
            if (incongruencias.length > 0) {
                for (let i = 0; i < incongruencias.length; i += CHUNK_SIZE) {
                    const chunk  = incongruencias.slice(i, i + CHUNK_SIZE);
                    const values = chunk.map(c => [
                        c.validacion_id, c.tipo, c.direccion, c.uuid,
                        c.rfc_emisor, c.rfc_receptor, c.fecha_emision,
                        c.monto_metadata, c.monto_cfdi, c.dato_metadata, c.dato_cfdi
                    ]);
                    await pool.query(
                        `INSERT INTO validacion_incongruencias
                         (validacion_id, tipo, direccion, uuid, rfc_emisor, rfc_receptor,
                          fecha_emision, monto_metadata, monto_cfdi, dato_metadata, dato_cfdi)
                         VALUES ?`,
                        [values]
                    );
                }
            }

            // 6. Actualizar resumen
            await pool.query(
                `UPDATE validaciones_sat SET
                    total_metadata_emitidos  = ?,
                    total_metadata_recibidos = ?,
                    total_cfdi_emitidos      = ?,
                    total_cfdi_recibidos     = ?,
                    faltantes_emitidos       = ?,
                    faltantes_recibidos      = ?,
                    cancelados_emitidos      = ?,
                    cancelados_recibidos     = ?,
                    completitud_pct          = ?,
                    status                   = 'completo'
                 WHERE id = ?`,
                [
                    mapMetaEmi.size, mapMetaRec.size,
                    mapCfdiEmi.size, mapCfdiRec.size,
                    faltantesEmi, faltantesRec,
                    canceladosEmi, canceladosRec,
                    completitud, validacionId
                ]
            );

            console.log(`[Validacion] ✅ Completada id=${validacionId} RFC=${rfc} completitud=${completitud}%`);

        } catch (err) {
            console.error('[Validacion] Error procesando:', err);
            await pool.query(
                `UPDATE validaciones_sat SET status='error', error_msg=? WHERE id=?`,
                [err.message, validacionId]
            );
        }
    });
});

// ── GET /api/validacion/estado/:id ──────────────────────────
router.get('/estado/:id', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT v.* FROM validaciones_sat v
             WHERE v.id = ?
               AND v.rfc IN (SELECT rfc FROM contribuyentes WHERE usuario_id = ?)`,
            [req.params.id, req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Validación no encontrada' });
        res.json(rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/validacion/historial/:rfc ──────────────────────
router.get('/historial/:rfc', authMiddleware, async (req, res) => {
    try {
        const rfc = req.params.rfc.toUpperCase();
        // Verificar que el RFC pertenezca al usuario
        const [owns] = await pool.query(
            'SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?',
            [rfc, req.user.id]
        );
        if (!owns.length) return res.status(403).json({ error: 'RFC no pertenece a tu cuenta' });
        const [rows] = await pool.query(
            `SELECT * FROM validaciones_sat WHERE rfc = ?
             ORDER BY fecha_validacion DESC LIMIT 50`,
            [rfc]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/validacion/historial ───────────────────────────
router.get('/historial', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM validaciones_sat
             WHERE rfc IN (SELECT rfc FROM contribuyentes WHERE usuario_id = ?)
             ORDER BY fecha_validacion DESC LIMIT 100`,
            [req.user.id]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/validacion/:id/incongruencias ───────────────────
router.get('/:id/incongruencias', authMiddleware, async (req, res) => {
    try {
        // Verificar que la validación pertenezca al usuario
        const [owns] = await pool.query(
            `SELECT 1 FROM validaciones_sat
             WHERE id = ? AND rfc IN (SELECT rfc FROM contribuyentes WHERE usuario_id = ?)`,
            [req.params.id, req.user.id]
        );
        if (!owns.length) return res.status(403).json({ error: 'Acceso denegado' });

        const { tipo, direccion, resuelta } = req.query;
        let   sql    = 'SELECT * FROM validacion_incongruencias WHERE validacion_id = ?';
        const params = [req.params.id];
        if (tipo)     { sql += ' AND tipo = ?';     params.push(tipo); }
        if (direccion){ sql += ' AND direccion = ?'; params.push(direccion); }
        if (resuelta !== undefined) { sql += ' AND resuelta = ?'; params.push(resuelta); }
        sql += ' ORDER BY tipo, direccion LIMIT 2000';
        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── PATCH /api/validacion/incongruencia/:id/resolver ────────
router.patch('/incongruencia/:id/resolver', authMiddleware, async (req, res) => {
    try {
        const { nota } = req.body;
        await pool.query(
            'UPDATE validacion_incongruencias SET resuelta=1, nota=? WHERE id=?',
            [nota || '', req.params.id]
        );
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── DELETE /api/validacion/:id ───────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT rfc FROM validaciones_sat WHERE id=?', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Validación no encontrada' });
        // Solo el dueño del RFC o un admin puede borrar
        if (req.user.role !== 'admin' && req.user.rfc !== rows[0].rfc) {
            return res.status(403).json({ error: 'No autorizado para eliminar esta validación' });
        }
        await pool.query('DELETE FROM validaciones_sat WHERE id=?', [req.params.id]);
        res.json({ ok: true, message: 'Validación eliminada' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
