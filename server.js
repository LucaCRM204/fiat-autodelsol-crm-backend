/**
 * ============================================
 * SERVER.JS — AUTO DEL SOL CRM (Fiat)
 * Con WebSockets en tiempo real, sin módulo de scoring
 * ============================================
 */
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// Importar socket server
const { initSocketServer } = require('./socket-server');

// Importar pool de MySQL
const pool = require('./db');

// Importar rutas
const authRouter = require('./routes/auth');
const leadsRouter = require('./routes/leads');
const activityRouter = require('./routes/activity');
const metasRouter = require('./routes/metas');

let usersRouter;
try {
  usersRouter = require('./routes/users');
} catch (_) {
  usersRouter = null;
}

const app = express();
const server = http.createServer(app);

// Guardar pool en app para usar en rutas
app.set('db', pool);

// Proxy (necesario para cookie Secure detrás de Railway/similares)
app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(compression());
app.use(morgan('dev'));

// CORS configuration
const origins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOpts = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-API-Key', 'Accept'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));

// Rutas principales
app.use('/api/auth', authRouter);

// Middleware: auto-emit socket events on lead changes
app.use('/api/leads', (req, res, next) => {
  if (req.method === 'GET') return next();

  const originalJson = res.json.bind(res);

  res.json = function (data) {
    const io = req.app.get('io');
    if (!io) return originalJson(data);

    try {
      // POST /api/leads (solo creación, no búsqueda)
      if (req.method === 'POST' && req.path === '/' && data?.lead && !data?.leads) {
        io.emit('lead:created', data.lead);
        console.log(`📡 [RT] lead:created #${data.lead.id}`);
      }

      // PUT/PATCH → lead:updated
      if ((req.method === 'PUT' || req.method === 'PATCH') && data?.lead) {
        io.emit('lead:updated', data.lead);
        console.log(`📡 [RT] lead:updated #${data.lead.id} (${req.method} ${req.path})`);
      }

      // DELETE → lead:deleted
      if (req.method === 'DELETE' && req.path.match(/^\/\d+$/)) {
        const leadId = parseInt(req.path.replace('/', ''));
        io.emit('lead:deleted', leadId);
        console.log(`📡 [RT] lead:deleted #${leadId}`);
      }

      // Notificación al asignado
      if (req.method === 'POST' && data?.lead?.assigned_to) {
        io.emit('notification', {
          id: `lead-${data.lead.id}-${Date.now()}`,
          type: 'lead_created',
          title: 'Nuevo lead asignado',
          message: `${data.lead.nombre || 'Lead nuevo'} - ${data.lead.modelo || 'Sin modelo'}`,
          timestamp: new Date().toISOString(),
          read: false,
          severity: 'info',
          leadId: data.lead.id,
          targetUserId: data.lead.assigned_to
        });
      }
    } catch (err) {
      console.error('Socket emit error:', err.message);
    }

    return originalJson(data);
  };

  next();
});

app.use('/api/leads', leadsRouter);
app.use('/api/presupuestos', require('./routes/presupuestos'));
app.use('/api/webhooks', require('./routes/webhooks')); // whatsapp-bot y zapier-formularios (emiten sockets internamente)
app.use('/api/activity', activityRouter);
app.use('/api/metas', metasRouter(pool));
app.use('/api/distribution', require('./routes/distribution'));
app.use('/api/calls', require('./routes/calls'));
app.use('/api/notas', require('./routes/notas'));
app.use('/api/recordatorios', require('./routes/recordatorios'));
app.use('/api/cotizaciones', require('./routes/cotizaciones'));
app.use('/api/alertas', require('./routes/alertas'));
if (usersRouter) app.use('/api/users', usersRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Ruta raíz
app.get('/', (_req, res) => res.json({
  message: 'Auto del Sol Fiat CRM Backend API',
  version: '1.0.0',
  features: ['realtime', 'presence', 'activity-tracking', 'auto-reassignment', 'metas', 'distribucion-ponderada']
}));

// Inicializar WebSockets
const io = initSocketServer(server, pool);
app.set('io', io);

// ============================================
// TAREAS PROGRAMADAS: distribución de leads
// ============================================
const dist = require('./services/distribucion.service');

const MIN = 60 * 1000;

// Cada 15 min: realinea los equipos por si algún cambio de jerarquía
// se escapó (edición directa en la base, deploy a mitad de camino, etc).
setInterval(async () => {
  try {
    const n = await dist.sincronizarTodos();
    if (n) console.log(`⚖️  Distribución: ${n} equipos realineados`);
  } catch (e) {
    console.error('[tarea] distribucion:', e.message);
  }
}, 15 * MIN);

// Reset del contador "recibidos este mes".
// Se chequea cada hora; corre el día 1 en horario de Argentina (UTC-3).
let ultimoResetMes = null;
setInterval(async () => {
  const arg = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
  const clave = `${arg.getUTCFullYear()}-${arg.getUTCMonth()}`;

  if (arg.getUTCDate() !== 1 || ultimoResetMes === clave) return;

  ultimoResetMes = clave;
  try {
    await dist.resetMensual();
    console.log('⚖️  Distribución: contadores mensuales reseteados');
  } catch (e) {
    console.error('[tarea] reset mensual:', e.message);
    ultimoResetMes = null; // que reintente en la próxima hora
  }
}, 60 * MIN);

// Primer realineado 30s después de arrancar, ya con todo levantado.
setTimeout(() => {
  dist.sincronizarTodos()
    .then((n) => n && console.log(`⚖️  Distribución: ${n} equipos realineados al inicio`))
    .catch((e) => console.error('[tarea] sync inicial:', e.message));
}, 30 * 1000);

const PORT = process.env.PORT || 3001;

require('./bootstrap')().finally(() => server.listen(PORT, () => {
  console.log(`\n🚀 Backend escuchando en puerto ${PORT}`);
  console.log(`⚡ WebSockets habilitados`);
  console.log(`📊 Reportes de actividad disponibles`);
  console.log(`🎯 Módulo de Metas activo`);
  console.log(`⚖️  Distribución ponderada activa`);
  console.log(`📥 Webhooks activos: /api/webhooks/whatsapp-bot, /api/webhooks/zapier-formularios, /api/webhooks/sheets\n`);
}));
