// seed-admin.js
// Crea (o resetea la contraseña de) el usuario owner inicial.
// Uso: node seed-admin.js
//
// Lee todo de .env — no hay credenciales hardcodeadas acá.
// Podés pasar el email/password por variables de entorno puntuales:
//   SEED_ADMIN_EMAIL=admin@autodelsolfiat.com SEED_ADMIN_PASSWORD=algo_seguro node seed-admin.js

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
require('dotenv').config();

(async () => {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@autodelsolfiat.com';
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME || 'Admin Auto del Sol Fiat';

  if (!password) {
    throw new Error(
      'Falta SEED_ADMIN_PASSWORD. Ejemplo: SEED_ADMIN_PASSWORD=algo_seguro node seed-admin.js'
    );
  }

  const conn = process.env.DATABASE_URL
    ? await mysql.createConnection(process.env.DATABASE_URL)
    : await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'autodelsol_fiat_crm',
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });

  const hash = await bcrypt.hash(password, 10);

  const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);

  if (existing.length > 0) {
    await conn.execute(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?',
      [hash, email]
    );
    console.log(`✅ Contraseña actualizada para ${email}`);
  } else {
    await conn.execute(
      "INSERT INTO users (name, email, password, role, active) VALUES (?, ?, ?, 'owner', 1)",
      [name, email, hash]
    );
    console.log(`✅ Usuario owner creado: ${email}`);
  }

  await conn.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
