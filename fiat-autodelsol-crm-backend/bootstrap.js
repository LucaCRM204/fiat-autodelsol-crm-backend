// bootstrap.js — se ejecuta al arrancar el server.
// 1) Carga database.sql (todo es CREATE TABLE IF NOT EXISTS: es seguro correrlo en cada deploy).
// 2) Crea el usuario owner si no existe (no pisa la contraseña si ya está creado).
//    Variables: SEED_ADMIN_PASSWORD (obligatoria para crear), SEED_ADMIN_EMAIL, SEED_ADMIN_NAME.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function getConnection() {
  if (process.env.DATABASE_URL) {
    return mysql.createConnection({ uri: process.env.DATABASE_URL, multipleStatements: true });
  }
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'autodelsol_fiat_crm',
    multipleStatements: true,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

async function bootstrap() {
  let conn;
  try {
    conn = await getConnection();

    const sql = fs.readFileSync(path.join(__dirname, 'database.sql'), 'utf8');
    await conn.query(sql);
    const [tablas] = await conn.query('SHOW TABLES');
    console.log(`🗄️  Schema OK — ${tablas.length} tablas`);

    const email = process.env.SEED_ADMIN_EMAIL || 'admin@autodelsolfiat.com';
    const name = process.env.SEED_ADMIN_NAME || 'Admin Auto del Sol Fiat';
    const password = process.env.SEED_ADMIN_PASSWORD;

    const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      console.log(`👤 Owner ya existe: ${email}`);
    } else if (!password) {
      console.warn('⚠️  No hay owner y falta SEED_ADMIN_PASSWORD: no se creó el admin');
    } else {
      const hash = await bcrypt.hash(password, 10);
      await conn.execute(
        "INSERT INTO users (name, email, password, role, active) VALUES (?, ?, ?, 'owner', 1)",
        [name, email, hash]
      );
      console.log(`👤 Owner creado: ${email}`);
    }
  } catch (e) {
    console.error('❌ Bootstrap:', e.message);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

module.exports = bootstrap;
