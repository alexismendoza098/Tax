const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const ExcelJS = require('exceljs');
const { parseXML, flattenXML } = require('../utils/xmlParser');
const { insertCFDI } = require('../utils/cfdiInserter');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

// Normaliza pkgId para lookup flexible (con/sin extensión, con/sin sufijo _01)
const normalizePkgId = id => String(id || '').replace(/\.(zip|txt)$/i, '').replace(/_\d{2}$/, '').toLowerCase();

// Helper to parse Metadata TXT
function parseMetadata(content) {
    const lines = content.split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = lines[0].trim().split('~');
    const rows = [];

    // Map Metadata headers to our internal standardized keys
    const mapKey = (h) => {
        const m = {
            'Uuid': 'uuid',
            'RfcEmisor': 'rfc_emisor',
            'NombreEmisor': 'nombre_emisor',
            'RfcReceptor': 'rfc_receptor',
            'NombreReceptor': 'nombre_receptor',
            'FechaEmision': 'fecha',
            'Monto': 'total',
            'EfectoComprobante': 'tipo_de_comprobante',
            'Estatus': 'estado',
            'FechaCancelacion': 'fecha_cancelacion'
        };
        return m[h] || h; // Return mapped key or original if not found
    };

    const keys = headers.map(mapKey);

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const vals = line.split('~');
        const row = {};
        
        keys.forEach((k, idx) => {
            let val = vals[idx];
            // Normalize numeric values
            if (k === 'total') val = parseFloat(val || 0);
            row[k] = val;
        });

        // Defaults for compatibility with XML report
        row['moneda'] = 'MXN'; // Metadata assumes MXN usually
        row['origen'] = 'Metadata'; // Flag to know it came from TXT

        rows.push(row);
    }
    return rows;
}

// ─── Convierte TXT Metadata (tilde-delimitado del SAT) al formato largo ───────
// Produce filas {Or, Var, Val, UUID} — mismo formato que 1a.py para XMLs,
// pero 100% en Node.js: sin Python, sin ZIP temporal, sin loops duplicados.
function metadataToLongRows(content) {
    const lines = content.split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = lines[0].trim().split('~');
    const hMap = {};
    headers.forEach((h, i) => { hMap[h.trim()] = i; });

    const getVal = (parts, key) =>
        hMap[key] !== undefined && hMap[key] < parts.length
            ? (parts[hMap[key]] || '').trim() : null;

    const longRows = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split('~');
        const uuid = getVal(parts, 'Uuid');
        if (!uuid) continue;

        const add = (varName, val) => {
            if (val !== null && val !== undefined && String(val).trim() !== '') {
                longRows.push({ Or: 'Metadata', Var: varName, Val: String(val), UUID: uuid });
            }
        };

        const fechaEmision = getVal(parts, 'FechaEmision');
        add('Version', '');
        add('Fecha', fechaEmision);
        if (fechaEmision) {
            try {
                const [y, m, d] = fechaEmision.split(' ')[0].split('-');
                if (y && m && d) add('FechaDDMMYYYY', `${d}/${m}/${y}`);
            } catch (_) {}
        }
        add('Total',             getVal(parts, 'Monto'));
        add('SubTotal',          '0');
        add('Descuento',         '0');
        add('Moneda',            'MXN');
        add('TipoDeComprobante', getVal(parts, 'EfectoComprobante'));
        add('FormaPago',         '');
        add('MetodoPago',        '');
        add('LugarExpedicion',   '');
        add('TotalTraslados',    '0');
        add('TotalRetenciones',  '0');
        add('RfcEmisor',         getVal(parts, 'RfcEmisor'));
        add('NombreEmisor',      getVal(parts, 'NombreEmisor'));
        add('RfcReceptor',       getVal(parts, 'RfcReceptor'));
        add('NombreReceptor',    getVal(parts, 'NombreReceptor'));
        add('Estado',            getVal(parts, 'Estatus'));
        add('FechaCancelacion',  getVal(parts, 'FechaCancelacion'));
    }
    return longRows;
}

