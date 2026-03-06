/**
 * ETaxes+ — DB Helpers
 * Generado por el Agente v2
 *
 * Funciones de utilidad para consultas comunes a MySQL.
 */
const pool = require('../db');

/**
 * Consulta paginada.
 * @param {string} sql   - SQL sin LIMIT/OFFSET
 * @param {Array}  params - parámetros del WHERE
 * @param {number} page   - página (1-indexed)
 * @param {number} limit  - registros por página
 * @returns {{ rows, total, pages, page, limit }}
 */
exports.queryPaginated = async (sql, params = [], page = 1, limit = 50) => {
  const offset   = (page - 1) * limit;
  const countSql = `SELECT COUNT(*) AS n FROM (${sql}) AS _t`;
  const [[{ n }]]= await pool.query(countSql, params);
  const [rows]   = await pool.query(`${sql} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { rows, total: n, pages: Math.ceil(n / limit), page, limit };
};

/**
 * Verificar si un registro existe.
 * @param {string} table - nombre de la tabla
 * @param {string} col   - columna a comparar
 * @param {*}      val   - valor a buscar
 * @returns {boolean}
 */
exports.exists = async (table, col, val) => {
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` = ? LIMIT 1`,
    [val]
  );
  return n > 0;
};

/**
 * Obtener contribuyente_id del usuario (patrón repetido en todo el sistema).
 * @param {number} userId - req.user.id
 * @param {string} [rfc]  - RFC opcional para filtrar
 * @returns {object|null} { id, rfc, nombre } o null
 */
exports.getContrib = async (userId, rfc) => {
  let q = 'SELECT id, rfc, nombre FROM contribuyentes WHERE usuario_id = ?';
  const p = [userId];
  if (rfc) { q += ' AND rfc = ?'; p.push(rfc.toUpperCase()); }
  else q += ' ORDER BY id LIMIT 1';
  const [rows] = await pool.query(q, p);
  return rows[0] || null;
};

/**
 * Construir cláusula WHERE de fecha para comprobantes.
 * @param {string} year - año o 'todos'
 * @param {string} mes  - mes o 'todos'
 * @param {string} [prefix] - alias de tabla (default 'c')
 * @returns {{ sql: string, params: Array }}
 */
exports.buildDateFilter = (year, mes, prefix = 'c') => {
  const parts = [], params = [];
  if (year && year !== 'todos') { parts.push(`YEAR(${prefix}.fecha) = ?`); params.push(parseInt(year)); }
  if (mes  && mes  !== 'todos') { parts.push(`MONTH(${prefix}.fecha) = ?`); params.push(parseInt(mes)); }
  return { sql: parts.length ? 'AND ' + parts.join(' AND ') : '', params };
};
