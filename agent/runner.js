/**
 * ============================================
 * AGENTE IA — CORRIDA SOBRE UN EVENTO
 * ============================================
 * Un evento (lead nuevo, SLA vencido, no contesta, estancado, manual) se
 * convierte en una corrida: el modelo recibe el contexto completo del lead,
 * decide qué hacer y actúa solo a través de las herramientas de tools.js.
 * Todo queda en agent_runs (con transcript) y agent_actions.
 */
const llm = require('./llm');
const tools = require('./tools');
const config = require('./config');

const MAX_STEPS = 8;
let pool = null;
function init(p) { pool = p; }

const EVENTOS = {
  'lead.created': (p) =>
    `Entró un lead nuevo${p.fuente ? ` por ${p.fuente}` : ''}. Revisalo: ¿es duplicado de otro lead reciente (buscá por teléfono)? ¿El vendedor asignado está activo? ¿Faltan datos clave (modelo, forma de pago)? Dejale al vendedor una nota corta con el contexto útil y el primer paso concreto.`,
  'lead.sla_nuevo': (p) =>
    p.nivel === 2
      ? `El lead sigue en "nuevo" ${p.minutos} minutos después de asignado, sin llamadas ni notas, y el vendedor ya fue avisado. Proponé reasignarlo a un vendedor activo del mismo equipo con poca carga y que se haya conectado hoy, y avisale al supervisor del vendedor actual.`
      : `El lead lleva ${p.minutos} minutos en "nuevo" sin llamadas ni notas del vendedor. Avisale al vendedor con un mensaje corto y directo para que lo contacte ya.`,
  'lead.no_contesta': (p) =>
    `El vendedor marcó el lead como "${p.estado}". Programá un recordatorio de rellamado en otra franja horaria (si antes se llamó a la mañana, a la tarde, y al revés).${p.estado !== 'no_contesta_1' ? ' Si el lead tiene charla de WhatsApp, proponé además un mensaje corto de seguimiento con send_whatsapp retomando lo que había consultado. No lo des por perdido.' : ''}`,
  'lead.respondio': (p) =>
    `El cliente contestó por WhatsApp el seguimiento que se le mandó: "${p.mensaje}". Avisale al vendedor asignado con notify_user, en una línea, qué respondió y qué conviene hacer ahora. No le mandes otro WhatsApp.`,
  'lead.estancado': (p) =>
    `El lead está en "${p.estado}" sin movimiento hace ${p.dias} días y no tiene recordatorios pendientes. Mirá el historial y los mensajes, y dejale al vendedor un próximo paso concreto (recordatorio con fecha y una nota con qué decir).`,
  manual: (p) =>
    `Un gerente pidió que revises este lead.${p.instruccion ? ` Su instrucción: "${p.instruccion}"` : ' Analizalo y hacé lo que haga falta para que avance.'}`,
};

async function systemPrompt() {
  const cfg = await config.get();
  const ahora = config.nowArg();
  const aprob = cfg.mode === 'shadow'
    ? 'El sistema está en modo sombra: TODAS tus acciones de escritura quedan pendientes de aprobación de un gerente. Proponé igual lo que harías.'
    : `Estas acciones quedan pendientes de aprobación de un gerente: ${cfg.tools_con_aprobacion.join(', ') || 'ninguna'}. El resto se ejecuta al instante.`;
  return `Sos el agente operativo del CRM de Auto del Sol Fiat, una concesionaria de Argentina. No conversás con clientes (eso lo hacen el bot y los vendedores): trabajás para el equipo comercial y, como mucho, mandás seguimientos puntuales por WhatsApp. Tu objetivo es que ningún lead se enfríe por falta de seguimiento.

Ahora es ${ahora.iso} (hora Argentina). Horario comercial: ${cfg.horario_inicio}:00 a ${cfg.horario_fin}:00. Nunca programes recordatorios fuera de ese horario ni en domingo.

Estados posibles: ${tools.ESTADOS.join(', ')}. "rechazado_supervisor" no lo tocás nunca.

Reglas:
- Actuás solo con las herramientas. ${aprob}${cfg.mode !== 'shadow' && cfg.whatsapp_automatico ? ' Los WhatsApp a clientes salen directo, sin revisión: escribilos con cuidado.' : ' Los WhatsApp a clientes pasan por aprobación.'}
- Hacé lo mínimo que sirva: máximo ${cfg.max_acciones_corrida} acciones por análisis, cada una con un fin distinto. Si no hace falta nada, no hagas nada y explicalo en finish.
- Antes de actuar mirá "acciones_del_agente_7d" y las notas: no repitas algo que ya hiciste o propusiste con este lead.
- create_recordatorio y reassign_lead ya le avisan al vendedor: no mandes además notify_user diciendo lo mismo. Una nota no tiene que repetir lo que dice el recordatorio.
- Notas y alertas en español rioplatense, cortas, concretas y accionables. Nada de saludos ni relleno.
- No inventes precios ni promociones: si los necesitás, usá list_planes.
- No marques un lead como perdido o vendido por tu cuenta, salvo que un gerente lo pida en una instrucción manual.
- No reasignes si el vendedor actual tuvo actividad en el lead en las últimas horas (llamadas, notas o WhatsApp con sent_by "vendedor").
- send_whatsapp: solo si el lead ya chateó por WhatsApp, máximo uno por análisis, 2-3 líneas, tono natural de la concesionaria, retomando lo que consultó. Sin precios inventados (usá list_planes), sin firmar como una persona y, si te preguntan, no digas que sos humano.
- Siempre terminá llamando a finish con un resumen de una o dos oraciones.${cfg.instrucciones_extra ? `\n\nInstrucciones del dueño:\n${cfg.instrucciones_extra}` : ''}`;
}

