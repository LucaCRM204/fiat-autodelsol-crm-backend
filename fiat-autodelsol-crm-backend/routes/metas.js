/**
 * ============================================
 * RUTAS DE METAS - /api/metas
 * ============================================
 */

const express = require('express');
const router = express.Router();

module.exports = (pool) => {
  
  // ============================================
  // GET /api/metas - Listar metas
  // ============================================
  router.get('/', async (req, res) => {
    try {
      const { mes, vendedor_id } = req.query;
      
      let query = `
        SELECT m.*, 
               u.name as vendedor_name,
               c.name as created_by_name
        FROM metas m
        LEFT JOIN users u ON m.vendedor_id = u.id
        LEFT JOIN users c ON m.created_by = c.id
        WHERE 1=1
      `;
      const params = [];
      
      if (mes) {
        query += ' AND m.mes = ?';
        params.push(mes);
      }
      
      if (vendedor_id) {
        query += ' AND m.vendedor_id = ?';
        params.push(vendedor_id);
      }
      
      query += ' ORDER BY m.mes DESC, u.name ASC';
      
      const [metas] = await pool.execute(query, params);
      res.json(metas);
    } catch (error) {
      console.error('Error listando metas:', error);
      res.status(500).json({ error: 'Error al obtener metas' });
    }
  });

  // ============================================
  // GET /api/metas/progreso/:vendedor_id/:mes - Obtener progreso
  // IMPORTANTE: Esta ruta debe ir ANTES de /:id
  // ============================================
  router.get('/progreso/:vendedor_id/:mes', async (req, res) => {
    try {
      const { vendedor_id, mes } = req.params;
      
      // Obtener la meta
      const [[meta]] = await pool.execute(
        'SELECT * FROM metas WHERE vendedor_id = ? AND mes = ?',
        [vendedor_id, mes]
      );
      
      // Calcular ventas reales del mes
      const [[ventasResult]] = await pool.execute(`
        SELECT COUNT(*) as total
        FROM leads
        WHERE assigned_to = ?
          AND estado = 'vendido'
          AND DATE_FORMAT(COALESCE(status_changed_at, created_at), '%Y-%m') = ?
      `, [vendedor_id, mes]);
      
      // Calcular leads del mes
      const [[leadsResult]] = await pool.execute(`
        SELECT COUNT(*) as total
        FROM leads
        WHERE assigned_to = ?
          AND DATE_FORMAT(created_at, '%Y-%m') = ?
      `, [vendedor_id, mes]);
      
      const ventas_reales = ventasResult?.total || 0;
      const leads_reales = leadsResult?.total || 0;
      const meta_ventas = meta?.meta_ventas || 0;
      const meta_leads = meta?.meta_leads || 0;
      
      res.json({
        tiene_meta: !!meta,
        meta_ventas,
        meta_leads,
        ventas_reales,
        leads_reales,
        porcentaje_ventas: meta_ventas > 0 ? Math.round((ventas_reales / meta_ventas) * 100) : 0,
        porcentaje_leads: meta_leads > 0 ? Math.round((leads_reales / meta_leads) * 100) : 0,
        cumple_meta_ventas: ventas_reales >= meta_ventas,
        cumple_meta_leads: leads_reales >= meta_leads
      });
    } catch (error) {
      console.error('Error obteniendo progreso:', error);
      res.status(500).json({ error: 'Error al obtener progreso' });
    }
  });

  // ============================================
  // GET /api/metas/:id - Obtener una meta
  // ============================================
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const [[meta]] = await pool.execute(`
        SELECT m.*, 
               u.name as vendedor_name,
               c.name as created_by_name
        FROM metas m
        LEFT JOIN users u ON m.vendedor_id = u.id
        LEFT JOIN users c ON m.created_by = c.id
        WHERE m.id = ?
      `, [id]);
      
      if (!meta) {
        return res.status(404).json({ error: 'Meta no encontrada' });
      }
      
      res.json(meta);
    } catch (error) {
      console.error('Error obteniendo meta:', error);
      res.status(500).json({ error: 'Error al obtener meta' });
    }
  });

  // ============================================
  // POST /api/metas - Crear meta
  // ============================================
  router.post('/', async (req, res) => {
    try {
      const { vendedor_id, mes, meta_ventas, meta_leads } = req.body;
      
      // Obtener created_by del token (puede estar en diferentes lugares)
      const created_by = req.user?.id || req.userId || null;
      
      // Validaciones
      if (!vendedor_id || !mes) {
        return res.status(400).json({ error: 'vendedor_id y mes son requeridos' });
      }
      
      // Verificar si ya existe una meta para este vendedor en este mes
      const [[existing]] = await pool.execute(
        'SELECT id FROM metas WHERE vendedor_id = ? AND mes = ?',
        [vendedor_id, mes]
      );
      
      if (existing) {
        return res.status(400).json({ 
          error: 'Ya existe una meta para este vendedor en este mes' 
        });
      }
      
      const [result] = await pool.execute(`
        INSERT INTO metas (vendedor_id, mes, meta_ventas, meta_leads, created_by)
        VALUES (?, ?, ?, ?, ?)
      `, [vendedor_id, mes, meta_ventas || 0, meta_leads || 0, created_by]);
      
      const [[newMeta]] = await pool.execute(`
        SELECT m.*, 
               u.name as vendedor_name,
               c.name as created_by_name
        FROM metas m
        LEFT JOIN users u ON m.vendedor_id = u.id
        LEFT JOIN users c ON m.created_by = c.id
        WHERE m.id = ?
      `, [result.insertId]);
      
      res.status(201).json(newMeta);
    } catch (error) {
      console.error('Error creando meta:', error);
      res.status(500).json({ error: 'Error al crear meta' });
    }
  });

  // ============================================
  // PUT /api/metas/:id - Actualizar meta
  // ============================================
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { meta_ventas, meta_leads, mes } = req.body;
      
      // Verificar que existe
      const [[existing]] = await pool.execute('SELECT id FROM metas WHERE id = ?', [id]);
      if (!existing) {
        return res.status(404).json({ error: 'Meta no encontrada' });
      }
      
      // Construir query dinámicamente
      const updates = [];
      const params = [];
      
      if (meta_ventas !== undefined) {
        updates.push('meta_ventas = ?');
        params.push(meta_ventas);
      }
      if (meta_leads !== undefined) {
        updates.push('meta_leads = ?');
        params.push(meta_leads);
      }
      if (mes !== undefined) {
        updates.push('mes = ?');
        params.push(mes);
      }
      
      if (updates.length === 0) {
        return res.status(400).json({ error: 'No hay campos para actualizar' });
      }
      
      updates.push('updated_at = NOW()');
      params.push(id);
      
      await pool.execute(`UPDATE metas SET ${updates.join(', ')} WHERE id = ?`, params);
      
      const [[updated]] = await pool.execute(`
        SELECT m.*, 
               u.name as vendedor_name,
               c.name as created_by_name
        FROM metas m
        LEFT JOIN users u ON m.vendedor_id = u.id
        LEFT JOIN users c ON m.created_by = c.id
        WHERE m.id = ?
      `, [id]);
      
      res.json(updated);
    } catch (error) {
      console.error('Error actualizando meta:', error);
      res.status(500).json({ error: 'Error al actualizar meta' });
    }
  });

  // ============================================
  // DELETE /api/metas/:id - Eliminar meta
  // ============================================
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const [result] = await pool.execute('DELETE FROM metas WHERE id = ?', [id]);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Meta no encontrada' });
      }
      
      res.json({ message: 'Meta eliminada correctamente' });
    } catch (error) {
      console.error('Error eliminando meta:', error);
      res.status(500).json({ error: 'Error al eliminar meta' });
    }
  });

  return router;
};