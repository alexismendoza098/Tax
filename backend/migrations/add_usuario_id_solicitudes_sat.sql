-- =================================================================
-- Migración: Añadir usuario_id a solicitudes_sat
-- Objetivo: permitir aislamiento multi-tenant (cada usuario ve
--           solo sus propias solicitudes SAT)
-- Aplicar con: npm run migrate
-- =================================================================

USE ETaxes2_0;

-- 1. Añadir columna usuario_id (nullable para no romper datos históricos)
ALTER TABLE solicitudes_sat
  ADD COLUMN IF NOT EXISTS usuario_id INT NULL
    COMMENT 'FK a usuarios.id — propietario de la solicitud';

-- 2. Índice para acelerar queries filtradas por usuario
ALTER TABLE solicitudes_sat
  ADD INDEX IF NOT EXISTS idx_solicitudes_usuario (usuario_id);

-- 3. FK hacia usuarios (SET NULL en delete para conservar historial)
-- Nota: si la constraint ya existe se omite con el bloque condicional
SET @constraint_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = 'ETaxes2_0'
    AND TABLE_NAME = 'solicitudes_sat'
    AND CONSTRAINT_NAME = 'fk_solicitudes_usuario'
);

SET @sql = IF(@constraint_exists = 0,
  'ALTER TABLE solicitudes_sat ADD CONSTRAINT fk_solicitudes_usuario
     FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL',
  'SELECT "FK ya existe, omitiendo" AS info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Rellenar datos históricos:
--    Asociar cada solicitud existente con el primer usuario que tenga ese RFC
UPDATE solicitudes_sat s
JOIN (
  SELECT rfc, MIN(usuario_id) AS usuario_id
  FROM contribuyentes
  GROUP BY rfc
) c ON s.rfc = c.rfc
SET s.usuario_id = c.usuario_id
WHERE s.usuario_id IS NULL;

SELECT
  CONCAT('solicitudes_sat: ', COUNT(*), ' filas totales') AS info
FROM solicitudes_sat;

SELECT
  CONCAT('Sin usuario_id: ', SUM(CASE WHEN usuario_id IS NULL THEN 1 ELSE 0 END)) AS sin_usuario
FROM solicitudes_sat;
