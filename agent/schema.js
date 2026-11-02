/**
 * ============================================
 * AGENTE IA — SCHEMA
 * ============================================
 * Crea las tablas del agente (idempotente, corre en cada arranque) y el
 * usuario de sistema "Agente IA" con el que se firman notas, recordatorios
 * e historial. Ese usuario queda con active = 0: no puede loguearse y no
 * entra en ningún reparto de leads.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const AGENT_EMAIL = 'agente-ia@sistema.local';
const AGENT_NAME = 'Agente IA';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS agent_config (
    k VARCHAR(60) NOT NULL PRIMARY KEY,
    v TEXT NULL,
    updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS agent_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(40) NOT NULL,
    lead_id INT NULL,
    payload TEXT NULL,
    dedupe_key VARCHAR(120) NOT NULL,
    status ENUM('pending','processing','done','error','skipped') DEFAULT 'pending',
    attempts INT DEFAULT 0,
    next_attempt_at DATETIME NULL,
    error TEXT NULL,
    run_id INT NULL,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    UNIQUE KEY uq_agent_event_dedupe (dedupe_key),
    INDEX idx_agent_events_status (status, next_attempt_at),
    INDEX idx_agent_events_lead (lead_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id INT NULL,
    lead_id INT NULL,
    trigger_type VARCHAR(40) NULL,
    model VARCHAR(60) NULL,
    status ENUM('running','done','error') DEFAULT 'running',
    steps INT DEFAULT 0,
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0,
    summary TEXT NULL,
    transcript MEDIUMTEXT NULL,
    error TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    INDEX idx_agent_runs_lead (lead_id),
    INDEX idx_agent_runs_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS agent_actions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    run_id INT NULL,
    event_id INT NULL,
    lead_id INT NULL,
    tool VARCHAR(60) NOT NULL,
    args TEXT NULL,
    reason TEXT NULL,
    status ENUM('executed','pending','approved','rejected','failed') NOT NULL,
    result TEXT NULL,
    source ENUM('agent','mcp') DEFAULT 'agent',
    decided_by INT NULL,
    decided_at DATETIME NULL,
    decision_note VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME NULL,
    INDEX idx_agent_actions_status (status, created_at),
    INDEX idx_agent_actions_lead (lead_id),
    INDEX idx_agent_actions_run (run_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function ensureSchema(pool) {
  for (const sql of TABLES) await pool.query(sql);

  // wa_messages.sent_by (bot / vendedor / agente / cliente): la escribe el bot
  // de WhatsApp actualizado. El primero de los dos que arranca la crea.
  const [col] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wa_messages' AND COLUMN_NAME = 'sent_by'`);
  if (!col[0].n) {
    await pool.query('ALTER TABLE wa_messages ADD COLUMN sent_by VARCHAR(20) NULL AFTER direction').catch((e) => {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    });
  }

  const [rows] = await pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [AGENT_EMAIL]);
  if (rows.length) return { id: rows[0].id, name: AGENT_NAME };

  // Password aleatoria que nadie conoce: el usuario existe solo para firmar.
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const [r] = await pool.execute(
    "INSERT INTO users (name, email, password, role, active, lead_percentage) VALUES (?, ?, ?, 'supervisor', 0, 0)",
    [AGENT_NAME, AGENT_EMAIL, hash]
  );
  console.log(`🤖 Usuario de sistema creado: ${AGENT_NAME} (#${r.insertId})`);
  return { id: r.insertId, name: AGENT_NAME };
}

module.exports = { ensureSchema, AGENT_EMAIL, AGENT_NAME };
