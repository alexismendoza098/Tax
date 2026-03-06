const pool = require('./db');

(async () => {
    try {
        const [rows] = await pool.query("SHOW COLUMNS FROM solicitudes_sat LIKE 'group_id'");
        if (rows.length === 0) {
            await pool.query("ALTER TABLE solicitudes_sat ADD COLUMN group_id VARCHAR(100) DEFAULT NULL");
            console.log("Column 'group_id' added successfully.");
        } else {
            console.log("Column 'group_id' already exists.");
        }
    } catch (e) {
        console.error("Migration Error:", e);
    }
    process.exit();
})();
