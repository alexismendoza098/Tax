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
