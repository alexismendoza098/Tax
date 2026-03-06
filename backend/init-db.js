
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function initDB() {
  console.log('Initializing database...');
  
  // Create connection to MySQL server (no database selected yet)
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3307,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });

  try {
    const sqlPath = path.join(__dirname, 'setup.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('Executing setup.sql...');
    await connection.query(sql);
    console.log('Database initialized successfully!');
    
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    await connection.end();
  }
}

initDB();
