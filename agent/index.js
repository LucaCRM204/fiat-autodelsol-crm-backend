/**
 * ============================================
 * AGENTE IA — PUNTO DE ENTRADA
 * ============================================
 * Uso en server.js:
 *   const agent = require('./agent');
 *   agent.mount(app);                 // rutas (antes de levantar el server)
 *   await agent.start({ pool, io });  // tablas + loops (después del bootstrap)
 *
 * Variables de entorno:
 *   OPENAI_API_KEY     la misma de los bots (o ANTHROPIC_API_KEY); ver llm.js
 *   AGENT_PROVIDER     opcional: 'openai' | 'anthropic' (si están las dos)
 *   AGENT_MODEL        opcional (default gpt-4o-mini / claude-sonnet-5-5)
 *   AGENT_MCP_KEY      opcional, habilita POST /mcp
 *   AGENT_DISABLED=1   apaga los loops (útil en entornos de prueba)
 */
const { ensureSchema } = require('./schema');
const config = require('./config');
const tools = require('./tools');
const runner = require('./runner');
const scanner = require('./scanner');
const worker = require('./worker');
const llm = require('./llm');

let listo = false;
const guard = (_req, res, next) =>
  listo ? next() : res.status(503).json({ ok: false, error: 'El agente todavía no arrancó' });

function mount(app) {
  app.use('/api/agent', guard, require('./routes'));
  app.use('/mcp', guard, require('./mcp'));
}

async function start({ pool, io }) {
  try {
    const agentUser = await ensureSchema(pool);
    config.init(pool);
    tools.init({ pool, io, agentUser });
    runner.init(pool);
    scanner.init(pool, agentUser.id, io);
    worker.init(pool);
    listo = true;

    if (process.env.AGENT_DISABLED === '1') {
      console.log('🤖 Agente IA: loops desactivados (AGENT_DISABLED=1)');
      return;
    }

    await worker.recuperarColgados();
    setInterval(scanner.tick, 60 * 1000);
    setInterval(worker.tick, 5 * 1000);
    setTimeout(scanner.tick, 10 * 1000);

    const cfg = await config.get();
    console.log(`🤖 Agente IA activo — modo ${cfg.mode} · ${llm.PROVIDER}/${llm.MODEL}${llm.hasKey() ? '' : ` (sin ${llm.KEY_VAR})`}${process.env.AGENT_MCP_KEY ? ' · MCP en /mcp' : ''}`);
  } catch (e) {
    // El CRM tiene que seguir andando aunque el agente no arranque.
    console.error('❌ Agente IA no arrancó:', e.message);
  }
}

module.exports = { mount, start };
