/**
 * ============================================
 * DISTRIBUCIÓN DE LEADS POR PORCENTAJE
 * ============================================
 * Reemplaza los `let ...Index = 0` en memoria de webhooks.js por un
 * reparto ponderado y persistente.
 *
 * scope = `lider:${equipoId}` — el mismo equipoId que ya usás
 *         (CASERES_ID = 357, ORGE_ID = 419, etc.)
 *
 * Tres estados distintos, no los mezcles:
 *   users.active = 0           -> cuenta de baja. Sale del equipo entero.
 *   distribucion.activo = 0    -> ya no pertenece a este equipo.
 *   distribucion.pausado = 1   -> está en el equipo pero no recibe leads.
 *
 * En los tres su porcentaje se reparte entre los demás y la suma vuelve
 * a 100. El que tenía queda guardado en peso_previo.
 */

const pool = require('../db');

const TOTAL = 100;
const ROL_VENDEDOR = 'vendedor';

// Cuántos niveles baja la cascada como máximo (gerente → supervisor →
// vendedor son 2, el resto es margen). También corta cualquier ciclo
// si la jerarquía quedara mal cargada.
const PROFUNDIDAD_MAX = 6;

const scopeDe = (equipoId) => `lider:${equipoId}`;

// IDs que nunca deben recibir leads (contenedores, usuarios basura).
// La lista vieja era la de GoldPlan y en Auto del Sol pisaba usuarios
// reales (ej: el 13 es un vendedor). Ahora se configura por .env:
//   DIST_EXCLUIDOS=198,380
const EXCLUIDOS = new Set(
  String(process.env.DIST_EXCLUIDOS || '')
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter(Number.isInteger)
);

// ─────────────────────────────────────────────────────────────
// Helpers puros (testeables sin base)
// ─────────────────────────────────────────────────────────────

const suma = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);
const r4 = (n) => Math.round(n * 10000) / 10000;

/** True si esta fila participa del reparto. */
const participa = (r) => !!r.activo && !r.pausado;

/**
 * Reescala los pesos para que sumen exactamente 100.
 * Solo cuentan los que participan; los pausados quedan en 0.
 * Los marcados como `fijo` conservan su valor y el resto absorbe.
 */
function normalizar(rows) {
  const out = rows.map((r) => ({ ...r, peso: Number(r.peso) || 0 }));
  const dentro = out.filter(participa);
  out.filter((r) => !participa(r)).forEach((r) => (r.peso = 0));
  if (!dentro.length) return out;

  const fijos = dentro.filter((r) => r.fijo);
  const libres = dentro.filter((r) => !r.fijo);
  let sumaFijos = suma(fijos, (r) => r.peso);

  if (sumaFijos > TOTAL) {
    const k = TOTAL / sumaFijos;
    fijos.forEach((r) => (r.peso *= k));
    sumaFijos = TOTAL;
  }

  const disponible = TOTAL - sumaFijos;

  if (libres.length) {
    const sumaLibres = suma(libres, (r) => r.peso);
    if (sumaLibres > 0) {
      const k = disponible / sumaLibres;
      libres.forEach((r) => (r.peso *= k));
    } else {
      // Nadie tenía peso: parejo entre todos.
      libres.forEach((r) => (r.peso = disponible / libres.length));
    }
  } else if (fijos.length) {
    const k = TOTAL / sumaFijos;
    fijos.forEach((r) => (r.peso *= k));
  }

  dentro.forEach((r) => (r.peso = r4(r.peso)));
  const dif = r4(TOTAL - suma(dentro, (r) => r.peso));
  if (Math.abs(dif) >= 0.0001) {
    const mayor = dentro.reduce((a, b) => (b.peso > a.peso ? b : a));
    mayor.peso = r4(mayor.peso + dif);
  }
  return out;
}

/** Fija el % de un vendedor y reacomoda al resto dentro de (100 - valor). */
function setPorcentaje(rows, userId, valor) {
  const v = Math.max(0, Math.min(TOTAL, Number(valor) || 0));
  const marcados = rows.map((r) =>
    r.user_id === Number(userId) && participa(r)
      ? { ...r, peso: v, fijo: 1, _temp: !r.fijo }
      : { ...r }
  );
  return normalizar(marcados).map((r) =>
    r._temp ? { ...r, fijo: 0, _temp: undefined } : r
  );
}

/**
 * Reparto exacto de N leads (método del resto mayor).
 * Garantiza que la suma dé exactamente N — el redondeo simple pierde leads.
 */
