-- ============================================================
-- ETaxes+ — Limpieza y optimización de solicitudes_sat
-- Fecha: 2026-03-07
-- ============================================================

USE ETaxes2_0;

-- 1. Índice para acelerar queries de flatten.js y requests.js
--    (busca por tipo_solicitud y ordena por fecha)
ALTER TABLE solicitudes_sat
  ADD INDEX IF NOT EXISTS idx_tipo_fecha (tipo_solicitud, fecha_solicitud);

-- 2. Limpiar solicitudes estancadas/vencidas
--
--    Estado 0 = Cancelada (SAT rechazó)
--    Estado 5 = Vencida   (SAT no reservó los paquetes en tiempo)
--    Estado 1 con >7 días = Pendiente estancada (jamás completará)
--
--    Estado 3 = Completada/Descargada → CONSERVAR (usadas en flatten para tipado)
--
DELETE FROM solicitudes_sat
WHERE estado_solicitud IN ('0', '5')
   OR (
       estado_solicitud = '1'
       AND fecha_solicitud < DATE_SUB(NOW(), INTERVAL 7 DAY)
   );

-- 3. Verificar resultado
SELECT
  estado_solicitud,
  tipo_solicitud,
  COUNT(*) AS registros
FROM solicitudes_sat
GROUP BY estado_solicitud, tipo_solicitud
ORDER BY registros DESC;

SELECT COUNT(*) AS total_solicitudes FROM solicitudes_sat;
