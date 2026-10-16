/**
 * ============================================
 * SOCKET SERVER v2 - SISTEMA DE ACEPTACIÓN
 * ============================================
 * NUEVO FLUJO:
 * - Lead nuevo → Vendedor recibe oferta (no ve datos)
 * - 10 min para aceptar → Si no acepta, pasa al siguiente
 * - Solo en horario laboral (9:30 - 19:30)
 * - Si todos rechazan, vuelve al primero
 */

const { Server } = require('socket.io');

// Almacenamiento en memoria
const connectedUsers = new Map();
const userSessions = new Map();
const activityLog = [];

// Configuración
const ACCEPTANCE_TIMEOUT_MINUTES = 10;
const WORK_HOURS = {
  start: { hour: 9, minute: 30 },
  end: { hour: 19, minute: 30 }
};

/**
 * Verifica si estamos en horario laboral
 */
function isWorkingHours() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = WORK_HOURS.start.hour * 60 + WORK_HOURS.start.minute;
  const endMinutes = WORK_HOURS.end.hour * 60 + WORK_HOURS.end.minute;
  
  // También verificar que sea día de semana (1-5 = Lun-Vie)
  const dayOfWeek = now.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  
  return isWeekday && currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

/**
 * Inicializa el servidor de WebSockets
 */
function initSocketServer(httpServer, pool) {
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Middleware de autenticación
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Autenticación requerida'));
      }
      
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      socket.userId = decoded.id || decoded.userId;
      socket.userName = decoded.name;
      socket.userRole = decoded.role;
      
      next();
    } catch (err) {
      console.error('Socket auth error:', err.message);
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, userName, userRole } = socket;
    console.log(`✅ Usuario conectado: ${userName} (ID: ${userId}, Role: ${userRole})`);

    handleUserConnect(socket, io, pool);

    // ===== EVENTOS DE LEADS =====
    
    socket.on('lead:created', (lead) => {
      console.log(`📥 Nuevo lead creado: ${lead.nombre}`);
      socket.broadcast.emit('lead:created', lead);
    });

    socket.on('lead:updated', (lead) => {
      console.log(`📝 Lead actualizado: ${lead.nombre} (ID: ${lead.id})`);
      socket.broadcast.emit('lead:updated', lead);
    });

    socket.on('lead:deleted', (leadId) => {
      console.log(`🗑️ Lead eliminado: ID ${leadId}`);
      socket.broadcast.emit('lead:deleted', leadId);
    });

    // ===== NUEVO: ACEPTAR LEAD =====
    socket.on('lead:accept', async ({ leadId }) => {
      console.log(`✅ Usuario ${userId} aceptó lead ${leadId}`);
      await handleLeadAcceptance(io, pool, leadId, userId, 'accepted');
    });

    // ===== NUEVO: RECHAZAR LEAD =====
    socket.on('lead:reject', async ({ leadId }) => {
      console.log(`❌ Usuario ${userId} rechazó lead ${leadId}`);
      await handleLeadAcceptance(io, pool, leadId, userId, 'rejected');
    });

    // ===== EVENTOS DE PRESENCIA =====
    
    socket.on('presence:heartbeat', () => {
      updateUserActivity(userId);
    });

    socket.on('presence:active', () => {
      updateUserPresence(socket, io, 'active');
    });

    socket.on('presence:idle', () => {
      updateUserPresence(socket, io, 'idle');
    });

    // ===== EVENTOS DE ALERTAS =====
    
    socket.on('alert:send', ({ targetUserId, alert }) => {
      emitToUser(io, targetUserId, 'alert:received', alert);
    });

    socket.on('alert:broadcast', (alert) => {
      io.emit('alert:received', alert);
    });

    // ===== DESCONEXIÓN =====
    
    socket.on('disconnect', (reason) => {
      console.log(`❌ Usuario desconectado: ${userName} (Razón: ${reason})`);
      handleUserDisconnect(socket, io, pool);
    });
  });

  // Iniciar el checker de timeouts de aceptación
  startAcceptanceChecker(io, pool);

  return io;
}

