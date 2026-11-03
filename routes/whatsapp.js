/**
 * ============================================
 * WHATSAPP DESDE EL CRM  (/api/whatsapp)
 * ============================================
 * El mini-chat de cada lead lee las charlas directo de la base (wa_messages /
 * wa_conversations, que escribe el bot) y manda mensajes a través del bot.
 * Todo con el login del CRM: cada usuario ve solo los leads que le tocan.
 *
 * Variables (las mismas del Agente IA):
 *   WA_BOT_URL  default https://api.crmalluma.com.ar/wa-fiat
 *   WA_BOT_KEY  = AGENT_BOT_KEY del .env del bot
 */
const express = require('express');
const axios = require('axios');
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const WA_BOT_URL = (process.env.WA_BOT_URL || 'https://api.crmalluma.com.ar/wa-fiat').replace(/\/$/, '');

const digits = (s) => String(s || '').replace(/\D/g, '');
const clave = (tel) => digits(tel).slice(-10);

/**
 * Teléfono en formato WhatsApp (549 + 10 dígitos) a partir de lo cargado en
 * el lead: acepta 11 2345-6789, 011 15 2345-6789, +54 9 11..., 54 11..., etc.
 */
function telefonoWhatsApp(tel) {
  let d = digits(tel);
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  // Sacar el "15" de celular que va después del código de área (2, 3 o 4 dígitos)
  if (d.length === 12) {
    for (const a of [2, 3, 4]) {
      if (d.slice(a, a + 2) === '15') { d = d.slice(0, a) + d.slice(a + 2); break; }
    }
  }
  return d.length === 10 ? `549${d}` : digits(tel);
}

/** Lead + permiso: owner/director/gerente todo; supervisor su equipo; vendedor lo suyo. */
async function leadAccesible(req, leadId) {
  const [[lead]] = await pool.execute('SELECT id, nombre, telefono, modelo, assigned_to FROM leads WHERE id = ?', [leadId]);
  if (!lead) return { error: 404 };
  const { id, role } = req.user;
  if (['owner', 'dueño', 'director', 'gerente'].includes(role)) return { lead };
  if (lead.assigned_to === id) return { lead };
  if (role === 'supervisor' && lead.assigned_to) {
    const [[v]] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (reportsTo = ? OR reportsTo IN (SELECT id FROM users WHERE reportsTo = ?))',
      [lead.assigned_to, id, id]);
    if (v) return { lead };
  }
  return { error: 403 };
}

function responderError(res, code) {
  return res.status(code).json({ ok: false, error: code === 404 ? 'Lead no encontrado' : 'No tenés acceso a este lead' });
}

/** Número exacto y sesión del bot con los que se chateó con este lead. */
async function charlaDelLead(lead) {
  const k = clave(lead.telefono);
  const [m] = await pool.execute(
    `SELECT phone, session_id FROM wa_messages
      WHERE lead_id = ? ${k.length >= 8 ? 'OR phone LIKE ?' : ''}
      ORDER BY id DESC LIMIT 1`,
    k.length >= 8 ? [lead.id, `%${k}`] : [lead.id]);
  const [c] = k.length >= 8
    ? await pool.execute('SELECT * FROM wa_conversations WHERE phone LIKE ? ORDER BY updated_at DESC LIMIT 1', [`%${k}`])
    : [[]];
  return { phone: m[0]?.phone || c[0]?.phone || null, session: m[0]?.session_id || c[0]?.session_id || null, conv: c[0] || null };
}

