/**
 * ============================================
 * CALLS ROUTES - Registro de llamadas
 * ============================================
 * POST /api/calls          - registrar llamada
 * GET  /api/calls/:leadId  - historial de llamadas de un lead
 */

const express = require('express');
const router = express.Router();

// Pool: funciona en ambos CRMs
function getPool(req) {
  const p = req.app.get('db');
  if (p) return p;
  try { return require('../db'); } catch(e) { return null; }
}

// POST /api/calls
router.post('/', async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user?.id || req.user?.userId;
    const { lead_id, telefono, duracion_segundos, resultado, notas } = req.body;

    if (!lead_id) {
      return res.status(400).json({ error: 'lead_id requerido' });
    }

    const [result] = await pool.execute(
      `INSERT INTO call_logs (lead_id, user_id, telefono, duracion_segundos, resultado, notas, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [lead_id, userId, telefono || '', duracion_segundos || 0, resultado || 'contactado', notas || '']
    );

    // Agregar nota al historial del lead
    if (notas || resultado) {
      const notaTexto = `📞 Llamada (${resultado || 'contactado'})${duracion_segundos ? ` - ${Math.floor(duracion_segundos / 60)}:${(duracion_segundos % 60).toString().padStart(2, '0')}` : ''}${notas ? ` — ${notas}` : ''}`;
      await pool.execute(
        `UPDATE leads SET notas = CONCAT(IFNULL(notas, ''), ?, '\n') WHERE id = ?`,
        [`\n[${new Date().toLocaleDateString('es-AR')}] ${notaTexto}`, lead_id]
      );
    }

    res.json({ ok: true, callId: result.insertId });
  } catch (err) {
    console.error('Error saving call:', err.message);
    res.status(500).json({ error: 'Error al guardar llamada' });
  }
});

// GET /api/calls/:leadId
router.get('/:leadId', async (req, res) => {
  try {
    const pool = getPool(req);
    const [calls] = await pool.execute(
      `SELECT c.*, u.name as user_name
       FROM call_logs c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.lead_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.leadId]
    );
    res.json({ ok: true, calls });
  } catch (err) {
    console.error('Error getting calls:', err.message);
    res.status(500).json({ error: 'Error al obtener llamadas' });
  }
});

module.exports = router;
