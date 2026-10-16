/**
 * ============================================
 * AUTH MIDDLEWARE
 * ============================================
 * Middleware para autenticar y autorizar usuarios.
 * Obtiene el rol actualizado de la base de datos en cada request
 * (no confía solo en lo que dice el JWT, por si el rol cambió).
 */

const jwt = require('jsonwebtoken');

/**
 * Middleware para verificar token JWT
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Obtener el rol actualizado de la base de datos
    const pool = req.app.get('db');
    if (pool) {
      try {
        const [users] = await pool.query(
          'SELECT id, email, name, role, active, reportsTo FROM users WHERE id = ? LIMIT 1',
          [decoded.id || decoded.uid]
        );

        if (users.length > 0) {
          const user = users[0];

          if (!user.active) {
            return res.status(403).json({ ok: false, error: 'Usuario desactivado' });
          }

          req.user = {
            id: user.id,
            uid: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            active: user.active,
            reportsTo: user.reportsTo
          };
        } else {
          return res.status(403).json({ ok: false, error: 'Usuario no encontrado' });
        }
      } catch (dbError) {
        console.error('Error consultando usuario en DB:', dbError.message);
        req.user = decoded;
      }
    } else {
      req.user = decoded;
    }

    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(403).json({ ok: false, error: 'Token inválido o expirado' });
  }
};

/**
 * Middleware para verificar roles
 * @param {string[]} allowedRoles - Roles permitidos
 */
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'No autenticado' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        error: 'No tenés permisos para esta acción',
        requiredRoles: allowedRoles,
        yourRole: req.user.role
      });
    }

    next();
  };
};

/**
 * Middleware para verificar que es el owner o tiene rol específico
 */
const requireOwnerOrRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'No autenticado' });
    }

    if (req.user.role === 'owner') {
      return next();
    }

    if (allowedRoles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({
      ok: false,
      error: 'No tenés permisos para esta acción'
    });
  };
};

/**
 * Middleware para verificar que el usuario accede a sus propios recursos
 * o tiene rol de supervisor/gerente/etc
 */
const requireSelfOrSupervisor = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'No autenticado' });
  }

  const targetUserId = parseInt(req.params.userId || req.params.id);

  if (req.user.id === targetUserId) {
    return next();
  }

  const supervisorRoles = ['owner', 'director', 'gerente', 'supervisor'];
  if (supervisorRoles.includes(req.user.role)) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    error: 'Solo podés acceder a tus propios recursos'
  });
};

module.exports = {
  authenticateToken,
  requireRole,
  requireOwnerOrRole,
  requireSelfOrSupervisor
};
