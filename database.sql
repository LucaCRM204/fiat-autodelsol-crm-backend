-- ============================================
-- AUTO DEL SOL FIAT CRM — Schema MySQL
-- Basado en la estructura de GoldPlan CRM, sin scoring.
-- Reconstruido a partir del código (no es un dump real) — revisar antes de
-- correrlo contra producción.
-- ============================================

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================
-- USUARIOS
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('owner','director','gerente','supervisor','vendedor') DEFAULT 'vendedor',
  reportsTo INT NULL,
  active TINYINT(1) DEFAULT 1,
  lead_percentage INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_reportsto FOREIGN KEY (reportsTo) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_users_reportsto (reportsTo),
  INDEX idx_users_role (role),
  INDEX idx_users_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- LEADS
-- ============================================
CREATE TABLE IF NOT EXISTS leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  telefono VARCHAR(60),
  modelo VARCHAR(120),
  marca ENUM('fiat') DEFAULT 'fiat',
  formaPago VARCHAR(60),
  notas TEXT,
  estado VARCHAR(40) DEFAULT 'nuevo',
  fuente VARCHAR(60) DEFAULT 'community',
  assigned_to INT NULL,
  infoUsado VARCHAR(255) NULL,
  entrega TINYINT(1) DEFAULT 0,
  fecha DATE NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Trazabilidad de asignación (migrations.js del original)
  assigned_at DATETIME NULL,
  accepted_at DATETIME NULL,
  response_time_minutes INT NULL,
  reassignment_count INT DEFAULT 0,
  last_status_change DATETIME NULL,

  -- Sistema de aceptación en tiempo real (socket-server.js)
  pending_acceptance TINYINT(1) DEFAULT 0,
  current_offer_to INT NULL,
  acceptance_expires_at DATETIME NULL,
  acceptance_attempts TEXT NULL, -- JSON array de user_ids que ya rechazaron

  CONSTRAINT fk_lead_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_offer_to FOREIGN KEY (current_offer_to) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_leads_assigned (assigned_to),
  INDEX idx_leads_estado (estado),
  INDEX idx_leads_created (created_at),
  INDEX idx_leads_fuente (fuente),
  INDEX idx_leads_pending (pending_acceptance, current_offer_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Log de aceptación/rechazo de leads (socket-server.js)
CREATE TABLE IF NOT EXISTS lead_acceptance_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  user_id INT NULL,
  action ENUM('offered','accepted','rejected','timeout') NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_acclog_lead (lead_id),
  INDEX idx_acclog_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de cambios de un lead (routes/leads.js → logLeadHistory)
CREATE TABLE IF NOT EXISTS lead_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  action VARCHAR(30) NOT NULL, -- 'creacion', 'cambio'
  field_name VARCHAR(60) NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  user_id INT NULL,
  user_name VARCHAR(100) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_leadhistory_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Log de reasignaciones (activity.js)
CREATE TABLE IF NOT EXISTS lead_reassignment_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  from_user_id INT NULL,
  to_user_id INT NULL,
  reason VARCHAR(100) DEFAULT 'manual',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_reassign_lead (lead_id),
  INDEX idx_reassign_from (from_user_id),
  INDEX idx_reassign_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- SESIONES / PRESENCIA (activity.js, socket-server.js)
-- ============================================
CREATE TABLE IF NOT EXISTS user_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  date DATE NOT NULL,
  session_start DATETIME NOT NULL,
  session_end DATETIME NULL,
  duration_minutes INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sessions_user_date (user_id, date),
  INDEX idx_sessions_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- ALERTAS / NOTIFICACIONES INTERNAS (alertas.js, recordatorios.js, cotizaciones.js)
-- ============================================
CREATE TABLE IF NOT EXISTS alertas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'cotizacion', 'recordatorio', etc.
  message TEXT NOT NULL,
  lead_id INT NULL,
  related_id INT NULL,
  is_read TINYINT(1) DEFAULT 0,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  INDEX idx_alertas_user (user_id, is_read),
  INDEX idx_alertas_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Alertas internas del sistema (migrations.js) — distinta de `alertas`,
-- se usa para avisos automáticos (timeouts, reasignaciones, etc.)
CREATE TABLE IF NOT EXISTS internal_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  severity VARCHAR(20) DEFAULT 'normal',
  lead_id INT NULL,
  related_id INT NULL,
  is_read TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  INDEX idx_ialerts_user (user_id, is_read),
  INDEX idx_ialerts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- NOTAS INTERNAS (notas.js)
-- ============================================
CREATE TABLE IF NOT EXISTS notas_internas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  texto TEXT NOT NULL,
  usuario VARCHAR(100) NOT NULL, -- nombre desnormalizado, ya lo hacía así el original
  user_id INT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notas_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- RECORDATORIOS (recordatorios.js)
-- ============================================
CREATE TABLE IF NOT EXISTS recordatorios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  descripcion TEXT NOT NULL,
  completado TINYINT(1) DEFAULT 0,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_recordatorios_lead (lead_id),
  INDEX idx_recordatorios_fecha (fecha, completado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- COTIZACIONES (cotizaciones.js)
-- ============================================
CREATE TABLE IF NOT EXISTS cotizaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  vehiculo VARCHAR(150),
  precio_contado DECIMAL(14,2),
  anticipo DECIMAL(14,2),
  valor_usado DECIMAL(14,2),
  planes TEXT, -- JSON
  bonificaciones TEXT,
  notas TEXT,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_cotizaciones_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- PRESUPUESTOS / CATÁLOGO DE PLANES (presupuestos.js)
-- ============================================
CREATE TABLE IF NOT EXISTS presupuestos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  modelo VARCHAR(150) NOT NULL,
  marca VARCHAR(60) DEFAULT 'fiat',
  imagen_url VARCHAR(500),
  precio_contado DECIMAL(14,2),
  especificaciones_tecnicas TEXT,
  planes_cuotas TEXT, -- JSON
  bonificaciones TEXT,
  anticipo DECIMAL(14,2),
  activo TINYINT(1) DEFAULT 1,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_presupuestos_activo (activo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- METAS DE VENTAS (metas.js)
-- ============================================
CREATE TABLE IF NOT EXISTS metas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendedor_id INT NOT NULL,
  mes VARCHAR(7) NOT NULL, -- formato 'YYYY-MM'
  meta_ventas INT DEFAULT 0,
  meta_leads INT DEFAULT 0,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vendedor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_meta_vendedor_mes (vendedor_id, mes),
  INDEX idx_metas_mes (mes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- REGISTRO DE LLAMADAS (calls.js)
-- ============================================
CREATE TABLE IF NOT EXISTS call_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  user_id INT NOT NULL,
  telefono VARCHAR(60),
  duracion_segundos INT DEFAULT 0,
  resultado VARCHAR(60) DEFAULT 'contactado',
  notas TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_calls_lead (lead_id),
  INDEX idx_calls_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- DISTRIBUCIÓN PONDERADA DE LEADS (services/distribucion.service.js)
-- ============================================

-- Qué equipos (por líder) usan reparto por porcentaje en vez de round-robin simple
CREATE TABLE IF NOT EXISTS distribucion_equipos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lider_id INT NOT NULL,
  modo ENUM('plano','cascada') DEFAULT 'plano',
  nota VARCHAR(255) NULL,
  activo TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lider_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_distequipo_lider (lider_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pesos (%) de cada miembro dentro de un scope (`lider:<id>`)
CREATE TABLE IF NOT EXISTS distribucion_pesos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scope VARCHAR(60) NOT NULL, -- 'lider:123'
  user_id INT NOT NULL,
  peso DECIMAL(7,4) DEFAULT 0, -- porcentaje 0-100
  peso_previo DECIMAL(7,4) DEFAULT 0, -- para restaurar al reanudar/reactivar
  fijo TINYINT(1) DEFAULT 0, -- si está fijado manualmente
  activo TINYINT(1) DEFAULT 1, -- si sigue en el equipo
  pausado TINYINT(1) DEFAULT 0, -- si está en el equipo pero no recibe leads
  current_weight DECIMAL(10,4) DEFAULT 0, -- estado interno del smooth WRR
  asignados_total INT DEFAULT 0,
  asignados_mes INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_distpeso_scope_user (scope, user_id),
  INDEX idx_distpeso_scope (scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Auditoría de cada asignación hecha por el algoritmo ponderado
CREATE TABLE IF NOT EXISTS distribucion_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scope VARCHAR(60) NOT NULL,
  lead_id INT NULL,
  user_id INT NOT NULL,
  peso DECIMAL(7,4),
  fuente VARCHAR(60) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  INDEX idx_distlog_scope (scope),
  INDEX idx_distlog_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================
-- WHATSAPP / BOT (Baileys)
-- ============================================
-- Estas 6 tablas las va a crear y usar el bot de WhatsApp corriendo en el
-- VPS (Hetzner, junto a ALRA y GoldPlan), no el propio backend del CRM.
-- Se incluyen acá porque el bot va a persistir contra esta misma base de
-- datos (Railway), tal como lo hace hoy el de GoldPlan. Revisar/ajustar
-- cuando se arme el bot real para Auto del Sol Fiat — este bloque replica el
-- schema real de GoldPlan (via SHOW CREATE TABLE), con dos cambios:
--   1. Collation normalizada a utf8mb4_unicode_ci en todo (el original
--      mezclaba utf8mb4_0900_ai_ci y utf8mb4_unicode_ci entre tablas).
--   2. wa_stage_history.conversation_id ahora es VARCHAR(30) y apunta a
--      wa_conversations(phone) en vez de a un id numérico: en el original
--      esa FK apuntaba a wa_conversations_backend_old (una tabla vieja/
--      deprecada con id autoincremental), pero wa_conversations —la
--      tabla activa— no tiene id, tiene phone como PK. Se usa phone como
--      referencia porque es el dato que el bot siempre tiene a mano en
--      cada evento de conversación.

SET FOREIGN_KEY_CHECKS = 0;

-- Estado actual de cada conversación de WhatsApp (una fila por número).
CREATE TABLE IF NOT EXISTS wa_conversations (
  phone VARCHAR(30) NOT NULL,
  session_id VARCHAR(50) NULL,
  nombre VARCHAR(100) NULL,
  modelo VARCHAR(100) NULL,
  marca VARCHAR(20) NULL,
  step VARCHAR(30) DEFAULT 'inicio',
  origen ENUM('pagina','bot','directo','desconocido') DEFAULT 'desconocido',
  lead_sent TINYINT(1) DEFAULT 0,
  vendor_takeover TINYINT(1) DEFAULT 0, -- si un vendedor tomó la conversación manualmente y el bot dejó de responder
  data JSON NULL, -- estado libre del flujo conversacional del bot
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (phone),
  INDEX idx_wa_conv_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Una instancia = una sesión de WhatsApp (un número) asignada a un
-- gerente/supervisor. Es lo que administra el panel de WhatsApp Admin.
CREATE TABLE IF NOT EXISTS wa_instances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  supervisor_id INT NOT NULL,
  supervisor_name VARCHAR(100) NULL, -- desnormalizado, igual que en el original
  phone VARCHAR(20) NULL,
  status ENUM('disconnected','connecting','qr_ready','connected') DEFAULT 'disconnected',
  default_fuente VARCHAR(50) DEFAULT 'community', -- 'whatsapp' en GoldPlan; acá la fuente única es community
  is_pagina TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (supervisor_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_wa_instance_supervisor (supervisor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de mensajes entrantes/salientes por número.
CREATE TABLE IF NOT EXISTS wa_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(50) NULL,
  lead_id INT NULL,
  phone VARCHAR(30) NULL,
  direction ENUM('in','out') DEFAULT 'in',
  message TEXT NULL,
  media_type VARCHAR(20) NULL,
  media_url VARCHAR(255) NULL,
  timestamp BIGINT NULL, -- epoch ms, tal como lo guarda Baileys
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  INDEX idx_wa_msg_phone (phone),
  INDEX idx_wa_msg_lead (lead_id),
  INDEX idx_wa_msg_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Estado de conexión de cada sesión del bot (una fila por gerente/número).
-- El id acá NO es autoincremental: se usa el mismo id del gerente
-- (supervisor_id), igual que en el original.
-- OJO: la FK de id->users(id) es un agregado mío, NO estaba en el DDL
-- original de GoldPlan (esa tabla no tenía ninguna constraint). La agrego
-- porque el patrón de datos lo sugiere fuerte, pero si el bot real llega
-- a insertar acá un id que no exista todavía en users, esta FK va a
-- rechazar el insert — sacarla si genera problemas.
CREATE TABLE IF NOT EXISTS wa_sessions (
  id INT NOT NULL,
  supervisor_name VARCHAR(100) NULL,
  phone VARCHAR(30) NULL,
  status VARCHAR(20) DEFAULT 'disconnected',
  bot_enabled TINYINT(1) DEFAULT 0,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  bot_fuente VARCHAR(100) NULL,
  bot_marcas VARCHAR(100) NULL,
  gerencia_id INT NULL, -- FK a users(id) agregada por mí, tampoco estaba en el original
  PRIMARY KEY (id),
  FOREIGN KEY (id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gerencia_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de cambios de etapa dentro de una conversación de WhatsApp
-- (ej: inicio -> pidiendo_modelo -> lead_creado).
CREATE TABLE IF NOT EXISTS wa_stage_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(30) NOT NULL, -- ver nota arriba: es wa_conversations.phone, no un id numérico
  from_stage VARCHAR(50) NULL,
  to_stage VARCHAR(50) NOT NULL,
  changed_by VARCHAR(100) DEFAULT 'bot',
  note TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES wa_conversations(phone) ON DELETE CASCADE,
  INDEX idx_wa_stage_conv (conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vendedores habilitados a recibir leads desde una instancia de WhatsApp
-- puntual (para el reparto interno del bot, independiente del sistema de
-- distribución ponderada del CRM).
CREATE TABLE IF NOT EXISTS wa_vendors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  instance_id INT NOT NULL,
  user_id INT NOT NULL,
  name VARCHAR(100) NULL, -- desnormalizado, igual que en el original
  active TINYINT(1) DEFAULT 1,
  total_assigned INT DEFAULT 0,
  last_assigned_at TIMESTAMP NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (instance_id) REFERENCES wa_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_wa_vendor (instance_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================
-- SEED: usuario owner inicial
-- Cambiar el email/password antes de correr en producción.
-- La password acá es un placeholder EN TEXTO PLANO — hashearla con bcrypt
-- (ver seed-admin.js) antes de insertar, nunca guardarla así.
-- ============================================
-- INSERT IGNORE INTO users (name, email, password, role) VALUES
-- ('Admin Auto del Sol Fiat', 'admin@autodelsolfiat.com', '<hash_bcrypt_aca>', 'owner');
