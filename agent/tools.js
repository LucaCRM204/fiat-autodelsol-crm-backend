/**
 * ============================================
 * AGENTE IA — HERRAMIENTAS DEL CRM
 * ============================================
 * Única puerta de entrada del agente (y de cualquier agente externo vía MCP)
 * a los datos del CRM. Cada herramienta declara:
 *   - input_schema : JSON Schema que ve el modelo
 *   - readOnly     : true = consulta, se ejecuta siempre y no se registra
 *   - run(args,ctx): la implementación contra MySQL
 *
 * Las de escritura pasan por executeTool(), que aplica la política:
 *   modo shadow, herramienta en tools_con_aprobacion, o WhatsApp a clientes
 *   con whatsapp_automatico apagado -> queda PENDIENTE
 *   en agent_actions hasta que un gerente la apruebe desde el panel.
 *   resto -> se ejecuta y queda registrada como EXECUTED.
 */
const axios = require('axios');
const config = require('./config');

// Bot de WhatsApp de Fiat (droplet). Ver src/routes/agent.js del bot.
const WA_BOT_URL = (process.env.WA_BOT_URL || 'https://api.crmalluma.com.ar/wa-fiat').replace(/\/$/, '');
const WA_BOT_KEY = process.env.WA_BOT_KEY || '';

const ESTADOS = [
  'nuevo', 'contactado', 'interesado', 'negociacion', 'vendido', 'perdido',
  'numero_invalido', 'no_contesta_1', 'no_contesta_2', 'no_contesta_3', 'rellamado',
];
const ESTADOS_CERRADOS = ['vendido', 'perdido', 'numero_invalido', 'rechazado_supervisor'];

let ctx = { pool: null, io: null, agentUser: null };
function init(c) { ctx = { ...ctx, ...c }; }

// ---------- helpers ----------
const cut = (s, n = 400) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const digits = (s) => String(s || '').replace(/\D/g, '');
const fail = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };
const parseJSON = (v) => { if (v == null || typeof v === 'object') return v; try { return JSON.parse(v); } catch { return v; } };

