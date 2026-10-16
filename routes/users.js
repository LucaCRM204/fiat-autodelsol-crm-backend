const express = require('express');
const pool = require('../db');
const bcrypt = require('bcrypt');
const dist = require('../services/distribucion.service'); // distribución ponderada
const router = express.Router();

// NOTA: estas rutas no llevan authenticateToken, igual que en el CRM original
// (GoldPlan). Si querés protegerlas, agregar el middleware acá:
// const { authenticateToken, requireRole } = require('../middleware/auth');
// router.use(authenticateToken);

// GET /users  → lista usuarios
router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, role, reportsTo, active, created_at, updated_at FROM users ORDER BY id ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error('[USERS LIST]', e);
    res.status(500).json({ error: 'Users list failed' });
  }
});

// POST /users  → crear usuario
router.post('/', async (req, res) => {
  try {
    const { name, email, password = '123456', role = 'vendedor', reportsTo = null, active = 1 } = req.body || {};

    const hashedPassword = await bcrypt.hash(password, 10);

    const [r] = await pool.query(
      'INSERT INTO users (name,email,password,role,reportsTo,active) VALUES (?,?,?,?,?,?)',
      [name, email, hashedPassword, role, reportsTo, active ? 1 : 0]
    );
    const [row] = await pool.query('SELECT id, name, email, role, reportsTo, active FROM users WHERE id=?', [r.insertId]);

    // Entra al reparto de su equipo y los porcentajes se reacomodan solos.
    try { await dist.invalidarPorUsuario(r.insertId); }
    catch (e) { console.error('[USERS CREATE] resync distribucion:', e.message); }

    res.status(201).json(row[0]);
  } catch (e) {
    console.error('[USERS CREATE]', e);
    res.status(500).json({ error: 'User create failed' });
  }
});

// PUT /users/:id  → actualizar usuario
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const fields = ['name', 'email', 'password', 'role', 'reportsTo', 'active'];
    const sets = [];
    const vals = [];

    for (const f of fields) {
      if (f in req.body) {
        sets.push(`${f}=?`);
        if (f === 'password') {
          vals.push(await bcrypt.hash(req.body[f], 10));
        } else {
          vals.push(req.body[f]);
        }
      }
    }

    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    vals.push(id);
    await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=?`, vals);

    // Si lo desactivaron, lo reactivaron o lo cambiaron de equipo,
    // sale/entra del reparto en el acto y los demás se reacomodan.
    if ('active' in req.body || 'reportsTo' in req.body || 'role' in req.body) {
      try { await dist.invalidarPorUsuario(id); }
      catch (e) { console.error('[USERS UPDATE] resync distribucion:', e.message); }
    }

    const [row] = await pool.query('SELECT id, name, email, role, reportsTo, active FROM users WHERE id=?', [id]);
    res.json(row[0]);
  } catch (e) {
    console.error('[USERS UPDATE]', e);
    res.status(500).json({ error: 'User update failed' });
  }
});

// DELETE /users/:id  → eliminar usuario
router.delete('/:id', async (req, res) => {
  try {
    // Hay que leer su equipo ANTES de borrarlo, después ya no existe.
    const [[prev]] = await pool.query('SELECT reportsTo FROM users WHERE id=?', [req.params.id]);

    await pool.query('DELETE FROM users WHERE id=?', [req.params.id]);
    await pool.query('DELETE FROM distribucion_pesos WHERE user_id=?', [req.params.id]);

    if (prev?.reportsTo) {
      try { await dist.sincronizarEquipo(prev.reportsTo); }
      catch (e) { console.error('[USERS DELETE] resync distribucion:', e.message); }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[USERS DELETE]', e);
    res.status(500).json({ error: 'User delete failed' });
  }
});

module.exports = router;