function repartirLote(rows, n) {
  const dentro = rows.filter(participa);
  const total = suma(dentro, (r) => Number(r.peso));
  if (total <= 0 || n <= 0) return rows.map((r) => ({ ...r, cantidad: 0 }));

  const exactos = dentro.map((r) => (n * Number(r.peso)) / total);
  const base = exactos.map(Math.floor);
  const resto = n - suma(base);
  const orden = dentro
    .map((_, i) => ({ i, frac: exactos[i] - base[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < resto; k++) base[orden[k % orden.length].i]++;

  const porId = new Map(dentro.map((r, i) => [r.user_id, base[i]]));
  return rows.map((r) => ({ ...r, cantidad: porId.get(r.user_id) ?? 0 }));
}

/**
 * Smooth weighted round-robin (el algoritmo de nginx).
 * En vez de darle 40 leads seguidos al que tiene 40%, los intercala
 * respetando la proporción. Se autocorrige al cambiar los pesos.
 */
function elegirSiguiente(rows) {
  const dentro = rows.filter((r) => participa(r) && Number(r.peso) > 0);
  if (!dentro.length) return { elegido: null, rows };

  const total = suma(dentro, (r) => Number(r.peso));
  let mejor = null;
  for (const r of dentro) {
    r.current_weight = Number(r.current_weight) + Number(r.peso);
    if (!mejor || r.current_weight > mejor.current_weight) mejor = r;
  }
  mejor.current_weight -= total;
  return { elegido: mejor, rows };
}

// ─────────────────────────────────────────────────────────────
// Jerarquía — mismo CTE recursivo que ya usás en webhooks.js
// ─────────────────────────────────────────────────────────────

/**
 * Devuelve la config del equipo, o null si no está gestionado.
 * Si es null, el webhook debe caer al round-robin de siempre.
 */
async function getConfigEquipo(liderId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT lider_id, modo, activo FROM distribucion_equipos
      WHERE lider_id = ? AND activo = 1 LIMIT 1`,
    [liderId]
  );
  return rows[0] || null;
}

/**
 * Hijos directos que son nodos de reparto: supervisores/gerentes que
 * tengan al menos un vendedor colgando. Se usa en modo cascada.
 * Los supervisores sin vendedores quedan afuera — si entraran, sus
 * leads se perderían.
 */
async function getSubEquipos(liderId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT s.id, s.name, s.role,
            (SELECT COUNT(*) FROM users v
              WHERE v.reportsTo = s.id AND v.active = 1 AND v.role = ?) AS vendedores
       FROM users s
      WHERE s.reportsTo = ? AND s.active = 1 AND s.role <> ?
      HAVING vendedores > 0
      ORDER BY s.id`,
    [ROL_VENDEDOR, liderId, ROL_VENDEDOR]
  );
  return rows;
}

/**
 * Quiénes componen el reparto de este scope.
 *   plano   -> todos los vendedores del árbol
 *   cascada -> los sub-equipos (supervisores con gente)
 * Si en cascada no hay sub-equipos, cae a vendedores directos.
 */
async function getMiembrosDeReparto(liderId, modo, conn = pool) {
  if (modo === 'cascada') {
    const subs = await getSubEquipos(liderId, conn);
    if (subs.length) return { tipo: 'equipos', miembros: subs };
  }
  const vend = await getVendedoresDeEquipo(liderId, conn);
  return { tipo: 'vendedores', miembros: vend };
}

/**
 * Vendedores activos bajo un líder, a cualquier profundidad.
 * Equivalente a getVendedoresDeEquipo() de webhooks.js, más el
 * filtro de contenedores.
 */
async function getVendedoresDeEquipo(equipoId, conn = pool) {
  const [rows] = await conn.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM users WHERE id = ?
       UNION ALL
       SELECT u.id
         FROM users u
         INNER JOIN tree t ON u.reportsTo = t.id
        WHERE u.active = 1
     )
     SELECT DISTINCT u.id, u.name, u.role
       FROM users u
       INNER JOIN tree t ON u.id = t.id
      WHERE u.active = 1 AND u.role = ?
      ORDER BY u.id`,
    [equipoId, ROL_VENDEDOR]
  );
  return rows.filter((v) => !EXCLUIDOS.has(v.id));
}

/**
 * Alinea la repartija con la composición real del equipo.
 * Un vendedor con active = 0 no aparece en el CTE, así que cae acá
 * y su tajada se reparte entre los demás.
 * Devuelve true si hubo cambios.
 */
async function sincronizarEquipo(equipoId, conn = null) {
  const propia = !conn;
  const c = conn || (await pool.getConnection());
  try {
    if (propia) await c.beginTransaction();

    const scope = scopeDe(equipoId);
    const cfg = await getConfigEquipo(equipoId, c);
    if (!cfg) {
      // Equipo no gestionado: no se toca nada.
      if (propia) await c.commit();
      return false;
    }
    const { miembros } = await getMiembrosDeReparto(equipoId, cfg.modo, c);
    const esperados = new Set(miembros.map((v) => v.id));

    const [actuales] = await c.query(
      `SELECT * FROM distribucion_pesos WHERE scope = ? FOR UPDATE`,
      [scope]
    );
    const activosAhora = new Set(
      actuales.filter((r) => r.activo).map((r) => r.user_id)
    );

    const entran = [...esperados].filter((id) => !activosAhora.has(id));
    const salen = [...activosAhora].filter((id) => !esperados.has(id));

    if (!entran.length && !salen.length) {
      // Aunque no haya altas ni bajas, los pesos pueden no sumar 100.
      // Pasa justo después del backfill inicial, donde los valores
      // vienen de users.lead_percentage sin normalizar.
      const vivos = actuales.filter((r) => r.activo);
      const dentro = vivos.filter((r) => !r.pausado);
      const sumaActual = suma(dentro, (r) => Number(r.peso));

      if (dentro.length && Math.abs(sumaActual - TOTAL) > 0.01) {
        await persistirPesos(c, normalizar(vivos));
        if (propia) await c.commit();
        return true;
      }

      if (propia) await c.commit();
      return false;
    }

    if (salen.length) {
      const marks = salen.map(() => '?').join(',');
      await c.query(
        `UPDATE distribucion_pesos
            SET peso_previo = IF(peso > 0, peso, peso_previo),
                activo = 0, peso = 0, fijo = 0, current_weight = 0
          WHERE scope = ? AND user_id IN (${marks})`,
        [scope, ...salen]
      );
    }

    if (entran.length) {
      const promedio = TOTAL / Math.max(1, esperados.size);
      for (const id of entran) {
        // Si ya había estado antes, vuelve con el porcentaje que tenía.
        await c.query(
          `INSERT INTO distribucion_pesos (scope, user_id, peso, activo, pausado, current_weight)
           VALUES (?, ?, ?, 1, 0, 0)
           ON DUPLICATE KEY UPDATE
             activo = 1,
             pausado = 0,
             peso = IF(peso_previo > 0, peso_previo, VALUES(peso)),
             current_weight = 0`,
          [scope, id, promedio]
        );
      }
    }

    const [vivos] = await c.query(
      `SELECT * FROM distribucion_pesos WHERE scope = ? AND activo = 1 FOR UPDATE`,
      [scope]
    );
    await persistirPesos(c, normalizar(vivos));

    if (propia) await c.commit();
    return true;
  } catch (e) {
    if (propia) await c.rollback();
    throw e;
  } finally {
    if (propia) c.release();
  }
}

/**
 * Guarda los pesos y refleja el valor en users.lead_percentage,
 * para que el panel viejo (/api/distribution/all) siga mostrando bien.
 */
async function persistirPesos(conn, rows) {
  for (const r of rows) {
    await conn.query(`UPDATE distribucion_pesos SET peso = ? WHERE id = ?`, [r.peso, r.id]);
    await conn.query(`UPDATE users SET lead_percentage = ? WHERE id = ?`, [
      Math.round(r.peso),
      r.user_id,
    ]);
  }
}

/** Sincroniza todos los equipos. Para el backfill y el cron. */
async function sincronizarTodos() {
  const [lideres] = await pool.query(
    `SELECT lider_id AS id FROM distribucion_equipos WHERE activo = 1`
  );
  let cambiados = 0;
  for (const l of lideres) {
    try {
      if (await sincronizarEquipo(l.id)) cambiados++;
    } catch (e) {
      console.error(`[distribucion] sync equipo ${l.id}:`, e.message);
    }
  }
  return cambiados;
}

// Cache corto para no sincronizar en cada lead del webhook.
const ultimaSync = new Map();
const TTL_SYNC_MS = 60_000;

async function sincronizarSiHaceFalta(equipoId) {
  const ahora = Date.now();
  if (ahora - (ultimaSync.get(equipoId) || 0) < TTL_SYNC_MS) return;
  ultimaSync.set(equipoId, ahora);
  try {
    await sincronizarEquipo(equipoId);
  } catch (e) {
    console.error(`[distribucion] sync ${equipoId}:`, e.message);
  }
}

/**
 * Llamá a esto apenas desactivás, reactivás o cambiás de equipo a un
 * usuario. Fuerza el realineado sin esperar el TTL.
 */
async function invalidarPorUsuario(userId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT scope FROM distribucion_pesos WHERE user_id = ?`,
    [userId]
  );
  const lideres = new Set();
  for (const r of rows) {
    const m = /^lider:(\d+)$/.exec(r.scope);
    if (m) lideres.add(Number(m[1]));
  }
  // El equipo nuevo puede no tener todavía una fila para este usuario.
  const [u] = await pool.query(`SELECT reportsTo FROM users WHERE id = ?`, [userId]);
  if (u[0]?.reportsTo) lideres.add(Number(u[0].reportsTo));

  for (const id of lideres) {
    ultimaSync.delete(id);
    try {
      await sincronizarEquipo(id);
    } catch (e) {
      console.error(`[distribucion] invalidar ${id}:`, e.message);
    }
  }
  return [...lideres];
}

