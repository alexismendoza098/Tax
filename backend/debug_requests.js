
const pool = require('./db');

async function checkRequests() {
    try {
        const [rows] = await pool.query("SELECT * FROM solicitudes_sat ORDER BY fecha_solicitud DESC");
        console.log("Solicitudes encontradas en DB:", rows.length);
        console.log(JSON.stringify(rows, null, 2));
        process.exit(0);
    } catch (error) {
        console.error("Error consultando DB:", error);
        process.exit(1);
    }
}

checkRequests();
