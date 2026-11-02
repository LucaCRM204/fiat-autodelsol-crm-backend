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

/**
 * Evidencia: busca en las tablas del CRM lo que la acción dejó registrado
 * (nota, recordatorio, historial, reasignación, alerta, WhatsApp). No confía
 * en lo que dice el agente: lee la base.
 */
router.get('/actions/:id/evidencia', requireRole(VEN), async (req, res) => {
  try {
    const pool = req.app.get('db');
    const [[a]] = await pool.execute(
      `SELECT a.*, d.name AS decidido_por FROM agent_actions a LEFT JOIN users d ON d.id = a.decided_by WHERE a.id = ?`,
      [parseInt(req.params.id)]);
    if (!a) return res.status(404).json({ ok: false, error: 'Acción no encontrada' });

    const args = parse(a.args) || {};
    const result = parse(a.result) || {};
    const agentId = tools.agentUserId();
    const cuando = a.executed_at || a.created_at;
    const ventana = [cuando, cuando]; // ±5 min alrededor de la ejecución
    const cerca = (col) => `${col} BETWEEN ? - INTERVAL 5 MINUTE AND ? + INTERVAL 5 MINUTE`;
    const evidencia = [];
    const push = (tipo, encontrado, detalle, fecha) => evidencia.push({ tipo, encontrado, detalle, fecha: fecha || null });

    const [[lead]] = a.lead_id
      ? await pool.execute(
          `SELECT l.id, l.nombre, l.telefono, l.modelo, l.estado, l.assigned_to, u.name AS vendedor
             FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = ?`, [a.lead_id])
      : [[null]];

    if (!['executed', 'approved'].includes(a.status)) {
      return res.json({ ok: true, accion: { ...a, args, result }, lead: lead || null, evidencia,
        aviso: a.status === 'pending' ? 'Todavía no se ejecutó: está esperando aprobación.' : a.status === 'rejected' ? 'Fue rechazada: no se hizo nada.' : 'Falló: no se hizo nada.' });
    }

    switch (a.tool) {
      case 'add_nota': {
        const [r] = await pool.execute('SELECT texto, usuario, timestamp FROM notas_internas WHERE id = ?', [result.nota_id || 0]);
        push('Nota interna en el lead', !!r[0], r[0]?.texto, r[0]?.timestamp);
        break;
      }
      case 'create_recordatorio': {
        const [r] = await pool.execute(
          "SELECT DATE_FORMAT(fecha, '%d/%m/%Y') AS fecha, TIME_FORMAT(hora, '%H:%i') AS hora, descripcion, completado FROM recordatorios WHERE id = ?",
          [result.recordatorio_id || 0]);
        push('Recordatorio en el calendario del vendedor', !!r[0],
          r[0] && `${r[0].fecha} ${r[0].hora} — ${r[0].descripcion}${r[0].completado ? ' (ya completado)' : ''}`);
        const [al] = await pool.execute(
          `SELECT message, timestamp FROM alertas WHERE lead_id = ? AND type = 'recordatorio' AND ${cerca('timestamp')} ORDER BY id DESC LIMIT 1`,
          [a.lead_id, ...ventana]);
        push('Aviso al vendedor', !!al[0], al[0]?.message, al[0]?.timestamp);
        break;
      }
      case 'notify_user': {
        const [r] = await pool.execute(
          `SELECT al.message, al.timestamp, al.is_read, u.name FROM alertas al JOIN users u ON u.id = al.user_id
            WHERE al.user_id = ? AND al.message = ? AND ${cerca('al.timestamp')} ORDER BY al.id DESC LIMIT 1`,
          [args.user_id || 0, String(args.mensaje || '').slice(0, 300), ...ventana]);
        push(`Alerta a ${r[0]?.name || 'usuario #' + args.user_id}`, !!r[0],
          r[0] && `${r[0].message}${r[0].is_read ? ' (ya la leyó)' : ' (sin leer)'}`, r[0]?.timestamp);
        break;
      }
      case 'update_lead_estado': {
        const [h] = await pool.execute(
          `SELECT old_value, new_value, created_at FROM lead_history
            WHERE lead_id = ? AND user_id = ? AND field_name = 'Estado' AND ${cerca('created_at')} ORDER BY id DESC LIMIT 1`,
          [a.lead_id, agentId, ...ventana]);
        push('Cambio de estado en el historial', !!h[0], h[0] && `${h[0].old_value} → ${h[0].new_value}`, h[0]?.created_at);
        break;
      }
      case 'reassign_lead': {
        const [r] = await pool.execute(
          `SELECT f.name AS de, t.name AS a, r.created_at FROM lead_reassignment_log r
             LEFT JOIN users f ON f.id = r.from_user_id LEFT JOIN users t ON t.id = r.to_user_id
            WHERE r.lead_id = ? AND r.reason = 'agente_ia' AND ${cerca('r.created_at')} ORDER BY r.id DESC LIMIT 1`,
          [a.lead_id, ...ventana]);
        push('Reasignación registrada', !!r[0], r[0] && `De ${r[0].de || 'sin vendedor'} a ${r[0].a}`, r[0]?.created_at);
        break;
      }
      case 'send_whatsapp': {
        const [w] = await pool.execute(
          `SELECT message, phone, created_at FROM wa_messages
            WHERE (lead_id = ? OR phone = ?) AND sent_by = 'agente' AND ${cerca('created_at')} ORDER BY id DESC LIMIT 1`,
          [a.lead_id, result.telefono || '', ...ventana]);
        push('Mensaje de WhatsApp enviado', !!w[0], w[0] && `A ${w[0].phone}: ${w[0].message}`, w[0]?.created_at);
        if (w[0]) {
          const [resp] = await pool.execute(
            `SELECT message, created_at FROM wa_messages WHERE phone = ? AND direction = 'in' AND created_at > ? ORDER BY id LIMIT 1`,
            [w[0].phone, w[0].created_at]);
          if (resp[0]) push('El cliente respondió', true, resp[0].message, resp[0].created_at);
        }
        break;
      }
      default:
        break;
    }

    res.json({ ok: true, accion: { ...a, args, result }, lead: lead || null, evidencia });
  } catch (e) {
    console.error('[agente] evidencia:', e);
    res.status(500).json({ ok: false, error: 'No se pudo verificar la acción' });
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
