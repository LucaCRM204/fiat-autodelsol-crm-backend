const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// ========================================
// COTIZACIONES - Presupuestos de vehículos con planes de financiamiento
// ========================================

// GET cotizaciones de un lead
router.get('/leads/:leadId/cotizaciones', authenticateToken, async (req, res) => {
  try {
    const { leadId } = req.params;

    const [cotizaciones] = await pool.execute(
      `SELECT 
        c.*,
        u.name as creado_por_nombre
       FROM cotizaciones c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.lead_id = ?
       ORDER BY c.created_at DESC`,
      [leadId]
    );

    // Parsear el JSON de planes
    const cotizacionesConPlanes = cotizaciones.map(cot => ({
      ...cot,
      planes: cot.planes ? JSON.parse(cot.planes) : []
    }));

    res.json({ ok: true, cotizaciones: cotizacionesConPlanes });
  } catch (error) {
    console.error('Error GET /leads/:leadId/cotizaciones:', error);
    res.status(500).json({ error: 'Error al obtener cotizaciones' });
  }
});

// POST crear cotización
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      leadId,
      vehiculo,
      precioContado,
      anticipo = 0,
      valorUsado = 0,
      planes = [],
      bonificaciones = '',
      notas = ''
    } = req.body;

    // Validaciones
    if (!leadId || !vehiculo || !precioContado) {
      return res.status(400).json({ 
        error: 'Campos requeridos: leadId, vehiculo, precioContado' 
      });
    }

    // Verificar que el lead existe
    const [leads] = await pool.execute('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    // Convertir planes a JSON
    const planesJSON = JSON.stringify(planes);

    const [result] = await pool.execute(
      `INSERT INTO cotizaciones 
        (lead_id, vehiculo, precio_contado, anticipo, valor_usado, planes, bonificaciones, notas, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [leadId, vehiculo, precioContado, anticipo, valorUsado, planesJSON, bonificaciones, notas, req.user.id]
    );

    const [nuevaCotizacion] = await pool.execute(
      `SELECT 
        c.*,
        u.name as creado_por_nombre
       FROM cotizaciones c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = ?`,
      [result.insertId]
    );

    // Parsear planes
    const cotizacion = {
      ...nuevaCotizacion[0],
      planes: nuevaCotizacion[0].planes ? JSON.parse(nuevaCotizacion[0].planes) : []
    };

    console.log(`💰 Cotización creada - Lead ${leadId}, Vehículo: ${vehiculo}, Precio: $${precioContado}`);

    // Crear alerta para el vendedor asignado
    try {
      const [leadInfo] = await pool.execute(
        'SELECT assigned_to, nombre FROM leads WHERE id = ?',
        [leadId]
      );
      
      if (leadInfo[0].assigned_to) {
        await pool.execute(
          `INSERT INTO alertas (user_id, type, message, lead_id, related_id)
           VALUES (?, 'cotizacion', ?, ?, ?)`,
          [
            leadInfo[0].assigned_to,
            `Nueva cotización para ${leadInfo[0].nombre}: ${vehiculo}`,
            leadId,
            result.insertId
          ]
        );
      }
    } catch (alertError) {
      console.error('Error al crear alerta de cotización:', alertError);
    }

    res.json({ ok: true, cotizacion });
  } catch (error) {
    console.error('Error POST /cotizaciones:', error);
    res.status(500).json({ error: 'Error al crear cotización' });
  }
});

// DELETE eliminar cotización
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que la cotización existe
    const [cotizaciones] = await pool.execute(
      'SELECT * FROM cotizaciones WHERE id = ?',
      [id]
    );

    if (cotizaciones.length === 0) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    const cotizacion = cotizaciones[0];

    // Solo el creador o admin pueden eliminar
    if (cotizacion.created_by !== req.user.id && !['owner', 'director'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar esta cotización' });
    }

    await pool.execute('DELETE FROM cotizaciones WHERE id = ?', [id]);

    console.log(`🗑️ Cotización eliminada - ID ${id}`);

    res.json({ ok: true, message: 'Cotización eliminada' });
  } catch (error) {
    console.error('Error DELETE /cotizaciones/:id:', error);
    res.status(500).json({ error: 'Error al eliminar cotización' });
  }
});

// GET estadísticas de cotizaciones
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    let whereClause = '';
    const params = [];

    // Filtrar según rol
    if (req.user.role === 'vendedor') {
      whereClause = 'WHERE c.created_by = ?';
      params.push(req.user.id);
    } else if (['supervisor', 'gerente'].includes(req.user.role)) {
      whereClause = 'WHERE u.reportsTo = ?';
      params.push(req.user.id);
    }

    const [stats] = await pool.execute(
      `SELECT 
        COUNT(*) as total_cotizaciones,
        AVG(c.precio_contado) as precio_promedio,
        SUM(c.precio_contado) as valor_total,
        COUNT(DISTINCT c.lead_id) as leads_cotizados,
        DATE_FORMAT(c.created_at, '%Y-%m') as mes
       FROM cotizaciones c
       LEFT JOIN users u ON c.created_by = u.id
       ${whereClause}
       GROUP BY mes
       ORDER BY mes DESC
       LIMIT 12`,
      params
    );

    res.json({ ok: true, stats });
  } catch (error) {
    console.error('Error GET /cotizaciones/stats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

module.exports = router;
