/**
 * ============================================
 * AGENTE IA — DETECTOR DE EVENTOS
 * ============================================
 * Mira la base cada minuto y encola eventos en agent_events. No toca
 * ninguna ruta existente del CRM: lee leads, lead_history y actividad.
 * dedupe_key + INSERT IGNORE garantizan que cada evento entre una vez.
 *
 *   lead.created     -> lead con id mayor al último visto
 *   lead.no_contesta -> cambio de estado a no_contesta_N (hecho por personas)
 *   lead.sla_nuevo   -> asignado hace > SLA y sin llamadas ni notas (nivel 1,
 *                       aviso); si sigue igual 2×SLA después del aviso
 *                       (nivel 2: propone reasignar)
 *   lead.estancado   -> contactado/interesado/negociacion/rellamado sin
 *                       actividad hace N días y sin recordatorio pendiente
 *   lead.respondio   -> el cliente contestó un seguimiento del agente
 * Además (sin IA, aunque el agente esté apagado): cuando vence un
 * recordatorio, le deja una alerta ⏰ al vendedor del lead.
 * "Actividad" incluye llamadas, notas y WhatsApp escrito por el vendedor.
 * Los dos últimos solo se detectan en horario comercial.
 */
const config = require('./config');

let pool = null;
let agentUserId = null;
let io = null;
function init(p, uid, socketIo) { pool = p; agentUserId = uid; io = socketIo || null; }

/**
 * Recordatorios que vencieron (fecha + hora en horario de Argentina) y todavía
 * no avisaron: alerta al vendedor del lead (o a quien lo creó). Una sola vez
 * por recordatorio; solo los de las últimas 48 h para no inundar con viejos.
 */
async function avisarRecordatoriosVencidos() {
  const ahora = config.nowArg();
  const [rows] = await pool.execute(
    `SELECT r.id, r.lead_id, r.descripcion, TIME_FORMAT(r.hora, '%H:%i') AS hora,
            COALESCE(l.assigned_to, r.created_by) AS destinatario, l.nombre
       FROM recordatorios r
       JOIN leads l ON l.id = r.lead_id
      WHERE r.completado = 0
        AND TIMESTAMP(r.fecha, r.hora) <= ?
        AND TIMESTAMP(r.fecha, r.hora) > ? - INTERVAL 48 HOUR
        AND NOT EXISTS (SELECT 1 FROM alertas a WHERE a.related_id = r.id AND a.type = 'recordatorio' AND a.message LIKE '⏰%')
      LIMIT 100`,
    [`${ahora.iso}:00`, `${ahora.iso}:00`]);
  for (const r of rows) {
    if (!r.destinatario) continue;
    const desc = String(r.descripcion || '').replace(/^🤖\s*/, '');
    const msg = `⏰ Es hora: ${r.nombre} — ${desc}`.slice(0, 500);
    await pool.execute(
      `INSERT INTO alertas (user_id, type, message, lead_id, related_id, timestamp) VALUES (?, 'recordatorio', ?, ?, ?, NOW())`,
      [r.destinatario, msg, r.lead_id, r.id]);
    if (io) {
      io.emit('notification', {
        id: `rec-${r.id}`, type: 'alert', title: '⏰ Recordatorio', message: msg,
        timestamp: new Date().toISOString(), read: false, severity: 'info', leadId: r.lead_id, targetUserId: r.destinatario,
      });
    }
  }
  return rows.length;
}

async function enqueue(type, leadId, payload, dedupeKey, createdBy = null) {
  const [r] = await pool.execute(
    'INSERT IGNORE INTO agent_events (type, lead_id, payload, dedupe_key, created_by) VALUES (?, ?, ?, ?, ?)',
    [type, leadId, JSON.stringify(payload || {}), dedupeKey.slice(0, 120), createdBy]);
  return r.insertId || null;
}

