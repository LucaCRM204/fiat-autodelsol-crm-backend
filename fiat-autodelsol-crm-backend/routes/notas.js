const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// ========================================
// NOTAS INTERNAS - Comentarios privados por lead
// ========================================

// GET todas las notas de un lead
router.get('/leads/:leadId/notas', authenticateToken, async (req, res) => {
  try {
    const { leadId } = req.params;

    const [notas] = await pool.execute(
      `SELECT ni.*, u.name as usuario
       FROM notas_internas ni
       LEFT JOIN users u ON ni.user_id = u.id
       WHERE ni.lead_id = ?
       ORDER BY ni.timestamp DESC`,
      [leadId]
    );

    res.json({ ok: true, notas });
  } catch (error) {
    console.error('Error GET /leads/:leadId/notas:', error);
    res.status(500).json({ error: 'Error al obtener notas' });
  }
});

// POST crear nota interna
router.post('/leads/:leadId/notas', authenticateToken, async (req, res) => {
  try {
    const { leadId } = req.params;
    const { texto } = req.body;

    if (!texto || texto.trim() === '') {
      return res.status(400).json({ error: 'El texto de la nota es requerido' });
    }

    // Verificar que el lead existe
    const [leads] = await pool.execute('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const [result] = await pool.execute(
      `INSERT INTO notas_internas (lead_id, texto, usuario, user_id, timestamp)
       VALUES (?, ?, ?, ?, NOW())`,
      [leadId, texto, req.user.name, req.user.id]
    );

    const [nuevaNota] = await pool.execute(
      `SELECT ni.*, u.name as usuario
       FROM notas_internas ni
       LEFT JOIN users u ON ni.user_id = u.id
       WHERE ni.id = ?`,
      [result.insertId]
    );

    console.log(`✅ Nota interna creada - Lead ${leadId}, Usuario: ${req.user.name}`);

    res.json({ ok: true, nota: nuevaNota[0] });
  } catch (error) {
    console.error('Error POST /leads/:leadId/notas:', error);
    res.status(500).json({ error: 'Error al crear nota' });
  }
});

// DELETE eliminar nota interna
router.delete('/notas/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la nota existe y pertenece al usuario (o es admin)
    const [notas] = await pool.execute(
      'SELECT * FROM notas_internas WHERE id = ?',
      [id]
    );

    if (notas.length === 0) {
      return res.status(404).json({ error: 'Nota no encontrada' });
    }

    const nota = notas[0];

    // Solo el creador o admin pueden eliminar
    if (nota.user_id !== req.user.id && !['owner', 'director'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar esta nota' });
    }

    await pool.execute('DELETE FROM notas_internas WHERE id = ?', [id]);

    console.log(`🗑️ Nota eliminada - ID ${id}, Usuario: ${req.user.name}`);

    res.json({ ok: true, message: 'Nota eliminada' });
  } catch (error) {
    console.error('Error DELETE /notas/:id:', error);
    res.status(500).json({ error: 'Error al eliminar nota' });
  }
});

module.exports = router;
