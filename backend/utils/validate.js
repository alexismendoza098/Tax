/**
 * ETaxes+ — Validadores de inputs fiscales
 * Generado por el Agente v2
 *
 * Uso:
 *   const { validarRFC, validarRango, validarMonto } = require('../utils/validate');
 */

// ── RFC ──────────────────────────────────────────────────────────────────────
/** Valida RFC de Persona Moral (12 caracteres) o Física (13 caracteres) */
exports.validarRFC = (rfc) => {
  if (!rfc || typeof rfc !== 'string') return false;
  const clean = rfc.trim().toUpperCase();
  // PM: 3 letras + 6 dígitos fecha + 3 homoclave
  const PM = /^[A-ZÑ&]{3}d{6}[A-Z0-9]{3}$/;
  // PF: 4 letras + 6 dígitos fecha + 3 homoclave
  const PF = /^[A-ZÑ&]{4}d{6}[A-Z0-9]{3}$/;
  return PM.test(clean) || PF.test(clean);
};

// ── Rango de fechas ───────────────────────────────────────────────────────────
/**
 * Valida rango de fechas.
 * @returns { valid: bool, error?: string, start?: Date, end?: Date }
 */
exports.validarRango = (inicio, fin) => {
  if (!inicio || !fin) return { valid: false, error: 'fecha_inicio y fecha_fin son requeridas' };
  const s = new Date(inicio);
  const e = new Date(fin);
  if (isNaN(s.getTime())) return { valid: false, error: `fecha_inicio inválida: ${inicio}` };
  if (isNaN(e.getTime())) return { valid: false, error: `fecha_fin inválida: ${fin}` };
  if (s > e) return { valid: false, error: 'fecha_inicio debe ser anterior a fecha_fin' };
  const diffDays = (e - s) / 86400000;
  if (diffDays > 366) return { valid: false, error: 'El rango máximo permitido es 366 días' };
  return { valid: true, start: s, end: e };
};

// ── Monto ──────────────────────────────────────────────────────────────────────
/** Valida que un monto sea numérico no negativo */
exports.validarMonto = (val, campo = 'monto') => {
  const n = parseFloat(val);
  if (isNaN(n)) return { valid: false, error: `${campo} debe ser un número` };
  if (n < 0)    return { valid: false, error: `${campo} no puede ser negativo` };
  return { valid: true, value: n };
};

// ── Año/Mes ───────────────────────────────────────────────────────────────────
/** Valida año (2000-2100) y mes (1-12) */
exports.validarPeriodo = (year, mes) => {
  const y = parseInt(year);
  const m = parseInt(mes);
  if (isNaN(y) || y < 2000 || y > 2100) return { valid: false, error: `Año inválido: ${year}` };
  if (isNaN(m) || m < 1 || m > 12)       return { valid: false, error: `Mes inválido: ${mes} (debe ser 1-12)` };
  return { valid: true, year: y, mes: m };
};

// ── UUID CFDI ─────────────────────────────────────────────────────────────────
/** Valida formato UUID (36 caracteres, guiones en posiciones correctas) */
exports.validarUUID = (uuid) => {
  if (!uuid || typeof uuid !== 'string') return false;
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(uuid.trim());
};

// ── Paginación ────────────────────────────────────────────────────────────────
/** Parsea y valida parámetros de paginación de la query string */
exports.parsePagination = (query, defaultLimit = 50) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(500, Math.max(1, parseInt(query.limit) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};
