const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const pool = require('../../db');
const { runSatScript, getPaths } = require('../../utils/satHelpers');

// 4. Download
router.post('/download', async (req, res) => {
    try {
        const { rfc, password, id, force } = req.body;
        console.log(`[DEBUG] Descargando solicitud/paquete: ${id} para RFC: ${rfc}`);
        
        const paths = getPaths(rfc);
        if (!paths) return res.status(400).json({ error: `Certificados no encontrados para el RFC: ${rfc}` });

        // 1. First, check if 'id' is a Request ID that has packages.
        // We do this by trying to verify it first, or checking the DB.
        // For robustness, let's Verify with SAT to get the latest list of packages.
        
        console.log(`[DEBUG] Verificando solicitud ${id} para obtener paquetes...`);
        const verifyArgs = [
            '--action', 'verify',
            '--rfc', rfc,
            '--cer', paths.cer,
            '--key', paths.key,
            '--pwd', password,
            '--id', id
        ];
        
        let packageIds = [];
        
        try {
            const verifyResult = await runSatScript(verifyArgs);
            if (verifyResult && verifyResult.data) {
                // Parse 'paquetes' which might be an array or null
                const pkgs = verifyResult.data.paquetes;
                if (Array.isArray(pkgs) && pkgs.length > 0) {
                    packageIds = pkgs;
                } else if (typeof pkgs === 'string' && pkgs.length > 0) {
                     // Try to parse if string
                     try { packageIds = JSON.parse(pkgs); } catch (e) { packageIds = [pkgs]; }
                }
                
                // Also update DB with latest status
                await pool.query(`
                    UPDATE solicitudes_sat 
                    SET estado_solicitud = ?, codigo_estado_solicitud = ?, mensaje = ?, paquetes = ?
                    WHERE id_solicitud = ?
                `, [
                    verifyResult.data.estado_solicitud,
                    verifyResult.data.codigo_estado_solicitud,
                    verifyResult.data.mensaje,
                    JSON.stringify(packageIds),
                    id
                ]);
            }
        } catch (verifyError) {
            console.warn("[WARN] Verify failed before download, trying direct download as package ID:", verifyError.message);
            // Fallback: Assume 'id' IS the package ID (rare but possible)
            packageIds = [id];
        }

        if (packageIds.length === 0) {
             // If verify didn't return packages, maybe the ID passed IS the package ID?
             // Or maybe status is not finished.
             // Let's try to treat 'id' as a package ID directly if verify failed to find list.
             console.log(`[DEBUG] No se encontraron paquetes vía Verify. Intentando usar ID ${id} como ID de paquete directo.`);
             packageIds = [id];
        }

        console.log(`[DEBUG] Paquetes a descargar:`, packageIds);

        const results = [];
        let successCount = 0;

        // 2. Download each package
        for (const pkgId of packageIds) {
            console.log(`[DEBUG] Descargando paquete: ${pkgId}`);
            
            // Check if file exists locally (if force=false)
            // Logic handled inside sat_wrapper.py if we pass --force based on req
            
            const downloadArgs = [
                '--action', 'download',
                '--rfc', rfc,
                '--cer', paths.cer,
                '--key', paths.key,
                '--pwd', password,
                '--id', pkgId
            ];

            if (force) {
                downloadArgs.push('--force');
            }

            try {
                const result = await runSatScript(downloadArgs);
                results.push({ id: pkgId, status: 'success', ...result });
                successCount++;
            } catch (err) {
                console.error(`[ERROR] Falló descarga de paquete ${pkgId}:`, err);
                results.push({ id: pkgId, status: 'error', error: err.message || err });
            }
        }

        // 3. Final Response
        // Update fecha_descarga only if at least one success
        if (successCount > 0) {
            await pool.query(`
                UPDATE solicitudes_sat 
                SET fecha_descarga = NOW() 
                WHERE id_solicitud = ?
            `, [id]);
        }

        // Return summary. If only 1 package, return like before for compatibility.
        if (results.length === 1 && results[0].status === 'success') {
             res.json(results[0]);
        } else {
             res.json({ 
                 status: successCount > 0 ? 'success' : 'partial_error',
                 message: `Descargados ${successCount} de ${packageIds.length} paquetes`,
                 results: results
             });
        }

    } catch (error) {
        console.error("SAT Download Error:", JSON.stringify(error, null, 2));
        
        // Handle specific SAT errors gracefully
        if (error.data && error.data.cod_estatus === '5004') {
            return res.status(404).json({ 
                error: "El paquete aún no está listo en el SAT (Intente más tarde)",
                details: error.data 
            });
        }
        
        // If it's a known Python script error structure
        if (error.message && error.message.includes('Python script failed')) {
             return res.status(500).json({ 
                 error: "Error interno en el script de descarga",
                 details: error.error || error.message
             });
        }

        res.status(500).json({ error: error.message || "Error al descargar paquete del SAT" });
    }
});

