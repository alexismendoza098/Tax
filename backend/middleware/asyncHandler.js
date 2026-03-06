/**
 * ETaxes+ — asyncHandler middleware
 * Generado por el Agente v2
 *
 * Envuelve funciones async de Express para capturar errores automáticamente
 * y pasarlos al error handler global (next(err)).
 *
 * Uso ANTES (repetitivo):
 *   router.get('/ruta', authMiddleware, async (req, res) => {
 *     try {
 *       const data = await pool.query(...);
 *       res.json(data);
 *     } catch (e) {
 *       res.status(500).json({ error: e.message });
 *     }
 *   });
 *
 * Uso DESPUÉS (limpio):
 *   const wrap = require('../middleware/asyncHandler');
 *   router.get('/ruta', authMiddleware, wrap(async (req, res) => {
 *     const data = await pool.query(...);
 *     res.json(data);
 *   }));
 */

/**
 * @param {Function} fn - función async (req, res, next) => Promise<void>
 * @returns {Function} middleware de Express con manejo automático de errores
 */
module.exports = function asyncHandler(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error(`[AsyncHandler] ${req.method} ${req.originalUrl}: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error interno del servidor' });
      }
    });
  };
};