async function getLeadRow(id) {
  const [rows] = await ctx.pool.execute(
    `SELECT l.*, u.name AS vendedor_nombre, u.active AS vendedor_activo, u.reportsTo AS vendedor_reporta_a
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function logHistory(leadId, field, oldVal, newVal) {
  await ctx.pool.execute(
    'INSERT INTO lead_history (lead_id, action, field_name, old_value, new_value, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [leadId, 'cambio', field, String(oldVal ?? ''), String(newVal ?? ''), ctx.agentUser.id, ctx.agentUser.name]
  );
}

async function emitLead(leadId) {
  if (!ctx.io) return;
  const [rows] = await ctx.pool.execute('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (rows[0]) ctx.io.emit('lead:updated', { ...rows[0], vendedor: rows[0].assigned_to ?? null });
}

async function notify(userId, message, leadId, type = 'tarea') {
  await ctx.pool.execute(
    'INSERT INTO alertas (user_id, type, message, lead_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
    [userId, type, message, leadId || null]
  );
  if (ctx.io) {
    ctx.io.emit('notification', {
      id: `agente-${leadId || 0}-${Date.now()}`,
      type: 'agente',
      title: '🤖 Agente IA',
      message,
      timestamp: new Date().toISOString(),
      read: false,
      severity: 'info',
      leadId: leadId || null,
      targetUserId: userId,
    });
  }
}

// ---------- herramientas ----------
const TOOLS = [
  {
    name: 'get_lead',
    readOnly: true,
    description: 'Devuelve un lead con todo su contexto: datos, vendedor asignado, historial de cambios, notas internas, llamadas, recordatorios pendientes, últimos mensajes de WhatsApp y cotizaciones.',
    input_schema: {
      type: 'object',
      properties: { lead_id: { type: 'integer' } },
      required: ['lead_id'],
    },
    async run({ lead_id }) {
      const lead = await getLeadRow(lead_id);
      if (!lead) fail(`No existe el lead #${lead_id}`);
      const p = ctx.pool;
      const tel = digits(lead.telefono).slice(-10);
      const [historial] = await p.execute(
        'SELECT field_name, old_value, new_value, user_name, created_at FROM lead_history WHERE lead_id = ? ORDER BY id DESC LIMIT 25', [lead_id]);
      const [notas] = await p.execute(
        'SELECT texto, usuario, timestamp FROM notas_internas WHERE lead_id = ? ORDER BY id DESC LIMIT 15', [lead_id]);
      const [llamadas] = await p.execute(
        'SELECT c.resultado, c.duracion_segundos, c.notas, c.created_at, u.name AS usuario FROM call_logs c LEFT JOIN users u ON u.id = c.user_id WHERE c.lead_id = ? ORDER BY c.id DESC LIMIT 15', [lead_id]);
      const [recordatorios] = await p.execute(
        'SELECT id, fecha, hora, descripcion FROM recordatorios WHERE lead_id = ? AND completado = 0 ORDER BY fecha, hora LIMIT 10', [lead_id]);
      const [cotizaciones] = await p.execute(
        'SELECT vehiculo, precio_contado, anticipo, created_at FROM cotizaciones WHERE lead_id = ? ORDER BY id DESC LIMIT 5', [lead_id]);
      const [accionesAgente] = await p.execute(
        `SELECT tool, status, args, created_at FROM agent_actions
          WHERE lead_id = ? AND created_at > NOW() - INTERVAL 7 DAY AND status IN ('pending','executed','approved')
          ORDER BY id DESC LIMIT 10`, [lead_id]);
      let whatsapp = [];
      if (tel.length >= 8) {
        const [wa] = await p.execute(
          `SELECT direction, sent_by, message, media_type, created_at FROM wa_messages
            WHERE lead_id = ? OR phone LIKE ? ORDER BY id DESC LIMIT 20`, [lead_id, `%${tel}`]);
        whatsapp = wa.reverse().map((m) => ({ ...m, message: cut(m.message, 300) }));
      }
      return {
        lead: {
          id: lead.id, nombre: lead.nombre, telefono: lead.telefono, modelo: lead.modelo,
          formaPago: lead.formaPago, infoUsado: lead.infoUsado, estado: lead.estado, fuente: lead.fuente,
          notas: cut(lead.notas, 1000), creado: lead.created_at, asignado: lead.assigned_at,
          ultima_actualizacion: lead.updated_at, reasignaciones: lead.reassignment_count,
          vendedor: lead.assigned_to ? { id: lead.assigned_to, nombre: lead.vendedor_nombre, activo: !!lead.vendedor_activo, reporta_a: lead.vendedor_reporta_a } : null,
        },
        historial: historial.map((h) => ({ ...h, old_value: cut(h.old_value, 120), new_value: cut(h.new_value, 120) })),
        notas_internas: notas.map((n) => ({ ...n, texto: cut(n.texto, 400) })),
        llamadas,
        recordatorios_pendientes: recordatorios,
        whatsapp_ultimos: whatsapp, // sent_by: cliente | bot | vendedor (desde el celular) | agente
        cotizaciones,
        // Lo que el agente ya hizo o propuso con este lead: no repetir
        acciones_del_agente_7d: accionesAgente.map((a) => ({ tool: a.tool, estado: a.status, args: cut(typeof a.args === 'string' ? a.args : JSON.stringify(a.args), 200), cuando: a.created_at })),
      };
    },
  },

  {
    name: 'search_leads',
    readOnly: true,
    description: 'Busca leads por teléfono, nombre, estado o vendedor. Sirve para detectar duplicados o ver la cartera de un vendedor. Máximo 25 resultados.',
    input_schema: {
      type: 'object',
      properties: {
        telefono: { type: 'string', description: 'Se compara por los últimos 8 dígitos' },
        nombre: { type: 'string' },
        estado: { type: 'string', enum: [...ESTADOS, 'rechazado_supervisor'] },
        assigned_to: { type: 'integer' },
        excluir_lead_id: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
    async run(a) {
      const where = [];
      const params = [];
      if (a.telefono) {
        const d = digits(a.telefono).slice(-8);
        if (d.length < 6) fail('El teléfono necesita al menos 6 dígitos');
        where.push('l.telefono LIKE ?'); params.push(`%${d}%`);
      }
      if (a.nombre) { where.push('l.nombre LIKE ?'); params.push(`%${a.nombre}%`); }
      if (a.estado) { where.push('l.estado = ?'); params.push(a.estado); }
      if (a.assigned_to) { where.push('l.assigned_to = ?'); params.push(a.assigned_to); }
      if (a.excluir_lead_id) { where.push('l.id <> ?'); params.push(a.excluir_lead_id); }
      if (!where.length) fail('Pasá al menos un filtro');
      const limit = Math.min(Math.max(parseInt(a.limit) || 10, 1), 25);
      const [rows] = await ctx.pool.execute(
        `SELECT l.id, l.nombre, l.telefono, l.modelo, l.estado, l.fuente, l.created_at, l.updated_at, u.name AS vendedor
           FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
          WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${limit}`, params);
      return { total: rows.length, leads: rows };
    },
  },

  {
    name: 'list_vendedores',
    readOnly: true,
    description: 'Lista vendedores activos con su supervisor, carga actual (leads abiertos), leads recibidos hoy y si se conectaron hoy. Con equipo_de filtra al equipo de un supervisor/gerente.',
    input_schema: {
      type: 'object',
      properties: { equipo_de: { type: 'integer', description: 'id del supervisor o gerente' } },
    },
    async run({ equipo_de }) {
      const params = [];
      let filtro = '';
      if (equipo_de) {
        filtro = 'AND (u.reportsTo = ? OR u.reportsTo IN (SELECT id FROM users WHERE reportsTo = ?))';
        params.push(equipo_de, equipo_de);
      }
      const [rows] = await ctx.pool.execute(
        `SELECT u.id, u.name, u.reportsTo, s.name AS supervisor,
                (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.estado NOT IN ('vendido','perdido','numero_invalido','rechazado_supervisor')) AS leads_abiertos,
                (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.assigned_at >= CURDATE()) AS leads_hoy,
                (SELECT COUNT(*) FROM user_sessions us WHERE us.user_id = u.id AND us.date = CURDATE()) > 0 AS conectado_hoy
           FROM users u LEFT JOIN users s ON s.id = u.reportsTo
          WHERE u.role = 'vendedor' AND u.active = 1 ${filtro}
          ORDER BY leads_abiertos ASC`, params);
      return { vendedores: rows.map((r) => ({ ...r, conectado_hoy: !!r.conectado_hoy })) };
    },
  },

  {
    name: 'list_planes',
    readOnly: true,
    description: 'Grilla de modelos/planes Fiat cargada en el CRM (precio contado, anticipo, cuotas). Usala para no inventar precios.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const [rows] = await ctx.pool.execute(
        'SELECT id, modelo, precio_contado, anticipo, planes_cuotas, bonificaciones FROM presupuestos WHERE activo = 1 ORDER BY modelo');
      return { planes: rows.map((r) => ({ ...r, planes_cuotas: parseJSON(r.planes_cuotas), bonificaciones: cut(r.bonificaciones, 300) })) };
    },
  },

  {
    name: 'add_nota',
    readOnly: false,
    description: 'Agrega una nota interna al lead, firmada por el Agente IA. Corta y accionable (máx. 600 caracteres).',
    input_schema: {
      type: 'object',
      properties: { lead_id: { type: 'integer' }, texto: { type: 'string', maxLength: 600 } },
      required: ['lead_id', 'texto'],
    },
    async run({ lead_id, texto }) {
      const t = String(texto || '').trim();
      if (!t) fail('La nota está vacía');
      if (!(await getLeadRow(lead_id))) fail(`No existe el lead #${lead_id}`);
      const [r] = await ctx.pool.execute(
        'INSERT INTO notas_internas (lead_id, texto, usuario, user_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [lead_id, `🤖 ${t.slice(0, 600)}`, ctx.agentUser.name, ctx.agentUser.id]);
      return { ok: true, nota_id: r.insertId };
    },
  },

  {
    name: 'create_recordatorio',
    readOnly: false,
    description: 'Crea un recordatorio en el lead; le aparece al vendedor asignado en su calendario. Fecha y hora en horario de Argentina, siempre a futuro.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'integer' },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
        hora: { type: 'string', description: 'HH:MM (24 h)' },
        descripcion: { type: 'string', maxLength: 300 },
      },
      required: ['lead_id', 'fecha', 'hora', 'descripcion'],
    },
    async run({ lead_id, fecha, hora, descripcion }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(hora)) fail('Formato: fecha YYYY-MM-DD y hora HH:MM');
      const ahora = config.nowArg();
      if (`${fecha} ${hora}` <= ahora.iso) fail(`La fecha tiene que ser posterior a ${ahora.iso} (hora Argentina)`);
      const lead = await getLeadRow(lead_id);
      if (!lead) fail(`No existe el lead #${lead_id}`);
      const [dup] = await ctx.pool.execute(
        'SELECT id FROM recordatorios WHERE lead_id = ? AND completado = 0 AND fecha = ? LIMIT 1', [lead_id, fecha]);
      if (dup.length) fail(`El lead ya tiene un recordatorio pendiente para ${fecha} (#${dup[0].id})`);
      const desc = `🤖 ${String(descripcion).trim().slice(0, 300)}`;
      const [r] = await ctx.pool.execute(
        'INSERT INTO recordatorios (lead_id, fecha, hora, descripcion, created_by, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [lead_id, fecha, `${hora}:00`, desc, ctx.agentUser.id]);
      if (lead.assigned_to) await notify(lead.assigned_to, `Recordatorio ${fecha} ${hora} — ${lead.nombre}: ${descripcion}`, lead_id, 'recordatorio');
      return { ok: true, recordatorio_id: r.insertId };
    },
  },

  {
    name: 'notify_user',
    readOnly: false,
    description: 'Manda una alerta interna (campanita + notificación en vivo) a un usuario del CRM: vendedor, supervisor o gerente.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'integer' },
        mensaje: { type: 'string', maxLength: 300 },
        lead_id: { type: 'integer' },
      },
      required: ['user_id', 'mensaje'],
    },
    async run({ user_id, mensaje, lead_id }) {
      const [u] = await ctx.pool.execute('SELECT id, active FROM users WHERE id = ?', [user_id]);
      if (!u.length || !u[0].active) fail(`El usuario #${user_id} no existe o está inactivo`);
      await notify(user_id, String(mensaje).slice(0, 300), lead_id);
      return { ok: true };
    },
  },

  {
    name: 'update_lead_estado',
    readOnly: false,
    description: 'Cambia el estado de un lead. Queda en el historial firmado por el Agente IA.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'integer' },
        estado: { type: 'string', enum: ESTADOS },
        motivo: { type: 'string', maxLength: 300 },
      },
      required: ['lead_id', 'estado', 'motivo'],
    },
    async run({ lead_id, estado, motivo }) {
      if (!ESTADOS.includes(estado)) fail(`Estado inválido: ${estado}`);
      const lead = await getLeadRow(lead_id);
      if (!lead) fail(`No existe el lead #${lead_id}`);
      if (lead.estado === 'rechazado_supervisor') fail('El lead está rechazado por supervisor: solo lo cambia un gerente');
      if (lead.estado === estado) return { ok: true, sin_cambios: true };
      await ctx.pool.execute('UPDATE leads SET estado = ?, last_status_change = NOW() WHERE id = ?', [estado, lead_id]);
      await logHistory(lead_id, 'Estado', lead.estado, estado);
      await ctx.pool.execute(
        'INSERT INTO notas_internas (lead_id, texto, usuario, user_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [lead_id, `🤖 Estado ${lead.estado} → ${estado}: ${String(motivo).slice(0, 300)}`, ctx.agentUser.name, ctx.agentUser.id]);
      await emitLead(lead_id);
      return { ok: true, de: lead.estado, a: estado };
    },
  },

  {
    name: 'reassign_lead',
    readOnly: false,
    description: 'Reasigna el lead a otro vendedor activo. Registra el log de reasignación, el historial y avisa a los dos vendedores.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'integer' },
        to_user_id: { type: 'integer' },
        motivo: { type: 'string', maxLength: 300 },
      },
      required: ['lead_id', 'to_user_id', 'motivo'],
    },
    async run({ lead_id, to_user_id, motivo }) {
      const lead = await getLeadRow(lead_id);
      if (!lead) fail(`No existe el lead #${lead_id}`);
      if (ESTADOS_CERRADOS.includes(lead.estado)) fail(`El lead está en "${lead.estado}", no se reasigna`);
      if (lead.assigned_to === to_user_id) return { ok: true, sin_cambios: true };
      const [u] = await ctx.pool.execute(
        "SELECT id, name FROM users WHERE id = ? AND role = 'vendedor' AND active = 1", [to_user_id]);
      if (!u.length) fail(`#${to_user_id} no es un vendedor activo`);
      await ctx.pool.execute(
        `UPDATE leads SET assigned_to = ?, assigned_at = NOW(), accepted_at = NULL,
                reassignment_count = COALESCE(reassignment_count, 0) + 1,
                pending_acceptance = 0, current_offer_to = NULL, acceptance_expires_at = NULL
          WHERE id = ?`, [to_user_id, lead_id]);
      await ctx.pool.execute(
        'INSERT INTO lead_reassignment_log (lead_id, from_user_id, to_user_id, reason) VALUES (?, ?, ?, ?)',
        [lead_id, lead.assigned_to, to_user_id, 'agente_ia']);
      await logHistory(lead_id, 'Vendedor', lead.vendedor_nombre || '', u[0].name);
      await ctx.pool.execute(
        'INSERT INTO notas_internas (lead_id, texto, usuario, user_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [lead_id, `🤖 Reasignado de ${lead.vendedor_nombre || 'sin vendedor'} a ${u[0].name}: ${String(motivo).slice(0, 300)}`, ctx.agentUser.name, ctx.agentUser.id]);
      await notify(to_user_id, `Te asignaron a ${lead.nombre} (${lead.modelo || 'sin modelo'}). ${motivo}`, lead_id, 'lead_assigned');
      if (lead.assigned_to && lead.vendedor_activo) await notify(lead.assigned_to, `${lead.nombre} pasó a ${u[0].name}: ${motivo}`, lead_id);
      await emitLead(lead_id);
      return { ok: true, de: lead.vendedor_nombre, a: u[0].name };
    },
  },
];

