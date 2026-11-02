/**
 * ============================================
 * AGENTE IA — CLIENTE LLM (OpenAI o Anthropic)
 * ============================================
 * El runner habla siempre en formato Anthropic (bloques text / tool_use /
 * tool_result). Si el proveedor es OpenAI, este archivo traduce ida y vuelta
 * a Chat Completions con tool calling. Así se cambia de proveedor sin tocar
 * nada más.
 *
 * Variables:
 *   OPENAI_API_KEY     -> usa OpenAI (la misma key de los bots de WhatsApp)
 *   ANTHROPIC_API_KEY  -> usa Anthropic
 *   AGENT_PROVIDER     -> 'openai' | 'anthropic' para forzar uno si están las dos
 *   AGENT_MODEL        -> modelo (default: gpt-4o-mini en OpenAI, claude-sonnet-5-5 en Anthropic)
 */
const axios = require('axios');

const PROVIDER = (process.env.AGENT_PROVIDER ||
  (process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai')).toLowerCase();

const MODEL = process.env.AGENT_MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o-mini');
const KEY_VAR = PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';

const RETRY_STATUS = [408, 409, 429, 500, 502, 503, 504, 529];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasKey = () => !!process.env[KEY_VAR];

async function post(url, body, headers) {
  let lastErr;
  for (let intento = 0; intento < 4; intento++) {
    try {
      const { data } = await axios.post(url, body, {
        timeout: 90 * 1000,
        headers: { 'content-type': 'application/json', ...headers },
      });
      return data;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status && !RETRY_STATUS.includes(status)) break;
      const retryAfter = Number(e.response?.headers?.['retry-after']);
      await sleep(retryAfter ? retryAfter * 1000 : 2000 * 2 ** intento);
    }
  }
  const status = lastErr.response?.status;
  const detalle = lastErr.response?.data?.error?.message || lastErr.message;
  throw new Error(`API ${PROVIDER}${status ? ` ${status}` : ''}: ${detalle}`);
}

// ---------- Anthropic (formato nativo) ----------
function anthropic({ system, messages, tools, maxTokens }) {
  return post(
    'https://api.anthropic.com/v1/messages',
    { model: MODEL, max_tokens: maxTokens, system, messages, tools },
    { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
  );
}

// ---------- OpenAI (traducción) ----------
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }

    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null;
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      out.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // user: resultados de herramientas y/o texto
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
      } else if (b.type === 'text') {
        out.push({ role: 'user', content: b.text });
      }
    }
  }
  return out;
}

function fromOpenAI(data) {
  const msg = data.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  return {
    content,
    stop_reason: (msg.tool_calls || []).length ? 'tool_use' : 'end_turn',
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

async function openai({ system, messages, tools, maxTokens }) {
  const data = await post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: MODEL,
      max_completion_tokens: maxTokens,
      messages: toOpenAIMessages(system, messages),
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: 'auto',
      parallel_tool_calls: true,
    },
    { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  );
  return fromOpenAI(data);
}

async function createMessage({ system, messages, tools, maxTokens = 1500 }) {
  return PROVIDER === 'anthropic'
    ? anthropic({ system, messages, tools, maxTokens })
    : openai({ system, messages, tools, maxTokens });
}

module.exports = { createMessage, hasKey, MODEL, PROVIDER, KEY_VAR };
