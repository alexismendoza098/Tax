/**
 * ETaxes+ — Respuestas API estandarizadas
 * Generado por el Agente v2
 *
 * Uso:
 *   const { ok, fail, paginate } = require('../utils/respond');
 *   ok(res, { data })
 *   fail(res, 400, 'Mensaje de error')
 *   paginate(res, rows, total, page, limit)
 */

/** 200 OK con data */
exports.ok = (res, data = {}) =>
  res.json({ success: true, ...data });

/** Error con código HTTP y mensaje */
exports.fail = (res, status, message, extra = {}) =>
  res.status(status).json({ error: message, ...extra });

/** 201 Created */
exports.created = (res, data = {}) =>
  res.status(201).json({ success: true, ...data });

/** Respuesta paginada */
exports.paginate = (res, rows, total, page, limit) =>
  res.json({
    data: rows,
    pagination: {
      total,
      page:  parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / limit),
    },
  });

/** 204 No Content (para DELETE exitoso) */
exports.noContent = (res) => res.status(204).end();

/** Error interno estandarizado (500) */
exports.serverError = (res, err, context = '') => {
  const msg = err?.message || String(err);
  if (context) console.error(`[ETaxes+ ERROR] ${context}:`, msg);
  return res.status(500).json({ error: 'Error interno del servidor' });
};
