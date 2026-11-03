/**
 * ============================================
 * TAREAS ASIGNADAS  (/api/tareas)
 * ============================================
 * "Asignar Tareas": un supervisor/gerente le asigna una tarea a un vendedor
 * sobre un lead. Quedan en la base, al vendedor le llega una alerta y al
 * completarla le avisa a quien la asignó.
 *
 * Quién ve qué:
 *   owner / director / gerente -> todas
 *   supervisor -> las que creó, las suyas y las de su equipo
 *   vendedor -> las que tiene asignadas (y las que haya creado)
 */
const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

const TIPOS = ['llamar', 'whatsapp', 'email', 'cotizar', 'seguimiento', 'recuperar_perdido'];
const PRIORIDADES = ['alta', 'media', 'baja'];
const ADMIN = ['owner', 'dueño', 'director', 'gerente'];

const SELECT = `
  SELECT t.id, t.lead_id, t.asignado_a, t.created_by, t.tipo, t.prioridad,
         DATE_FORMAT(t.fecha_limite, '%Y-%m-%dT%H:%i:00') AS fecha_limite,
         t.descripcion, t.completada, t.completada_at, t.created_at,
         c.name AS creador_nombre, a.name AS asignado_nombre,
         l.nombre AS lead_nombre, l.telefono AS lead_telefono, l.modelo AS lead_modelo,
         l.estado AS lead_estado, l.assigned_to AS lead_vendedor
    FROM tareas_asignadas t
    JOIN leads l ON l.id = t.lead_id
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN users a ON a.id = t.asignado_a`;

async function avisar(req, userId, message, leadId, relatedId) {
  try {
    await pool.execute(
      'INSERT INTO alertas (user_id, type, message, lead_id, related_id, timestamp) VALUES (?, ?, ?, ?, ?, NOW())',
      [userId, 'tarea', message.slice(0, 500), leadId, relatedId]);
    const io = req.app.get('io');
    if (io) io.emit('notification', {
      id: `tarea-${relatedId}-${Date.now()}`, type: 'alert', title: '📋 Tarea', message,
      timestamp: new Date().toISOString(), read: false, severity: 'info', leadId, targetUserId: userId,
    });
  } catch (e) {
    console.error('[tareas] alerta:', e.message);
  }
}

// GET tareas visibles (pendientes + completadas de los últimos 7 días)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { id, role } = req.user;
    const reciente = '(t.completada = 0 OR t.completada_at > NOW() - INTERVAL 7 DAY)';
    let query;
    let params = [];
    if (ADMIN.includes(role)) {
      query = `${SELECT} WHERE ${reciente}`;
    } else if (role === 'supervisor') {
      query = `${SELECT} WHERE ${reciente} AND (
        t.created_by = ? OR t.asignado_a = ?
        OR t.asignado_a IN (SELECT u.id FROM users u WHERE u.reportsTo = ? OR u.reportsTo IN (SELECT id FROM users WHERE reportsTo = ?)))`;
      params = [id, id, id, id];
    } else {
      query = `${SELECT} WHERE ${reciente} AND (t.asignado_a = ? OR t.created_by = ?)`;
      params = [id, id];
    }
    const [rows] = await pool.execute(`${query} ORDER BY t.completada, t.fecha_limite LIMIT 1000`, params);
    res.json({ ok: true, tareas: rows });
  } catch (e) {
    console.error('[tareas] GET:', e);
    res.status(500).json({ ok: false, error: 'Error al cargar las tareas' });
  }
});

// POST asignar una tarea
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'vendedor') return res.status(403).json({ ok: false, error: 'Los vendedores no asignan tareas' });
    const { leadId, asignadoA, tipo, prioridad, fechaLimite, descripcion } = req.body || {};
    const desc = String(descripcion || '').trim();
    if (!parseInt(leadId) || !parseInt(asignadoA) || !desc) return res.status(400).json({ ok: false, error: 'Faltan lead, vendedor o descripción' });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(fechaLimite || ''))) return res.status(400).json({ ok: false, error: 'Fecha límite inválida' });

    const [[lead]] = await pool.execute('SELECT id, nombre FROM leads WHERE id = ?', [leadId]);
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });
    const [[vend]] = await pool.execute('SELECT id, name FROM users WHERE id = ? AND active = 1', [asignadoA]);
    if (!vend) return res.status(400).json({ ok: false, error: 'El vendedor no existe o está inactivo' });

    const [r] = await pool.execute(
      `INSERT INTO tareas_asignadas (lead_id, asignado_a, created_by, tipo, prioridad, fecha_limite, descripcion)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lead.id, vend.id, req.user.id, TIPOS.includes(tipo) ? tipo : 'seguimiento',
       PRIORIDADES.includes(prioridad) ? prioridad : 'media',
       String(fechaLimite).slice(0, 16).replace('T', ' ') + ':00', desc.slice(0, 2000)]);

    await avisar(req, vend.id, `📋 Nueva tarea de ${req.user.name}: ${desc.slice(0, 120)} (${lead.nombre})`, lead.id, r.insertId);
    const [[tarea]] = await pool.execute(`${SELECT} WHERE t.id = ?`, [r.insertId]);
    res.json({ ok: true, tarea });
  } catch (e) {
    console.error('[tareas] POST:', e);
    res.status(500).json({ ok: false, error: 'Error al asignar la tarea' });
  }
});

// PUT completar
router.put('/:id/completar', authenticateToken, async (req, res) => {
  try {
    const [[t]] = await pool.execute('SELECT * FROM tareas_asignadas WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ ok: false, error: 'Tarea no encontrada' });
    const { id, role, name } = req.user;
    if (t.asignado_a !== id && t.created_by !== id && !ADMIN.includes(role)) {
      return res.status(403).json({ ok: false, error: 'No podés completar esta tarea' });
    }
    if (t.completada) return res.json({ ok: true });
    await pool.execute(
      'UPDATE tareas_asignadas SET completada = 1, completada_at = NOW(), completada_por = ? WHERE id = ?', [id, t.id]);
    if (t.created_by !== id) {
      const [[lead]] = await pool.execute('SELECT nombre FROM leads WHERE id = ?', [t.lead_id]);
      await avisar(req, t.created_by, `✅ ${name} completó la tarea: ${String(t.descripcion).slice(0, 120)} (${lead?.nombre || ''})`, t.lead_id, t.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[tareas] completar:', e);
    res.status(500).json({ ok: false, error: 'Error al completar la tarea' });
  }
});

// DELETE eliminar (quien la creó, o owner/director/gerente)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const [[t]] = await pool.execute('SELECT created_by FROM tareas_asignadas WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ ok: false, error: 'Tarea no encontrada' });
    if (t.created_by !== req.user.id && !ADMIN.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Solo quien la asignó puede eliminarla' });
    }
    await pool.execute('DELETE FROM tareas_asignadas WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tareas] DELETE:', e);
    res.status(500).json({ ok: false, error: 'Error al eliminar la tarea' });
  }
});

module.exports = router;