// Serializa filas largas al texto CSV que se concatena en el master CSV
function longRowsToCsvLines(longRows, isFirst) {
    const esc = s => `"${String(s || '').replace(/"/g, '""')}"`;
    const body = longRows
        .map(r => `${esc(r.Or)},${esc(r.Var)},${esc(r.Val)},${esc(r.UUID)}`)
        .join('\n');
    return isFirst ? `Or,Var,Val,UUID\n${body}` : `\n${body}`;
}

const UPLOADS_ROOT = process.env.UPLOAD_DIR
  || path.join(__dirname, '..', 'uploads');
const DOWNLOADS_DIR = process.env.DOWNLOAD_DIR
  || path.join(__dirname, '..', 'downloads');
const TEMP_DIR = path.join(UPLOADS_ROOT, 'temp_flatten');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const { exec } = require('child_process');

// Helper to find file recursively
const findFileRecursively = (dir, filename) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            const found = findFileRecursively(fullPath, filename);
            if (found) return found;
        } else if (file === filename) {
            return fullPath;
        }
    }
    return null;
};

// Helper: calcula el nombre consecutivo para el siguiente reporte consolidado
// Ej: si existe Cfdi_RyE01 y Cfdi_RyE02, retorna Cfdi_RyE03
function getNextConsolidatedName(tipo) {
    const files = fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR) : [];
    const pat = new RegExp(`^Reporte_Consolidado_${tipo}_RyE(\\d+)\\.(csv|xlsx)$`, 'i');
    let max = 0;
    files.forEach(f => {
        const m = pat.exec(f);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `Reporte_Consolidado_${tipo}_RyE${String(max + 1).padStart(2, '0')}`;
}

const multer = require('multer');

// Configure Multer for Uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        cb(null, DOWNLOADS_DIR);
    },
    filename: function (req, file, cb) {
        // Keep original filename but ensure safety
        // Use the original name which usually includes the UUID
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.zip') || file.originalname.endsWith('.txt') ||
            file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' ||
            file.mimetype === 'text/plain') {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos ZIP (CFDI) o TXT (Metadata)'), false);
        }
    }
});

router.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No se subió ningún archivo." });
        }
        res.json({ 
            success: true, 
            message: "Archivo subido correctamente", 
            filename: req.file.filename,
            size: req.file.size
        });
    } catch (e) {
        console.error("Upload Error:", e);
        res.status(500).json({ error: "Error al subir el archivo" });
    }
});

