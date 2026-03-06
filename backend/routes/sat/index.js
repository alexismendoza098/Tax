const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');

const authRoutes      = require('./auth');
const requestsRoutes  = require('./requests');
const downloadsRoutes = require('./downloads');
const bulkRoutes      = require('./bulk');      // Descarga masiva anual

// Proteger TODAS las rutas SAT con autenticación JWT
router.use(authMiddleware);

// Mount sub-modules
// Since the main server mounts this at /api/sat, these routes will be:
// /api/sat/config       -> authRoutes
// /api/sat/request      -> requestsRoutes
// /api/sat/bulk-year    -> bulkRoutes (nuevo)
// /api/sat/status-codes -> bulkRoutes (diccionario SAT)

router.use('/', authRoutes);
router.use('/', requestsRoutes);
router.use('/', downloadsRoutes);
router.use('/', bulkRoutes);

module.exports = router;
