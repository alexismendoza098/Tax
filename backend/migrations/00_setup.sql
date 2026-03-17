-- =====================================================
-- ETaxes+ — Schema COMPLETO
-- Todas las tablas del sistema (29 tablas)
-- Railway/Cloud: NO incluye CREATE DATABASE ni USE
-- El pool de conexión ya apunta a la DB correcta via env vars
-- =====================================================

SET foreign_key_checks = 0;

-- ─────────────────────────────────────────────────────
-- 1. Usuarios
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  rfc VARCHAR(13) NULL,
  nombre VARCHAR(200) NULL,
  email VARCHAR(200) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 2. Contribuyentes
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contribuyentes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rfc VARCHAR(13) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  regimen_fiscal VARCHAR(10),
  usuario_id INT NOT NULL,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  UNIQUE KEY uq_rfc_usuario (rfc, usuario_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 3. Comprobantes
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 4. Conceptos
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 5. Concepto traslados
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 6. Concepto retenciones
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 7. Impuesto traslados (nivel comprobante)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS impuesto_traslados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 8. Impuesto retenciones (nivel comprobante)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS impuesto_retenciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  impuesto VARCHAR(5),
  tipo_factor VARCHAR(10),
  tasa_o_cuota DECIMAL(10,6),
  base DECIMAL(18,2) DEFAULT 0,
  importe DECIMAL(18,2) DEFAULT 0,
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 9. Pagos
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  pago_index INT DEFAULT 0,
  fecha_pago DATETIME,
  forma_de_pago VARCHAR(5),
  moneda_dr VARCHAR(5) DEFAULT 'MXN',
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 10. Pago documentos relacionados
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 11. Pago traslados
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 12. CFDI relacionados
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cfdi_relacionados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(36) NOT NULL,
  tipo_relacion VARCHAR(5),
  uuid_relacionado VARCHAR(36),
  FOREIGN KEY (uuid) REFERENCES comprobantes(uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 13. Reportes IVA
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 14. Solicitudes SAT
-- ─────────────────────────────────────────────────────
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 15. Papelera (Art. 30 CFF — retención 5 años)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS papelera (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tipo_registro VARCHAR(50) NOT NULL,
  registro_id VARCHAR(100) NOT NULL,
  datos_json LONGTEXT NOT NULL,
  contribuyente_id INT,
  rfc VARCHAR(13),
  eliminado_por INT,
  motivo VARCHAR(255),
  fecha_eliminacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_papelera_tipo (tipo_registro),
  INDEX idx_papelera_contribuyente (contribuyente_id),
  INDEX idx_papelera_fecha (fecha_eliminacion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 16. Catálogo de Cuentas (Contabilidad Electrónica SAT)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalogo_cuentas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  numero_cuenta VARCHAR(30) NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  naturaleza CHAR(1) NOT NULL COMMENT 'D=Deudora, A=Acreedora',
  tipo VARCHAR(20) NOT NULL,
  sub_tipo VARCHAR(50),
  nivel TINYINT DEFAULT 1,
  cuenta_padre_id INT,
  codigo_agrupador VARCHAR(20),
  activa TINYINT(1) DEFAULT 1,
  es_cuenta_sat TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_cuenta_contribuyente (contribuyente_id, numero_cuenta),
  INDEX idx_catalogo_contribuyente (contribuyente_id),
  INDEX idx_catalogo_nivel (nivel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 17. Pólizas Contables
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS polizas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  tipo_poliza VARCHAR(20) NOT NULL,
  numero INT NOT NULL,
  ejercicio YEAR NOT NULL,
  periodo TINYINT NOT NULL,
  concepto VARCHAR(500),
  uuid_cfdi VARCHAR(36),
  num_operacion VARCHAR(100),
  generada_auto TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_polizas_periodo (contribuyente_id, ejercicio, periodo),
  INDEX idx_polizas_tipo (tipo_poliza)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 18. Movimientos de Pólizas
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poliza_movimientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  poliza_id INT NOT NULL,
  cuenta_id INT NOT NULL,
  numero_cuenta VARCHAR(30),
  descripcion VARCHAR(500),
  debe DECIMAL(18,2) DEFAULT 0,
  haber DECIMAL(18,2) DEFAULT 0,
  uuid_cfdi VARCHAR(36),
  FOREIGN KEY (poliza_id) REFERENCES polizas(id) ON DELETE CASCADE,
  INDEX idx_mov_poliza (poliza_id),
  INDEX idx_mov_cuenta (cuenta_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 19. Balanza de Verificación
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS balanza_verificacion (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio YEAR NOT NULL,
  periodo TINYINT NOT NULL,
  cuenta_id INT NOT NULL,
  numero_cuenta VARCHAR(30),
  descripcion VARCHAR(255),
  saldo_inicial_debe DECIMAL(18,2) DEFAULT 0,
  saldo_inicial_haber DECIMAL(18,2) DEFAULT 0,
  debe_periodo DECIMAL(18,2) DEFAULT 0,
  haber_periodo DECIMAL(18,2) DEFAULT 0,
  saldo_final_debe DECIMAL(18,2) DEFAULT 0,
  saldo_final_haber DECIMAL(18,2) DEFAULT 0,
  generada_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_balanza (contribuyente_id, ejercicio, periodo, cuenta_id),
  INDEX idx_balanza_periodo (contribuyente_id, ejercicio, periodo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 20. Activos Fijos
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activos_fijos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  descripcion VARCHAR(500) NOT NULL,
  tipo VARCHAR(50) NOT NULL,
  fecha_adquisicion DATE NOT NULL,
  costo_adquisicion DECIMAL(18,2) NOT NULL,
  uuid_cfdi VARCHAR(36),
  vida_util_anios TINYINT NOT NULL DEFAULT 10,
  tasa_depreciacion DECIMAL(5,4) NOT NULL,
  metodo VARCHAR(20) DEFAULT 'lineal',
  depreciacion_acumulada DECIMAL(18,2) DEFAULT 0,
  cuenta_id INT,
  activo TINYINT(1) DEFAULT 1,
  fecha_baja DATE,
  motivo_baja VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_activos_contribuyente (contribuyente_id),
  INDEX idx_activos_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 21. Depreciaciones
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS depreciaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  activo_id INT NOT NULL,
  ejercicio YEAR NOT NULL,
  periodo TINYINT NOT NULL,
  depreciacion_periodo DECIMAL(18,2) NOT NULL,
  depreciacion_acumulada_al_periodo DECIMAL(18,2) NOT NULL,
  saldo_por_depreciar DECIMAL(18,2) NOT NULL,
  poliza_id INT,
  FOREIGN KEY (activo_id) REFERENCES activos_fijos(id) ON DELETE CASCADE,
  UNIQUE KEY uq_depreciacion (activo_id, ejercicio, periodo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 22. ISR Pagos Provisionales
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS isr_pagos_provisionales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio YEAR NOT NULL,
  periodo TINYINT NOT NULL,
  ingresos_periodo DECIMAL(18,2) DEFAULT 0,
  ingresos_acumulados DECIMAL(18,2) DEFAULT 0,
  deducciones_periodo DECIMAL(18,2) DEFAULT 0,
  deducciones_acumuladas DECIMAL(18,2) DEFAULT 0,
  depreciacion_periodo DECIMAL(18,2) DEFAULT 0,
  depreciacion_acumulada DECIMAL(18,2) DEFAULT 0,
  ptu_pagada DECIMAL(18,2) DEFAULT 0,
  utilidad_fiscal DECIMAL(18,2) DEFAULT 0,
  coeficiente_utilidad DECIMAL(10,6) DEFAULT 0,
  base_isr DECIMAL(18,2) DEFAULT 0,
  isr_causado DECIMAL(18,2) DEFAULT 0,
  isr_retenido DECIMAL(18,2) DEFAULT 0,
  isr_pagos_anteriores DECIMAL(18,2) DEFAULT 0,
  isr_a_pagar DECIMAL(18,2) DEFAULT 0,
  tasa_isr DECIMAL(5,2) DEFAULT 30.00,
  tipo_persona CHAR(2) DEFAULT 'PM',
  regimen_fiscal VARCHAR(10),
  estado VARCHAR(20) DEFAULT 'borrador',
  fecha_pago DATE,
  referencia_pago VARCHAR(100),
  observaciones TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_isr_periodo (contribuyente_id, ejercicio, periodo),
  INDEX idx_isr_contribuyente (contribuyente_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 23. DIOT Proveedores
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diot_proveedores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  periodo_year YEAR NOT NULL,
  periodo_mes TINYINT NOT NULL,
  rfc_proveedor VARCHAR(13),
  nombre_proveedor VARCHAR(255),
  tipo_tercero VARCHAR(2) NOT NULL,
  tipo_operacion VARCHAR(2) DEFAULT '85',
  valor_actos_tasa0 DECIMAL(18,2) DEFAULT 0,
  valor_actos_exentos DECIMAL(18,2) DEFAULT 0,
  valor_actos_16 DECIMAL(18,2) DEFAULT 0,
  valor_actos_8 DECIMAL(18,2) DEFAULT 0,
  iva_pagado_16 DECIMAL(18,2) DEFAULT 0,
  iva_pagado_8 DECIMAL(18,2) DEFAULT 0,
  iva_no_acreditable DECIMAL(18,2) DEFAULT 0,
  iva_importacion DECIMAL(18,2) DEFAULT 0,
  iva_retenido DECIMAL(18,2) DEFAULT 0,
  isr_retenido DECIMAL(18,2) DEFAULT 0,
  num_cfdis INT DEFAULT 0,
  es_efos TINYINT(1) DEFAULT 0,
  estado VARCHAR(20) DEFAULT 'pendiente',
  generado_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_diot (contribuyente_id, periodo_year, periodo_mes, rfc_proveedor),
  INDEX idx_diot_periodo (contribuyente_id, periodo_year, periodo_mes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 24. Estados de Cuenta Bancarios
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estados_cuenta (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  banco VARCHAR(50) NOT NULL,
  cuenta VARCHAR(50),
  titular VARCHAR(255),
  periodo_inicio DATE,
  periodo_fin DATE,
  total_movimientos INT DEFAULT 0,
  total_cargos DECIMAL(18,2) DEFAULT 0,
  total_abonos DECIMAL(18,2) DEFAULT 0,
  saldo_inicial DECIMAL(18,2) DEFAULT 0,
  saldo_final DECIMAL(18,2) DEFAULT 0,
  archivo_nombre VARCHAR(255),
  formato VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_contrib_periodo (contribuyente_id, periodo_inicio, periodo_fin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 25. Movimientos Bancarios
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS movimientos_bancarios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  estado_cuenta_id INT NOT NULL,
  fecha DATE NOT NULL,
  concepto TEXT,
  referencia VARCHAR(150),
  cargo DECIMAL(18,2) DEFAULT 0,
  abono DECIMAL(18,2) DEFAULT 0,
  saldo DECIMAL(18,2),
  tipo VARCHAR(10) NOT NULL,
  conciliado TINYINT(1) DEFAULT 0,
  cfdi_uuid VARCHAR(36),
  confianza TINYINT(3),
  nota_conciliacion VARCHAR(255),
  FOREIGN KEY (estado_cuenta_id) REFERENCES estados_cuenta(id) ON DELETE CASCADE,
  INDEX idx_fecha (fecha),
  INDEX idx_conciliado (conciliado),
  INDEX idx_tipo (tipo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 26. Validaciones CFDI (caché SAT)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validaciones_cfdi (
  uuid VARCHAR(36) PRIMARY KEY,
  estado_sat VARCHAR(20),
  es_cancelable VARCHAR(50),
  estatus_cancelacion VARCHAR(50),
  validado_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_validaciones_estado (estado_sat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 27. Alertas Fiscales
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alertas_fiscales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  tipo VARCHAR(50) NOT NULL,
  severidad VARCHAR(10) DEFAULT 'media',
  descripcion TEXT NOT NULL,
  monto DECIMAL(18,2),
  referencia_id VARCHAR(100),
  resuelta TINYINT(1) DEFAULT 0,
  fecha_alerta TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_resolucion DATETIME,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  INDEX idx_alertas_contribuyente (contribuyente_id, resuelta),
  INDEX idx_alertas_tipo (tipo, severidad)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 28. Config Fiscal por Contribuyente
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_fiscal (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL UNIQUE,
  tipo_persona CHAR(2) DEFAULT 'PM',
  regimen_fiscal VARCHAR(10),
  coeficiente_utilidad DECIMAL(10,6) DEFAULT 0,
  tasa_isr DECIMAL(5,2) DEFAULT 30.00,
  aplica_iva_frontera TINYINT(1) DEFAULT 0,
  aplica_resico TINYINT(1) DEFAULT 0,
  obliga_contabilidad_electronica TINYINT(1) DEFAULT 1,
  periodicidad_pagos VARCHAR(20) DEFAULT 'mensual',
  ejercicio_base_coef YEAR,
  actualizado_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 29. Validaciones SAT
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validaciones_sat (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rfc VARCHAR(13) NOT NULL,
  periodo_inicio DATE NOT NULL,
  periodo_fin DATE NOT NULL,
  fecha_validacion DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_metadata_emitidos INT DEFAULT 0,
  total_metadata_recibidos INT DEFAULT 0,
  total_cfdi_emitidos INT DEFAULT 0,
  total_cfdi_recibidos INT DEFAULT 0,
  faltantes_emitidos INT DEFAULT 0,
  faltantes_recibidos INT DEFAULT 0,
  incongruencias_emitidos INT DEFAULT 0,
  incongruencias_recibidos INT DEFAULT 0,
  cancelados_emitidos INT DEFAULT 0,
  cancelados_recibidos INT DEFAULT 0,
  completitud_pct DECIMAL(5,2) DEFAULT 0.00,
  status VARCHAR(20) DEFAULT 'procesando',
  error_msg TEXT NULL,
  INDEX idx_val_rfc (rfc),
  INDEX idx_val_fecha (fecha_validacion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 30. Validación Incongruencias
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validacion_incongruencias (
  id INT AUTO_INCREMENT PRIMARY KEY,
  validacion_id INT NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  direccion VARCHAR(10) NOT NULL,
  uuid VARCHAR(36) NOT NULL,
  rfc_emisor VARCHAR(13) NULL,
  rfc_receptor VARCHAR(13) NULL,
  fecha_emision VARCHAR(30) NULL,
  monto_metadata DECIMAL(15,2) NULL,
  monto_cfdi DECIMAL(15,2) NULL,
  dato_metadata TEXT NULL,
  dato_cfdi TEXT NULL,
  resuelta TINYINT(1) DEFAULT 0,
  nota TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (validacion_id) REFERENCES validaciones_sat(id) ON DELETE CASCADE,
  INDEX idx_inc_validacion (validacion_id),
  INDEX idx_inc_uuid (uuid),
  INDEX idx_inc_tipo (tipo),
  INDEX idx_inc_resuelta (resuelta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- 31. Nómina Resumen
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nomina_resumen (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contribuyente_id INT NOT NULL,
  ejercicio YEAR NOT NULL,
  periodo TINYINT NOT NULL,
  num_empleados INT DEFAULT 0,
  total_percepciones DECIMAL(18,2) DEFAULT 0,
  total_deducciones DECIMAL(18,2) DEFAULT 0,
  isr_retenido_empleados DECIMAL(18,2) DEFAULT 0,
  imss_obrero DECIMAL(18,2) DEFAULT 0,
  imss_patronal DECIMAL(18,2) DEFAULT 0,
  infonavit DECIMAL(18,2) DEFAULT 0,
  subsidio_empleo DECIMAL(18,2) DEFAULT 0,
  neto_pagar DECIMAL(18,2) DEFAULT 0,
  num_cfdis INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contribuyente_id) REFERENCES contribuyentes(id) ON DELETE CASCADE,
  UNIQUE KEY uq_nomina_periodo (contribuyente_id, ejercicio, periodo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────
-- Índices de rendimiento
-- ─────────────────────────────────────────────────────
CREATE INDEX idx_comprobantes_contribuyente ON comprobantes(contribuyente_id);
CREATE INDEX idx_comprobantes_fecha ON comprobantes(fecha);
CREATE INDEX idx_comprobantes_tipo ON comprobantes(tipo_de_comprobante);
CREATE INDEX idx_comprobantes_rfc_emisor ON comprobantes(rfc_emisor);
CREATE INDEX idx_comprobantes_rfc_receptor ON comprobantes(rfc_receptor);
CREATE INDEX idx_conceptos_uuid ON conceptos(uuid);
CREATE INDEX idx_pagos_uuid ON pagos(uuid);
CREATE INDEX idx_pagos_fecha ON pagos(fecha_pago);

SET foreign_key_checks = 1;