// ============================================
// SISTEMA DE ACEPTACIÓN DE LEADS
// ============================================

/**
 * Ofrece un lead a un vendedor específico
 */
async function offerLeadToVendor(io, pool, lead, vendorId) {
  const expiresAt = new Date(Date.now() + ACCEPTANCE_TIMEOUT_MINUTES * 60 * 1000);
  
  // Actualizar lead con la oferta
  await pool.execute(`
    UPDATE leads 
    SET pending_acceptance = TRUE,
        current_offer_to = ?,
        acceptance_expires_at = ?
    WHERE id = ?
  `, [vendorId, expiresAt, lead.id]);

  // Registrar en log
  try {
    await pool.execute(`
      INSERT INTO lead_acceptance_log (lead_id, user_id, action)
      VALUES (?, ?, 'offered')
    `, [lead.id, vendorId]);
  } catch (e) {
    console.log('lead_acceptance_log table might not exist yet');
  }

  // Enviar notificación al vendedor
  emitToUser(io, vendorId, 'lead:offer', {
    leadId: lead.id,
    expiresAt: expiresAt.toISOString(),
    timeoutMinutes: ACCEPTANCE_TIMEOUT_MINUTES,
    message: '🔔 NUEVO LEAD DISPONIBLE',
    timestamp: new Date().toISOString()
  });

  // También enviar notificación push
  emitToUser(io, vendorId, 'notification', {
    type: 'lead_offer',
    title: '🔔 NUEVO LEAD DISPONIBLE',
    message: `Tenés ${ACCEPTANCE_TIMEOUT_MINUTES} minutos para aceptar`,
    leadId: lead.id,
    expiresAt: expiresAt.toISOString(),
    requiresAction: true,
    sound: true,
    timestamp: new Date().toISOString()
  });

  console.log(`📨 Lead ${lead.id} ofrecido a vendedor ${vendorId}, expira en ${ACCEPTANCE_TIMEOUT_MINUTES} min`);
}

/**
 * Maneja la aceptación o rechazo de un lead
 */
async function handleLeadAcceptance(io, pool, leadId, userId, action) {
  try {
    // Obtener el lead
    const [[lead]] = await pool.execute('SELECT * FROM leads WHERE id = ?', [leadId]);
    
    if (!lead) {
      console.log(`Lead ${leadId} no encontrado`);
      return;
    }

    // Verificar que el lead estaba ofrecido a este usuario
    if (lead.current_offer_to !== userId) {
      console.log(`Lead ${leadId} no estaba ofrecido al usuario ${userId}`);
      emitToUser(io, userId, 'lead:offer_expired', {
        leadId,
        message: 'Esta oferta ya no está disponible'
      });
      return;
    }

    // Registrar la acción
    try {
      await pool.execute(`
        INSERT INTO lead_acceptance_log (lead_id, user_id, action)
        VALUES (?, ?, ?)
      `, [leadId, userId, action]);
    } catch (e) {
      // Ignorar si la tabla no existe
    }

    if (action === 'accepted') {
      // ✅ Lead aceptado - asignar al vendedor
      await pool.execute(`
        UPDATE leads 
        SET pending_acceptance = FALSE,
            current_offer_to = NULL,
            acceptance_expires_at = NULL,
            assigned_to = ?,
            accepted_at = NOW(),
            estado = 'nuevo'
        WHERE id = ?
      `, [userId, leadId]);

      // Notificar al vendedor que ahora puede ver el lead
      emitToUser(io, userId, 'lead:accepted_success', {
        leadId,
        message: '✅ Lead aceptado! Ya podés ver los datos del cliente.'
      });

      // Notificar a todos que el lead fue asignado
      const [[updatedLead]] = await pool.execute(`
        SELECT l.*, u.name as vendedor_nombre
        FROM leads l
        LEFT JOIN users u ON l.assigned_to = u.id
        WHERE l.id = ?
      `, [leadId]);

      io.emit('lead:assigned', {
        lead: updatedLead,
        vendedorId: userId,
        timestamp: new Date().toISOString()
      });

      io.emit('lead:updated', updatedLead);

      console.log(`✅ Lead ${leadId} aceptado por vendedor ${userId}`);

    } else {
      // ❌ Lead rechazado - pasar al siguiente vendedor
      await passLeadToNextVendor(io, pool, lead, userId);
    }

  } catch (error) {
    console.error('Error en handleLeadAcceptance:', error);
  }
}