router.post('/process', authMiddleware, async (req, res) => {
    try {
        console.log("[Flatten] Process Request Body:", req.body);
        const { rfc, packageIds } = req.body;
        
        // Resolve Contribuyente ID
        let contribuyenteId = null;
        if (rfc && req.user) {
             const [contribs] = await pool.query('SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?', [rfc, req.user.id]);
             if (contribs.length > 0) {
                 contribuyenteId = contribs[0].id;
             } else {
                 // Auto-create contribuyente
                 const [result] = await pool.query('INSERT INTO contribuyentes (rfc, usuario_id) VALUES (?, ?)', [rfc, req.user.id]);
                 contribuyenteId = result.insertId;
             }
        }

        let packagesToProcess = [];

        if (packageIds) {
            if (Array.isArray(packageIds)) {
                packagesToProcess = packageIds;
            } else {
                packagesToProcess = [packageIds];
            }
        } else if (rfc) {
            const [rows] = await pool.query('SELECT paquetes FROM solicitudes_sat WHERE rfc = ?', [rfc]);
            rows.forEach(row => {
                try {
                    const pkgs = JSON.parse(row.paquetes || '[]');
                    packagesToProcess.push(...pkgs);
                } catch (_) { /* JSON inválido en solicitud — omitir */ }
            });
        }

        if (packagesToProcess.length === 0) {
            return res.status(400).json({ error: "No se encontraron paquetes para procesar." });
        }

        // De-duplicate
        packagesToProcess = [...new Set(packagesToProcess)];

        // ── Lookup tipo real desde solicitudes_sat (para nombrar reporte correctamente) ──
        // Los paquetes SAT vienen SIEMPRE como .zip aunque sean Metadata → la extensión no basta
        const [solRows] = await pool.query(
            'SELECT tipo_solicitud, paquetes FROM solicitudes_sat WHERE paquetes IS NOT NULL'
        ).catch(() => [[]]);
        const typeLookup = {};
        solRows.forEach(sol => {
            try {
                JSON.parse(sol.paquetes || '[]').forEach(pid => {
                    typeLookup[pid] = sol.tipo_solicitud;
                    typeLookup[normalizePkgId(pid)] = sol.tipo_solicitud;
                });
            } catch (_) {}
        });

        // Un Master CSV por TIPO de paquete (Metadata o Cfdi) — todos los paquetes
        // seleccionados se combinan en el Master de su tipo y producen UN solo XLSX.
        const ts = Date.now();
        const metaMasterPath = path.join(TEMP_DIR, `Master_meta_${ts}.csv`);
        const cfdiMasterPath = path.join(TEMP_DIR, `Master_cfdi_${ts}.csv`);
        let metaHeaderWritten = false;
        let cfdiHeaderWritten = false;
        let hasMetadataFiles = false;
        let hasCfdiFiles = false;
        let processedCount = 0;
        const script2 = path.join(__dirname, '..', 'scripts', '2a.py');

        // Detecta si un ZIP es CFDI (contiene .xml) o Metadata (contiene .txt)
        // Se usa como fallback cuando el paquete no tiene tipo registrado en la DB
        function detectZipType(zipPath) {
            try {
                const zip = new AdmZip(zipPath);
                const entries = zip.getEntries();
                const hasXml = entries.some(e => e.entryName.toLowerCase().endsWith('.xml'));
                return hasXml ? 'CFDI' : 'Metadata';
            } catch (_) {
                return 'CFDI'; // fallback seguro
            }
        }

        for (let pkgId of packagesToProcess) {
            // Normalizar: el frontend podría mandar la extensión incluida (p.ej. "UUID.txt")
            // → la eliminamos para trabajar siempre con el ID puro
            pkgId = pkgId.replace(/\.(zip|txt)$/i, '');

            // ── Resolver archivo: busca .zip primero (CFDI), luego .txt (Metadata SAT) ──
            let pkgPath = path.join(DOWNLOADS_DIR, `${pkgId}.zip`);
            let isTxtFile = false;

            if (!fs.existsSync(pkgPath)) {
                const foundZip = findFileRecursively(DOWNLOADS_DIR, `${pkgId}.zip`);
                if (foundZip) {
                    pkgPath = foundZip;
                } else {
                    const tryTxt = path.join(DOWNLOADS_DIR, `${pkgId}.txt`);
                    if (fs.existsSync(tryTxt)) {
                        pkgPath = tryTxt;
                        isTxtFile = true;
                    } else {
                        const foundTxt = findFileRecursively(DOWNLOADS_DIR, `${pkgId}.txt`);
                        if (foundTxt) {
                            pkgPath = foundTxt;
                            isTxtFile = true;
                        } else {
                            console.warn(`[Flatten] Package ${pkgId} no encontrado (.zip ni .txt)`);
                            continue;
                        }
                    }
                }
            }

            // Tipo por paquete — DB tiene prioridad; si no hay registro, se inspecciona
            // el contenido del ZIP (.xml adentro = CFDI, .txt adentro = Metadata)
            const realType = typeLookup[pkgId] || typeLookup[normalizePkgId(pkgId)]
                           || (isTxtFile ? 'Metadata' : detectZipType(pkgPath));
            const isMetaPkg = (realType === 'Metadata' || isTxtFile);

            console.log(`[Flatten] Processing package: ${pkgId} at path: ${pkgPath} (${isMetaPkg ? 'TXT/Metadata' : 'ZIP/CFDI'})`);

            // ── 1. DB Insertion — solo para ZIPs (contienen XMLs) ──
            if (!isTxtFile) {
                try {
                    const zip = new AdmZip(pkgPath);
                    const zipEntries = zip.getEntries();

                    for (const entry of zipEntries) {
                        if (entry.entryName.toLowerCase().endsWith('.xml')) {
                            const xmlContent = entry.getData().toString('utf8');
                            try {
                                const parsed = await parseXML(xmlContent);
                                if (contribuyenteId) {
                                    if (parsed.comprobante) parsed.comprobante.metadata_paquete_id = pkgId;
                                    else parsed.metadata_paquete_id = pkgId;
                                    await insertCFDI(parsed, contribuyenteId).catch(() => { /* CFDI duplicado o inválido — omitir */ });
                                }
                            } catch (_) { /* XML malformado — omitir */ }
                        }
                    }
                } catch (e) {
                    console.error(`[Flatten] Error leyendo ZIP para DB: ${e.message}`);
                }
            }

            // ── 2a. TXT Metadata: procesar DIRECTAMENTE en Node.js (sin 1a.py) ──
            if (isTxtFile) {
                try {
                    const content = fs.readFileSync(pkgPath, 'utf8');
                    const longRows = metadataToLongRows(content);
                    if (longRows.length === 0) {
                        console.warn(`[Flatten] TXT ${pkgId}: sin registros válidos — omitiendo`);
                        continue;
                    }
                    const csvText = longRowsToCsvLines(longRows, !metaHeaderWritten);
                    fs.appendFileSync(metaMasterPath, csvText);
                    metaHeaderWritten = true;
                    hasMetadataFiles = true;
                    console.log(`[Flatten] TXT ${pkgId}: ${longRows.length} filas Metadata escritas`);
                    processedCount++;
                } catch (e) {
                    console.error(`[Flatten] Error procesando TXT ${pkgId}: ${e.message}`);
                }
                continue; // ← saltar el bloque de Python 1a.py
            }

            // ── 2b. ZIP/CFDI: flujo Python con 1a.py ──
            const tempCsv = path.join(TEMP_DIR, `TEMPZ_${pkgId}.csv`);
            const script1 = path.join(__dirname, '..', 'scripts', '1a.py');

            await new Promise((resolve) => {
                exec(`python "${script1}" "${pkgPath}" "${tempCsv}"`, (error, stdout, stderr) => {
                    if (stdout && stdout.trim()) console.log(`[1a.py][${pkgId}] ${stdout.trim()}`);
                    if (stderr && stderr.trim()) console.warn(`[1a.py][${pkgId}] STDERR: ${stderr.trim()}`);
                    if (error) {
                        console.error(`[1a.py][${pkgId}] Falló (código ${error.code}): ${stderr || error.message}`);
                        resolve(); return;
                    }

                    if (fs.existsSync(tempCsv)) {
                        const content = fs.readFileSync(tempCsv, 'utf8');
                        const lines = content.split(/\r?\n/);
                        // Escribir al master correcto según el tipo detectado del ZIP
                        const targetMaster = isMetaPkg ? metaMasterPath : cfdiMasterPath;
                        const hdrWritten   = isMetaPkg ? metaHeaderWritten : cfdiHeaderWritten;
                        if (!hdrWritten) {
                            fs.appendFileSync(targetMaster, content);
                            if (isMetaPkg) metaHeaderWritten = true; else cfdiHeaderWritten = true;
                        } else {
                            if (lines.length > 1) {
                                const dataLines = lines.slice(1).join('\n');
                                if (dataLines.trim()) fs.appendFileSync(targetMaster, '\n' + dataLines.trim());
                            }
                        }
                        if (isMetaPkg) hasMetadataFiles = true; else hasCfdiFiles = true;
                        try { fs.unlinkSync(tempCsv); } catch (_) { /* cleanup-temp */ }
                    }
                    resolve();
                });
            });

            processedCount++;
        }

        // ── 3. Pivot con 2a.py — uno por tipo ──
        const generatedFiles = [];

        const runPivot = (masterPath, tipo) => new Promise((resolve) => {
            if (!fs.existsSync(masterPath)) { resolve(); return; }
            const consolidatedName = getNextConsolidatedName(tipo);
            const finalCsv = path.join(DOWNLOADS_DIR, `${consolidatedName}.csv`);
            exec(`python "${script2}" "${masterPath}" "${finalCsv}"`, (err2, stdout2, stderr2) => {
                if (err2) { console.error(`[2a.py][${tipo}] Error: ${stderr2}`); }
                else {
                    if (stdout2 && stdout2.trim()) console.log(`[2a.py][${tipo}] ${stdout2.trim()}`);
                    const xlsxPath = finalCsv.replace('.csv', '.xlsx');
                    if (fs.existsSync(xlsxPath)) {
                        const fname = path.basename(xlsxPath);
                        generatedFiles.push({
                            filename: fname,
                            downloadUrl: `${process.env.API_URL || 'http://localhost:3000'}/api/flatten/download/${fname}`,
                        });
                    }
                }
                try { fs.unlinkSync(masterPath); } catch (_) { /* cleanup-temp */ }
                resolve();
            });
        });

        if (hasMetadataFiles) await runPivot(metaMasterPath, 'Metadata');
        if (hasCfdiFiles)     await runPivot(cfdiMasterPath, 'Cfdi');

        // Limpiar masters residuales (si no se procesaron)
        [metaMasterPath, cfdiMasterPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });

        if (generatedFiles.length > 0) {
            res.json({
                success: true,
                message: `Procesados ${processedCount} paquete(s). ${generatedFiles.length} reporte(s) generado(s).`,
                files: generatedFiles,
                filename: generatedFiles[0].filename,
                downloadUrl: generatedFiles[0].downloadUrl,
            });
        } else {
            res.json({ success: false, error: 'No se generaron reportes. Verifica que los paquetes tengan datos válidos.' });
        }

    } catch (error) {
        console.error("Flatten Error:", error);
        res.status(500).json({ error: "Error al generar el reporte." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/flatten/reports — lista todos los Reporte_Consolidado_*.xlsx
// El nombre incluye un timestamp, así que buscamos por patrón
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reports', authMiddleware, (req, res) => {
    try {
        if (!fs.existsSync(DOWNLOADS_DIR)) return res.json([]);

        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.startsWith('Reporte_Consolidado_') && f.endsWith('.xlsx'))
            .map(f => {
                const fullPath = path.join(DOWNLOADS_DIR, f);
                const stat = fs.statSync(fullPath);
                return {
                    filename: f,
                    size: stat.size,
                    sizeFmt: (stat.size / 1024).toFixed(1) + ' KB',
                    date: stat.mtime,
                    downloadUrl: `/api/flatten/download/${encodeURIComponent(f)}`,
                };
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date)); // más reciente primero

        res.json(files);
    } catch (e) {
        console.error('[Flatten] Error listando reportes:', e);
        res.status(500).json({ error: 'Error al listar reportes' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/flatten/reports/:filename — eliminar un reporte (xlsx + csv par)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/reports/:filename', authMiddleware, (req, res) => {
    try {
        const { filename } = req.params;

        // Sanitizar: solo permite Reporte_Consolidado_* o Reporte_Masivo_*
        if (
            filename.includes('/') || filename.includes('\\') ||
            filename.includes('..') ||
            (!filename.startsWith('Reporte_Consolidado_') && !filename.startsWith('Reporte_Masivo_'))
        ) {
            return res.status(400).json({ error: 'Nombre de archivo no permitido' });
        }

        const deleted = [];
        const notFound = [];

        // Borrar tanto .xlsx como .csv (vienen en pares con el mismo timestamp base)
        const base = filename.replace(/\.(xlsx|csv)$/i, '');
        for (const ext of ['.xlsx', '.csv']) {
            const fullPath = path.join(DOWNLOADS_DIR, base + ext);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                deleted.push(base + ext);
            } else {
                notFound.push(base + ext);
            }
        }

        if (deleted.length === 0) {
            return res.status(404).json({ error: 'Archivo no encontrado' });
        }

        res.json({ success: true, deleted, notFound });
    } catch (e) {
        console.error('[Flatten] Error eliminando reporte:', e);
        res.status(500).json({ error: 'Error al eliminar reporte: ' + e.message });
    }
});

router.get('/preview/:packageId', authMiddleware, async (req, res) => {
    try {
        const { packageId } = req.params;
        
        const [rows] = await pool.query(`
            SELECT 
                fecha, uuid, rfc_emisor, nombre_emisor, tipo_de_comprobante, 
                metodo_pago, subtotal, descuento, total, total_traslados, total_retenciones, estado, moneda, tipo_cambio
            FROM comprobantes 
            WHERE metadata_paquete_id = ?
            ORDER BY fecha ASC
        `, [packageId]);
        
        // Calculate totals with Fiscal Logic
        // Ingreso (I): Positive
        // Egreso (E): Negative (Returns/Discounts)
        // Pago (P): Neutral or handled separately (usually just cash flow)
        // Nomina (N): Expense (Positive for deduction)
        // Traslado (T): Neutral
        
        const totals = {
            subtotal: 0,
            descuento: 0,
            total_traslados: 0,
            total_retenciones: 0,
            total: 0
        };

        const processedRows = rows.map(r => {
            const type = (r.tipo_de_comprobante || 'I').toUpperCase();
            const multiplier = type === 'E' ? -1 : 1;
            
            // Convert to numbers
            const sub = parseFloat(r.subtotal) || 0;
            const desc = parseFloat(r.descuento) || 0;
            const tras = parseFloat(r.total_traslados) || 0;
            const ret = parseFloat(r.total_retenciones) || 0;
            const tot = parseFloat(r.total) || 0;

            // Only sum active (Vigente) vouchers
            if (r.estado !== 'Cancelado') {
                totals.subtotal += sub * multiplier;
                totals.descuento += desc * multiplier;
                totals.total_traslados += tras * multiplier;
                totals.total_retenciones += ret * multiplier;
                totals.total += tot * multiplier;
            }

            return {
                ...r,
                subtotal: sub,
                descuento: desc,
                total_traslados: tras,
                total_retenciones: ret,
                total: tot
            };
        });

        res.json({
            rows: processedRows,
            totals: totals
        });
    } catch (e) {
        console.error("Preview Error:", e);
        res.status(500).json({ error: "Error fetching preview data" });
    }
});

router.get('/packages', authMiddleware, async (req, res) => {
    try {
        if (!fs.existsSync(DOWNLOADS_DIR)) {
            return res.json([]);
        }
        
        // Helper to get files recursively
        // Excluye "temp_extract" y "temp_flatten" — son directorios temporales de 1a.py
        const SKIP_DIRS = new Set(['temp_extract', 'temp_flatten']);
        const getFiles = (dir) => {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    if (!SKIP_DIRS.has(file)) {          // ← saltar carpetas temporales
                        results = results.concat(getFiles(filePath));
                    }
                } else {
                    // Solo archivos .zip o .txt que NO sean reportes consolidados
                    if ((file.endsWith('.zip') || file.endsWith('.txt')) &&
                        !file.startsWith('Reporte_') && !file.startsWith('Master_')) {
                        results.push(filePath);
                    }
                }
            });
            return results;
        };

        const allFiles = getFiles(DOWNLOADS_DIR);

        // ── Mapa pkgId → {tipo, direccion} desde solicitudes_sat ──────────────
        // Aislamiento: solo paquetes del usuario autenticado
        // (con fallback para datos históricos sin usuario_id asignado)
        const [solicitudes] = await pool.query(`
            SELECT tipo_solicitud, tipo_comprobante, paquetes
            FROM solicitudes_sat
            WHERE paquetes IS NOT NULL
              AND (
                usuario_id = ?
                OR (usuario_id IS NULL AND rfc IN (
                      SELECT rfc FROM contribuyentes WHERE usuario_id = ?
                    ))
              )
        `, [req.user.id, req.user.id]);

        const pkgMap = {};
        // Whitelist de IDs que pertenecen al usuario actual
        const userPkgIds = new Set();
        solicitudes.forEach(sol => {
            try {
                JSON.parse(sol.paquetes || '[]').forEach(pid => {
                    const entry = { tipo: sol.tipo_solicitud, dir: sol.tipo_comprobante };
                    pkgMap[pid] = entry;
                    pkgMap[normalizePkgId(pid)] = entry; // lookup flexible (sin _01, sin extensión)
                    userPkgIds.add(pid);
                    userPkgIds.add(normalizePkgId(pid));
                });
            } catch (_) {}
        });

        // ── "Procesado" para CFDI: verificar en comprobantes del usuario ──────
        const [cfdiRows] = await pool.query(`
            SELECT DISTINCT c.metadata_paquete_id
            FROM comprobantes c
            INNER JOIN contribuyentes co ON c.contribuyente_id = co.id
            WHERE co.usuario_id = ?
        `, [req.user.id]);
        const processedCfdiIds = new Set(cfdiRows.map(r => r.metadata_paquete_id));

        // ── "Procesado" para Metadata: si existe un reporte posterior al archivo ─
        const metaReports = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => /^Reporte_Consolidado_Metadata_RyE\d+\.(csv|xlsx)$/i.test(f))
            .sort();
        const latestMetaTime = metaReports.length
            ? fs.statSync(path.join(DOWNLOADS_DIR, metaReports[metaReports.length - 1])).mtime
            : null;

        // Filtrar allFiles a solo los paquetes que pertenecen al usuario
        const userFiles = allFiles.filter(filePath => {
            const pkgId = path.basename(filePath).replace(/\.(zip|txt)$/i, '');
            return userPkgIds.has(pkgId) || userPkgIds.has(normalizePkgId(pkgId));
        });

        const packages = userFiles.map(filePath => {
            const fileName = path.basename(filePath);
            const relativePath = path.relative(DOWNLOADS_DIR, filePath);
            const pkgId = fileName.replace(/\.(zip|txt)$/i, '');
            const fileStat = fs.statSync(filePath);

            // ── Tipo y dirección (DB primero, extensión como fallback) ────────
            const dbInfo = pkgMap[pkgId] || pkgMap[normalizePkgId(pkgId)] || {};
            const type      = dbInfo.tipo || (fileName.endsWith('.txt') ? 'Metadata' : 'CFDI');
            const direccion = dbInfo.dir === 'Issued'   ? 'Emitido'
                            : dbInfo.dir === 'Received' ? 'Recibido'
                            : 'Sin clasificar';

            // ── Estado "Procesado" ────────────────────────────────────────────
            const isProcessed = type === 'CFDI'
                ? processedCfdiIds.has(pkgId)
                : (latestMetaTime != null && fileStat.mtime < latestMetaTime);

            return {
                name:      fileName,
                path:      relativePath,
                type,        // 'Metadata' | 'CFDI'
                direccion,   // 'Emitido' | 'Recibido' | 'Sin clasificar'
                processed: isProcessed,
                size:      (fileStat.size / 1024).toFixed(2) + ' KB',
                date:      fileStat.mtime
            };
        });
        
        // Sort by date desc
        packages.sort((a, b) => new Date(b.date) - new Date(a.date));
            
        res.json(packages);
    } catch (e) {
        console.error("List Packages Error:", e);
        res.status(500).json({ error: "Error listing packages" });
    }
});