// GET charla completa del lead
router.get('/leads/:leadId', authenticateToken, async (req, res) => {
  try {
    const { lead, error } = await leadAccesible(req, parseInt(req.params.leadId, 10));
    if (error) return responderError(res, error);
    const k = clave(lead.telefono);
    const [rows] = await pool.execute(
      `SELECT id, phone, session_id, direction, sent_by, message, media_type, media_url, timestamp, created_at
         FROM wa_messages
        WHERE lead_id = ? ${k.length >= 8 ? 'OR phone LIKE ?' : ''}
        ORDER BY id DESC LIMIT 300`,
      k.length >= 8 ? [lead.id, `%${k}`] : [lead.id]);
    const { conv } = await charlaDelLead(lead);
    res.json({
      ok: true,
      conversation: conv && {
        phone: conv.phone,
        nombre: conv.nombre,
        modelo: conv.modelo,
        step: conv.step,
        origen: conv.origen,
        vendorTakeover: !!conv.vendor_takeover,
        leadSent: !!conv.lead_sent,
      },
      messages: rows.reverse(),
    });
  } catch (e) {
    console.error('[whatsapp] GET charla:', e);
    res.status(500).json({ ok: false, error: 'No se pudo cargar la charla' });
  }
});

async function enviarPorBot(req, res, extra) {
  const { lead, error } = await leadAccesible(req, parseInt(req.params.leadId, 10));
  if (error) return responderError(res, error);
  if (!process.env.WA_BOT_KEY) return res.status(500).json({ ok: false, error: 'Falta WA_BOT_KEY en el backend' });

  const { phone, session } = await charlaDelLead(lead);
  // Si ya chatearon, se responde desde el mismo número; si no, desde el del vendedor asignado
  const userId = session ? parseInt(String(session).replace('user_', ''), 10) : lead.assigned_to;
  if (!userId) return res.status(409).json({ ok: false, error: 'El lead no tiene vendedor asignado' });

  try {
    await axios.post(`${WA_BOT_URL}/api/agent/send`, {
      userId,
      phone: phone || telefonoWhatsApp(lead.telefono),
      leadId: lead.id,
      sentBy: 'vendedor',
      ...extra,
    }, { headers: { 'x-agent-key': process.env.WA_BOT_KEY }, timeout: 30000, maxBodyLength: 20 * 1024 * 1024 });
    res.json({ ok: true });
  } catch (e) {
    const msg = e.response?.data?.error || 'El bot de WhatsApp no respondió';
    console.error('[whatsapp] enviar:', msg);
    res.status(e.response?.status === 409 ? 409 : 502).json({ ok: false, error: msg });
  }
}

// POST texto
router.post('/leads/:leadId/send', authenticateToken, async (req, res) => {
  const texto = String(req.body?.message || '').trim();
  if (!texto) return res.status(400).json({ ok: false, error: 'El mensaje está vacío' });
  if (texto.length > 4000) return res.status(400).json({ ok: false, error: 'Mensaje demasiado largo' });
  await enviarPorBot(req, res, { texto });
});

// POST imagen (base64)
router.post('/leads/:leadId/send-image', authenticateToken, async (req, res) => {
  const { base64, mimetype, caption } = req.body || {};
  if (!base64 || !/^image\/(jpeg|png|webp)$/.test(mimetype || '')) {
    return res.status(400).json({ ok: false, error: 'Mandá una imagen JPG, PNG o WEBP' });
  }
  await enviarPorBot(req, res, { texto: String(caption || '').slice(0, 1000), imagen: { base64, mimetype } });
});

// POST tomar la charla (el bot se calla) o devolvérsela al bot
router.post('/leads/:leadId/takeover', authenticateToken, async (req, res) => {
  try {
    const { lead, error } = await leadAccesible(req, parseInt(req.params.leadId, 10));
    if (error) return responderError(res, error);
    const { conv } = await charlaDelLead(lead);
    if (!conv) return res.status(404).json({ ok: false, error: 'Este lead no tiene charla con el bot' });
    const activo = req.body?.vendedor !== false;
    await pool.execute('UPDATE wa_conversations SET vendor_takeover = ? WHERE phone = ?', [activo ? 1 : 0, conv.phone]);
    res.json({ ok: true, vendorTakeover: activo });
  } catch (e) {
    console.error('[whatsapp] takeover:', e);
    res.status(500).json({ ok: false, error: 'No se pudo cambiar el control de la charla' });
  }
});

module.exports = router;
