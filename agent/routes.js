/**
 * ============================================
 * AGENTE IA — API DEL PANEL  (/api/agent)
 * ============================================
 * Bandeja de acciones, aprobaciones, corridas, configuración y disparo
 * manual. Acceso: owner, director y gerente. Configuración: owner y director.
 */
const router = require('express').Router();
const { authenticateToken, requireRole } = require('../middleware/auth');
const config = require('./config');
const tools = require('./tools');
const llm = require('./llm');
const { enqueue } = require('./scanner');

const VEN = ['owner', 'director', 'gerente'];
const ADMIN = ['owner', 'director'];
const ESTADOS_ACCION = ['pending', 'executed', 'approved', 'rejected', 'failed'];
const parse = (v) => { if (v == null || typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };

router.use(authenticateToken);

router.get('/status', requireRole(VEN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const [[c]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM agent_actions WHERE status = 'pending') AS pendientes,
         (SELECT COUNT(*) FROM agent_actions WHERE created_at >= CURDATE() AND status IN ('executed','approved')) AS ejecutadas_hoy,
         (SELECT COUNT(*) FROM agent_runs WHERE created_at >= CURDATE()) AS corridas_hoy,
         (SELECT COALESCE(SUM(input_tokens),0) FROM agent_runs WHERE created_at >= CURDATE()) AS tokens_in_hoy,
         (SELECT COALESCE(SUM(output_tokens),0) FROM agent_runs WHERE created_at >= CURDATE()) AS tokens_out_hoy,
         (SELECT COUNT(*) FROM agent_events WHERE status = 'pending') AS en_cola,
         (SELECT COUNT(*) FROM agent_events WHERE status = 'error' AND created_at >= CURDATE()) AS errores_hoy`);
    const cfg = await config.get();
    res.json({ ok: true, config: cfg, contadores: c, api_key: llm.hasKey(), api_key_var: llm.KEY_VAR, proveedor: llm.PROVIDER, modelo: llm.MODEL, en_horario: config.enHorario(cfg) });
  } catch (e) {
    console.error('[agente] status:', e);
    res.status(500).json({ ok: false, error: 'Error al leer el estado del agente' });
  }
});

router.get('/actions', requireRole(VEN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const status = ESTADOS_ACCION.includes(req.query.status) ? req.query.status : null;
    const leadId = parseInt(req.query.lead_id) || null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const where = [];
    const params = [];
    if (status) { where.push('a.status = ?'); params.push(status); }
    if (leadId) { where.push('a.lead_id = ?'); params.push(leadId); }
    const [rows] = await pool.execute(
      `SELECT a.*, l.nombre AS lead_nombre, l.estado AS lead_estado, l.modelo AS lead_modelo,
              v.name AS vendedor_nombre, d.name AS decidido_por, r.summary AS run_resumen
         FROM agent_actions a
         LEFT JOIN leads l ON l.id = a.lead_id
         LEFT JOIN users v ON v.id = l.assigned_to
         LEFT JOIN users d ON d.id = a.decided_by
         LEFT JOIN agent_runs r ON r.id = a.run_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.id DESC LIMIT ${limit}`, params);
    const actions = rows.map((a) => ({ ...a, args: parse(a.args) || {}, result: parse(a.result) }));
    // Nombres de los usuarios mencionados en los argumentos (reasignar / avisar)
    const ids = [...new Set(actions.flatMap((a) => [a.args.to_user_id, a.args.user_id]).filter(Number.isInteger))];
    const nombres = {};
    if (ids.length) {
      const [us] = await pool.query('SELECT id, name FROM users WHERE id IN (?)', [ids]);
      for (const u of us) nombres[u.id] = u.name;
    }
    res.json({ ok: true, actions: actions.map((a) => ({ ...a, usuario_destino: nombres[a.args.to_user_id ?? a.args.user_id] || null })) });
  } catch (e) {
    console.error('[agente] actions:', e);
    res.status(500).json({ ok: false, error: 'Error al leer las acciones' });
  }
});

router.post('/actions/:id/approve', requireRole(VEN), async (req, res) => {
  try {
    const r = await tools.approveAction(parseInt(req.params.id), req.user.id);
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    console.error('[agente] aprobar:', e);
    res.status(500).json({ ok: false, error: 'No se pudo aprobar la acción' });
  }
});

router.post('/actions/:id/reject', requireRole(VEN), async (req, res) => {
  try {
    const r = await tools.rejectAction(parseInt(req.params.id), req.user.id, req.body?.motivo);
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    console.error('[agente] rechazar:', e);
    res.status(500).json({ ok: false, error: 'No se pudo rechazar la acción' });
  }
});

router.get('/runs', requireRole(VEN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const leadId = parseInt(req.query.lead_id) || null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const [rows] = await pool.execute(
      `SELECT r.id, r.event_id, r.lead_id, r.trigger_type, r.model, r.status, r.steps,
              r.input_tokens, r.output_tokens, r.summary, r.error, r.created_at, r.finished_at,
              l.nombre AS lead_nombre
         FROM agent_runs r LEFT JOIN leads l ON l.id = r.lead_id
        ${leadId ? 'WHERE r.lead_id = ?' : ''}
        ORDER BY r.id DESC LIMIT ${limit}`, leadId ? [leadId] : []);
    res.json({ ok: true, runs: rows });
  } catch (e) {
    console.error('[agente] runs:', e);
    res.status(500).json({ ok: false, error: 'Error al leer las corridas' });
  }
});

router.get('/runs/:id', requireRole(ADMIN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const [[run]] = await pool.execute('SELECT * FROM agent_runs WHERE id = ?', [parseInt(req.params.id)]);
    if (!run) return res.status(404).json({ ok: false, error: 'Corrida no encontrada' });
    res.json({ ok: true, run: { ...run, transcript: parse(run.transcript) } });
  } catch (e) {
    console.error('[agente] run:', e);
    res.status(500).json({ ok: false, error: 'Error al leer la corrida' });
  }
});

router.get('/config', requireRole(VEN), async (_req, res) => {
  try {
    res.json({ ok: true, config: await config.get(), defaults: config.DEFAULTS });
  } catch (e) {
    console.error('[agente] config:', e);
    res.status(500).json({ ok: false, error: 'Error al leer la configuración' });
  }
});

router.put('/config', requireRole(ADMIN), async (req, res) => {
  try {
    const r = await config.set(req.body, req.user.id);
    if (r.ok) console.log(`🤖 Config del agente actualizada por ${req.user.name}:`, JSON.stringify(req.body));
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    console.error('[agente] guardar config:', e);
    res.status(500).json({ ok: false, error: 'No se pudo guardar la configuración' });
  }
});

router.post('/run', requireRole(VEN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const leadId = parseInt(req.body?.lead_id);
    if (!leadId) return res.status(400).json({ ok: false, error: 'Falta lead_id' });
    const [[lead]] = await pool.execute('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (!lead) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });
    const cfg = await config.get();
    if (cfg.mode === 'off') return res.status(409).json({ ok: false, error: 'El agente está apagado' });
    const instruccion = req.body?.instruccion ? String(req.body.instruccion).slice(0, 500) : null;
    const id = await enqueue('manual', leadId, { instruccion, pedido_por: req.user.name }, `manual:${leadId}:${Date.now()}`, req.user.id);
    res.json({ ok: true, event_id: id });
  } catch (e) {
    console.error('[agente] run manual:', e);
    res.status(500).json({ ok: false, error: 'No se pudo encolar la revisión' });
  }
});

router.get('/events', requireRole(ADMIN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const [rows] = await pool.query(
      `SELECT e.id, e.type, e.lead_id, e.status, e.attempts, e.error, e.run_id, e.created_at, e.processed_at, l.nombre AS lead_nombre
         FROM agent_events e LEFT JOIN leads l ON l.id = e.lead_id ORDER BY e.id DESC LIMIT ${limit}`);
    res.json({ ok: true, events: rows });
  } catch (e) {
    console.error('[agente] events:', e);
    res.status(500).json({ ok: false, error: 'Error al leer los eventos' });
  }
});

module.exports = router;
