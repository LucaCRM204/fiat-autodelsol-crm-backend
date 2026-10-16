/**
 * ============================================
 * LEAD DISTRIBUTION ROUTES - v2
 * ============================================
 * REEMPLAZA a routes/distribution.js.
 *
 * Compatibles (mismo contrato que antes, el panel actual no se rompe):
 *   GET  /api/distribution/all       - todas las distribuciones (bulk)
 *   GET  /api/distribution/:supId    - vendedores de un supervisor
 *   PUT  /api/distribution           - actualizar config
 *
 * Nuevos:
 *   GET  /api/distribution/:id/detalle      - con pausados, fijos y contadores
 *   GET  /api/distribution/:id/preview?n=   - cómo caería un lote de N
 *   PUT  /api/distribution/:id/:userId      - cambiar un solo porcentaje
 *   PUT  /api/distribution/:id/:userId/pausa
 *   POST /api/distribution/:id/parejo
 *   POST /api/distribution/:id/sincronizar
 *
 * CAMBIO DE COMPORTAMIENTO en PUT /: antes devolvía 400 si los
 * porcentajes no sumaban 100. Ahora los normaliza. Ese era el bug:
 * al sumar un vendedor la config quedaba imposible de guardar.
 *
 * ⚠️ ANTES ESTAS RUTAS NO TENÍAN AUTH. Ahora sí. Si tu panel actual
 * no manda el header Authorization, va a empezar a recibir 401.
 * Si necesitás deployar sin tocar el frontend todavía, comentá el
 * authenticateToken de los dos GET de compatibilidad y dejalo en los
 * de escritura. Está marcado abajo con [AUTH-COMPAT].
 */

const express = require('express');
const router = express.Router();
const dist = require('../services/distribucion.service');
const pool = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

// Roles que pueden ver y tocar la distribución.
const ROLES_ADMIN = ['owner', 'director', 'gerente', 'supervisor'];
const soloAdmins = requireRole(ROLES_ADMIN);

function emitir(req, evento, payload) {
  try {
    const io = req.app.get('io');
    if (io) io.emit(evento, payload);
  } catch (_) { /* no romper la respuesta por un socket caído */ }
}

/**
 * ¿Este usuario puede administrar el equipo `equipoId`?
 *   owner / director  -> cualquiera
 *   gerente / supervisor -> el suyo, y cualquiera que cuelgue debajo
 *   vendedor -> ninguno
 */