// Stream File to Browser
router.get('/download-file/:packageId', (req, res) => {
    const { packageId } = req.params;
    const { rfc } = req.query; 
    
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(packageId) || packageId.includes('..')) {
        return res.status(400).send("ID de paquete inválido");
    }

    let safeId = packageId;
    if (safeId.toLowerCase().endsWith('.zip')) {
        safeId = safeId.slice(0, -4);
    }

    const baseDir = path.join(__dirname, '..', '..', 'downloads');
    let filePath;

    if (rfc && /^[a-zA-Z0-9]+$/.test(rfc)) {
        filePath = path.join(baseDir, rfc, `${safeId}.zip`);
    } else {
        filePath = path.join(baseDir, `${safeId}.zip`);
    }

    if (!fs.existsSync(filePath) && rfc) {
         const legacyPath = path.join(baseDir, `${safeId}.zip`);
         if (fs.existsSync(legacyPath)) filePath = legacyPath;
    }

    if (fs.existsSync(filePath)) {
        res.download(filePath); 
    } else {
        res.status(404).send("Archivo no encontrado en el servidor. Intente descargarlo nuevamente desde el panel.");
    }
});

// Consolidate Packages
router.post('/consolidate', async (req, res) => {
    try {
        const { rfc, packageIds } = req.body;
        
        if (!packageIds || !Array.isArray(packageIds) || packageIds.length === 0) {
             return res.status(400).json({ error: "No se proporcionaron IDs de paquetes para consolidar" });
        }
        
        const zip = new AdmZip();
        const baseDir = path.join(__dirname, '..', '..', 'downloads');
        const rfcDir = rfc ? path.join(baseDir, rfc) : null;
        
        let metadataContent = "";
        let isMetadata = false;
        let processedCount = 0;

        for (const id of packageIds) {
             let safeId = id;
             if (safeId.toLowerCase().endsWith('.zip')) safeId = safeId.slice(0, -4);
             
             let filePath;
             if (rfcDir && fs.existsSync(path.join(rfcDir, `${safeId}.zip`))) {
                 filePath = path.join(rfcDir, `${safeId}.zip`);
             } else if (fs.existsSync(path.join(baseDir, `${safeId}.zip`))) {
                 filePath = path.join(baseDir, `${safeId}.zip`);
             } else {
                 console.warn(`Package ${id} not found locally during consolidation.`);
                 continue;
             }

             try {
                 const pkgZip = new AdmZip(filePath);
                 const zipEntries = pkgZip.getEntries();
                 
                 zipEntries.forEach(entry => {
                     if (entry.isDirectory) return;
                     
                     if (entry.entryName.endsWith('.txt')) {
                         isMetadata = true;
                         let text = pkgZip.readAsText(entry);
                         
                         if (metadataContent === "") {
                             metadataContent += text;
                         } else {
                             const lines = text.split('\n');
                             if (lines.length > 0 && lines[0].includes('~')) {
                                 metadataContent += lines.slice(1).join('\n');
                             } else {
                                 metadataContent += "\n" + text;
                             }
                         }
                     } else {
                         zip.addFile(entry.entryName, entry.getData());
                     }
                 });
                 processedCount++;
             } catch (zipErr) {
                 console.error(`Error processing zip ${id}:`, zipErr);
             }
        }

        if (processedCount === 0) {
            return res.status(400).json({ error: "No se encontraron paquetes descargados para consolidar. Descárguelos primero." });
        }

        if (isMetadata && metadataContent) {
            zip.addFile(`Metadata_Consolidada_${rfc || 'SAT'}.txt`, Buffer.from(metadataContent, "utf8"));
        }

        const downloadName = `Consolidado_${rfc || 'SAT'}_${new Date().getTime()}.zip`;
        const tempPath = path.join(__dirname, '..', '..', 'uploads', 'temp', downloadName);
        
        const tempDir = path.dirname(tempPath);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        zip.writeZip(tempPath);
        
        res.download(tempPath, downloadName, (err) => {
             if (err) console.error("Error sending consolidated zip:", err);
             try { fs.unlinkSync(tempPath); } catch (_) { /* cleanup-temp */ }
        });

    } catch (error) {
        console.error("Consolidation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
