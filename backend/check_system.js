const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

console.log("==========================================");
console.log("   DIAGNÓSTICO DEL SISTEMA IVA TAX RECOVERY");
console.log("==========================================");

const checks = {
    dirs: [
        'uploads',
        'uploads/certs',
        '../downloads' // relative to backend
    ],
    files: [
        'server.js',
        'package.json',
        '.env'
    ]
};

async function runDiagnostics() {
    let errors = 0;

    // 1. Verificación de Directorios y Archivos
    console.log("\n[1] Verificando Estructura de Archivos...");
    checks.dirs.forEach(dir => {
        const fullPath = path.join(__dirname, dir);
        if (fs.existsSync(fullPath)) {
            console.log(`  ✅ DIR: ${dir}`);
        } else {
            console.error(`  ❌ DIR FALTANTE: ${dir} (Creando...)`);
            try {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`     ✅ Creado exitosamente.`);
            } catch (e) {
                console.error(`     ❌ Error al crear: ${e.message}`);
                errors++;
            }
        }
    });

    checks.files.forEach(file => {
        const fullPath = path.join(__dirname, file);
        if (fs.existsSync(fullPath)) {
            console.log(`  ✅ ARCHIVO: ${file}`);
        } else {
            console.error(`  ❌ ARCHIVO FALTANTE: ${file}`);
            errors++;
        }
    });

    // 2. Verificación de Dependencias (node_modules)
    console.log("\n[2] Verificando Dependencias...");
    if (fs.existsSync(path.join(__dirname, 'node_modules'))) {
        console.log("  ✅ node_modules existe.");
    } else {
        console.error("  ❌ node_modules NO encontrado. Ejecute 'npm install'.");
        errors++;
    }

    // 3. Verificación de Certificados
    console.log("\n[3] Verificando Certificados...");
    const certsDir = path.join(__dirname, 'uploads', 'certs');
    if (fs.existsSync(certsDir)) {
        const rfcDirs = fs.readdirSync(certsDir);
        if (rfcDirs.length === 0) {
            console.log("  ⚠️ No hay RFCs configurados en uploads/certs.");
        } else {
            rfcDirs.forEach(rfc => {
                const rfcPath = path.join(certsDir, rfc);
                if (fs.statSync(rfcPath).isDirectory()) {
                    const hasCer = fs.existsSync(path.join(rfcPath, 'cer.cer'));
                    const hasKey = fs.existsSync(path.join(rfcPath, 'key.key'));
                    if (hasCer && hasKey) {
                        console.log(`  ✅ ${rfc}: cer.cer y key.key encontrados.`);
                    } else {
                        console.error(`  ❌ ${rfc}: Faltan archivos (cer: ${hasCer}, key: ${hasKey})`);
                        // Don't count as fatal error, just warning
                    }
                }
            });
        }
    }

    // 4. Verificación de Puerto 3000
    console.log("\n[4] Verificando Puerto 3000...");
    // Simple check via netstat (Windows)
    exec('netstat -ano | findstr :3000', (err, stdout, stderr) => {
        if (stdout) {
            console.log("  ⚠️  El puerto 3000 parece estar ocupado. Si es este servidor, está bien.");
            console.log("      Procesos usando puerto 3000:\n" + stdout);
        } else {
            console.log("  ✅ Puerto 3000 libre.");
        }

        finish(errors);
    });
}

function finish(errors) {
    console.log("\n==========================================");
    if (errors === 0) {
        console.log("   ✅ SISTEMA LISTO PARA INICIAR");
        process.exit(0);
    } else {
        console.error(`   ❌ SE ENCONTRARON ${errors} ERRORES CRÍTICOS`);
        console.log("   Por favor revise los mensajes anteriores.");
        // We exit with 0 anyway to allow the batch script to pause and show output, 
        // or we could exit 1 to stop. Let's exit 0 but the user sees the red text.
        process.exit(0);
    }
}

runDiagnostics();