/** Algunos eventos dejan de tener sentido si el lead cambió mientras esperaban en la cola. */
function sigueVigente(type, payload, lead) {
  if (!lead) return 'El lead ya no existe';
  if (type === 'lead.sla_nuevo' && lead.estado !== 'nuevo') return `El lead ya pasó a "${lead.estado}"`;
  if (type === 'lead.sla_nuevo' && payload.assigned_to && lead.vendedor?.id !== payload.assigned_to) return 'El lead ya fue reasignado';
  if (type === 'lead.no_contesta' && lead.estado !== payload.estado) return `El lead ya pasó a "${lead.estado}"`;
  if (type === 'lead.estancado' && lead.estado !== payload.estado) return `El lead ya pasó a "${lead.estado}"`;
  if (type !== 'manual' && tools.ESTADOS_CERRADOS.includes(lead.estado)) return `El lead está cerrado (${lead.estado})`;
  return null;
}

/**
 * Devuelve { status: 'done'|'skipped', runId?, summary?, reason? }.
 * Tira error solo si falla la API o la base (el worker reintenta).
 */
async function run(event) {
  const payload = (typeof event.payload === 'string' ? JSON.parse(event.payload || '{}') : event.payload) || {};
  const contexto = await tools.getLeadContext(event.lead_id).catch(() => null);
  const motivoSkip = sigueVigente(event.type, payload, contexto?.lead);
  if (motivoSkip) return { status: 'skipped', reason: motivoSkip };

  const describir = EVENTOS[event.type];
  if (!describir) return { status: 'skipped', reason: `Tipo de evento desconocido: ${event.type}` };

  const [r] = await pool.execute(
    'INSERT INTO agent_runs (event_id, lead_id, trigger_type, model) VALUES (?, ?, ?, ?)',
    [event.id, event.lead_id, event.type, llm.MODEL]);
  const runId = r.insertId;

  const system = await systemPrompt();
  const defs = tools.definitions({ includeFinish: true });
  const messages = [{
    role: 'user',
    content: `${describir(payload)}\n\nContexto completo del lead #${event.lead_id}:\n${JSON.stringify(contexto)}`,
  }];

  const cfgRun = await config.get();
  let escrituras = 0;
  let steps = 0, inTok = 0, outTok = 0, summary = null;
  try {
    while (steps < MAX_STEPS) {
      steps++;
      const resp = await llm.createMessage({ system, messages, tools: defs });
      inTok += resp.usage?.input_tokens || 0;
      outTok += resp.usage?.output_tokens || 0;
      messages.push({ role: 'assistant', content: resp.content });

      const calls = resp.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        summary = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || 'Sin acciones.';
        break;
      }

      const results = [];
      for (const c of calls) {
        if (c.name === 'finish') {
          summary = String(c.input?.resumen || '').trim() || 'Sin resumen.';
          results.push({ type: 'tool_result', tool_use_id: c.id, content: 'ok' });
          continue;
        }
        let out;
        if (!tools.isReadOnly(c.name) && tools.has(c.name) && escrituras >= cfgRun.max_acciones_corrida) {
          out = { error: `Límite de ${cfgRun.max_acciones_corrida} acciones por análisis alcanzado. Terminá con finish.` };
        } else {
          if (!tools.isReadOnly(c.name) && tools.has(c.name)) escrituras++;
          out = await tools.executeTool(c.name, c.input || {}, { source: 'agent', runId, eventId: event.id });
        }
        const text = JSON.stringify(out);
        results.push({
          type: 'tool_result',
          tool_use_id: c.id,
          content: text.length > 8000 ? text.slice(0, 8000) + '…(recortado)' : text,
          ...(out && out.error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
      if (summary !== null) break;
    }
    if (summary === null) summary = `Corte por límite de ${MAX_STEPS} pasos.`;

    await pool.execute(
      `UPDATE agent_runs SET status = 'done', steps = ?, input_tokens = ?, output_tokens = ?, summary = ?, transcript = ?, finished_at = NOW() WHERE id = ?`,
      [steps, inTok, outTok, summary.slice(0, 2000), JSON.stringify(messages), runId]);
    return { status: 'done', runId, summary };
  } catch (e) {
    await pool.execute(
      `UPDATE agent_runs SET status = 'error', steps = ?, input_tokens = ?, output_tokens = ?, error = ?, transcript = ?, finished_at = NOW() WHERE id = ?`,
      [steps, inTok, outTok, String(e.message).slice(0, 2000), JSON.stringify(messages), runId]).catch(() => {});
    throw e;
  }
}

module.exports = { init, run, EVENT_TYPES: Object.keys(EVENTOS) };