// ─────────────────────────────────────────────────────────────
// API del servicio
// ─────────────────────────────────────────────────────────────

async function listar(equipoId) {
  await sincronizarEquipo(equipoId);
  const [rows] = await pool.query(
    `SELECT d.*, u.name, u.email, u.role
       FROM distribucion_pesos d
       JOIN users u ON u.id = d.user_id
      WHERE d.scope = ? AND d.activo = 1
      ORDER BY d.pausado ASC, d.peso DESC, u.name ASC`,
    [scopeDe(equipoId)]
  );
  return rows.map((r) => ({
    ...r,
    peso: Number(r.peso),
    peso_previo: Number(r.peso_previo),
    porcentaje: Number(r.peso),
    fijo: !!r.fijo,
    pausado: !!r.pausado,
    activo: !!r.activo,
  }));
}

async function actualizarPorcentaje(equipoId, userId, valor, fijo = null) {
  const scope = scopeDe(equipoId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [raw] = await conn.query(
      `SELECT * FROM distribucion_pesos WHERE scope = ? AND activo = 1 FOR UPDATE`,
      [scope]
    );
    const rows = setPorcentaje(raw, userId, valor);
    if (fijo !== null) {
      await conn.query(
        `UPDATE distribucion_pesos SET fijo = ? WHERE scope = ? AND user_id = ?`,
        [fijo ? 1 : 0, scope, Number(userId)]
      );
    }
    await persistirPesos(conn, rows);
    await conn.commit();
    return rows;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Saca (o vuelve a meter) a un vendedor del reparto sin tocarle la cuenta.
 * Al pausar guarda su porcentaje; al reanudar lo recupera.
 */
async function pausarVendedor(equipoId, userId, pausado) {
  const scope = scopeDe(equipoId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (pausado) {
      await conn.query(
        `UPDATE distribucion_pesos
            SET peso_previo = IF(peso > 0, peso, peso_previo),
                pausado = 1, peso = 0, fijo = 0, current_weight = 0
          WHERE scope = ? AND user_id = ?`,
        [scope, Number(userId)]
      );
    } else {
      await conn.query(
        `UPDATE distribucion_pesos
            SET pausado = 0,
                peso = IF(peso_previo > 0, peso_previo, 0),
                current_weight = 0
          WHERE scope = ? AND user_id = ?`,
        [scope, Number(userId)]
      );
    }

    const [raw] = await conn.query(
      `SELECT * FROM distribucion_pesos WHERE scope = ? AND activo = 1 FOR UPDATE`,
      [scope]
    );
    await persistirPesos(conn, normalizar(raw));
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listar(equipoId);
}

/** Deja parejo a todo el que participe (los pausados no cuentan). */
async function repartirParejo(equipoId) {
  const scope = scopeDe(equipoId);
  await sincronizarEquipo(equipoId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [raw] = await conn.query(
      `SELECT * FROM distribucion_pesos
        WHERE scope = ? AND activo = 1 AND pausado = 0 FOR UPDATE`,
      [scope]
    );
    const parejo = TOTAL / Math.max(1, raw.length);
    await persistirPesos(
      conn,
      raw.map((r) => ({ ...r, peso: parejo }))
    );
    await conn.query(
      `UPDATE distribucion_pesos SET fijo = 0 WHERE scope = ? AND activo = 1`,
      [scope]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return listar(equipoId);
}

/**
 * Elige un miembro del scope y devuelve su id, o null si no hay nadie.
 * Es un paso de la cascada: el elegido puede ser un vendedor o un
 * supervisor, según cómo esté armado ese scope.
 */
async function elegirEnScope(conn, scope, idsHabilitados) {
  if (!idsHabilitados.length) return null;

  const marks = idsHabilitados.map(() => '?').join(',');
  const [raw] = await conn.query(
    `SELECT * FROM distribucion_pesos
      WHERE scope = ? AND user_id IN (${marks}) FOR UPDATE`,
    [scope, ...idsHabilitados]
  );

  const { elegido, rows } = elegirSiguiente(raw);
  if (!elegido) return null;

  for (const r of rows) {
    await conn.query(`UPDATE distribucion_pesos SET current_weight = ? WHERE id = ?`, [
      r.current_weight,
      r.id,
    ]);
  }
  await conn.query(
    `UPDATE distribucion_pesos
        SET asignados_total = asignados_total + 1,
            asignados_mes  = asignados_mes + 1
      WHERE id = ?`,
    [elegido.id]
  );
  return elegido;
}

/** Miembros del scope que pueden recibir ahora mismo (doble chequeo). */
async function idsHabilitados(scope) {
  const [rows] = await pool.query(
    `SELECT d.user_id
       FROM distribucion_pesos d
       JOIN users u ON u.id = d.user_id
      WHERE d.scope = ? AND d.activo = 1 AND d.pausado = 0 AND u.active = 1`,
    [scope]
  );
  return rows.map((r) => r.user_id).filter((id) => !EXCLUIDOS.has(id));
}

/**
 * A quién le toca el próximo lead.
 *
 * Devuelve { gestionado, userId }:
 *   gestionado = false -> este equipo NO usa distribución por porcentaje.
 *                         El webhook debe caer al round-robin de siempre.
 *   gestionado = true  -> userId es el vendedor elegido (o null si el
 *                         equipo está gestionado pero quedó sin nadie).
 *
 * En modo cascada baja nivel por nivel: elige supervisor por porcentaje,
 * después vendedor por porcentaje dentro de ese supervisor.
 */
async function siguienteVendedor(equipoId, leadId = null, fuente = null) {
  const cfg = await getConfigEquipo(equipoId);
  if (!cfg) return { gestionado: false, userId: null };

  await sincronizarSiHaceFalta(equipoId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let nodo = Number(equipoId);
    let elegido = null;
    const camino = [];

    for (let nivel = 0; nivel < PROFUNDIDAD_MAX; nivel++) {
      const scope = scopeDe(nodo);
      const ids = await idsHabilitados(scope);

      elegido = await elegirEnScope(conn, scope, ids);
      if (!elegido) break;

      camino.push({ scope, userId: elegido.user_id, peso: elegido.peso });

      // ¿El elegido es un vendedor, o un supervisor por el que hay que bajar?
      const [[u]] = await conn.query(`SELECT role FROM users WHERE id = ?`, [
        elegido.user_id,
      ]);
      if (!u || u.role === ROL_VENDEDOR) break;

      // Es un sub-equipo: se baja un nivel.
      const subCfg = await getConfigEquipo(elegido.user_id, conn);
      if (!subCfg) break; // sub-equipo sin configurar, se corta acá
      nodo = elegido.user_id;
      elegido = null;

      // El scope de abajo puede no existir todavía.
      await sincronizarEquipo(nodo, conn);
    }

    if (!elegido) {
      await conn.commit();
      return { gestionado: true, userId: null };
    }

    for (const paso of camino) {
      await conn.query(
        `INSERT INTO distribucion_log (scope, lead_id, user_id, peso, fuente)
         VALUES (?, ?, ?, ?, ?)`,
        [paso.scope, leadId, paso.userId, paso.peso, fuente]
      );
    }

    await conn.commit();
    return { gestionado: true, userId: elegido.user_id };
  } catch (e) {
    await conn.rollback();
    console.error(`[distribucion] siguienteVendedor ${equipoId}:`, e.message);
    throw e;
  } finally {
    conn.release();
  }
}

async function previsualizar(equipoId, n = 100) {
  return repartirLote(await listar(equipoId), n);
}

/** Corré esto el 1° de cada mes. */
async function resetMensual() {
  await pool.query(`UPDATE distribucion_pesos SET asignados_mes = 0`);
}

module.exports = {
  scopeDe,
  EXCLUIDOS,
  // puras
  normalizar,
  setPorcentaje,
  repartirLote,
  elegirSiguiente,
  // jerarquía
  getVendedoresDeEquipo,
  getConfigEquipo,
  getSubEquipos,
  getMiembrosDeReparto,
  sincronizarEquipo,
  sincronizarTodos,
  invalidarPorUsuario,
  // API
  listar,
  actualizarPorcentaje,
  pausarVendedor,
  repartirParejo,
  siguienteVendedor,
  previsualizar,
  resetMensual,
};