router.post('/delete', authMiddleware, async (req, res) => {
    try {
        const { packageIds } = req.body;
        
        if (!packageIds || !Array.isArray(packageIds) || packageIds.length === 0) {
            return res.status(400).json({ error: "No se proporcionaron paquetes para eliminar." });
        }
        
        const deleted = [];
        const errors = [];
        
        for (const pkgId of packageIds) {
            // pkgId usually comes as the filename (e.g. 'UUID.zip') from the frontend selection
            // But just in case, handle potential paths or IDs
            const filename = path.basename(pkgId);
            const bareId = filename.replace(/\.(zip|txt)$/i, '');

            // Aislamiento: verificar que el paquete pertenezca al usuario
            const [owns] = await pool.query(`
                SELECT 1 FROM solicitudes_sat
                WHERE JSON_SEARCH(paquetes, 'one', ?) IS NOT NULL
                  AND (
                    usuario_id = ?
                    OR (usuario_id IS NULL AND rfc IN (
                          SELECT rfc FROM contribuyentes WHERE usuario_id = ?
                        ))
                  )
                LIMIT 1
            `, [bareId, req.user.id, req.user.id]);

            if (!owns.length) {
                errors.push({ file: filename, error: 'Acceso denegado: paquete no pertenece a tu cuenta' });
                continue;
            }

            const foundPath = findFileRecursively(DOWNLOADS_DIR, filename);
            
            if (foundPath) {
                try {
                    fs.unlinkSync(foundPath);
                    deleted.push(filename);
                } catch (err) {
                    console.error(`Error deleting ${filename}:`, err);
                    errors.push({ file: filename, error: err.message });
                }
            } else {
                 // Try adding extensions if missing
                 const exts = ['.zip', '.txt'];
                 for (const ext of exts) {
                     if (!filename.endsWith(ext)) {
                         const fPath = findFileRecursively(DOWNLOADS_DIR, filename + ext);
                         if (fPath) {
                             try {
                                 fs.unlinkSync(fPath);
                                 deleted.push(filename + ext);
                             } catch (err) { errors.push({ file: filename + ext, error: err.message }); }
                         }
                     }
                 }
            }
        }
        
        res.json({ 
            success: true, 
            deleted, 
            errors,
            message: `Se eliminaron ${deleted.length} paquetes.` 
        });
        
    } catch (e) {
        console.error("Delete Error:", e);
        res.status(500).json({ error: "Error al eliminar paquetes" });
    }
});

