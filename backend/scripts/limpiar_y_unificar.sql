-- =====================================================================
-- LIMPIEZA Y UNIFICACIÓN DE DATOS — ETX Tax Recovery
-- EJECUTAR EN phpMyAdmin o MySQL Workbench
-- ANTES de ejecutar: hacer backup con mysqldump
-- =====================================================================

USE IVATAXRECOVERY;

-- 1. Ver estado actual ANTES de cambiar nada
SELECT 'ANTES DE LIMPIEZA' as fase, COUNT(*) as total_cfdis,
       SUM(CASE WHEN estado NOT IN ('Vigente','Cancelado') THEN 1 ELSE 0 END) as metadata_invalidos,
       ROUND(SUM(total_traslados),2) as iva_total
FROM comprobantes;

-- 2. ¿Cuáles son los CFDIs sin IVA (de metadata)?
SELECT tipo_de_comprobante, estado, COUNT(*) as n,
       ROUND(SUM(total_traslados),2) as iva_total,
       ROUND(SUM(total),2) as monto_total
FROM comprobantes
WHERE estado NOT IN ('Vigente','Cancelado')
GROUP BY tipo_de_comprobante, estado;

-- ──────────────────────────────────────────────────────────
-- OPCIÓN A: Corregir estado numérico (1→Vigente, 0→Cancelado)
-- Esto conserva los CFDIs de metadata en DB pero NO les agrega IVA
-- Útil solo para referencia, no para Auditoría
-- ──────────────────────────────────────────────────────────

-- DESCOMENTA PARA EJECUTAR:
-- UPDATE comprobantes SET estado = 'Vigente' WHERE estado = '1';
-- UPDATE comprobantes SET estado = 'Cancelado' WHERE estado = '0';

-- ──────────────────────────────────────────────────────────
-- OPCIÓN B: ELIMINAR los CFDIs de metadata (RECOMENDADO)
-- Luego los vuelves a procesar como XML (Tipo=CFDI)
-- ──────────────────────────────────────────────────────────

-- Primero ver qué se va a borrar:
SELECT uuid FROM comprobantes WHERE estado NOT IN ('Vigente','Cancelado') LIMIT 5;

-- Borrar tablas relacionadas primero (FK constraints):
-- DESCOMENTA PARA EJECUTAR:
/*
DELETE it FROM impuesto_traslados it
  INNER JOIN comprobantes c ON c.uuid = it.uuid
  WHERE c.estado NOT IN ('Vigente','Cancelado');

DELETE ir FROM impuesto_retenciones ir
  INNER JOIN comprobantes c ON c.uuid = ir.uuid
  WHERE c.estado NOT IN ('Vigente','Cancelado');

DELETE cr FROM cfdi_relacionados cr
  INNER JOIN comprobantes c ON c.uuid = cr.uuid
  WHERE c.estado NOT IN ('Vigente','Cancelado');

DELETE con FROM conceptos con
  INNER JOIN comprobantes c ON c.uuid = con.uuid
  WHERE c.estado NOT IN ('Vigente','Cancelado');

-- Finalmente borrar los comprobantes de metadata:
DELETE FROM comprobantes WHERE estado NOT IN ('Vigente','Cancelado');
*/

-- ──────────────────────────────────────────────────────────
-- 3. UNIFICAR contribuyentes fragmentados
-- Si usas siempre el usuario 'cesar' (id=1), mover datos a contribuyente_id=9
-- ──────────────────────────────────────────────────────────

-- Ver situación actual:
SELECT c.id, c.rfc, c.usuario_id, u.username, COUNT(cp.uuid) as cfdis
FROM contribuyentes c
LEFT JOIN usuarios u ON u.id = c.usuario_id
LEFT JOIN comprobantes cp ON cp.contribuyente_id = c.id
WHERE c.rfc = 'MESP980407UD4'
GROUP BY c.id;

-- DESCOMENTA SI QUIERES UNIFICAR (elige el usuario correcto):
-- Mover CFDIs del usuario admin (contrib_id=10) al usuario cesar (contrib_id=9):
-- UPDATE comprobantes SET contribuyente_id = 9 WHERE contribuyente_id = 10;

-- Mover CFDIs del usuario demo (contrib_id=4) al usuario cesar (contrib_id=9):
-- UPDATE comprobantes SET contribuyente_id = 9 WHERE contribuyente_id = 4;

-- ──────────────────────────────────────────────────────────
-- 4. VERIFICAR resultado final
-- ──────────────────────────────────────────────────────────
SELECT 'DESPUÉS DE LIMPIEZA' as fase, COUNT(*) as total_cfdis,
       SUM(CASE WHEN estado='Vigente' THEN 1 ELSE 0 END) as vigentes,
       SUM(CASE WHEN estado='Cancelado' THEN 1 ELSE 0 END) as cancelados,
       SUM(CASE WHEN total_traslados>0 THEN 1 ELSE 0 END) as con_iva,
       ROUND(SUM(total_traslados),2) as iva_total,
       SUM(CASE WHEN rfc_emisor = 'MESP980407UD4' THEN 1 ELSE 0 END) as emitidos,
       SUM(CASE WHEN rfc_receptor = 'MESP980407UD4' THEN 1 ELSE 0 END) as recibidos
FROM comprobantes
WHERE contribuyente_id = 9;  -- cambia según tu usuario
