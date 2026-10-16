// utils/assign.js
const pool = require('../db');

// Índice único para round-robin en memoria (fallback simple, sin ponderar).
// Para reparto por porcentaje entre equipos, ver services/distribucion.service.js
let globalRoundRobinIndex = 0;

// Asigna de forma equitativa a TODOS los vendedores activos
const getAssignedVendorByBrand = async (marca) => {
  try {
    const [vendors] = await pool.execute(
      `SELECT u.id, u.name, COUNT(l.id) as total_leads
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id
       WHERE u.role = 'vendedor'
         AND u.active = 1
       GROUP BY u.id, u.name
       ORDER BY u.id ASC`
    );

    if (vendors.length === 0) {
      console.warn('⚠️ No hay vendedores activos en el sistema');
      return null;
    }

    console.log(`👥 Vendedores disponibles: ${vendors.length}`);

    const selectedVendor = vendors[globalRoundRobinIndex % vendors.length];
    globalRoundRobinIndex = (globalRoundRobinIndex + 1) % vendors.length;

    console.log(`✅ Lead [${marca?.toUpperCase() || 'SIN MARCA'}] → Vendedor ${selectedVendor.id} (${selectedVendor.name})`);
    console.log(`   📊 Tiene ${selectedVendor.total_leads} leads totales`);
    console.log(`   🔄 Índice actual: ${globalRoundRobinIndex - 1}/${vendors.length - 1} | Próximo: ${globalRoundRobinIndex}`);

    return selectedVendor.id;
  } catch (error) {
    console.error('❌ Error en asignación:', error);
    return null;
  }
};

const getNextVendorId = async () => {
  return await getAssignedVendorByBrand(null);
};

const resetRoundRobinIndex = () => {
  globalRoundRobinIndex = 0;
  console.log('🔄 Índice round-robin reseteado a 0');
};

const getRoundRobinStatus = async () => {
  try {
    const [vendors] = await pool.execute(
      `SELECT
         u.id,
         u.name,
         u.active,
         COUNT(l.id) as total_leads,
         SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as leads_7d,
         SUM(CASE WHEN l.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN 1 ELSE 0 END) as leads_24h,
         MAX(l.created_at) as ultimo_lead
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id
       WHERE u.role = 'vendedor'
         AND u.active = 1
       GROUP BY u.id, u.name, u.active
       ORDER BY u.id ASC`
    );

    if (vendors.length === 0) {
      return {
        totalVendedoresActivos: 0,
        indiceActual: globalRoundRobinIndex,
        proximoVendedor: null,
        todosLosVendedores: []
      };
    }

    const nextVendor = vendors[globalRoundRobinIndex % vendors.length];

    return {
      totalVendedoresActivos: vendors.length,
      indiceActual: globalRoundRobinIndex,
      proximoVendedor: {
        id: nextVendor.id,
        nombre: nextVendor.name,
        leads_totales: nextVendor.total_leads
      },
      todosLosVendedores: vendors
    };
  } catch (error) {
    console.error('Error obteniendo estado:', error);
    return null;
  }
};

// Legacy - se mantiene por compatibilidad
const touchUser = async (conn, userId) => {
  return;
};

module.exports = {
  getAssignedVendorByBrand,
  getNextVendorId,
  touchUser,
  resetRoundRobinIndex,
  getRoundRobinStatus
};
