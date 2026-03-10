/**
 * tenant.js — Middleware de aislamiento multi-tenant
 *
 * Garantiza que cualquier contribuyente_id o RFC que llega en el request
 * pertenezca al usuario autenticado (req.user.id).
 *
 * Uso:
 *   const { validateContribuyente, validateRFC } = require('../middleware/tenant');
 *
 *   // Por ID de contribuyente (en query, params o body)
 *   router.get('/mis-datos', authMiddleware, validateContribuyente, handler);
 *
 *   // Por RFC (en query, params o body)
 *   router.get('/por-rfc', authMiddleware, validateRFC, handler);
 *
 * Si la validación pasa, el middleware inyecta req.contrib con
 * { id, rfc } para que el handler no tenga que volver a consultarlo.
 */

const pool = require('../db');

// ─── Valida por contribuyente_id ─────────────────────────────────────────────
async function validateContribuyente(req, res, next) {
  const contribuyente_id =
    req.params.contribuyente_id ??
    req.query.contribuyente_id ??
    req.body?.contribuyente_id;

  // Si no viene contribuyente_id, dejar pasar (algunos endpoints lo usan solo
  // como filtro opcional; las queries ya hacen el JOIN correcto).
  if (!contribuyente_id) return next();

  try {
    const [rows] = await pool.query(
      'SELECT id, rfc FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );

    if (!rows.length) {
      return res.status(403).json({
        error: 'Acceso denegado: el contribuyente no pertenece a tu cuenta'
      });
    }

    req.contrib = rows[0]; // Inyectar para evitar query extra en el handler
    next();
  } catch (err) {
    console.error('[tenant] validateContribuyente error:', err.message);
    res.status(500).json({ error: 'Error al validar acceso al contribuyente' });
  }
}

// ─── Valida por RFC ───────────────────────────────────────────────────────────
async function validateRFC(req, res, next) {
  const rfc =
    req.params.rfc ??
    req.query.rfc ??
    req.body?.rfc;

  if (!rfc) return next();

  try {
    const [rows] = await pool.query(
      'SELECT id, rfc FROM contribuyentes WHERE rfc = ? AND usuario_id = ?',
      [rfc.toUpperCase(), req.user.id]
    );

    if (!rows.length) {
      return res.status(403).json({
        error: 'Acceso denegado: el RFC no pertenece a tu cuenta'
      });
    }

    req.contrib = rows[0];
    next();
  } catch (err) {
    console.error('[tenant] validateRFC error:', err.message);
    res.status(500).json({ error: 'Error al validar acceso al RFC' });
  }
}

// ─── Helper para validar ownership en el código del handler ──────────────────
// Útil cuando el identificador llega dentro de un body complejo o en
// situaciones donde no es práctico usarlo como middleware de ruta.
async function assertOwnsContribuyente(userId, contribuyenteId) {
  const [rows] = await pool.query(
    'SELECT id, rfc FROM contribuyentes WHERE id = ? AND usuario_id = ?',
    [contribuyenteId, userId]
  );
  if (!rows.length) {
    const err = new Error('Contribuyente no autorizado');
    err.statusCode = 403;
    throw err;
  }
  return rows[0];
}

module.exports = { validateContribuyente, validateRFC, assertOwnsContribuyente };