async function puedeAdministrar(user, equipoId) {
  if (!user) return false;
  if (['owner', 'director'].includes(user.role)) return true;
  if (Number(user.id) === Number(equipoId)) return true;
  if (!['gerente', 'supervisor'].includes(user.role)) return false;

  const [rows] = await pool.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM users WHERE id = ?
       UNION ALL
       SELECT u.id FROM users u
         INNER JOIN tree t ON u.reportsTo = t.id
        WHERE u.active = 1
     )
     SELECT 1 FROM tree WHERE id = ? LIMIT 1`,
    [user.id, Number(equipoId)]
  );
  return rows.length > 0;
}

/** Guard para las rutas que reciben :equipoId */
async function guardEquipo(req, res, next) {
  try {
    const equipoId = Number(req.params.equipoId ?? req.params.supervisorId);
    if (!equipoId) return res.status(400).json({ ok: false, error: 'Equipo inválido' });

    if (!(await puedeAdministrar(req.user, equipoId))) {
      return res.status(403).json({ ok: false, error: 'No podés administrar este equipo' });
    }
    req.equipoId = equipoId;
    next();
  } catch (e) {
    console.error('[distribution] guard:', e.message);
    res.status(500).json({ ok: false, error: 'Error verificando permisos' });
  }
}

// ─────────────────────────────────────────────────────────────
// COMPATIBILIDAD — mismos contratos que antes
// ─────────────────────────────────────────────────────────────

// GET /api/distribution/all
// [AUTH-COMPAT] quitá authenticateToken/soloAdmins si el panel viejo
// todavía no manda token.
router.get('/all', authenticateToken, soloAdmins, async (req, res) => {
  try {
    const [vendors] = await pool.query(`
      SELECT u.id, u.name, u.lead_percentage, u.reportsTo AS supervisor_id,
             sup.name AS supervisor_name,
             d.peso, d.pausado, d.fijo, d.asignados_mes
        FROM users u
        JOIN users sup ON u.reportsTo = sup.id
        LEFT JOIN distribucion_pesos d
               ON d.user_id = u.id
              AND d.scope = CONCAT('lider:', u.reportsTo)
              AND d.activo = 1
       WHERE u.role = 'vendedor' AND u.active = 1
       ORDER BY sup.name, u.name
    `);

    const [stats] = await pool.query(`
      SELECT l.assigned_to,
             COUNT(*) AS leads_recibidos,
             SUM(CASE WHEN l.estado = 'vendido' THEN 1 ELSE 0 END) AS ventas
        FROM leads l
       WHERE l.assigned_to IS NOT NULL
         AND l.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY l.assigned_to
    `);
    const statsMap = new Map(stats.map((s) => [s.assigned_to, s]));

    // Un gerente/supervisor solo ve los equipos que cuelgan de él.
    const esGlobal = ['owner', 'director'].includes(req.user.role);

    const groups = new Map();
    for (const v of vendors) {
      if (dist.EXCLUIDOS.has(v.id)) continue;
      if (!groups.has(v.supervisor_id)) {
        groups.set(v.supervisor_id, {
          supervisorId: v.supervisor_id,
          supervisorName: v.supervisor_name,
          vendors: [],
        });
      }
      const st = statsMap.get(v.id);
      // `peso` manda; lead_percentage queda como espejo por compatibilidad.
      const pct = v.peso != null ? Number(v.peso) : Number(v.lead_percentage) || 0;
      groups.get(v.supervisor_id).vendors.push({
        id: v.id,
        name: v.name,
        lead_percentage: pct,
        pausado: !!v.pausado,
        fijo: !!v.fijo,
        asignados_mes: Number(v.asignados_mes) || 0,
        leads_recibidos: st ? Number(st.leads_recibidos) : 0,
        ventas: st ? Number(st.ventas) : 0,
      });
    }

    let equipos = Array.from(groups.values());
    if (!esGlobal) {
      const permitidos = await Promise.all(
        equipos.map((g) => puedeAdministrar(req.user, g.supervisorId))
      );
      equipos = equipos.filter((_, i) => permitidos[i]);
    }

    const teams = equipos.map((g) => {
      const totalLeads = g.vendors.reduce((s, v) => s + v.leads_recibidos, 0);
      return {
        ...g,
        totalLeads,
        vendors: g.vendors.map((v) => ({
          ...v,
          porcentaje_real: totalLeads > 0
            ? Math.round((v.leads_recibidos / totalLeads) * 100)
            : 0,
          porcentaje_target: v.lead_percentage,
        })),
      };
    });

    res.json({ ok: true, teams });
  } catch (err) {
    console.error('[distribution] all:', err.message);
    res.status(500).json({ ok: false, error: 'Error al obtener distribución' });
  }
});

// PUT /api/distribution  { distributions: [{ userId, percentage }] }
router.put('/', authenticateToken, soloAdmins, async (req, res) => {
  try {
    const { distributions } = req.body;
    if (!Array.isArray(distributions) || !distributions.length) {
      return res.status(400).json({ ok: false, error: 'Formato inválido' });
    }

    const [filas] = await pool.query(
      `SELECT id, reportsTo FROM users WHERE id IN (?)`,
      [distributions.map((d) => Number(d.userId))]
    );
    const equipoDe = new Map(filas.map((f) => [f.id, f.reportsTo]));

    // Se valida permiso sobre cada equipo tocado ANTES de escribir nada.
    const equipos = new Set(
      distributions.map((d) => equipoDe.get(Number(d.userId))).filter(Boolean)
    );
    for (const e of equipos) {
      if (!(await puedeAdministrar(req.user, e))) {
        return res.status(403).json({
          ok: false,
          error: `No podés administrar el equipo ${e}`,
        });
      }
    }

    // Ya no se rechaza si no suman 100 — se reescalan.
    for (const d of distributions) {
      const equipoId = equipoDe.get(Number(d.userId));
      if (!equipoId) continue;
      await dist.actualizarPorcentaje(equipoId, Number(d.userId), Number(d.percentage) || 0);
    }

    const resultado = {};
    for (const e of equipos) resultado[e] = await dist.listar(e);
    emitir(req, 'distribucion:updated', { equipos: [...equipos] });

    res.json({ ok: true, message: 'Distribución actualizada', equipos: resultado });
  } catch (err) {
    console.error('[distribution] update:', err.message);
    res.status(500).json({ ok: false, error: 'Error al actualizar distribución' });
  }
});

// ─────────────────────────────────────────────────────────────
// NUEVOS — anidados bajo /:equipoId
// ─────────────────────────────────────────────────────────────

router.get('/:equipoId/detalle', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const cfg = await dist.getConfigEquipo(req.equipoId);
    const vendedores = await dist.listar(req.equipoId);
    const total = vendedores.filter((v) => !v.pausado).reduce((s, v) => s + v.peso, 0);

    // En cascada los miembros son supervisores, no vendedores.
    // El panel usa esto para mostrar el boton "ver equipo".
    const tipo = vendedores.some((v) => v.role && v.role !== 'vendedor')
      ? 'equipos'
      : 'vendedores';

    res.json({
      ok: true,
      equipoId: req.equipoId,
      gestionado: !!cfg,
      modo: cfg ? cfg.modo : null,
      tipo,
      total: Math.round(total * 100) / 100,
      vendedores,
    });
  } catch (err) {
    console.error('[distribution] detalle:', err.message);
    res.status(500).json({ ok: false, error: 'Error al obtener la distribución del equipo' });
  }
});

router.get('/:equipoId/preview', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const n = Math.max(1, Math.min(100000, Number(req.query.n) || 100));
    res.json({ ok: true, n, reparto: await dist.previsualizar(req.equipoId, n) });
  } catch (err) {
    console.error('[distribution] preview:', err.message);
    res.status(500).json({ ok: false, error: 'Error al calcular la vista previa' });
  }
});

router.put('/:equipoId/:userId/pausa', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const vendedores = await dist.pausarVendedor(
      req.equipoId,
      Number(req.params.userId),
      !!req.body.pausado
    );
    emitir(req, 'distribucion:updated', { equipos: [req.equipoId] });
    res.json({ ok: true, vendedores });
  } catch (err) {
    console.error('[distribution] pausa:', err.message);
    res.status(500).json({ ok: false, error: 'Error al cambiar el estado del vendedor' });
  }
});

router.put('/:equipoId/:userId', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const { porcentaje, fijo = null } = req.body;
    if (porcentaje == null || isNaN(Number(porcentaje))) {
      return res.status(400).json({ ok: false, error: 'Falta el porcentaje' });
    }
    await dist.actualizarPorcentaje(
      req.equipoId,
      Number(req.params.userId),
      Number(porcentaje),
      fijo
    );
    emitir(req, 'distribucion:updated', { equipos: [req.equipoId] });
    res.json({ ok: true, vendedores: await dist.listar(req.equipoId) });
  } catch (err) {
    console.error('[distribution] set:', err.message);
    res.status(500).json({ ok: false, error: 'Error al guardar el cambio' });
  }
});

router.post('/:equipoId/parejo', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const vendedores = await dist.repartirParejo(req.equipoId);
    emitir(req, 'distribucion:updated', { equipos: [req.equipoId] });
    res.json({ ok: true, vendedores });
  } catch (err) {
    console.error('[distribution] parejo:', err.message);
    res.status(500).json({ ok: false, error: 'Error al repartir parejo' });
  }
});

router.post('/:equipoId/sincronizar', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const cambio = await dist.sincronizarEquipo(req.equipoId);
    res.json({ ok: true, cambio, vendedores: await dist.listar(req.equipoId) });
  } catch (err) {
    console.error('[distribution] sincronizar:', err.message);
    res.status(500).json({ ok: false, error: 'Error al sincronizar el equipo' });
  }
});

// GET /api/distribution/gestionados — equipos que usan porcentajes.
// Va antes de /:supervisorId para que no se lo coma.
router.get('/gestionados', authenticateToken, soloAdmins, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.lider_id, e.modo, e.nota, u.name, u.role, u.reportsTo
         FROM distribucion_equipos e
         JOIN users u ON u.id = e.lider_id
        WHERE e.activo = 1
        ORDER BY FIELD(e.modo,'cascada','plano'), u.name`
    );

    const permitidos = await Promise.all(
      rows.map((r) => puedeAdministrar(req.user, r.lider_id))
    );
    res.json({ ok: true, equipos: rows.filter((_, i) => permitidos[i]) });
  } catch (err) {
    console.error('[distribution] gestionados:', err.message);
    res.status(500).json({ ok: false, error: 'Error al obtener los equipos' });
  }
});

// GET /api/distribution/:supervisorId — contrato viejo.
// Va ÚLTIMO para no comerse las rutas de arriba.
// [AUTH-COMPAT] mismo criterio que el /all.
router.get('/:supervisorId', authenticateToken, soloAdmins, guardEquipo, async (req, res) => {
  try {
    const [vendors] = await pool.query(
      `SELECT u.id, u.name, u.role, u.lead_percentage, u.active,
              d.peso, d.pausado
         FROM users u
         LEFT JOIN distribucion_pesos d
                ON d.user_id = u.id
               AND d.scope = CONCAT('lider:', u.reportsTo)
               AND d.activo = 1
        WHERE u.reportsTo = ? AND u.role = 'vendedor' AND u.active = 1
        ORDER BY u.name`,
      [req.equipoId]
    );
    res.json({ ok: true, vendors: vendors.filter((v) => !dist.EXCLUIDOS.has(v.id)) });
  } catch (err) {
    console.error('[distribution] byId:', err.message);
    res.status(500).json({ ok: false, error: 'Error al obtener distribución' });
  }
});

module.exports = router;