TOOLS.push({
  name: 'send_whatsapp',
  readOnly: false,
  clienteFinal: true,
  description: 'Manda un mensaje de seguimiento al cliente por WhatsApp, desde el número del vendedor donde ya chatearon. Según la configuración, sale directo o queda pendiente de aprobación. Solo para leads que ya tienen charla de WhatsApp; máximo uno cada 48 h por lead. Corto (2-3 líneas), natural, sin inventar precios ni promociones, sin presentarte como una persona en particular.',
  input_schema: {
    type: 'object',
    properties: {
      lead_id: { type: 'integer' },
      mensaje: { type: 'string', maxLength: 500 },
    },
    required: ['lead_id', 'mensaje'],
  },
  async run({ lead_id, mensaje }) {
    const texto = String(mensaje || '').trim();
    if (!texto) fail('El mensaje está vacío');
    if (texto.length > 500) fail('Máximo 500 caracteres');
    if (!WA_BOT_KEY) fail('Falta WA_BOT_KEY en el backend: no se puede mandar WhatsApp');
    const cfg = await config.get();
    if (!config.enHorario(cfg)) fail('Fuera del horario comercial: aprobalo dentro del horario');

    const lead = await getLeadRow(lead_id);
    if (!lead) fail(`No existe el lead #${lead_id}`);
    if (ESTADOS_CERRADOS.includes(lead.estado)) fail(`El lead está en "${lead.estado}": no se le escribe`);

    const tel = digits(lead.telefono).slice(-10);
    const [ult] = await ctx.pool.execute(
      `SELECT phone, session_id FROM wa_messages
        WHERE (lead_id = ? OR phone LIKE ?) AND session_id LIKE 'user\\_%'
        ORDER BY id DESC LIMIT 1`, [lead_id, `%${tel}`]);
    if (!ult.length) fail('El lead no tiene charla de WhatsApp: no se le escribe en frío');
    const { phone, session_id } = ult[0];
    const userId = parseInt(String(session_id).replace('user_', ''), 10);

    const [rec] = await ctx.pool.execute(
      `SELECT COUNT(*) AS n FROM wa_messages WHERE phone = ? AND sent_by = 'agente' AND created_at > NOW() - INTERVAL 48 HOUR`, [phone]);
    if (rec[0].n) fail('Ya se le mandó un seguimiento en las últimas 48 h');

    try {
      await axios.post(`${WA_BOT_URL}/api/agent/send`, { userId, phone, texto },
        { headers: { 'x-agent-key': WA_BOT_KEY }, timeout: 20000 });
    } catch (e) {
      fail(`El bot no pudo mandarlo: ${e.response?.data?.error || e.message}`);
    }
    await ctx.pool.execute(
      'INSERT INTO notas_internas (lead_id, texto, usuario, user_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [lead_id, `🤖 WhatsApp enviado al cliente: "${texto.slice(0, 400)}"`, ctx.agentUser.name, ctx.agentUser.id]);
    if (lead.assigned_to) await notify(lead.assigned_to, `Se le mandó un seguimiento por WhatsApp a ${lead.nombre}. Si contesta, seguís vos.`, lead_id);
    return { ok: true, enviado_desde_usuario: userId, telefono: phone };
  },
});

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Herramienta interna para cerrar la corrida (no se expone por MCP). */
const FINISH_TOOL = {
  name: 'finish',
  description: 'Terminá la corrida con un resumen de una o dos oraciones de lo que hiciste o propusiste y por qué.',
  input_schema: { type: 'object', properties: { resumen: { type: 'string', maxLength: 500 } }, required: ['resumen'] },
};

function definitions({ includeFinish = false } = {}) {
  const defs = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  return includeFinish ? [...defs, FINISH_TOOL] : defs;
}

async function needsApproval(name) {
  const cfg = await config.get();
  if (cfg.mode === 'shadow') return true;
  if (BY_NAME[name]?.clienteFinal && !cfg.whatsapp_automatico) return true;
  return cfg.tools_con_aprobacion.includes(name);
}

/**
 * Ejecuta una herramienta aplicando la política.
 * meta: { source: 'agent'|'mcp', runId, eventId, reason }
 * Devuelve siempre un objeto serializable (nunca tira).
 */
async function executeTool(name, args = {}, meta = {}) {
  const tool = BY_NAME[name];
  if (!tool) return { error: `Herramienta desconocida: ${name}` };

  if (tool.readOnly) {
    try { return await tool.run(args); }
    catch (e) { return { error: e.userFacing ? e.message : 'Error interno consultando el CRM' }; }
  }

  const leadId = Number.isInteger(args.lead_id) ? args.lead_id : null;
  if (leadId) {
    const [dup] = await ctx.pool.execute(
      "SELECT id FROM agent_actions WHERE lead_id = ? AND tool = ? AND status = 'pending' LIMIT 1", [leadId, name]);
    if (dup.length) return { error: `Ya hay una acción ${name} pendiente para este lead (#${dup[0].id}). No la repitas.` };
  }
  const base = [meta.runId || null, meta.eventId || null, leadId, name, JSON.stringify(args), meta.reason || args.motivo || null, meta.source || 'agent'];

  if (await needsApproval(name)) {
    const [r] = await ctx.pool.execute(
      `INSERT INTO agent_actions (run_id, event_id, lead_id, tool, args, reason, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`, base);
    if (ctx.io) ctx.io.emit('agent:action', { id: r.insertId, status: 'pending', tool: name, lead_id: leadId });
    return { queued: true, action_id: r.insertId, mensaje: 'Acción en la bandeja: se ejecuta cuando un gerente la apruebe.' };
  }

  try {
    const result = await tool.run(args);
    await ctx.pool.execute(
      `INSERT INTO agent_actions (run_id, event_id, lead_id, tool, args, reason, source, status, result, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'executed', ?, NOW())`,
      [...base, JSON.stringify(result)]);
    return result;
  } catch (e) {
    const msg = e.userFacing ? e.message : 'Error interno ejecutando la acción';
    if (!e.userFacing) console.error(`[agente] ${name}:`, e);
    await ctx.pool.execute(
      `INSERT INTO agent_actions (run_id, event_id, lead_id, tool, args, reason, source, status, result) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?)`,
      [...base, JSON.stringify({ error: msg })]);
    return { error: msg };
  }
}

/** Aprueba y ejecuta una acción pendiente. */
async function approveAction(actionId, userId) {
  const [claim] = await ctx.pool.execute(
    "UPDATE agent_actions SET status = 'approved', decided_by = ?, decided_at = NOW() WHERE id = ? AND status = 'pending'",
    [userId, actionId]);
  if (!claim.affectedRows) return { ok: false, error: 'La acción no existe o ya se resolvió' };
  const [[action]] = await ctx.pool.execute('SELECT * FROM agent_actions WHERE id = ?', [actionId]);
  const tool = BY_NAME[action.tool];
  try {
    const result = await tool.run(parseJSON(action.args) || {});
    await ctx.pool.execute("UPDATE agent_actions SET result = ?, executed_at = NOW() WHERE id = ?", [JSON.stringify(result), actionId]);
    if (ctx.io) ctx.io.emit('agent:action', { id: actionId, status: 'approved' });
    return { ok: true, result };
  } catch (e) {
    const msg = e.userFacing ? e.message : 'Error interno ejecutando la acción';
    if (!e.userFacing) console.error(`[agente] aprobar #${actionId}:`, e);
    await ctx.pool.execute("UPDATE agent_actions SET status = 'failed', result = ? WHERE id = ?", [JSON.stringify({ error: msg }), actionId]);
    return { ok: false, error: msg };
  }
}

async function rejectAction(actionId, userId, note) {
  const [r] = await ctx.pool.execute(
    "UPDATE agent_actions SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ? AND status = 'pending'",
    [userId, note ? String(note).slice(0, 255) : null, actionId]);
  if (r.affectedRows && ctx.io) ctx.io.emit('agent:action', { id: actionId, status: 'rejected' });
  return r.affectedRows ? { ok: true } : { ok: false, error: 'La acción no existe o ya se resolvió' };
}

module.exports = {
  init, definitions, executeTool, approveAction, rejectAction,
  getLeadContext: (id) => BY_NAME.get_lead.run({ lead_id: id }),
  isReadOnly: (name) => !!BY_NAME[name]?.readOnly,
  agentUserId: () => ctx.agentUser?.id,
  has: (name) => !!BY_NAME[name],
  ESTADOS, ESTADOS_CERRADOS,
};
