/**
 * ============================================
 * AGENTE IA — WORKER DE LA COLA
 * ============================================
 * Procesa agent_events de a uno (una sola instancia en Railway). Reintenta
 * hasta 3 veces con espera creciente si falla la API. Respeta el tope
 * diario de corridas y el modo off.
 */
const config = require('./config');
const llm = require('./llm');
const runner = require('./runner');

let pool = null;
let avisoSinKey = false;
function init(p) { pool = p; }

async function finish(id, status, extra = {}) {
  await pool.execute(
    'UPDATE agent_events SET status = ?, error = ?, run_id = ?, processed_at = NOW() WHERE id = ?',
    [status, extra.error ? String(extra.error).slice(0, 1000) : null, extra.runId || null, id]);
}

async function procesar(ev) {
  const [claim] = await pool.execute(
    "UPDATE agent_events SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'pending'", [ev.id]);
  if (!claim.affectedRows) return;

  const cfg = await config.get();
  if (cfg.mode === 'off') return finish(ev.id, 'skipped', { error: 'Agente apagado' });
  if (!llm.hasKey()) {
    if (!avisoSinKey) { console.warn(`⚠️  Agente IA: falta ${llm.KEY_VAR}, los eventos se descartan`); avisoSinKey = true; }
    return finish(ev.id, 'skipped', { error: `Falta ${llm.KEY_VAR}` });
  }
  const [[{ hoy }]] = await pool.query('SELECT COUNT(*) AS hoy FROM agent_runs WHERE created_at >= CURDATE()');
  if (hoy >= cfg.max_runs_dia) return finish(ev.id, 'skipped', { error: `Tope diario de ${cfg.max_runs_dia} corridas` });

  try {
    const r = await runner.run(ev);
    await finish(ev.id, r.status, { runId: r.runId, error: r.reason });
  } catch (e) {
    console.error(`[agente] evento #${ev.id} (${ev.type}):`, e.message);
    if (ev.attempts + 1 >= 3) return finish(ev.id, 'error', { error: e.message });
    await pool.execute(
      "UPDATE agent_events SET status = 'pending', error = ?, next_attempt_at = NOW() + INTERVAL ? MINUTE WHERE id = ?",
      [String(e.message).slice(0, 1000), 2 * (ev.attempts + 1), ev.id]);
  }
}

let corriendo = false;
async function tick() {
  if (corriendo) return;
  corriendo = true;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM agent_events
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        ORDER BY (type = 'manual') DESC, id LIMIT 5`);
    for (const ev of rows) await procesar(ev);
  } catch (e) {
    console.error('[agente] worker:', e.message);
  } finally {
    corriendo = false;
  }
}

/** Al arrancar: lo que quedó a medias por un reinicio vuelve a la cola (hay una sola instancia). */
async function recuperarColgados() {
  const [r] = await pool.query(
    "UPDATE agent_events SET status = 'pending' WHERE status = 'processing'");
  if (r.affectedRows) console.log(`🤖 ${r.affectedRows} eventos colgados devueltos a la cola`);
  await pool.query(
    "UPDATE agent_runs SET status = 'error', error = 'Interrumpida por reinicio', finished_at = NOW() WHERE status = 'running'");
}

module.exports = { init, tick, recuperarColgados };
