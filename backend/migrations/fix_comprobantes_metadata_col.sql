-- =====================================================================
-- MIGRACIÓN: Agregar columna metadata_paquete_id a comprobantes
-- Bug: la ruta GET /api/flatten/packages hacía SELECT DISTINCT
--      metadata_paquete_id FROM comprobantes pero la columna no existía,
--      causando un error 500 ("Error al listar paquetes").
-- =====================================================================

USE ETaxes2_0;

ALTER TABLE comprobantes
  ADD COLUMN IF NOT EXISTS metadata_paquete_id VARCHAR(50) NULL DEFAULT NULL
  COMMENT 'ID del paquete ZIP de donde se importó este CFDI (flatten)';

-- Índice para acelerar búsquedas por paquete
CREATE INDEX IF NOT EXISTS idx_comprobantes_paquete
  ON comprobantes (metadata_paquete_id);