/**
 * Pasa el lead al siguiente vendedor del equipo
 * FIX: Asegurar que attempts siempre sea un array
 */
async function passLeadToNextVendor(io, pool, lead, currentUserId) {
  try {
    // Obtener intentos anteriores - FIX: asegurar que sea un array
    let attempts = [];
    try {
      if (lead.acceptance_attempts) {
        const parsed = JSON.parse(lead.acceptance_attempts);
        // Asegurar que sea un array
        attempts = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.log('Error parseando acceptance_attempts, usando array vacío');
      attempts = [];
    }
    
    // Agregar el usuario actual a los intentos (si existe y no está ya)
    if (currentUserId && !attempts.includes(currentUserId)) {
      attempts.push(currentUserId);
    }

    // Obtener el supervisor del vendedor actual
    let supervisorId = null;
    if (currentUserId) {
      const [[currentUser]] = await pool.execute(
        'SELECT reportsTo FROM users WHERE id = ?',
        [currentUserId]
      );
      supervisorId = currentUser?.reportsTo;
    }

    // Buscar el siguiente vendedor del mismo equipo
    let teamVendors = [];
    if (supervisorId) {
      const [vendors] = await pool.execute(`
        SELECT id, name 
        FROM users 
        WHERE role = 'vendedor' 
          AND active = TRUE
          AND reportsTo = ?
        ORDER BY id
      `, [supervisorId]);
      teamVendors = vendors;
    }

    // Si no hay vendedores en el equipo, buscar cualquier vendedor activo
    if (teamVendors.length === 0) {
      const [vendors] = await pool.execute(`
        SELECT id, name 
        FROM users 
        WHERE role = 'vendedor' 
          AND active = TRUE
        ORDER BY id
      `);
      teamVendors = vendors;
    }

    // Filtrar vendedores que ya rechazaron
    const availableVendors = teamVendors.filter(v => !attempts.includes(v.id));

    let nextVendor = null;

    if (availableVendors.length > 0) {
      // Hay vendedores que aún no recibieron la oferta
      nextVendor = availableVendors[0];
    } else if (teamVendors.length > 0) {
      // Todos rechazaron, volver al primero
      console.log(`🔄 Todos los vendedores rechazaron lead ${lead.id}, volviendo al primero`);
      attempts = []; // Reset attempts
      nextVendor = teamVendors[0];
    }

    if (nextVendor) {
      // Actualizar attempts en el lead
      await pool.execute(`
        UPDATE leads 
        SET acceptance_attempts = ?,
            current_offer_to = NULL,
            acceptance_expires_at = NULL
        WHERE id = ?
      `, [JSON.stringify(attempts), lead.id]);

      // Ofrecer al siguiente vendedor
      const [[updatedLead]] = await pool.execute('SELECT * FROM leads WHERE id = ?', [lead.id]);
      await offerLeadToVendor(io, pool, updatedLead, nextVendor.id);

      console.log(`➡️ Lead ${lead.id} pasado a vendedor ${nextVendor.id} (${nextVendor.name})`);
    } else {
      // No hay vendedores disponibles
      console.log(`⚠️ No hay vendedores disponibles para lead ${lead.id}`);
      
      // Asignar directo al primero que se encuentre
      const [[anyVendor]] = await pool.execute(`
        SELECT id FROM users WHERE role = 'vendedor' AND active = TRUE LIMIT 1
      `);
      
      if (anyVendor) {
        await pool.execute(`
          UPDATE leads 
          SET pending_acceptance = FALSE,
              current_offer_to = NULL,
              acceptance_expires_at = NULL,
              assigned_to = ?
          WHERE id = ?
        `, [anyVendor.id, lead.id]);
      }
    }

  } catch (error) {
    console.error('Error en passLeadToNextVendor:', error);
  }
}

/**
 * Checker que corre cada 30 segundos para verificar timeouts
 */
function startAcceptanceChecker(io, pool) {
  console.log(`⏰ Checker de aceptación iniciado (timeout: ${ACCEPTANCE_TIMEOUT_MINUTES} min)`);
  
  setInterval(async () => {
    if (!pool) return;
    
    try {
      // Buscar leads con ofertas expiradas
      const [expiredOffers] = await pool.execute(`
        SELECT l.*, u.name as current_vendor_name
        FROM leads l
        LEFT JOIN users u ON l.current_offer_to = u.id
        WHERE l.pending_acceptance = TRUE
          AND l.acceptance_expires_at IS NOT NULL
          AND l.acceptance_expires_at < NOW()
      `);

      for (const lead of expiredOffers) {
        console.log(`⏰ Timeout para lead ${lead.id} (ofrecido a ${lead.current_vendor_name})`);
        
        // Registrar timeout
        try {
          await pool.execute(`
            INSERT INTO lead_acceptance_log (lead_id, user_id, action)
            VALUES (?, ?, 'timeout')
          `, [lead.id, lead.current_offer_to]);
        } catch (e) {
          // Ignorar
        }

        // Notificar al vendedor que perdió la oportunidad
        if (lead.current_offer_to) {
          emitToUser(io, lead.current_offer_to, 'lead:offer_expired', {
            leadId: lead.id,
            message: '⏰ Se acabó el tiempo para aceptar este lead'
          });
        }

        // Pasar al siguiente vendedor
        await passLeadToNextVendor(io, pool, lead, lead.current_offer_to);
      }
    } catch (err) {
      // Silenciar errores si las columnas no existen aún
      if (!err.message.includes('Unknown column')) {
        console.error('Error en acceptance checker:', err);
      }
    }
  }, 30000); // Cada 30 segundos
}

// ============================================
// FUNCIÓN PARA INICIAR OFERTA DE LEAD
// ============================================

/**
 * Inicia el proceso de oferta para un lead nuevo
 * Llamar desde leads.js cuando se crea un lead
 */
async function initiateLeadOffer(io, pool, lead, vendorId) {
  // Solo en horario laboral
  if (!isWorkingHours()) {
    console.log(`📅 Fuera de horario laboral, lead ${lead.id} asignado directamente`);
    return false; // Indica que se debe asignar directo
  }

  // Iniciar oferta
  await offerLeadToVendor(io, pool, lead, vendorId);
  return true; // Indica que se inició el proceso de aceptación
}

// ============================================
// FUNCIONES DE PRESENCIA
// ============================================

async function handleUserConnect(socket, io, pool) {
  const { userId, userName, userRole } = socket;
  const now = new Date();

  connectedUsers.set(socket.id, {
    odUserId: userId,
    odUserName: userName,
    role: userRole,
    connectedAt: now,
    lastActivity: now,
    status: 'active'
  });

  if (!userSessions.has(userId)) {
    userSessions.set(userId, new Set());
  }
  userSessions.get(userId).add(socket.id);

  await logSessionStart(pool, userId);

  logActivity(userId, 'connected', { socketId: socket.id });

  socket.broadcast.emit('presence:user_online', {
    odUserId: userId,
    odUserName: userName,
    role: userRole,
    status: 'active',
    connectedAt: now.toISOString()
  });

  socket.emit('presence:users_list', getOnlineUsers());

  // Emit users:online for useRealtime compatibility
  const onlineIds = Array.from(userSessions.keys());
  io.emit('users:online', onlineIds);

  // Verificar si hay leads pendientes de aceptación para este usuario
  if (pool) {
    try {
      const [[pendingOffer]] = await pool.execute(`
        SELECT id, acceptance_expires_at 
        FROM leads 
        WHERE current_offer_to = ? 
          AND pending_acceptance = TRUE
          AND acceptance_expires_at > NOW()
        LIMIT 1
      `, [userId]);

      if (pendingOffer) {
        socket.emit('lead:offer', {
          leadId: pendingOffer.id,
          expiresAt: pendingOffer.acceptance_expires_at,
          message: '🔔 NUEVO LEAD DISPONIBLE',
          timeoutMinutes: ACCEPTANCE_TIMEOUT_MINUTES,
          timestamp: new Date().toISOString()
        });
      }
    } catch (err) {
      // Silenciar si las columnas no existen
    }
  }
}

async function handleUserDisconnect(socket, io, pool) {
  const { userId, userName } = socket;
  const userData = connectedUsers.get(socket.id);

  connectedUsers.delete(socket.id);

  if (userSessions.has(userId)) {
    userSessions.get(userId).delete(socket.id);
    
    if (userSessions.get(userId).size === 0) {
      userSessions.delete(userId);
      
      if (userData) {
        await logSessionEnd(pool, userId, userData.connectedAt);
      }

      io.emit('presence:user_offline', {
        odUserId: userId,
        odUserName: userName,
        disconnectedAt: new Date().toISOString()
      });

      // Emit users:online for useRealtime compatibility
      const onlineIds = Array.from(userSessions.keys());
      io.emit('users:online', onlineIds);

      logActivity(userId, 'disconnected', {});
    }
  }
}

function updateUserPresence(socket, io, status) {
  const userData = connectedUsers.get(socket.id);
  if (userData) {
    userData.status = status;
    userData.lastActivity = new Date();
    
    io.emit('presence:user_status_changed', {
      odUserId: socket.userId,
      status: status,
      lastActivity: userData.lastActivity.toISOString()
    });
  }
}

function updateUserActivity(userId) {
  userSessions.get(userId)?.forEach(socketId => {
    const userData = connectedUsers.get(socketId);
    if (userData) {
      userData.lastActivity = new Date();
    }
  });
}

function getOnlineUsers() {
  const users = new Map();
  
  connectedUsers.forEach((data, socketId) => {
    if (!users.has(data.odUserId) || users.get(data.odUserId).lastActivity < data.lastActivity) {
      users.set(data.odUserId, {
        odUserId: data.odUserId,
        odUserName: data.odUserName,
        role: data.role,
        status: data.status,
        connectedAt: data.connectedAt.toISOString(),
        lastActivity: data.lastActivity.toISOString(),
        sessionsCount: userSessions.get(data.odUserId)?.size || 1
      });
    }
  });

  return Array.from(users.values());
}

// ============================================
// FUNCIONES DE ACTIVIDAD Y REPORTES
// ============================================

function logActivity(userId, action, data) {
  activityLog.push({
    userId,
    action,
    data,
    timestamp: new Date()
  });

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  while (activityLog.length > 0 && activityLog[0].timestamp < oneDayAgo) {
    activityLog.shift();
  }
}

async function logSessionStart(pool, userId) {
  if (!pool) return;
  
  try {
    await pool.execute(`
      INSERT INTO user_sessions (user_id, session_start, date)
      VALUES (?, NOW(), CURDATE())
    `, [userId]);
  } catch (err) {
    // Ignorar si la tabla no existe
  }
}

async function logSessionEnd(pool, userId, connectedAt) {
  if (!pool) return;
  
  try {
    const durationMinutes = Math.round((Date.now() - connectedAt.getTime()) / 60000);
    
    await pool.execute(`
      UPDATE user_sessions 
      SET session_end = NOW(),
          duration_minutes = ?
      WHERE user_id = ? 
        AND session_end IS NULL
        AND date = CURDATE()
      ORDER BY session_start DESC
      LIMIT 1
    `, [durationMinutes, userId]);
  } catch (err) {
    // Ignorar
  }
}

// ============================================
// UTILIDADES
// ============================================

function emitToUser(io, userId, event, data) {
  const sockets = userSessions.get(userId);
  if (sockets) {
    sockets.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  initSocketServer,
  getOnlineUsers,
  emitToUser,
  initiateLeadOffer,
  isWorkingHours,
  ACCEPTANCE_TIMEOUT_MINUTES
};