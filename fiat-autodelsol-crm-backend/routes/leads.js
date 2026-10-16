/**
 * ============================================
 * ROUTES/LEADS.JS - AUTO DEL SOL (FIAT)
 * ============================================
 * FEATURES:
 * - Estados protegidos (rechazado_supervisor)
 * - Asignación directa por round-robin / distribución ponderada
 * - Sistema de aceptación en tiempo real (10 min, ver socket-server.js)
 * - Marca fija: fiat | Fuente por defecto: community
 */

const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// ===== HISTORIAL DE LEADS =====
async function logLeadHistory(leadId, action, fieldName, oldValue, newValue, userId, userName) {
  try {
    await pool.execute(
      'INSERT INTO lead_history (lead_id, action, field_name, old_value, new_value, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [leadId, action, fieldName, String(oldValue ?? ''), String(newValue ?? ''), userId, userName]
    );
  } catch (e) { console.error('Error log history:', e.message); }
}

const FIELD_LABELS = {
  nombre: 'Nombre', telefono: 'Teléfono', modelo: 'Modelo', marca: 'Marca',
  formaPago: 'Forma de Pago', estado: 'Estado', fuente: 'Fuente', notas: 'Observaciones',
  assigned_to: 'Vendedor', equipo: 'Equipo', fecha: 'Fecha'
};
const { getAssignedVendorByBrand, getRoundRobinStatus, resetRoundRobinIndex } = require('../utils/assign');

// Importar funciones del socket server
let socketFunctions = null;
try {
  socketFunctions = require('../socket-server');
} catch (e) {
  console.log('Socket server not loaded yet');
}

// ============================================
// ESTADOS PROTEGIDOS
// ============================================
const ESTADOS_PROTEGIDOS = ['rechazado_supervisor'];

function validarCambioEstadoLead(estadoActual, nuevoEstado, role, esAutomatico = false) {
  const ROLES_SUPER = ['owner', 'gerente', 'director'];

  if (ESTADOS_PROTEGIDOS.includes(estadoActual)) {
    if (!ROLES_SUPER.includes(role)) {
      return {
        permitido: false,
        error: `El estado "${estadoActual}" es final y solo puede ser modificado por el Owner, Director o Gerente.`
      };
    }
  }

  if (ESTADOS_PROTEGIDOS.includes(nuevoEstado) && !esAutomatico) {
    return {
      permitido: false,
      error: `No se puede cambiar manualmente a "${nuevoEstado}". Este estado solo se asigna automáticamente.`
    };
  }

  return { permitido: true };
}

// Utilidad para mapear
const mapLead = (row) => ({
  ...row,
  vendedor: row.assigned_to ?? null,
});

// Helper: Validar permisos de asignación
const canAssignToVendor = async (userId, userRole, targetVendorId) => {
  if (['owner', 'dueño', 'director'].includes(userRole)) {
    return true;
  }

  if (userId === targetVendorId) {
    return true;
  }

  const [targetUser] = await pool.execute(
    'SELECT id, role, reportsTo FROM users WHERE id = ?',
    [targetVendorId]
  );

  if (targetUser.length === 0) {
    return false;
  }

  const target = targetUser[0];

  if (userRole === 'gerente') {
    if (target.reportsTo === userId) {
      return true;
    }

    if (target.reportsTo) {
      const [supervisor] = await pool.execute(
        'SELECT reportsTo FROM users WHERE id = ?',
        [target.reportsTo]
      );
      if (supervisor.length > 0 && supervisor[0].reportsTo === userId) {
        return true;
      }
    }

    return false;
  }

  if (userRole === 'supervisor') {
    return target.reportsTo === userId;
  }

  return false;
};

// GET todos los leads
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Para vendedores: no mostrar leads pendientes de aceptación de OTROS
    // Solo mostrar sus propios leads aceptados
    const { role, id: userId } = req.user;

    let query = 'SELECT * FROM leads';
    let params = [];

    if (role === 'vendedor') {
      query = `
        SELECT * FROM leads 
        WHERE (assigned_to = ? AND pending_acceptance = FALSE)
           OR (pending_acceptance = FALSE AND assigned_to IS NULL)
        ORDER BY created_at DESC
      `;
      params = [userId];
    } else {
      query = 'SELECT * FROM leads ORDER BY created_at DESC';
    }

    const [rows] = await pool.execute(query, params);
    const leads = rows.map(mapLead);
    res.json({ ok: true, leads });
  } catch (error) {
    console.error('Error GET /leads:', error);
    res.status(500).json({ error: 'Error al obtener leads' });
  }
});