async function maxId(table) {
  const [[r]] = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`);
  return Number(r.m);
}

async function scanNuevos(activo) {
  let cursor = await config.getCursor('leads');
  if (cursor === null) { await config.setCursor('leads', await maxId('leads')); return 0; }
  const [rows] = await pool.execute('SELECT id, fuente FROM leads WHERE id > ? ORDER BY id LIMIT 200', [cursor]);
  let n = 0;
  for (const l of rows) {
    if (activo && (await enqueue('lead.created', l.id, { fuente: l.fuente }, `created:${l.id}`))) n++;
    cursor = l.id;
  }
  if (rows.length) await config.setCursor('leads', cursor);
  return n;
}

async function scanCambiosEstado(activo) {
  let cursor = await config.getCursor('history');
  if (cursor === null) { await config.setCursor('history', await maxId('lead_history')); return 0; }
  const [rows] = await pool.execute(
    `SELECT id, lead_id, field_name, new_value, user_id FROM lead_history WHERE id > ? ORDER BY id LIMIT 500`, [cursor]);
  let n = 0;
  for (const h of rows) {
    cursor = h.id;
    if (!activo || h.user_id === agentUserId) continue;
    const campo = String(h.field_name || '').toLowerCase();
    if (campo === 'estado' && /^no_contesta_[123]$/.test(h.new_value)) {
      if (await enqueue('lead.no_contesta', h.lead_id, { estado: h.new_value }, `nocontesta:${h.id}`)) n++;
    }
  }
  if (rows.length) await config.setCursor('history', cursor);
  return n;
}

async function scanSLA(cfg) {
  const sla = cfg.sla_nuevo_min;
  const [rows] = await pool.execute(
    `SELECT l.id, l.assigned_to, l.assigned_at, TIMESTAMPDIFF(MINUTE, l.assigned_at, NOW()) AS minutos
       FROM leads l
      WHERE l.estado = 'nuevo' AND l.assigned_to IS NOT NULL
        AND l.assigned_at < NOW() - INTERVAL ? MINUTE
        AND l.assigned_at > NOW() - INTERVAL 3 DAY
        AND NOT EXISTS (SELECT 1 FROM call_logs c WHERE c.lead_id = l.id AND c.created_at >= l.assigned_at)
        AND NOT EXISTS (SELECT 1 FROM notas_internas n WHERE n.lead_id = l.id AND n.user_id <> ? AND n.timestamp >= l.assigned_at)
        AND NOT EXISTS (SELECT 1 FROM wa_messages w WHERE w.lead_id = l.id AND w.direction = 'out' AND w.sent_by = 'vendedor' AND w.created_at >= l.assigned_at)
      ORDER BY l.assigned_at LIMIT 50`, [sla, agentUserId]);
  let n = 0;
  for (const l of rows) {
    const ts = new Date(l.assigned_at).getTime();
    const base = { minutos: l.minutos, assigned_to: l.assigned_to };
    // Nivel 1: aviso al vendedor. Nivel 2 (propuesta de reasignar) recién
    // cuando el aviso ya se procesó hace 2×SLA y el lead sigue igual: así
    // los leads que entran de noche no se reasignan a primera hora.
    if (await enqueue('lead.sla_nuevo', l.id, { ...base, nivel: 1 }, `sla1:${l.id}:${ts}`)) { n++; continue; }
    const [[aviso]] = await pool.execute(
      `SELECT COUNT(*) AS ok FROM agent_events
        WHERE dedupe_key = ? AND status IN ('done','skipped') AND processed_at < NOW() - INTERVAL ? MINUTE`,
      [`sla1:${l.id}:${ts}`, sla * 2]);
    if (aviso.ok && (await enqueue('lead.sla_nuevo', l.id, { ...base, nivel: 2 }, `sla2:${l.id}:${ts}`))) n++;
  }
  return n;
}

async function scanEstancados(cfg) {
  const d = cfg.estancado_dias;
  const [rows] = await pool.execute(
    `SELECT l.id, l.estado, YEARWEEK(NOW(), 1) AS semana
       FROM leads l
      WHERE l.estado IN ('contactado','interesado','negociacion','rellamado')
        AND l.assigned_to IS NOT NULL
        AND l.updated_at < NOW() - INTERVAL ? DAY
        AND l.updated_at > NOW() - INTERVAL 45 DAY
        AND NOT EXISTS (SELECT 1 FROM recordatorios r WHERE r.lead_id = l.id AND r.completado = 0 AND r.fecha >= CURDATE())
        AND NOT EXISTS (SELECT 1 FROM notas_internas n WHERE n.lead_id = l.id AND n.timestamp > NOW() - INTERVAL ? DAY)
        AND NOT EXISTS (SELECT 1 FROM call_logs c WHERE c.lead_id = l.id AND c.created_at > NOW() - INTERVAL ? DAY)
        AND NOT EXISTS (SELECT 1 FROM wa_messages w WHERE w.lead_id = l.id AND w.created_at > NOW() - INTERVAL ? DAY)
      ORDER BY l.updated_at DESC LIMIT 20`, [d, d, d, d]);
  let n = 0;
  for (const l of rows) {
    if (await enqueue('lead.estancado', l.id, { estado: l.estado, dias: d }, `estancado:${l.id}:${l.semana}`)) n++;
  }
  return n;
}

async function scanRespuestas(activo) {
  let cursor = await config.getCursor('wa');
  if (cursor === null) { await config.setCursor('wa', await maxId('wa_messages')); return 0; }
  const [rows] = await pool.execute(
    `SELECT id, phone, lead_id, message FROM wa_messages WHERE id > ? AND direction = 'in' ORDER BY id LIMIT 500`, [cursor]);
  let n = 0;
  for (const m of rows) {
    cursor = m.id;
    if (!activo) continue;
    const [ag] = await pool.execute(
      `SELECT id, lead_id FROM wa_messages
        WHERE phone = ? AND sent_by = 'agente' AND id < ? AND created_at > NOW() - INTERVAL 7 DAY
        ORDER BY id DESC LIMIT 1`, [m.phone, m.id]);
    const leadId = m.lead_id || ag[0]?.lead_id;
    if (!ag.length || !leadId) continue;
    // Una sola vez por seguimiento: la primera respuesta después de ese mensaje
    if (await enqueue('lead.respondio', leadId, { mensaje: String(m.message || '').slice(0, 300) }, `respondio:${ag[0].id}`)) n++;
  }
  if (rows.length) await config.setCursor('wa', cursor);
  return n;
}

let corriendo = false;
async function tick() {
  if (corriendo) return;
  corriendo = true;
  try {
    const vencidos = await avisarRecordatoriosVencidos().catch((e) => { console.error('[agente] recordatorios vencidos:', e.message); return 0; });
    if (vencidos) console.log(`⏰ ${vencidos} recordatorios vencidos avisados`);
    const cfg = await config.get();
    const activo = cfg.mode !== 'off';
    const nuevos = await scanNuevos(activo);
    const estados = await scanCambiosEstado(activo);
    const respuestas = await scanRespuestas(activo);
    let sla = 0, estancados = 0;
    if (activo && config.enHorario(cfg)) {
      sla = await scanSLA(cfg);
      estancados = await scanEstancados(cfg);
    }
    const total = nuevos + estados + respuestas + sla + estancados;
    if (total) console.log(`🤖 Eventos: ${nuevos} nuevos, ${estados} no contesta, ${respuestas} respuestas, ${sla} SLA, ${estancados} estancados`);
  } catch (e) {
    console.error('[agente] scanner:', e.message);
  } finally {
    corriendo = false;
  }
}

module.exports = { init, tick, enqueue };
