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