// GET un lead
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const lead = rows[0];
    const { role, id: userId } = req.user;

    // Si es vendedor y el lead está pendiente de aceptación para ÉL, no mostrar datos
    if (role === 'vendedor' && lead.pending_acceptance && lead.current_offer_to === userId) {
      return res.json({
        ok: true,
        lead: {
          id: lead.id,
          pending_acceptance: true,
          message: 'Debés aceptar este lead para ver los datos'
        }
      });
    }

    // Si es vendedor y el lead no es suyo, no mostrar
    if (role === 'vendedor' && lead.assigned_to !== userId && lead.pending_acceptance) {
      return res.status(403).json({ error: 'No tenés acceso a este lead' });
    }

    res.json({ ok: true, lead: mapLead(lead) });
  } catch (error) {
    console.error('Error GET /leads/:id:', error);
    res.status(500).json({ error: 'Error al obtener lead' });
  }
});

// GET estado del round-robin
router.get('/round-robin/status', authenticateToken, async (req, res) => {
  try {
    if (!['owner', 'director', 'gerente'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const status = await getRoundRobinStatus();
    res.json({ ok: true, ...status });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener estado' });
  }
});

// POST resetear round-robin
router.post('/round-robin/reset', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner puede resetear' });
    }

    resetRoundRobinIndex();
    res.json({ ok: true, message: 'Índice round-robin reseteado a 0' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al resetear' });
  }
});

// GET distribución de leads
router.get('/distribution', authenticateToken, async (req, res) => {
  try {
    if (!['owner', 'director', 'gerente'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const [distribution] = await pool.execute(`
      SELECT 
        u.id,
        u.name as nombre,
        u.active,
        COUNT(l.id) as total_leads,
        SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as leads_30d,
        SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as leads_7d,
        SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN 1 ELSE 0 END) as leads_hoy,
        MAX(l.created_at) as ultimo_lead
      FROM users u
      LEFT JOIN leads l ON l.assigned_to = u.id
      WHERE u.role = 'vendedor'
      GROUP BY u.id, u.name, u.active
      ORDER BY u.active DESC, total_leads DESC
    `);

    res.json({ ok: true, distribution });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener distribución' });
  }
});

// GET leads sin asignar
router.get('/unassigned', authenticateToken, async (req, res) => {
  try {
    if (!['owner', 'director', 'gerente'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const [rows] = await pool.execute(`
      SELECT * FROM leads 
      WHERE marca IS NULL OR assigned_to IS NULL
      ORDER BY created_at DESC
    `);

    const leads = rows.map(mapLead);

    res.json({
      ok: true,
      leads,
      count: leads.length,
      message: `${leads.length} leads sin asignar encontrados`
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener leads sin asignar' });
  }
});

// ============================================
// POST crear lead - CON SISTEMA DE ACEPTACIÓN
// ============================================
router.post('/', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');

    const {
      nombre,
      telefono,
      modelo,
      marca = 'fiat',
      formaPago = 'Contado',
      infoUsado = '',
      entrega = false,
      fecha = new Date().toISOString().split('T')[0],
      estado = 'nuevo',
      fuente = 'community',
      notas = '',
      vendedor = null,
      assigned_to = null
    } = req.body;

    if (!nombre || !telefono) {
      return res.status(400).json({
        error: 'Campos requeridos faltantes',
        details: {
          nombre: !nombre ? 'requerido' : 'ok',
          telefono: !telefono ? 'requerido' : 'ok'
        }
      });
    }

    if (marca !== 'fiat') {
      return res.status(400).json({ error: 'Marca inválida' });
    }

    if (ESTADOS_PROTEGIDOS.includes(estado)) {
      return res.status(400).json({
        error: `No se puede crear un lead con estado "${estado}".`
      });
    }

    // Determinar vendedor asignado
    let finalAssignedTo = assigned_to || vendedor;
    const isFromBot = fuente && (fuente.includes('whatsapp') || fuente.includes('bot'));

    if (finalAssignedTo) {
      if (!isFromBot) {
        const hasPermission = await canAssignToVendor(req.user.id, req.user.role, finalAssignedTo);
        if (!hasPermission) {
          return res.status(403).json({ error: 'No tenés permisos para asignar a este vendedor' });
        }
      }
    } else {
      if (req.user.role === 'vendedor') {
        finalAssignedTo = req.user.id;
      } else {
        try {
          // Intentar distribución por porcentaje primero
          const [vendedoresConPct] = await pool.execute(`
            SELECT u.id, u.name, u.lead_percentage
            FROM users u
            WHERE u.role = 'vendedor' 
            AND u.active = 1
            AND u.lead_percentage > 0
            ORDER BY u.id
          `);

          if (vendedoresConPct.length > 0) {
            // Algoritmo de déficit
            const vendorIds = vendedoresConPct.map(v => v.id);
            const placeholders = vendorIds.map(() => '?').join(',');
            const [counts] = await pool.execute(
              `SELECT assigned_to, COUNT(*) as total
               FROM leads 
               WHERE assigned_to IN (${placeholders})
                 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
               GROUP BY assigned_to`,
              vendorIds
            );
            const countMap = new Map();
            counts.forEach(c => countMap.set(c.assigned_to, c.total));
            const totalLeads = counts.reduce((sum, c) => sum + c.total, 0) || 1;

            let bestId = vendedoresConPct[0].id;
            let maxDeficit = -Infinity;
            for (const v of vendedoresConPct) {
              const received = countMap.get(v.id) || 0;
              const realPct = (received / totalLeads) * 100;
              const deficit = v.lead_percentage - realPct;
              if (deficit > maxDeficit) {
                maxDeficit = deficit;
                bestId = v.id;
              }
            }
            finalAssignedTo = bestId;
            console.log(`📊 Distribución por %: vendedor ${finalAssignedTo} (déficit: ${maxDeficit.toFixed(1)}%)`);
          } else {
            // Fallback: round-robin
            finalAssignedTo = await getAssignedVendorByBrand(marca);
          }
        } catch (assignError) {
          console.error('Error en asignación:', assignError);
          return res.status(500).json({ error: 'Error al asignar vendedor' });
        }
      }
    }

    // Asignación directa (sin sistema de aceptación)
    const assignedTo = finalAssignedTo;
    console.log(`📅 Lead asignado directamente a vendedor ${assignedTo || 'ninguno'}`);

    // Anti-duplicado: verificar si ya existe un lead con este teléfono en los últimos 5 minutos
    const cleanTel = telefono.replace(/\D/g, '').slice(-10);
    const [recentDuplicates] = await pool.execute(
      `SELECT id, nombre, created_at FROM leads 
       WHERE REPLACE(REPLACE(REPLACE(telefono, '+', ''), '-', ''), ' ', '') LIKE ? 
       AND created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
       LIMIT 1`,
      [`%${cleanTel}`]
    );

    if (recentDuplicates.length > 0) {
      console.log(`⚠️ Lead duplicado detectado: tel ${telefono} ya existe como lead #${recentDuplicates[0].id} (creado ${recentDuplicates[0].created_at})`);
      return res.status(409).json({
        error: 'Lead duplicado',
        message: `Ya existe un lead con este teléfono creado hace menos de 5 minutos (Lead #${recentDuplicates[0].id}: ${recentDuplicates[0].nombre})`,
        existingLeadId: recentDuplicates[0].id
      });
    }

    // Crear el lead con asignación directa
    const [result] = await pool.execute(`
      INSERT INTO leads (
        nombre, telefono, modelo, marca, formaPago, estado, fuente, notas, 
        assigned_to, infoUsado, entrega, fecha, created_at, created_by,
        pending_acceptance, assigned_at
      ) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, FALSE, ${assignedTo ? 'NOW()' : 'NULL'})
    `, [
      nombre, telefono, modelo, marca, formaPago, estado, fuente, notas,
      assignedTo, infoUsado, entrega, fecha, req.user.id
    ]);

    const leadId = result.insertId;
    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [leadId]);
    const lead = rows[0];

    // Notificar al vendedor asignado
    if (assignedTo && io) {
      const sockets = require('../socket-server');
      if (sockets && sockets.emitToUser) {
        sockets.emitToUser(io, assignedTo, 'notification', {
          type: 'lead_assigned',
          title: '🔔 NUEVO LEAD ASIGNADO',
          message: `Se te asignó un nuevo lead: ${nombre}`,
          leadId: lead.id,
          sound: true,
          timestamp: new Date().toISOString()
        });

        io.emit('lead:assigned', {
          lead: lead,
          vendedorId: assignedTo,
          timestamp: new Date().toISOString()
        });
      }
    }

    console.log('✅ Lead creado:', leadId, assignedTo ? `(asignado a ${assignedTo})` : '(sin asignar)');
    await logLeadHistory(leadId, 'creacion', null, null, 'Lead creado', req.user?.id, req.user?.name || 'Sistema');

    res.json({ ok: true, lead: mapLead(lead) });
  } catch (error) {
    console.error('❌ Error POST /leads:', error);
    res.status(500).json({ error: 'Error al crear lead', message: error.message });
  }
});

// ============================================
// POST Aceptar lead
// ============================================
router.post('/:id/accept', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const io = req.app.get('io');

    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const lead = rows[0];

    // Verificar que el lead está ofrecido a este usuario
    if (lead.current_offer_to !== userId) {
      return res.status(403).json({ error: 'Este lead no está disponible para vos' });
    }

    // Verificar que no expiró
    if (lead.acceptance_expires_at && new Date(lead.acceptance_expires_at) < new Date()) {
      return res.status(400).json({ error: 'La oferta expiró' });
    }

    // Aceptar el lead
    await pool.execute(`
      UPDATE leads 
      SET pending_acceptance = FALSE,
          current_offer_to = NULL,
          acceptance_expires_at = NULL,
          assigned_to = ?,
          accepted_at = NOW()
      WHERE id = ?
    `, [userId, id]);

    // Registrar en log
    try {
      await pool.execute(`
        INSERT INTO lead_acceptance_log (lead_id, user_id, action)
        VALUES (?, ?, 'accepted')
      `, [id, userId]);
    } catch (e) {
      // Ignorar si la tabla no existe
    }

    const [updatedRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);
    const updatedLead = updatedRows[0];

    // Notificar a todos
    if (io) {
      io.emit('lead:assigned', {
        lead: updatedLead,
        vendedorId: userId,
        timestamp: new Date().toISOString()
      });
      io.emit('lead:changed', updatedLead);
    }

    console.log(`✅ Lead ${id} aceptado por vendedor ${userId}`);

    res.json({
      ok: true,
      lead: mapLead(updatedLead),
      message: '✅ Lead aceptado! Ya podés ver los datos del cliente.'
    });

  } catch (error) {
    console.error('Error aceptando lead:', error);
    res.status(500).json({ error: 'Error al aceptar lead' });
  }
});

// ============================================
// POST Rechazar lead
// ============================================
router.post('/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const io = req.app.get('io');

    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const lead = rows[0];

    if (lead.current_offer_to !== userId) {
      return res.status(403).json({ error: 'Este lead no está disponible para vos' });
    }

    // Registrar rechazo
    try {
      await pool.execute(`
        INSERT INTO lead_acceptance_log (lead_id, user_id, action)
        VALUES (?, ?, 'rejected')
      `, [id, userId]);
    } catch (e) {
      // Ignorar
    }

    // Obtener intentos anteriores
    let attempts = [];
    try {
      attempts = lead.acceptance_attempts ? JSON.parse(lead.acceptance_attempts) : [];
    } catch (e) {
      attempts = [];
    }

    if (!attempts.includes(userId)) {
      attempts.push(userId);
    }

    // Buscar siguiente vendedor del equipo
    const [[currentUser]] = await pool.execute(
      'SELECT reportsTo FROM users WHERE id = ?',
      [userId]
    );

    const supervisorId = currentUser?.reportsTo;

    let teamVendors = [];
    if (supervisorId) {
      const [vendors] = await pool.execute(`
        SELECT id, name FROM users 
        WHERE role = 'vendedor' AND active = TRUE AND reportsTo = ?
        ORDER BY id
      `, [supervisorId]);
      teamVendors = vendors;
    }

    if (teamVendors.length === 0) {
      const [vendors] = await pool.execute(`
        SELECT id, name FROM users 
        WHERE role = 'vendedor' AND active = TRUE
        ORDER BY id
      `);
      teamVendors = vendors;
    }

    const availableVendors = teamVendors.filter(v => !attempts.includes(v.id));

    let nextVendor = null;
    if (availableVendors.length > 0) {
      nextVendor = availableVendors[0];
    } else if (teamVendors.length > 0) {
      // Todos rechazaron, volver al primero
      attempts = [];
      nextVendor = teamVendors[0];
    }

    if (nextVendor) {
      const newExpires = new Date(Date.now() + 10 * 60 * 1000);

      await pool.execute(`
        UPDATE leads 
        SET acceptance_attempts = ?,
            current_offer_to = ?,
            acceptance_expires_at = ?
        WHERE id = ?
      `, [JSON.stringify(attempts), nextVendor.id, newExpires, id]);

      // Notificar al siguiente vendedor
      if (io) {
        const sockets = require('../socket-server');
        if (sockets && sockets.emitToUser) {
          sockets.emitToUser(io, nextVendor.id, 'lead:offer', {
            leadId: lead.id,
            expiresAt: newExpires.toISOString(),
            timeoutMinutes: 10,
            message: '🔔 NUEVO LEAD DISPONIBLE',
            timestamp: new Date().toISOString()
          });

          sockets.emitToUser(io, nextVendor.id, 'notification', {
            type: 'lead_offer',
            title: '🔔 NUEVO LEAD DISPONIBLE',
            message: 'Tenés 10 minutos para aceptar',
            leadId: lead.id,
            requiresAction: true,
            sound: true,
            timestamp: new Date().toISOString()
          });
        }
      }

      console.log(`➡️ Lead ${id} pasado a vendedor ${nextVendor.id}`);
    }

    res.json({ ok: true, message: 'Lead rechazado, pasando al siguiente vendedor' });

  } catch (error) {
    console.error('Error rechazando lead:', error);
    res.status(500).json({ error: 'Error al rechazar lead' });
  }
});

