/**
 * ============================================
 * AGENTE IA — SERVIDOR MCP  (POST /mcp)
 * ============================================
 * Expone las mismas herramientas del agente por Model Context Protocol
 * (transporte Streamable HTTP, respuestas JSON, sin sesión), para que
 * Claude, ChatGPT u otro agente operen el CRM con las MISMAS reglas: las
 * acciones de escritura respetan modo y aprobaciones, y quedan registradas
 * con source = 'mcp'.
 *
 * Autenticación: header  Authorization: Bearer <AGENT_MCP_KEY>
 * Si AGENT_MCP_KEY no está definida, el endpoint responde 404.
 */
const crypto = require('crypto');
const router = require('express').Router();
const tools = require('./tools');

const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function autorizado(req) {
  const key = process.env.AGENT_MCP_KEY;
  if (!key) return null;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(String(token));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  const esNotificacion = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOLOS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLOS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'autodelsol-fiat-crm', version: '1.0.0' },
        instructions: 'CRM de Auto del Sol Fiat. Consultá con get_lead / search_leads / list_vendedores / list_planes. Las acciones de escritura pueden quedar pendientes de aprobación de un gerente: si la respuesta trae queued: true, avisalo así.',
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: tools.definitions().map((t) => ({ ...t, inputSchema: t.input_schema, input_schema: undefined })) });
    case 'tools/call': {
      if (!tools.has(params.name)) return err(id, -32602, `Herramienta desconocida: ${params.name}`);
      const out = await tools.executeTool(params.name, params.arguments || {}, { source: 'mcp' });
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }], isError: !!(out && out.error) });
    }
    default:
      if (esNotificacion) return null; // notifications/initialized, etc.
      return err(id, -32601, `Método no soportado: ${method}`);
  }
}

router.post('/', async (req, res) => {
  const auth = autorizado(req);
  if (auth === null) return res.status(404).end();
  if (!auth) return res.status(401).json(err(null, -32001, 'No autorizado'));

  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handle(body);
    if (!out) return res.status(202).end();
    res.json(out);
  } catch (e) {
    console.error('[mcp]', e);
    res.status(500).json(err(req.body?.id, -32603, 'Error interno'));
  }
});

// Sin streaming del lado del servidor ni sesiones.
router.get('/', (_req, res) => res.status(405).set('Allow', 'POST').end());
router.delete('/', (_req, res) => res.status(405).set('Allow', 'POST').end());

module.exports = router;
