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

// Temporary directory for extraction
const TEMP_DIR = path.join(__dirname, '..', 'uploads', 'temp_flatten');
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

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
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos ZIP'), false);
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

        const allRows = [];
        let processedCount = 0;
        let finalReportPath = null;
        
        // CONSOLIDATION: Master CSV to hold all data
        // We will accumulate all TEMPZ_{pkgId}.csv contents into this master file
        const masterTimestamp = Date.now();
        const masterCsvName = `Master_${masterTimestamp}.csv`;
        const masterCsvPath = path.join(TEMP_DIR, masterCsvName);
        let masterHeaderWritten = false;

        for (const pkgId of packagesToProcess) {
            // Try to find the file
            let zipPath = path.join(DOWNLOADS_DIR, `${pkgId}.zip`);
            if (!fs.existsSync(zipPath)) {
                // Try recursive search
                const foundPath = findFileRecursively(DOWNLOADS_DIR, `${pkgId}.zip`);
                if (foundPath) zipPath = foundPath;
                else {
                    console.warn(`[Flatten] Package ${pkgId} not found`);
                    continue;
                }
            }

            console.log(`[Flatten] Processing package: ${pkgId} at path: ${zipPath}`);

            // 1. DB Insertion (Node.js Logic) - Essential for Calculation Step
            try {
                const zip = new AdmZip(zipPath);
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
                        } catch (_) { /* XML malformado — omitir este archivo */ }
                    }
                }
            } catch (e) {
                console.error(`[Flatten] Error reading zip for DB: ${e.message}`);
            }

            // 2. Python Flow (Report Generation)
            // 1a.py -> TEMPZ.csv
            const tempCsv = path.join(TEMP_DIR, `TEMPZ_${pkgId}.csv`);
            const script1 = path.join(__dirname, '..', 'scripts', '1a.py');
            
            await new Promise((resolve, reject) => {
                exec(`python "${script1}" "${zipPath}" "${tempCsv}"`, (error, stdout, stderr) => {
                    if (error) { console.error(`[1a.py] Error: ${stderr}`); resolve(); return; }
                    
                    // CONSOLIDATION: Append to Master CSV
                    if (fs.existsSync(tempCsv)) {
                        const content = fs.readFileSync(tempCsv, 'utf8');
                        const lines = content.split(/\r?\n/);
                        if (lines.length > 0) {
                            if (!masterHeaderWritten) {
                                // Write header + all lines
                                fs.appendFileSync(masterCsvPath, content);
                                masterHeaderWritten = true;
                            } else {
                                // Write all lines EXCEPT header (line 0)
                                // Only if there's data
                                if (lines.length > 1) {
                                    const dataLines = lines.slice(1).join('\n');
                                    if (dataLines.trim()) {
                                        fs.appendFileSync(masterCsvPath, '\n' + dataLines.trim());
                                    }
                                }
                            }
                        }
                        // Cleanup temp
                        try { fs.unlinkSync(tempCsv); } catch (_) { /* cleanup-temp */ }
                    }
                    resolve();
                });
            });
            
            processedCount++;
        }

        // 3. Final Pivot (2a.py) on Master CSV
        if (processedCount > 0 && fs.existsSync(masterCsvPath)) {
            const consolidatedName = `Reporte_Consolidado_${masterTimestamp}`;
            const finalCsv = path.join(DOWNLOADS_DIR, `${consolidatedName}.csv`);
            const script2 = path.join(__dirname, '..', 'scripts', '2a.py');
            
            await new Promise((resolve, reject) => {
                exec(`python "${script2}" "${masterCsvPath}" "${finalCsv}"`, (error2, stdout2, stderr2) => {
                    if (error2) { console.error(`[2a.py] Error: ${stderr2}`); resolve(); return; }
                    console.log(`[2a.py] Output: ${stdout2}`);
                    finalReportPath = finalCsv.replace('.csv', '.xlsx');
                    resolve();
                });
            });
            
            // Cleanup master
            try { fs.unlinkSync(masterCsvPath); } catch (_) { /* cleanup-temp */ }
        }

        if (finalReportPath && fs.existsSync(finalReportPath)) {
            const filename = path.basename(finalReportPath);
             res.json({
                success: true,
                message: `Procesados ${processedCount} paquetes en un reporte consolidado.`,
                downloadUrl: `${process.env.API_URL || 'http://localhost:3000'}/api/flatten/download/${filename}`,
                filename: filename
            });
        } else {
             // Fallback if python failed or no files
             res.json({ success: false, error: "Error en procesamiento Python" });
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

router.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    // Sanitize
    if (filename.includes('/') || filename.includes('\\')) return res.status(400).send("Nombre de archivo inválido");

    const filePath = path.join(DOWNLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send("Archivo no encontrado");
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
        const getFiles = (dir) => {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(getFiles(filePath));
                } else {
                    if (file.endsWith('.zip') || file.endsWith('.txt')) {
                        results.push(filePath);
                    }
                }
            });
            return results;
        };

        const allFiles = getFiles(DOWNLOADS_DIR);
        
        // Get list of processed packages from DB
        const [rows] = await pool.query('SELECT DISTINCT metadata_paquete_id FROM comprobantes');
        const processedIds = new Set(rows.map(r => r.metadata_paquete_id));
        
        const packages = allFiles.map(filePath => {
            const fileName = path.basename(filePath);
            const relativePath = path.relative(DOWNLOADS_DIR, filePath);
            
            let type = 'CFDI';
            if (fileName.toLowerCase().includes('meta')) type = 'Metadata';
            
            // Check if processed
            // We use the filename (without extension) as ID often
            const pkgId = fileName.replace(/\.(zip|txt)$/i, '');
            const isProcessed = processedIds.has(pkgId);
            
            return {
                name: fileName,
                path: relativePath, // Useful for backend, maybe not safe for frontend?
                type: type,
                processed: isProcessed,
                size: (fs.statSync(filePath).size / 1024).toFixed(2) + ' KB',
                date: fs.statSync(filePath).mtime
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

module.exports = router;
