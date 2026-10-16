const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// ========================================
// ALERTAS - Sistema de notificaciones para usuarios
// ========================================

// GET alertas del usuario
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, unreadOnly = false } = req.query;

    let query = `
      SELECT 
        a.*,
        l.nombre as lead_nombre,
        l.telefono as lead_telefono
      FROM alertas a
      LEFT JOIN leads l ON a.lead_id = l.id
      WHERE a.user_id = ?
    `;

    if (unreadOnly === 'true') {
      query += ' AND a.is_read = FALSE';
    }

    query += ' ORDER BY a.timestamp DESC LIMIT ?';

    const [alertas] = await pool.execute(query, [req.user.id, parseInt(limit)]);

    // Contar alertas no leídas
    const [count] = await pool.execute(
      'SELECT COUNT(*) as unread FROM alertas WHERE user_id = ? AND is_read = FALSE',
      [req.user.id]
    );

    res.json({ 
      ok: true, 
      alertas,
      unreadCount: count[0].unread
    });
  } catch (error) {
    console.error('Error GET /alertas:', error);
    res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

// GET contador de alertas no leídas
router.get('/count', authenticateToken, async (req, res) => {
  try {
    const [count] = await pool.execute(
      'SELECT COUNT(*) as unread FROM alertas WHERE user_id = ? AND is_read = FALSE',
      [req.user.id]
    );

    res.json({ ok: true, unreadCount: count[0].unread });
  } catch (error) {
    console.error('Error GET /alertas/count:', error);
    res.status(500).json({ error: 'Error al obtener contador' });
  }
});

// POST crear alerta (uso interno del sistema)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { userId, type, message, leadId = null, relatedId = null } = req.body;

    // Validaciones
    if (!userId || !type || !message) {
      return res.status(400).json({ 
        error: 'Campos requeridos: userId, type, message' 
      });
    }

    // Validar tipo
    const tiposValidos = ['lead_assigned', 'ranking_change', 'recordatorio', 'tarea', 'meta', 'cotizacion'];
    if (!tiposValidos.includes(type)) {
      return res.status(400).json({ 
        error: 'Tipo de alerta inválido',
        tiposValidos 
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO alertas (user_id, type, message, lead_id, related_id, timestamp)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, type, message, leadId, relatedId]
    );

    const [nuevaAlerta] = await pool.execute(
      `SELECT 
        a.*,
        l.nombre as lead_nombre
       FROM alertas a
       LEFT JOIN leads l ON a.lead_id = l.id
       WHERE a.id = ?`,
      [result.insertId]
    );

    console.log(`🔔 Alerta creada - Usuario ${userId}, Tipo: ${type}`);

    res.json({ ok: true, alerta: nuevaAlerta[0] });
  } catch (error) {
    console.error('Error POST /alertas:', error);
    res.status(500).json({ error: 'Error al crear alerta' });
  }
});

// PUT marcar alerta como leída
router.put('/:id/leer', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la alerta existe y pertenece al usuario
    const [alertas] = await pool.execute(
      'SELECT * FROM alertas WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (alertas.length === 0) {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    await pool.execute(
      'UPDATE alertas SET is_read = TRUE WHERE id = ?',
      [id]
    );

    console.log(`✅ Alerta marcada como leída - ID ${id}`);

    res.json({ ok: true, message: 'Alerta marcada como leída' });
  } catch (error) {
    console.error('Error PUT /alertas/:id/leer:', error);
    res.status(500).json({ error: 'Error al marcar alerta' });
  }
});

// PUT marcar todas las alertas como leídas
router.put('/leer-todas', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE alertas SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE',
      [req.user.id]
    );

    console.log(`✅ ${result.affectedRows} alertas marcadas como leídas - Usuario ${req.user.id}`);

    res.json({ 
      ok: true, 
      message: `${result.affectedRows} alertas marcadas como leídas` 
    });
  } catch (error) {
    console.error('Error PUT /alertas/leer-todas:', error);
    res.status(500).json({ error: 'Error al marcar alertas' });
  }
});

// DELETE eliminar alerta
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la alerta existe y pertenece al usuario
    const [alertas] = await pool.execute(
      'SELECT * FROM alertas WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (alertas.length === 0) {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    await pool.execute('DELETE FROM alertas WHERE id = ?', [id]);

    console.log(`🗑️ Alerta eliminada - ID ${id}`);

    res.json({ ok: true, message: 'Alerta eliminada' });
  } catch (error) {
    console.error('Error DELETE /alertas/:id:', error);
    res.status(500).json({ error: 'Error al eliminar alerta' });
  }
});

// DELETE eliminar todas las alertas leídas
router.delete('/limpiar-leidas', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM alertas WHERE user_id = ? AND is_read = TRUE',
      [req.user.id]
    );

    console.log(`🗑️ ${result.affectedRows} alertas leídas eliminadas - Usuario ${req.user.id}`);

    res.json({ 
      ok: true, 
      message: `${result.affectedRows} alertas eliminadas` 
    });
  } catch (error) {
    console.error('Error DELETE /alertas/limpiar-leidas:', error);
    res.status(500).json({ error: 'Error al limpiar alertas' });
  }
});

module.exports = router;