// ── GET /api/flatten/download/:filename ────────────────────────────
// Descarga individual de un archivo ZIP (o TXT) del repositorio
// Aislamiento: valida que el paquete pertenezca al usuario autenticado
router.get('/download/:filename', authMiddleware, async (req, res) => {
    try {
        const filename = path.basename(req.params.filename); // sanitizar path traversal
        const pkgId = filename.replace(/\.(zip|txt)$/i, '');

        // Verificar que el paquete pertenezca al usuario (por solicitudes_sat.paquetes)
        const [owns] = await pool.query(`
            SELECT 1 FROM solicitudes_sat
            WHERE JSON_SEARCH(paquetes, 'one', ?) IS NOT NULL
              AND (
                usuario_id = ?
                OR (usuario_id IS NULL AND rfc IN (
                      SELECT rfc FROM contribuyentes WHERE usuario_id = ?
                    ))
              )
            LIMIT 1
        `, [pkgId, req.user.id, req.user.id]);

        if (!owns.length) {
            return res.status(403).json({ error: 'Acceso denegado: este paquete no pertenece a tu cuenta' });
        }

        const filePath = findFileRecursively(DOWNLOADS_DIR, filename);
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Archivo no encontrado en el repositorio' });
        }
        res.download(filePath, filename);
    } catch (e) {
        console.error('[FLATTEN/DOWNLOAD]', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
