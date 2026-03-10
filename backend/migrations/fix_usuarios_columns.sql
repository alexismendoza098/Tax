-- Agrega columnas faltantes en la tabla usuarios
-- Sin estas columnas, backend/routes/users.js falla con "Unknown column"
USE ETaxes2_0;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS rfc     VARCHAR(13)  NULL AFTER username,
  ADD COLUMN IF NOT EXISTS nombre  VARCHAR(200) NULL AFTER rfc,
  ADD COLUMN IF NOT EXISTS email   VARCHAR(200) NULL AFTER nombre;