// ============================================
// GET Ofertas pendientes para el usuario actual
// ============================================
router.get('/pending-offers/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.execute(`
      SELECT id, acceptance_expires_at 
      FROM leads 
      WHERE current_offer_to = ? 
        AND pending_acceptance = TRUE
        AND acceptance_expires_at > NOW()
    `, [userId]);

    res.json({
      ok: true,
      offers: rows.map(r => ({
        leadId: r.id,
        expiresAt: r.acceptance_expires_at
      }))
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener ofertas' });
  }
});

// PUT actualizar lead
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    console.log(`📝 PUT /leads/${id} - Usuario: ${req.user.id} (${req.user.role})`);
    console.log(`📝 Updates recibidos:`, JSON.stringify(updates));

    const [currentLead] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);

    if (currentLead.length === 0) {
      console.log(`❌ Lead ${id} no encontrado`);
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const leadActual = currentLead[0];
    console.log(`📋 Estado actual del lead: ${leadActual.estado}`);

    // Validar estados protegidos
    if (updates.estado && updates.estado !== leadActual.estado) {
      const validacion = validarCambioEstadoLead(
        leadActual.estado,
        updates.estado,
        req.user.role,
        false
      );

      if (!validacion.permitido) {
        return res.status(403).json({ error: validacion.error });
      }
    }

    if (ESTADOS_PROTEGIDOS.includes(leadActual.estado) && !['owner', 'gerente', 'director'].includes(req.user.role)) {
      return res.status(403).json({
        error: `Este lead está en estado "${leadActual.estado}" y no puede ser modificado.`
      });
    }

    const allowedFields = [
      'nombre', 'telefono', 'modelo', 'marca', 'formaPago', 'estado',
      'fuente', 'notas', 'assigned_to', 'vendedor', 'infoUsado', 'entrega', 'fecha'
    ];

    if (updates.marca && !updates.vendedor && !updates.assigned_to) {
      try {
        const autoVendor = await getAssignedVendorByBrand(updates.marca);
        if (autoVendor) {
          updates.assigned_to = autoVendor;
        }
      } catch (error) {
        console.error('Error en auto-asignación:', error);
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'vendedor') ||
      Object.prototype.hasOwnProperty.call(updates, 'assigned_to')) {

      const newVendorId = updates.vendedor || updates.assigned_to;

      if (newVendorId !== null && newVendorId !== undefined) {
        const hasPermission = await canAssignToVendor(req.user.id, req.user.role, newVendorId);

        if (!hasPermission) {
          return res.status(403).json({ error: 'No tenés permisos para asignar a este vendedor' });
        }
      }
    }

    const setClause = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (!allowedFields.includes(key)) continue;

      if (key === 'marca' && value !== 'fiat') {
        return res.status(400).json({ error: 'Marca inválida' });
      }

      const fieldName = key === 'vendedor' ? 'assigned_to' : key;
      setClause.push(`${fieldName} = ?`);
      values.push(value === undefined ? null : value);
    }

    if (setClause.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    values.push(id);

    // Log changes to history
    const [beforeRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);
    const beforeLead = beforeRows[0];

    await pool.execute(
      `UPDATE leads SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);
    const afterLead = rows[0];

    const trackFields = ['nombre', 'telefono', 'modelo', 'marca', 'formaPago', 'estado', 'fuente', 'notas', 'assigned_to'];
    for (const field of trackFields) {
      if (String(beforeLead[field] || '') !== String(afterLead[field] || '')) {
        let oldVal = beforeLead[field];
        let newVal = afterLead[field];
        if (field === 'assigned_to' && (oldVal || newVal)) {
          try {
            if (oldVal) { const [u] = await pool.execute('SELECT name FROM users WHERE id = ?', [oldVal]); oldVal = u[0]?.name || oldVal; }
            if (newVal) { const [u] = await pool.execute('SELECT name FROM users WHERE id = ?', [newVal]); newVal = u[0]?.name || newVal; }
          } catch (e) { }
        }
        await logLeadHistory(id, 'cambio', FIELD_LABELS[field] || field, oldVal, newVal, req.user?.id, req.user?.name || 'Sistema');
      }
    }

    console.log(`✅ Lead ${id} actualizado. Estado: ${afterLead.estado}`);
    res.json({ ok: true, lead: mapLead(afterLead) });
  } catch (error) {
    console.error('❌ Error PUT /leads/:id:', error);
    res.status(500).json({ error: 'Error al actualizar lead' });
  }
});

