/**
 * Script rápido para crear/actualizar usuario admin con contraseña admin123
 * Uso: node add-admin.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function addAdmin() {
    console.log('=== Configurando usuario admin ===\n');

    const users = [
        { username: 'admin', password: 'admin123', role: 'admin' },
        { username: 'demo',  password: 'demo123',  role: 'user'  }
    ];

    for (const u of users) {
        try {
            const hash = await bcrypt.hash(u.password, 10);
            await pool.query(
                `INSERT INTO usuarios (username, password_hash, role)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)`,
                [u.username, hash, u.role]
            );
            console.log(`✅ Usuario '${u.username}' (${u.role}) creado/actualizado`);
        } catch (err) {
            console.error(`❌ Error con usuario '${u.username}':`, err.message);
        }
    }

    console.log('\n=== Credenciales de acceso ===');
    console.log('  Usuario: admin   | Contraseña: admin123 | Rol: admin');
    console.log('  Usuario: demo    | Contraseña: demo123  | Rol: usuario');
    console.log('\n¡Listo! Ahora puedes iniciar sesión.');

    await pool.end();
    process.exit(0);
}

addAdmin().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
