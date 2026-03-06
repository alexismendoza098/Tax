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
