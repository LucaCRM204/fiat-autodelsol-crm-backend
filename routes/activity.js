/**
 * ============================================
 * ACTIVITY ROUTES - Reportes de Actividad (MySQL)
 * ============================================
 */

const express = require('express');
const router = express.Router();

// Middleware de autenticación (importa el tuyo o usa este básico)
const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ ok: false, error: 'Token inválido' });
  }
};

const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'No autenticado' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Sin permisos' });
    }
    next();
  };
};

/**
 * GET /api/activity/online
 * Obtener usuarios actualmente online
 */
router.get('/online', authenticateToken, requireRole(['owner', 'director', 'gerente', 'supervisor']), async (req, res) => {
  try {
    const { getOnlineUsers } = require('../socket-server');
    const onlineUsers = getOnlineUsers();
    
    res.json({ 
      ok: true, 
      users: onlineUsers,
      count: onlineUsers.length 
    });
  } catch (error) {
    console.error('Error getting online users:', error);
    res.status(500).json({ ok: false, error: 'Error al obtener usuarios online' });
  }
});

/**
 * GET /api/activity/report/:userId
 * Obtener reporte de actividad de un usuario
 */
router.get('/report/:userId', authenticateToken, requireRole(['owner', 'director', 'gerente']), async (req, res) => {
  try {
    const { userId } = req.params;
    const { period = 'day', date } = req.query;
    const pool = req.app.get('db');

    const targetDate = date || new Date().toISOString().split('T')[0];

    let dateCondition = '';
    let params = [userId];

    switch (period) {
      case 'day':
        dateCondition = 'AND date = ?';
        params.push(targetDate);
        break;
      case 'week':
        dateCondition = 'AND date >= DATE_SUB(?, INTERVAL 7 DAY) AND date <= ?';
        params.push(targetDate, targetDate);
        break;
      case 'month':
        dateCondition = 'AND date >= DATE_SUB(?, INTERVAL 30 DAY) AND date <= ?';
        params.push(targetDate, targetDate);
        break;
    }

    // Obtener sesiones
    const [sessions] = await pool.execute(`
      SELECT 
        id,
        date,
        session_start,
        session_end,
        duration_minutes
      FROM user_sessions
      WHERE user_id = ?
        ${dateCondition}
      ORDER BY session_start DESC
    `, params);

    // Calcular totales
    const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
    const totalHours = Math.round(totalMinutes / 60 * 10) / 10;
    const sessionCount = sessions.length;
    const avgSessionMinutes = sessionCount > 0 ? Math.round(totalMinutes / sessionCount) : 0;

    // Agrupar por día si es semana o mes
    let dailyBreakdown = [];
    if (period !== 'day') {
      const [breakdown] = await pool.execute(`
        SELECT 
          date,
          COUNT(*) as sessions,
          SUM(duration_minutes) as total_minutes,
          MIN(session_start) as first_login,
          MAX(session_end) as last_logout
        FROM user_sessions
        WHERE user_id = ?
          ${dateCondition}
        GROUP BY date
        ORDER BY date DESC
      `, params);
      dailyBreakdown = breakdown;
    }

    // Obtener info del usuario
    const [[user]] = await pool.execute('SELECT id, name, role FROM users WHERE id = ?', [userId]);

    res.json({
      ok: true,
      report: {
        user,
        period,
        dateRange: {
          from: period === 'day' ? targetDate : new Date(new Date(targetDate).getTime() - (period === 'week' ? 7 : 30) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          to: targetDate
        },
        summary: {
          totalHours,
          totalMinutes,
          sessionCount,
          avgSessionMinutes,
        },
        sessions: period === 'day' ? sessions : [],
        dailyBreakdown,
      }
    });
  } catch (error) {
    console.error('Error generating activity report:', error);
    res.status(500).json({ ok: false, error: 'Error al generar reporte' });
  }
});

/**
 * GET /api/activity/team-report
 * Obtener reporte de todo el equipo
 */
router.get('/team-report', authenticateToken, requireRole(['owner', 'director', 'gerente']), async (req, res) => {
  try {
    const { period = 'day', date } = req.query;
    const pool = req.app.get('db');
    const currentUser = req.user;

    const targetDate = date || new Date().toISOString().split('T')[0];

    let dateCondition = '';
    let dateParams = [];

    switch (period) {
      case 'day':
        dateCondition = 'AND s.date = ?';
        dateParams = [targetDate];
        break;
      case 'week':
        dateCondition = 'AND s.date >= DATE_SUB(?, INTERVAL 7 DAY) AND s.date <= ?';
        dateParams = [targetDate, targetDate];
        break;
      case 'month':
        dateCondition = 'AND s.date >= DATE_SUB(?, INTERVAL 30 DAY) AND s.date <= ?';
        dateParams = [targetDate, targetDate];
        break;
    }

    // Filtrar según rol del usuario que solicita
    let userCondition = '';
    let userParams = [];

    if (currentUser.role !== 'owner') {
      userCondition = 'AND (u.id = ? OR u.reportsTo = ?)';
      userParams = [currentUser.id, currentUser.id];
    }

    const [teamReport] = await pool.execute(`
      SELECT 
        u.id as user_id,
        u.name,
        u.role,
        COUNT(DISTINCT s.id) as session_count,
        COALESCE(SUM(s.duration_minutes), 0) as total_minutes,
        MIN(s.session_start) as first_login,
        MAX(s.session_end) as last_logout
      FROM users u
      LEFT JOIN user_sessions s ON u.id = s.user_id ${dateCondition}
      WHERE u.active = 1
        ${userCondition}
      GROUP BY u.id
      ORDER BY total_minutes DESC
    `, [...dateParams, ...userParams]);

    // Calcular estadísticas globales
    const totalTeamMinutes = teamReport.reduce((sum, r) => sum + r.total_minutes, 0);
    const activeUsers = teamReport.filter(r => r.total_minutes > 0).length;

    res.json({
      ok: true,
      report: {
        period,
        dateRange: {
          from: period === 'day' ? targetDate : new Date(new Date(targetDate).getTime() - (period === 'week' ? 7 : 30) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          to: targetDate
        },
        summary: {
          totalTeamHours: Math.round(totalTeamMinutes / 60 * 10) / 10,
          activeUsers,
          totalUsers: teamReport.length,
        },
        users: teamReport.map(r => ({
          ...r,
          total_hours: Math.round(r.total_minutes / 60 * 10) / 10,
        })),
      }
    });
  } catch (error) {
    console.error('Error generating team report:', error);
    res.status(500).json({ ok: false, error: 'Error al generar reporte del equipo' });
  }
});

/**
 * GET /api/activity/lead-response-times
 * Tiempos de respuesta a leads por vendedor
 */
router.get('/lead-response-times', authenticateToken, requireRole(['owner', 'director', 'gerente']), async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    const pool = req.app.get('db');

    let dateCondition = '';
    switch (period) {
      case 'day':
        dateCondition = "AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)";
        break;
      case 'week':
        dateCondition = "AND l.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)";
        break;
      case 'month':
        dateCondition = "AND l.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)";
        break;
    }

    const [responseTimes] = await pool.execute(`
      SELECT 
        u.id as user_id,
        u.name,
        COUNT(l.id) as leads_received,
        SUM(CASE WHEN l.accepted_at IS NOT NULL THEN 1 ELSE 0 END) as leads_accepted,
        AVG(
          CASE 
            WHEN l.accepted_at IS NOT NULL 
            THEN TIMESTAMPDIFF(MINUTE, l.assigned_at, l.accepted_at) 
            ELSE NULL 
          END
        ) as avg_response_minutes,
        SUM(CASE WHEN l.accepted_at IS NULL AND l.estado = 'nuevo' THEN 1 ELSE 0 END) as pending_leads
      FROM users u
      LEFT JOIN leads l ON l.assigned_to = u.id ${dateCondition}
      WHERE u.role = 'vendedor' AND u.active = 1
      GROUP BY u.id
      ORDER BY avg_response_minutes ASC
    `);

    // Contar reasignaciones
    const intervalMap = { day: '1 DAY', week: '7 DAY', month: '30 DAY' };
    const [reassignments] = await pool.execute(`
      SELECT 
        from_user_id,
        COUNT(*) as count
      FROM lead_reassignment_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${intervalMap[period]})
      GROUP BY from_user_id
    `);

    const reassignmentMap = new Map(reassignments.map(r => [r.from_user_id, r.count]));

    res.json({
      ok: true,
      data: responseTimes.map(r => ({
        ...r,
        avg_response_minutes: r.avg_response_minutes ? Math.round(r.avg_response_minutes * 10) / 10 : null,
        acceptance_rate: r.leads_received > 0 
          ? Math.round((r.leads_accepted / r.leads_received) * 100) 
          : 0,
        reassignments: reassignmentMap.get(r.user_id) || 0,
      })),
    });
  } catch (error) {
    console.error('Error getting lead response times:', error);
    res.status(500).json({ ok: false, error: 'Error al obtener tiempos de respuesta' });
  }
});

/**
 * GET /api/activity/reassignments
 * Historial de reasignaciones
 */
router.get('/reassignments', authenticateToken, requireRole(['owner', 'director', 'gerente']), async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const pool = req.app.get('db');

    const [reassignments] = await pool.execute(`
      SELECT 
        r.id,
        r.lead_id,
        r.from_user_id,
        r.to_user_id,
        r.reason,
        r.created_at,
        l.nombre as lead_nombre,
        l.telefono as lead_telefono,
        uf.name as from_user_name,
        ut.name as to_user_name
      FROM lead_reassignment_log r
      LEFT JOIN leads l ON r.lead_id = l.id
      LEFT JOIN users uf ON r.from_user_id = uf.id
      LEFT JOIN users ut ON r.to_user_id = ut.id
      ORDER BY r.created_at DESC
      LIMIT ?
    `, [parseInt(limit)]);

    res.json({ ok: true, reassignments });
  } catch (error) {
    console.error('Error getting reassignments:', error);
    res.status(500).json({ ok: false, error: 'Error al obtener reasignaciones' });
  }
});

module.exports = router;
