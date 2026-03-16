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
-- =====================================================================
-- MÓDULO ESTADOS DE CUENTA BANCARIOS — ETX Tax Recovery
-- Conciliación CFDI vs movimientos bancarios (Art. 28 LISR, Art. 1-B LIVA)
-- =====================================================================

USE IVATAXRECOVERY;

-- ─── 1. Estados de cuenta (cabecera de cada archivo subido) ──────────
CREATE TABLE IF NOT EXISTS estados_cuenta (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id   INT NOT NULL,
  banco              VARCHAR(50)  NOT NULL,  -- BBVA, SANTANDER, HSBC, BANAMEX, BANORTE, OTRO
  cuenta             VARCHAR(50),            -- Últimos 4 dígitos o número parcial
  titular            VARCHAR(255),
  periodo_inicio     DATE,
  periodo_fin        DATE,
  total_movimientos  INT          DEFAULT 0,
  total_cargos       DECIMAL(18,2) DEFAULT 0,
  total_abonos       DECIMAL(18,2) DEFAULT 0,
  saldo_inicial      DECIMAL(18,2) DEFAULT 0,
  saldo_final        DECIMAL(18,2) DEFAULT 0,
  archivo_nombre     VARCHAR(255),
  formato            VARCHAR(20),            -- CSV, EXCEL
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_contrib_periodo (contribuyente_id, periodo_inicio, periodo_fin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. Movimientos bancarios individuales ────────────────────────────
CREATE TABLE IF NOT EXISTS movimientos_bancarios (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  estado_cuenta_id  INT          NOT NULL,
  fecha             DATE         NOT NULL,
  concepto          TEXT,
  referencia        VARCHAR(150),
  cargo             DECIMAL(18,2) DEFAULT 0,
  abono             DECIMAL(18,2) DEFAULT 0,
  saldo             DECIMAL(18,2),
  tipo              VARCHAR(10)  NOT NULL,   -- CARGO | ABONO
  conciliado        TINYINT(1)   DEFAULT 0,
  cfdi_uuid         VARCHAR(36),            -- UUID del CFDI conciliado
  confianza         TINYINT(3),             -- 0-100: qué tan segura es la conciliación
  nota_conciliacion VARCHAR(255),
  FOREIGN KEY (estado_cuenta_id) REFERENCES estados_cuenta(id) ON DELETE CASCADE,
  INDEX idx_fecha    (fecha),
  INDEX idx_conciliado (conciliado),
  INDEX idx_tipo     (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
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
-- =====================================================================
-- MIGRACIÓN: Tablas faltantes en ETaxes2_0
-- Corrección: las migraciones anteriores usaban USE IVATAXRECOVERY
-- Ejecutar: node scripts/migrate.js
-- =====================================================================

USE ETaxes2_0;

-- ─────────────────────────────────────────────────────
-- 1. PAPELERA (Art. 30 CFF — retención 5 años)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS papelera (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tipo_registro   VARCHAR(50) NOT NULL,
  registro_id     VARCHAR(100) NOT NULL,
  datos_json      LONGTEXT NOT NULL,
  contribuyente_id INT,
  rfc             VARCHAR(13),
  eliminado_por   INT,
  motivo          VARCHAR(255),
  fecha_eliminacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_expiracion  DATE GENERATED ALWAYS AS (DATE_ADD(fecha_eliminacion, INTERVAL 5 YEAR)) STORED,
  INDEX idx_papelera_tipo (tipo_registro),
  INDEX idx_papelera_contribuyente (contribuyente_id),
  INDEX idx_papelera_fecha (fecha_eliminacion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 2. CATÁLOGO DE CUENTAS (Contabilidad Electrónica SAT)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalogo_cuentas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  numero_cuenta   VARCHAR(30) NOT NULL,
  descripcion     VARCHAR(255) NOT NULL,
  naturaleza      CHAR(1) NOT NULL COMMENT 'D=Deudora, A=Acreedora',
  tipo            VARCHAR(20) NOT NULL,
  sub_tipo        VARCHAR(50),
  nivel           TINYINT DEFAULT 1,
  cuenta_padre_id INT,
  codigo_agrupador VARCHAR(20),
  activa          TINYINT(1) DEFAULT 1,
  es_cuenta_sat   TINYINT(1) DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_cuenta_contribuyente (contribuyente_id, numero_cuenta),
  INDEX idx_catalogo_contribuyente (contribuyente_id),
  INDEX idx_catalogo_nivel (nivel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 3. PÓLIZAS CONTABLES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS polizas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  tipo_poliza     VARCHAR(20) NOT NULL COMMENT 'D=Diario, I=Ingresos, E=Egresos, X=Cierre',
  numero          INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  concepto        VARCHAR(500),
  uuid_cfdi       VARCHAR(36),
  num_operacion   VARCHAR(100),
  generada_auto   TINYINT(1) DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_polizas_periodo (contribuyente_id, ejercicio, periodo),
  INDEX idx_polizas_tipo (tipo_poliza)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 4. MOVIMIENTOS DE PÓLIZAS
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poliza_movimientos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  poliza_id       INT NOT NULL,
  cuenta_id       INT NOT NULL,
  numero_cuenta   VARCHAR(30),
  descripcion     VARCHAR(500),
  debe            DECIMAL(18,2) DEFAULT 0,
  haber           DECIMAL(18,2) DEFAULT 0,
  uuid_cfdi       VARCHAR(36),
  FOREIGN KEY (poliza_id) REFERENCES polizas(id) ON DELETE CASCADE,
  INDEX idx_mov_poliza (poliza_id),
  INDEX idx_mov_cuenta (cuenta_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 5. BALANZA DE VERIFICACIÓN
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balanza_verificacion (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  cuenta_id       INT NOT NULL,
  numero_cuenta   VARCHAR(30),
  descripcion     VARCHAR(255),
  saldo_inicial_debe   DECIMAL(18,2) DEFAULT 0,
  saldo_inicial_haber  DECIMAL(18,2) DEFAULT 0,
  debe_periodo    DECIMAL(18,2) DEFAULT 0,
  haber_periodo   DECIMAL(18,2) DEFAULT 0,
  saldo_final_debe     DECIMAL(18,2) DEFAULT 0,
  saldo_final_haber    DECIMAL(18,2) DEFAULT 0,
  generada_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_balanza (contribuyente_id, ejercicio, periodo, cuenta_id),
  INDEX idx_balanza_periodo (contribuyente_id, ejercicio, periodo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 6. ACTIVOS FIJOS
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activos_fijos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  descripcion     VARCHAR(500) NOT NULL,
  tipo            VARCHAR(50) NOT NULL,
  fecha_adquisicion DATE NOT NULL,
  costo_adquisicion DECIMAL(18,2) NOT NULL,
  uuid_cfdi       VARCHAR(36),
  vida_util_anios TINYINT NOT NULL DEFAULT 10,
  tasa_depreciacion DECIMAL(5,4) NOT NULL,
  metodo          VARCHAR(20) DEFAULT 'lineal',
  depreciacion_acumulada DECIMAL(18,2) DEFAULT 0,
  valor_en_libros DECIMAL(18,2) GENERATED ALWAYS AS (costo_adquisicion - depreciacion_acumulada) STORED,
  cuenta_id       INT,
  activo          TINYINT(1) DEFAULT 1,
  fecha_baja      DATE,
  motivo_baja     VARCHAR(255),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_activos_contribuyente (contribuyente_id),
  INDEX idx_activos_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 7. DEPRECIACIONES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS depreciaciones (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  activo_id       INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  depreciacion_periodo DECIMAL(18,2) NOT NULL,
  depreciacion_acumulada_al_periodo DECIMAL(18,2) NOT NULL,
  saldo_por_depreciar DECIMAL(18,2) NOT NULL,
  poliza_id       INT,
  FOREIGN KEY (activo_id) REFERENCES activos_fijos(id) ON DELETE CASCADE,
  UNIQUE KEY uq_depreciacion (activo_id, ejercicio, periodo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 8. ISR PAGOS PROVISIONALES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS isr_pagos_provisionales (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  ingresos_periodo     DECIMAL(18,2) DEFAULT 0,
  ingresos_acumulados  DECIMAL(18,2) DEFAULT 0,
  deducciones_periodo  DECIMAL(18,2) DEFAULT 0,
  deducciones_acumuladas DECIMAL(18,2) DEFAULT 0,
  depreciacion_periodo DECIMAL(18,2) DEFAULT 0,
  depreciacion_acumulada DECIMAL(18,2) DEFAULT 0,
  ptu_pagada           DECIMAL(18,2) DEFAULT 0,
  utilidad_fiscal      DECIMAL(18,2) DEFAULT 0,
  coeficiente_utilidad DECIMAL(10,6) DEFAULT 0,
  base_isr             DECIMAL(18,2) DEFAULT 0,
  isr_causado          DECIMAL(18,2) DEFAULT 0,
  isr_retenido         DECIMAL(18,2) DEFAULT 0,
  isr_pagos_anteriores DECIMAL(18,2) DEFAULT 0,
  isr_a_pagar          DECIMAL(18,2) DEFAULT 0,
  tasa_isr             DECIMAL(5,2) DEFAULT 30.00,
  tipo_persona         CHAR(2) DEFAULT 'PM',
  regimen_fiscal       VARCHAR(10),
  estado               VARCHAR(20) DEFAULT 'borrador',
  fecha_pago           DATE,
  referencia_pago      VARCHAR(100),
  observaciones        TEXT,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_isr_periodo (contribuyente_id, ejercicio, periodo),
  INDEX idx_isr_contribuyente (contribuyente_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 9. DIOT PROVEEDORES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diot_proveedores (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  periodo_year    YEAR NOT NULL,
  periodo_mes     TINYINT NOT NULL,
  rfc_proveedor   VARCHAR(13),
  nombre_proveedor VARCHAR(255),
  tipo_tercero    VARCHAR(2) NOT NULL,
  tipo_operacion  VARCHAR(2) DEFAULT '85',
  valor_actos_tasa0   DECIMAL(18,2) DEFAULT 0,
  valor_actos_exentos DECIMAL(18,2) DEFAULT 0,
  valor_actos_16      DECIMAL(18,2) DEFAULT 0,
  valor_actos_8       DECIMAL(18,2) DEFAULT 0,
  iva_pagado_16       DECIMAL(18,2) DEFAULT 0,
  iva_pagado_8        DECIMAL(18,2) DEFAULT 0,
  iva_no_acreditable  DECIMAL(18,2) DEFAULT 0,
  iva_importacion     DECIMAL(18,2) DEFAULT 0,
  iva_retenido        DECIMAL(18,2) DEFAULT 0,
  isr_retenido        DECIMAL(18,2) DEFAULT 0,
  num_cfdis       INT DEFAULT 0,
  es_efos         TINYINT(1) DEFAULT 0,
  estado          VARCHAR(20) DEFAULT 'pendiente',
  generado_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_diot (contribuyente_id, periodo_year, periodo_mes, rfc_proveedor),
  INDEX idx_diot_periodo (contribuyente_id, periodo_year, periodo_mes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 10. ESTADOS DE CUENTA BANCARIOS
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estados_cuenta (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id   INT NOT NULL,
  banco              VARCHAR(50) NOT NULL,
  cuenta             VARCHAR(50),
  titular            VARCHAR(255),
  periodo_inicio     DATE,
  periodo_fin        DATE,
  total_movimientos  INT DEFAULT 0,
  total_cargos       DECIMAL(18,2) DEFAULT 0,
  total_abonos       DECIMAL(18,2) DEFAULT 0,
  saldo_inicial      DECIMAL(18,2) DEFAULT 0,
  saldo_final        DECIMAL(18,2) DEFAULT 0,
  archivo_nombre     VARCHAR(255),
  formato            VARCHAR(20),
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_contrib_periodo (contribuyente_id, periodo_inicio, periodo_fin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 11. MOVIMIENTOS BANCARIOS
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS movimientos_bancarios (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  estado_cuenta_id  INT NOT NULL,
  fecha             DATE NOT NULL,
  concepto          TEXT,
  referencia        VARCHAR(150),
  cargo             DECIMAL(18,2) DEFAULT 0,
  abono             DECIMAL(18,2) DEFAULT 0,
  saldo             DECIMAL(18,2),
  tipo              VARCHAR(10) NOT NULL,
  conciliado        TINYINT(1) DEFAULT 0,
  cfdi_uuid         VARCHAR(36),
  confianza         TINYINT(3),
  nota_conciliacion VARCHAR(255),
  FOREIGN KEY (estado_cuenta_id) REFERENCES estados_cuenta(id) ON DELETE CASCADE,
  INDEX idx_fecha (fecha),
  INDEX idx_conciliado (conciliado),
  INDEX idx_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 12. VALIDACIONES CFDI (caché)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validaciones_cfdi (
  uuid            VARCHAR(36) PRIMARY KEY,
  estado_sat      VARCHAR(20),
  es_cancelable   VARCHAR(50),
  estatus_cancelacion VARCHAR(50),
  validado_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_validaciones_estado (estado_sat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 13. ALERTAS FISCALES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alertas_fiscales (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  tipo            VARCHAR(50) NOT NULL,
  severidad       VARCHAR(10) DEFAULT 'media',
  descripcion     TEXT NOT NULL,
  monto           DECIMAL(18,2),
  referencia_id   VARCHAR(100),
  resuelta        TINYINT(1) DEFAULT 0,
  fecha_alerta    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_resolucion DATETIME,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_alertas_contribuyente (contribuyente_id, resuelta),
  INDEX idx_alertas_tipo (tipo, severidad)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 14. CONFIG FISCAL POR CONTRIBUYENTE
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_fiscal (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL UNIQUE,
  tipo_persona    CHAR(2) DEFAULT 'PM',
  regimen_fiscal  VARCHAR(10),
  coeficiente_utilidad DECIMAL(10,6) DEFAULT 0,
  tasa_isr        DECIMAL(5,2) DEFAULT 30.00,
  aplica_iva_frontera TINYINT(1) DEFAULT 0,
  aplica_resico   TINYINT(1) DEFAULT 0,
  obliga_contabilidad_electronica TINYINT(1) DEFAULT 1,
  periodicidad_pagos VARCHAR(20) DEFAULT 'mensual',
  ejercicio_base_coef YEAR,
  actualizado_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 15. NÓMINA RESUMEN
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nomina_resumen (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  num_empleados   INT DEFAULT 0,
  total_percepciones DECIMAL(18,2) DEFAULT 0,
  total_deducciones  DECIMAL(18,2) DEFAULT 0,
  isr_retenido_empleados DECIMAL(18,2) DEFAULT 0,
  imss_obrero     DECIMAL(18,2) DEFAULT 0,
  imss_patronal   DECIMAL(18,2) DEFAULT 0,
  infonavit       DECIMAL(18,2) DEFAULT 0,
  subsidio_empleo DECIMAL(18,2) DEFAULT 0,
  neto_pagar      DECIMAL(18,2) DEFAULT 0,
  num_cfdis       INT DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_nomina_periodo (contribuyente_id, ejercicio, periodo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- Índices de performance adicionales (IF NOT EXISTS no está
-- soportado en todos los MySQL, así que los envolvemos en
-- un handler de error ignorado)
-- ─────────────────────────────────────────────────────
SELECT 'Migración completada exitosamente' AS resultado;
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
-- Agrega columnas faltantes en la tabla usuarios
-- Sin estas columnas, backend/routes/users.js falla con "Unknown column"
USE ETaxes2_0;

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS rfc     VARCHAR(13)  NULL AFTER username,
  ADD COLUMN IF NOT EXISTS nombre  VARCHAR(200) NULL AFTER rfc,
  ADD COLUMN IF NOT EXISTS email   VARCHAR(200) NULL AFTER nombre;
-- =====================================================
-- MIGRACIÓN: Nuevas Funcionalidades Contables/Fiscales
-- ETX Tax Recovery — Marzo 2026
-- =====================================================
-- Ejecutar: mysql -u root -p IVATAXRECOVERY < nuevas_funcionalidades.sql
-- =====================================================

USE IVATAXRECOVERY;

-- ─────────────────────────────────────────────────────
-- 1. PAPELERA — Archivo histórico de registros eliminados
--    (retención 5 años por Art. 30 CFF)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS papelera (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tipo_registro   VARCHAR(50) NOT NULL COMMENT 'cfdi, solicitud_sat, estado_cuenta, movimiento',
  registro_id     VARCHAR(100) NOT NULL COMMENT 'uuid o id del registro original',
  datos_json      LONGTEXT NOT NULL COMMENT 'snapshot JSON completo del registro',
  contribuyente_id INT,
  rfc             VARCHAR(13),
  eliminado_por   INT COMMENT 'usuario_id que eliminó',
  motivo          VARCHAR(255),
  fecha_eliminacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_expiracion  DATE GENERATED ALWAYS AS (DATE_ADD(fecha_eliminacion, INTERVAL 5 YEAR)) STORED,
  INDEX idx_papelera_tipo (tipo_registro),
  INDEX idx_papelera_contribuyente (contribuyente_id),
  INDEX idx_papelera_fecha (fecha_eliminacion)
) ENGINE=InnoDB COMMENT='Archivo histórico para auditoría — Art. 30 CFF retención 5 años';

-- ─────────────────────────────────────────────────────
-- 2. CATÁLOGO DE CUENTAS (Contabilidad Electrónica SAT)
--    Conforme a Código Agrupador SAT — Apéndice 24
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalogo_cuentas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  numero_cuenta   VARCHAR(30) NOT NULL COMMENT 'Ej: 102.01.01',
  descripcion     VARCHAR(255) NOT NULL,
  naturaleza      CHAR(1) NOT NULL COMMENT 'D=Deudora, A=Acreedora',
  tipo            VARCHAR(20) NOT NULL COMMENT 'Activo, Pasivo, Capital, Ingreso, Costo, Gasto, OtrosR, OtrosG',
  sub_tipo        VARCHAR(50) COMMENT 'Circulante, No Circulante, CP, LP, etc.',
  nivel           TINYINT DEFAULT 1 COMMENT '1=Rubro, 2=Cuenta, 3=Subcuenta',
  cuenta_padre_id INT COMMENT 'FK a nivel superior',
  codigo_agrupador VARCHAR(20) COMMENT 'Código SAT agrupador (Apéndice 24)',
  activa          TINYINT(1) DEFAULT 1,
  es_cuenta_sat   TINYINT(1) DEFAULT 0 COMMENT '1=es cuenta del catálogo SAT estándar',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_cuenta_contribuyente (contribuyente_id, numero_cuenta),
  INDEX idx_catalogo_contribuyente (contribuyente_id),
  INDEX idx_catalogo_nivel (nivel)
) ENGINE=InnoDB COMMENT='Catálogo de cuentas — Contabilidad Electrónica SAT';

-- ─────────────────────────────────────────────────────
-- 3. PÓLIZAS CONTABLES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS polizas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL COMMENT 'Mes 1-12',
  tipo_poliza     VARCHAR(2) NOT NULL COMMENT 'I=Ingreso, E=Egreso, D=Diario, N=Nómina, T=Transferencia',
  numero          INT NOT NULL,
  concepto        VARCHAR(500) NOT NULL,
  fecha           DATE NOT NULL,
  total_debe      DECIMAL(18,2) DEFAULT 0,
  total_haber     DECIMAL(18,2) DEFAULT 0,
  origen          VARCHAR(50) DEFAULT 'manual' COMMENT 'manual, cfdi_emitido, cfdi_recibido, nomina, banco',
  referencia_uuid VARCHAR(36) COMMENT 'UUID CFDI que originó esta póliza',
  generada_auto   TINYINT(1) DEFAULT 0,
  creada_por      INT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_polizas_periodo (contribuyente_id, ejercicio, periodo),
  INDEX idx_polizas_tipo (tipo_poliza)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 4. MOVIMIENTOS DE PÓLIZA (Partidas contables)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poliza_movimientos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  poliza_id       INT NOT NULL,
  cuenta_id       INT NOT NULL COMMENT 'FK catalogo_cuentas',
  numero_cuenta   VARCHAR(30) NOT NULL COMMENT 'Copia desnormalizada',
  descripcion     VARCHAR(500),
  debe            DECIMAL(18,2) DEFAULT 0,
  haber           DECIMAL(18,2) DEFAULT 0,
  moneda          VARCHAR(5) DEFAULT 'MXN',
  tipo_cambio     DECIMAL(10,4) DEFAULT 1,
  uuid_cfdi       VARCHAR(36) COMMENT 'CFDI relacionado si aplica',
  FOREIGN KEY (poliza_id) REFERENCES polizas(id) ON DELETE CASCADE,
  INDEX idx_mov_poliza (poliza_id),
  INDEX idx_mov_cuenta (cuenta_id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 5. BALANZA DE COMPROBACIÓN
--    Se genera/recalcula al cierre de cada mes
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balanza_comprobacion (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  cuenta_id       INT NOT NULL,
  numero_cuenta   VARCHAR(30) NOT NULL,
  descripcion     VARCHAR(255) NOT NULL,
  saldo_inicial_debe   DECIMAL(18,2) DEFAULT 0,
  saldo_inicial_haber  DECIMAL(18,2) DEFAULT 0,
  movimientos_debe     DECIMAL(18,2) DEFAULT 0,
  movimientos_haber    DECIMAL(18,2) DEFAULT 0,
  saldo_final_debe     DECIMAL(18,2) DEFAULT 0,
  saldo_final_haber    DECIMAL(18,2) DEFAULT 0,
  generada_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_balanza (contribuyente_id, ejercicio, periodo, cuenta_id),
  INDEX idx_balanza_periodo (contribuyente_id, ejercicio, periodo)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 6. ACTIVOS FIJOS
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activos_fijos (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  descripcion     VARCHAR(500) NOT NULL,
  tipo            VARCHAR(50) NOT NULL COMMENT 'Mobiliario, Equipo, Vehiculo, Edificio, Computacion, Otro',
  fecha_adquisicion DATE NOT NULL,
  costo_adquisicion DECIMAL(18,2) NOT NULL,
  uuid_cfdi       VARCHAR(36) COMMENT 'CFDI de compra',
  vida_util_anios TINYINT NOT NULL DEFAULT 10,
  tasa_depreciacion DECIMAL(5,4) NOT NULL COMMENT 'Conforme Art. 34 LISR',
  metodo          VARCHAR(20) DEFAULT 'lineal' COMMENT 'lineal, acelerado',
  depreciacion_acumulada DECIMAL(18,2) DEFAULT 0,
  valor_en_libros DECIMAL(18,2) GENERATED ALWAYS AS (costo_adquisicion - depreciacion_acumulada) STORED,
  cuenta_id       INT COMMENT 'cuenta contable asignada',
  activo          TINYINT(1) DEFAULT 1,
  fecha_baja      DATE,
  motivo_baja     VARCHAR(255),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_activos_contribuyente (contribuyente_id),
  INDEX idx_activos_tipo (tipo)
) ENGINE=InnoDB;

-- Tabla de cálculos de depreciación mensuales
CREATE TABLE IF NOT EXISTS depreciaciones (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  activo_id       INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  depreciacion_periodo DECIMAL(18,2) NOT NULL,
  depreciacion_acumulada_al_periodo DECIMAL(18,2) NOT NULL,
  saldo_por_depreciar DECIMAL(18,2) NOT NULL,
  poliza_id       INT COMMENT 'póliza contable generada',
  FOREIGN KEY (activo_id) REFERENCES activos_fijos(id) ON DELETE CASCADE,
  UNIQUE KEY uq_depreciacion (activo_id, ejercicio, periodo)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 7. ISR — PAGOS PROVISIONALES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS isr_pagos_provisionales (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL COMMENT 'Mes 1-12',
  -- Ingresos
  ingresos_periodo     DECIMAL(18,2) DEFAULT 0,
  ingresos_acumulados  DECIMAL(18,2) DEFAULT 0,
  -- Deducciones
  deducciones_periodo  DECIMAL(18,2) DEFAULT 0,
  deducciones_acumuladas DECIMAL(18,2) DEFAULT 0,
  -- Depreciaciones (Art. 31 LISR)
  depreciacion_periodo DECIMAL(18,2) DEFAULT 0,
  depreciacion_acumulada DECIMAL(18,2) DEFAULT 0,
  -- PTU pagada
  ptu_pagada           DECIMAL(18,2) DEFAULT 0,
  -- Cálculo ISR
  utilidad_fiscal      DECIMAL(18,2) DEFAULT 0 COMMENT 'Ingresos - Deducciones - Depreciaciones - PTU',
  coeficiente_utilidad DECIMAL(10,6) DEFAULT 0 COMMENT 'Determinado del ejercicio anterior',
  base_isr             DECIMAL(18,2) DEFAULT 0,
  isr_causado          DECIMAL(18,2) DEFAULT 0,
  isr_retenido         DECIMAL(18,2) DEFAULT 0 COMMENT 'Retenciones de clientes',
  isr_pagos_anteriores DECIMAL(18,2) DEFAULT 0,
  isr_a_pagar          DECIMAL(18,2) DEFAULT 0,
  -- Metadata
  tasa_isr             DECIMAL(5,2) DEFAULT 30.00 COMMENT 'PM: 30%, PF: tabla Art. 96',
  tipo_persona         CHAR(2) DEFAULT 'PM' COMMENT 'PM=Moral, PF=Física',
  regimen_fiscal       VARCHAR(10),
  estado               VARCHAR(20) DEFAULT 'borrador' COMMENT 'borrador, calculado, declarado, pagado',
  fecha_pago           DATE,
  referencia_pago      VARCHAR(100),
  observaciones        TEXT,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_isr_periodo (contribuyente_id, ejercicio, periodo),
  INDEX idx_isr_contribuyente (contribuyente_id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 8. DIOT — Declaración Informativa de Operaciones con Terceros
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diot_proveedores (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  periodo_year    YEAR NOT NULL,
  periodo_mes     TINYINT NOT NULL,
  rfc_proveedor   VARCHAR(13),
  nombre_proveedor VARCHAR(255),
  tipo_tercero    VARCHAR(2) NOT NULL COMMENT '04=Nacional, 05=Extranjero, 15=Global',
  tipo_operacion  VARCHAR(2) DEFAULT '85' COMMENT '85=Prest.Serv, 86=Adq.Bienes, 87=Arrendamiento',
  -- Importes
  valor_actos_tasa0   DECIMAL(18,2) DEFAULT 0,
  valor_actos_exentos DECIMAL(18,2) DEFAULT 0,
  valor_actos_16      DECIMAL(18,2) DEFAULT 0 COMMENT 'Tasa 16%',
  valor_actos_8       DECIMAL(18,2) DEFAULT 0 COMMENT 'Tasa 8% (frontera)',
  iva_pagado_16       DECIMAL(18,2) DEFAULT 0,
  iva_pagado_8        DECIMAL(18,2) DEFAULT 0,
  iva_no_acreditable  DECIMAL(18,2) DEFAULT 0,
  iva_importacion     DECIMAL(18,2) DEFAULT 0,
  iva_retenido        DECIMAL(18,2) DEFAULT 0,
  isr_retenido        DECIMAL(18,2) DEFAULT 0,
  -- Metadata
  num_cfdis       INT DEFAULT 0,
  es_efos         TINYINT(1) DEFAULT 0,
  estado          VARCHAR(20) DEFAULT 'pendiente',
  generado_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_diot (contribuyente_id, periodo_year, periodo_mes, rfc_proveedor),
  INDEX idx_diot_periodo (contribuyente_id, periodo_year, periodo_mes)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 9. NÓMINA — Resumen mensual retenciones
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nomina_resumen (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio       YEAR NOT NULL,
  periodo         TINYINT NOT NULL,
  num_empleados   INT DEFAULT 0,
  total_percepciones DECIMAL(18,2) DEFAULT 0,
  total_deducciones  DECIMAL(18,2) DEFAULT 0,
  isr_retenido_empleados DECIMAL(18,2) DEFAULT 0,
  imss_obrero     DECIMAL(18,2) DEFAULT 0,
  imss_patronal   DECIMAL(18,2) DEFAULT 0,
  infonavit       DECIMAL(18,2) DEFAULT 0,
  subsidio_empleo DECIMAL(18,2) DEFAULT 0,
  neto_pagar      DECIMAL(18,2) DEFAULT 0,
  num_cfdis       INT DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_nomina_periodo (contribuyente_id, ejercicio, periodo)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 10. CONFIGURACIÓN FISCAL POR CONTRIBUYENTE
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_fiscal (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL UNIQUE,
  tipo_persona    CHAR(2) DEFAULT 'PM' COMMENT 'PM, PF',
  regimen_fiscal  VARCHAR(10),
  coeficiente_utilidad DECIMAL(10,6) DEFAULT 0,
  tasa_isr        DECIMAL(5,2) DEFAULT 30.00,
  aplica_iva_frontera TINYINT(1) DEFAULT 0,
  aplica_resico   TINYINT(1) DEFAULT 0,
  obliga_contabilidad_electronica TINYINT(1) DEFAULT 1,
  periodicidad_pagos  VARCHAR(20) DEFAULT 'mensual',
  ejercicio_base_coef YEAR COMMENT 'Año del ejercicio que se usó para calcular coef',
  actualizado_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- 11. VALIDACIONES CFDI (caché de consultas SAT)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validaciones_cfdi (
  uuid            VARCHAR(36) PRIMARY KEY,
  estado_sat      VARCHAR(20) COMMENT 'Vigente, Cancelado, No Encontrado',
  es_cancelable   VARCHAR(50),
  estatus_cancelacion VARCHAR(50),
  validado_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_validaciones_estado (estado_sat)
) ENGINE=InnoDB COMMENT='Caché de validaciones en tiempo real con SAT';

-- ─────────────────────────────────────────────────────
-- 12. ALERTAS FISCALES
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alertas_fiscales (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  tipo            VARCHAR(50) NOT NULL COMMENT 'efos, ingreso_sin_cfdi, cargo_sin_factura, ppd_vencido, isr_alto',
  severidad       VARCHAR(10) DEFAULT 'media' COMMENT 'baja, media, alta, critica',
  descripcion     TEXT NOT NULL,
  monto           DECIMAL(18,2),
  referencia_id   VARCHAR(100) COMMENT 'uuid, id etc del registro relacionado',
  resuelta        TINYINT(1) DEFAULT 0,
  fecha_alerta    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_resolucion DATETIME,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_alertas_contribuyente (contribuyente_id, resuelta),
  INDEX idx_alertas_tipo (tipo, severidad)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────────────
-- Índices adicionales de performance
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_comprobantes_metodo ON comprobantes(metodo_pago);
CREATE INDEX IF NOT EXISTS idx_comprobantes_estado ON comprobantes(estado);
CREATE INDEX IF NOT EXISTS idx_solicitudes_rfc ON solicitudes_sat(rfc);
-- ============================================================
--  Módulo Validación SAT
--  Compara Metadata vs CFDIs descargados
-- ============================================================

CREATE TABLE IF NOT EXISTS validaciones_sat (
    id                        INT AUTO_INCREMENT PRIMARY KEY,
    rfc                       VARCHAR(13)  NOT NULL,
    periodo_inicio            DATE         NOT NULL,
    periodo_fin               DATE         NOT NULL,
    fecha_validacion          DATETIME     DEFAULT CURRENT_TIMESTAMP,

    -- Conteos Metadata
    total_metadata_emitidos   INT          DEFAULT 0,
    total_metadata_recibidos  INT          DEFAULT 0,

    -- Conteos CFDIs reales
    total_cfdi_emitidos       INT          DEFAULT 0,
    total_cfdi_recibidos      INT          DEFAULT 0,

    -- Resumen de problemas
    faltantes_emitidos        INT          DEFAULT 0,
    faltantes_recibidos       INT          DEFAULT 0,
    incongruencias_emitidos   INT          DEFAULT 0,
    incongruencias_recibidos  INT          DEFAULT 0,
    cancelados_emitidos       INT          DEFAULT 0,
    cancelados_recibidos      INT          DEFAULT 0,

    completitud_pct           DECIMAL(5,2) DEFAULT 0.00,
    status                    ENUM('procesando','completo','error') DEFAULT 'procesando',
    error_msg                 TEXT         NULL,

    INDEX idx_val_rfc   (rfc),
    INDEX idx_val_fecha (fecha_validacion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS validacion_incongruencias (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    validacion_id   INT          NOT NULL,
    tipo            ENUM('faltante','monto','rfc','fecha','cancelado') NOT NULL,
    direccion       ENUM('emitido','recibido') NOT NULL,

    uuid            VARCHAR(36)  NOT NULL,
    rfc_emisor      VARCHAR(13)  NULL,
    rfc_receptor    VARCHAR(13)  NULL,
    fecha_emision   VARCHAR(30)  NULL,

    monto_metadata  DECIMAL(15,2) NULL,
    monto_cfdi      DECIMAL(15,2) NULL,
    dato_metadata   TEXT          NULL,
    dato_cfdi       TEXT          NULL,

    resuelta        TINYINT(1)   DEFAULT 0,
    nota            TEXT         NULL,
    created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (validacion_id) REFERENCES validaciones_sat(id) ON DELETE CASCADE,
    INDEX idx_inc_validacion (validacion_id),
    INDEX idx_inc_uuid       (uuid),
    INDEX idx_inc_tipo       (tipo),
    INDEX idx_inc_resuelta   (resuelta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
