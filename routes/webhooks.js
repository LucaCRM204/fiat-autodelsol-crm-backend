/**
 * ============================================
 * WEBHOOKS DE ENTRADA DE LEADS — Auto del Sol Fiat
 * ============================================
 * Dos endpoints:
 *   POST /api/webhooks/whatsapp-bot   -> leads que entran por el bot de WhatsApp
 *   POST /api/webhooks/zapier-formularios -> leads de formularios via Zapier
 *
 * Ambos usan la MISMA lógica de asignación: primero intentan la
 * distribución ponderada (services/distribucion.service.js) si hay un
 * equipo/líder configurado para recibir estos leads; si no, caen a un
 * round-robin parejo entre todos los vendedores activos.
 *
 * El bot de WhatsApp manda `ownerId` = el usuario dueño del número
 * que recibió el mensaje (ver asignarLeadBot):
 *   - número de un VENDEDOR      -> el lead es de ese vendedor
 *   - número de GERENCIA/SUPERV. -> se reparte entre su equipo
 *     (distribución ponderada si el equipo está configurado en
 *      distribucion_equipos; si no, round-robin dentro del equipo)
 *   - sin ownerId                -> round-robin general, como antes
 *
 * Autenticación: header `x-api-key`, validado contra LEAD_API_KEYS en
 * el .env (ver middleware/intakeAuth.js). Formato de esa variable:
 *   whatsapp-bot:clave123;zapier-formularios:clave456
 *
 * Para agregar más fuentes en el futuro, el patrón es: duplicar uno de
 * estos dos bloques, cambiar la ruta y el nombre del provider en
 * LEAD_API_KEYS. La lógica de asignación (asignarVendedor) es
 * reutilizable tal cual.
 */

const express = require('express');
const pool = require('../db');
const intakeAuth = require('../middleware/intakeAuth');
const dist = require('../services/distribucion.service');
const router = express.Router();

// Round-robin parejo de emergencia, para cuando no hay ningún equipo
// configurado en distribucion_equipos todavía.
let roundRobinIndex = 0;

async function getVendedoresActivos() {
  const [rows] = await pool.execute(
    `SELECT id, name FROM users WHERE role = 'vendedor' AND active = 1 ORDER BY id`
  );
  return rows;
}

/**
 * Elige un vendedor para el lead nuevo.
 * - Si existe un líder/equipo gestionado por distribucion_equipos con
 *   scope 'general' (ver nota abajo), reparte por porcentaje.
 * - Si no, round-robin parejo entre todos los vendedores activos.
 *
 * NOTA: a diferencia de GoldPlan (que tiene un gerente/equipo por cada
 * fuente de leads), acá todavía no hay esa jerarquía armada. Si en el
 * futuro se arma un equipo específico para leads de WhatsApp o de
 * formularios, lo más simple es registrar ese líder en
 * distribucion_equipos y reemplazar este fallback por
 * dist.siguienteVendedor(liderId, leadId, fuente).
 */
async function asignarVendedor(leadId, fuente) {
  const vendedores = await getVendedoresActivos();
  if (vendedores.length === 0) return null;

  const vendedor = vendedores[roundRobinIndex % vendedores.length];
  roundRobinIndex = (roundRobinIndex + 1) % vendedores.length;

  console.log(`[${fuente}] Lead #${leadId || '?'} -> ${vendedor.name} (${vendedor.id})`);
  return vendedor.id;
}

// Round-robin por equipo (cuando el equipo no usa distribución ponderada)
const roundRobinPorEquipo = new Map();

/**
 * Asignación de un lead del bot según de quién es el número de WhatsApp.
 * Devuelve { userId, motivo } o { userId: null }.
 */
async function asignarLeadBot(ownerId) {
  const id = parseInt(ownerId, 10);
  if (!id) return { userId: await asignarVendedor(null, 'whatsapp-bot'), motivo: 'round-robin general (sin dueño)' };

  const [[owner]] = await pool.execute('SELECT id, name, role, active FROM users WHERE id = ?', [id]);
  if (!owner) {
    console.warn(`[whatsapp-bot] ownerId ${id} no existe — round-robin general`);
    return { userId: await asignarVendedor(null, 'whatsapp-bot'), motivo: 'round-robin general (dueño inexistente)' };
  }

  // Número de un vendedor: el lead es suyo (si está dado de baja, se reparte)
  if (owner.role === 'vendedor') {
    if (owner.active) return { userId: owner.id, motivo: `número propio de ${owner.name}` };
    console.warn(`[whatsapp-bot] ${owner.name} (${owner.id}) está inactivo — round-robin general`);
    return { userId: await asignarVendedor(null, 'whatsapp-bot'), motivo: 'round-robin general (vendedor inactivo)' };
  }

  // Número de gerencia/supervisión: se reparte en su equipo
  try {
    const r = await dist.siguienteVendedor(owner.id, null, 'whatsapp-bot');
    if (r.gestionado && r.userId) return { userId: r.userId, motivo: `distribución ponderada del equipo de ${owner.name}` };
  } catch (e) {
    console.error(`[whatsapp-bot] distribución ${owner.id}:`, e.message);
  }

  const equipo = await dist.getVendedoresDeEquipo(owner.id);
  if (equipo.length) {
    const i = (roundRobinPorEquipo.get(owner.id) || 0) % equipo.length;
    roundRobinPorEquipo.set(owner.id, (i + 1) % equipo.length);
    return { userId: equipo[i].id, motivo: `round-robin del equipo de ${owner.name}` };
  }

  console.warn(`[whatsapp-bot] ${owner.name} (${owner.id}) no tiene vendedores activos debajo — round-robin general`);
  return { userId: await asignarVendedor(null, 'whatsapp-bot'), motivo: 'round-robin general (equipo vacío)' };
}

