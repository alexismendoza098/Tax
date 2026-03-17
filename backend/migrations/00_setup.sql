-- =====================================================
-- ETaxes+ — Schema base
-- Tablas principales del sistema
-- Railway/Cloud: NO incluye CREATE DATABASE ni USE
-- El pool de conexión ya apunta a la DB correcta via env vars
-- =====================================================

-- Desactivar FK checks para permitir creación de tablas en cualquier orden
SET foreign_key_checks = 0;

-- 1. Usuarios
CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  rfc VARCHAR(13) NULL,
  nombre VARCHAR(200) NULL,
  email VARCHAR(200) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Contribuyentes
CREATE TABLE IF NOT EXISTS contribuyentes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rfc VARCHAR(13) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  regimen_fiscal VARCHAR(10),
  usuario_id INT NOT NULL,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  UNIQUE KEY uq_rfc_usuario (rfc, usuario_id)
) ENGINE=InnoDB;

-- 3. Comprobantes
CREATE TABLE IF NOT EXISTS comprobantes (
  uuid VARCHAR(36) PRIMARY KEY,
  version VARCHAR(5),
  fecha DATETIME,
  tipo_de_comprobante CHAR(1),
  forma_pago VARCHAR(5),
  metodo_pago VARCHAR(5),
  subtotal DECIMAL(18,2) DEFAULT 0,
  descuento DECIMAL(18,2) DEFAULT 0,
  moneda VARCHAR(5) DEFAULT 'MXN',
  tipo_cambio DECIMAL(10,4) DEFAULT 1,
  lugar_expedicion VARCHAR(10),
  total DECIMAL(18,2) DEFAULT 0,
  total_traslados DECIMAL(18,2) DEFAULT 0,
  total_retenciones DECIMAL(18,2) DEFAULT 0,
  rfc_emisor VARCHAR(13),
  nombre_emisor VARCHAR(255),
  rfc_receptor VARCHAR(13),
  nombre_receptor VARCHAR(255),
  serie VARCHAR(25),
  folio VARCHAR(40),
  estado VARCHAR(20) DEFAULT 'Vigente',
  contribuyente_id INT,
  metadata_paquete_id VARCHAR(50) NULL,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 4. Conceptos
CREATE TABLE IF NOT EXISTS conceptos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  concepto_index INT DEFAULT 0,
  clave_prod_serv VARCHAR(20),
  no_identificacion VARCHAR(100),
  cantidad DECIMAL(18,6) DEFAULT 1,
  clave_unidad VARCHAR(10),
  unidad VARCHAR(50),
  descripcion TEXT,
  valor_unitario DECIMAL(18,6) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  objeto_imp VARCHAR(5),
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Concepto traslados
CREATE TABLE IF NOT EXISTS concepto_traslados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  concepto_index INT DEFAULT 0,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. Concepto retenciones
CREATE TABLE IF NOT EXISTS concepto_retenciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  concepto_index INT DEFAULT 0,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 7. Impuesto traslados (nivel comprobante)
CREATE TABLE IF NOT EXISTS impuesto_traslados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 8. Impuesto retenciones (nivel comprobante)
CREATE TABLE IF NOT EXISTS impuesto_retenciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 9. Pagos
CREATE TABLE IF NOT EXISTS pagos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  pago_index INT DEFAULT 0,
  fecha_pago DATETIME,
  forma_de_pago VARCHAR(5),
  moneda_dr VARCHAR(5) DEFAULT 'MXN',
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 10. Pago documentos relacionados
CREATE TABLE IF NOT EXISTS pago_doctos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  pago_index INT DEFAULT 0,
  docto_index INT DEFAULT 0,
  id_documento VARCHAR(36),
  serie VARCHAR(25),
  folio VARCHAR(40),
  monto_dr DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 11. Pago traslados
CREATE TABLE IF NOT EXISTS pago_traslados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  pago_index INT DEFAULT 0,
  local_index INT DEFAULT 0,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 12. CFDI relacionados
CREATE TABLE IF NOT EXISTS cfdi_relacionados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  tipo_relacion VARCHAR(5),
  uuid_relacionado VARCHAR(36),
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 13. Reportes IVA
CREATE TABLE IF NOT EXISTS reportes_iva (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  periodo_year INT NOT NULL,
  periodo_mes INT NOT NULL,
  iva_trasladado_pue DECIMAL(18,2) DEFAULT 0,
  iva_trasladado_ppd DECIMAL(18,2) DEFAULT 0,
  iva_acreditable_pue DECIMAL(18,2) DEFAULT 0,
  iva_acreditable_ppd DECIMAL(18,2) DEFAULT 0,
  retencion_iva DECIMAL(18,2) DEFAULT 0,
  retencion_isr DECIMAL(18,2) DEFAULT 0,
  saldo_iva DECIMAL(18,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_reporte_periodo (contribuyente_id, periodo_year, periodo_mes)
) ENGINE=InnoDB;

-- 14. Solicitudes SAT
CREATE TABLE IF NOT EXISTS solicitudes_sat (
  id_solicitud VARCHAR(100) PRIMARY KEY,
  rfc VARCHAR(13) NOT NULL,
  fecha_inicio DATE,
  fecha_fin DATE,
  tipo_solicitud VARCHAR(50),
  tipo_comprobante VARCHAR(50),
  estado_solicitud VARCHAR(50),
  codigo_estado_solicitud VARCHAR(50),
  mensaje TEXT,
  paquetes JSON,
  usuario_id INT NULL,
  group_id VARCHAR(36) NULL,
  fecha_solicitud TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_descarga DATETIME DEFAULT NULL
) ENGINE=InnoDB;

-- Índices de rendimiento (ER_DUP_KEYNAME se ignora si ya existen)
CREATE INDEX idx_comprobantes_contribuyente ON comprobantes(contribuyente_id);
CREATE INDEX idx_comprobantes_fecha ON comprobantes(fecha);
CREATE INDEX idx_comprobantes_tipo ON comprobantes(tipo_de_comprobante);
CREATE INDEX idx_comprobantes_rfc_emisor ON comprobantes(rfc_emisor);
CREATE INDEX idx_comprobantes_rfc_receptor ON comprobantes(rfc_receptor);
CREATE INDEX idx_conceptos_uuid ON conceptos(uuid);
CREATE INDEX idx_pagos_uuid ON pagos(uuid);
CREATE INDEX idx_pagos_fecha ON pagos(fecha_pago);

-- Reactivar FK checks
SET foreign_key_checks = 1;