// POST reactivar lead (solo owner)
router.post('/:id/reactivar', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { role } = req.user;
  const { nuevo_estado, motivo } = req.body;

  if (role !== 'owner') {
    return res.status(403).json({ error: 'Solo el Owner puede reactivar leads rechazados' });
  }

  try {
    const [leads] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);

    if (leads.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const lead = leads[0];

    if (!ESTADOS_PROTEGIDOS.includes(lead.estado)) {
      return res.status(400).json({ error: 'Este lead no está en estado rechazado' });
    }

    if (!nuevo_estado) {
      return res.status(400).json({ error: 'Debe especificar el nuevo estado' });
    }

    if (ESTADOS_PROTEGIDOS.includes(nuevo_estado)) {
      return res.status(400).json({ error: 'No se puede reactivar a un estado de rechazo' });
    }

    const timestamp = new Date().toISOString();
    const notaReactivacion = `\n[${timestamp}] REACTIVADO por Owner desde "${lead.estado}": ${motivo || 'Sin motivo'}`;

    await pool.execute(`
      UPDATE leads 
      SET estado = ?,
          notas = CONCAT(IFNULL(notas, ''), ?),
          updated_at = NOW()
      WHERE id = ?
    `, [nuevo_estado, notaReactivacion, id]);

    const [leadActualizado] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);

    res.json({
      ok: true,
      mensaje: `Lead reactivado a "${nuevo_estado}"`,
      lead: mapLead(leadActualizado[0])
    });

  } catch (error) {
    console.error('Error al reactivar lead:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE eliminar lead
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const [currentLead] = await pool.execute('SELECT estado FROM leads WHERE id = ?', [req.params.id]);

    if (currentLead.length > 0 && ESTADOS_PROTEGIDOS.includes(currentLead[0].estado)) {
      if (req.user.role !== 'owner') {
        return res.status(403).json({
          error: `No se puede eliminar un lead en estado "${currentLead[0].estado}".`
        });
      }
    }

    await pool.execute('DELETE FROM leads WHERE id = ?', [req.params.id]);
    res.json({ ok: true, message: 'Lead eliminado' });
  } catch (error) {
    console.error('Error DELETE /leads/:id:', error);
    res.status(500).json({ error: 'Error al eliminar lead' });
  }
});

// GET historial de un lead
router.get('/:id/history', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM lead_history WHERE lead_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ ok: true, history: rows });
  } catch (error) {
    console.error('Error GET history:', error);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

module.exports = router;