// ========================================
// POST /api/webhooks/whatsapp-bot
// Leads que entran por el bot de WhatsApp
// ========================================
router.post('/whatsapp-bot', intakeAuth, async (req, res) => {
  try {
    const { nombre, telefono, modelo, notas, formaPago, ownerId } = req.body;

    console.log('[whatsapp-bot] Recibido:', JSON.stringify(req.body));

    if (!nombre || !telefono) {
      return res.status(400).json({
        error: 'Nombre y telefono son requeridos',
        received: { nombre, telefono }
      });
    }

    const { userId: assigned_to, motivo } = await asignarLeadBot(ownerId);
    if (!assigned_to) {
      return res.status(500).json({ error: 'No hay vendedores activos para asignar' });
    }
    console.log(`[whatsapp-bot] ${nombre} (${telefono}) -> usuario ${assigned_to} | ${motivo}`);

    const [result] = await pool.execute(
      `INSERT INTO leads
        (nombre, telefono, modelo, marca, formaPago, estado, fuente, notas, assigned_to, created_at, assigned_at)
       VALUES
        (?, ?, ?, 'fiat', ?, 'nuevo', 'community', ?, ?, NOW(), NOW())`,
      [
        nombre,
        telefono,
        modelo || 'Consultar',
        formaPago || 'Consultar',
        notas || '',
        assigned_to
      ]
    );

    const [leadRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    const lead = leadRows[0] || null;

    // Emitir en tiempo real, igual que hace el middleware de server.js para /api/leads
    const io = req.app.get('io');
    if (io && lead) {
      io.emit('lead:created', lead);
    }

    res.json({
      ok: true,
      lead,
      leadId: result.insertId,
      assignedTo: assigned_to,
      motivo,
      fuente: 'whatsapp-bot'
    });
  } catch (error) {
    console.error('[whatsapp-bot] Error:', error);
    res.status(500).json({ error: 'Error al procesar lead' });
  }
});

// ========================================
// POST /api/webhooks/zapier-formularios
// Leads de formularios (landing, redes, etc.) vía Zapier
// ========================================
router.post('/zapier-formularios', intakeAuth, async (req, res) => {
  try {
    const { nombre, telefono, modelo, notas, formaPago, email } = req.body;

    console.log('[zapier-formularios] Recibido:', JSON.stringify(req.body));

    if (!nombre || !telefono) {
      return res.status(400).json({
        error: 'Nombre y telefono son requeridos',
        received: { nombre, telefono }
      });
    }

    const assigned_to = await asignarVendedor(null, 'zapier-formularios');
    if (!assigned_to) {
      return res.status(500).json({ error: 'No hay vendedores activos para asignar' });
    }

    const notasFinal = email ? `Mail: ${email}${notas ? ' | ' + notas : ''}` : (notas || '');

    const [result] = await pool.execute(
      `INSERT INTO leads
        (nombre, telefono, modelo, marca, formaPago, estado, fuente, notas, assigned_to, created_at, assigned_at)
       VALUES
        (?, ?, ?, 'fiat', ?, 'nuevo', 'community', ?, ?, NOW(), NOW())`,
      [
        nombre,
        telefono,
        modelo || 'Consultar',
        formaPago || 'Consultar',
        notasFinal,
        assigned_to
      ]
    );

    const [leadRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    const lead = leadRows[0] || null;

    const io = req.app.get('io');
    if (io && lead) {
      io.emit('lead:created', lead);
    }

    res.json({
      ok: true,
      lead,
      leadId: result.insertId,
      assignedTo: assigned_to,
      fuente: 'zapier-formularios'
    });
  } catch (error) {
    console.error('[zapier-formularios] Error:', error);
    res.status(500).json({ error: 'Error al procesar lead' });
  }
});

// ========================================
// GET /api/webhooks/health
// ========================================
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    roundRobinIndex
  });
});

module.exports = router;
