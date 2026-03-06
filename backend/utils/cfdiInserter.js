const pool = require('../db');

/**
 * Insert parsed CFDI data into the database.
 * Handles transaction and related tables (conceptos, impuestos, pagos, etc.).
 * 
 * @param {Object} parsed - The object returned by parseXML or compatible structure.
 * @param {number|null} contribuyenteId - The ID of the taxpayer (optional).
 * @returns {Promise<Object>} - Result { inserted: boolean, uuid: string, skipped: boolean, reason: string }
 */
async function insertCFDI(parsed, contribuyenteId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Ensure parsed structure exists even if empty
    const c = parsed.comprobante || parsed; // Handle flat object if passed directly
    const conceptos = parsed.conceptos || [];
    const conceptoTraslados = parsed.concepto_traslados || [];
    const conceptoRetenciones = parsed.concepto_retenciones || [];
    const impuestoTraslados = parsed.impuesto_traslados || [];
    const impuestoRetenciones = parsed.impuesto_retenciones || [];
    const pagos = parsed.pagos || [];
    const pagoDoctos = parsed.pago_doctos || [];
    const pagoTraslados = parsed.pago_traslados || [];
    const cfdiRelacionados = parsed.cfdi_relacionados || [];

    c.contribuyente_id = contribuyenteId || null;

    // ── Verificar si el UUID ya existe ──────────────────────────────────
    const [existing] = await conn.query(
      'SELECT uuid, metadata_paquete_id, estado FROM comprobantes WHERE uuid = ?',
      [c.uuid]
    );

    if (existing.length > 0) {
      const updates   = [];
      const updateVals = [];

      // Actualizar metadata_paquete_id si cambió
      if (c.metadata_paquete_id && existing[0].metadata_paquete_id !== c.metadata_paquete_id) {
        updates.push('metadata_paquete_id = ?');
        updateVals.push(c.metadata_paquete_id);
      }

      // ⚡ DETECTAR CANCELACIONES: Si el SAT cambió el estado (Vigente → Cancelado)
      //    Esto ocurre cuando el contribuyente cancela una factura días después de emitirla.
      //    Al re-descargar Metadata/CFDI del mismo período, el sistema detecta el cambio
      //    y actualiza la BD automáticamente sin duplicar el registro.
      const estadoViejo = (existing[0].estado || '').toLowerCase().trim();
      const estadoNuevo = (c.estado || '').toLowerCase().trim();
      const estadoCambio = estadoNuevo !== '' && estadoViejo !== estadoNuevo;

      if (estadoCambio) {
        updates.push('estado = ?');
        updateVals.push(c.estado);
      }

      if (updates.length > 0) {
        updateVals.push(c.uuid);
        await conn.query(`UPDATE comprobantes SET ${updates.join(', ')} WHERE uuid = ?`, updateVals);
        await conn.commit();
        return {
          updated:         true,
          uuid:            c.uuid,
          estado_cambio:   estadoCambio,
          estado_anterior: existing[0].estado,
          estado_nuevo:    c.estado,
          reason:          estadoCambio
            ? `Estado actualizado: ${existing[0].estado || '?'} → ${c.estado}`
            : 'metadata_paquete_id actualizado',
        };
      }

      await conn.commit();
      return { skipped: true, uuid: c.uuid, reason: 'UUID ya existe, sin cambios' };
    }

    // Insert comprobante
    await conn.query(
      `INSERT INTO comprobantes (uuid, version, fecha, tipo_de_comprobante, forma_pago, metodo_pago,
        subtotal, descuento, moneda, tipo_cambio, lugar_expedicion, total, total_traslados,
        total_retenciones, rfc_emisor, nombre_emisor, rfc_receptor, nombre_receptor,
        serie, folio, estado, contribuyente_id, metadata_paquete_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.uuid, c.version, c.fecha, c.tipo_de_comprobante, c.forma_pago, c.metodo_pago,
       c.subtotal, c.descuento, c.moneda, c.tipo_cambio, c.lugar_expedicion, c.total,
       c.total_traslados, c.total_retenciones, c.rfc_emisor, c.nombre_emisor,
       c.rfc_receptor, c.nombre_receptor, c.serie, c.folio, c.estado, c.contribuyente_id, c.metadata_paquete_id]
    );

    // Insert conceptos
    for (const concepto of conceptos) {
      await conn.query(
        `INSERT INTO conceptos (uuid, concepto_index, clave_prod_serv, no_identificacion,
          cantidad, clave_unidad, unidad, descripcion, valor_unitario, importe, objeto_imp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [concepto.uuid, concepto.concepto_index, concepto.clave_prod_serv, concepto.no_identificacion,
         concepto.cantidad, concepto.clave_unidad, concepto.unidad, concepto.descripcion,
         concepto.valor_unitario, concepto.importe, concepto.objeto_imp]
      );
    }

    // Insert concepto_traslados
    for (const ct of conceptoTraslados) {
      await conn.query(
        `INSERT INTO concepto_traslados (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ct.uuid, ct.concepto_index, ct.impuesto, ct.tipo_factor, ct.tasa_o_cuota, ct.base, ct.importe]
      );
    }

    // Insert concepto_retenciones
    for (const cr of conceptoRetenciones) {
      await conn.query(
        `INSERT INTO concepto_retenciones (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cr.uuid, cr.concepto_index, cr.impuesto, cr.tipo_factor, cr.tasa_o_cuota, cr.base, cr.importe]
      );
    }

    // Insert impuesto_traslados
    for (const it of impuestoTraslados) {
      await conn.query(
        `INSERT INTO impuesto_traslados (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [it.uuid, it.impuesto, it.tipo_factor, it.tasa_o_cuota, it.base, it.importe]
      );
    }

    // Insert impuesto_retenciones
    for (const ir of impuestoRetenciones) {
      await conn.query(
        `INSERT INTO impuesto_retenciones (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ir.uuid, ir.impuesto, ir.tipo_factor, ir.tasa_o_cuota, ir.base, ir.importe]
      );
    }

    // Insert pagos
    for (const p of pagos) {
      await conn.query(
        `INSERT INTO pagos (uuid, pago_index, fecha_pago, forma_de_pago, moneda_dr)
         VALUES (?, ?, ?, ?, ?)`,
        [p.uuid, p.pago_index, p.fecha_pago, p.forma_de_pago, p.moneda_dr]
      );
    }

    // Insert pago_doctos
    for (const pd of pagoDoctos) {
      await conn.query(
        `INSERT INTO pago_doctos (uuid, pago_index, docto_index, id_documento, serie, folio, monto_dr)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pd.uuid, pd.pago_index, pd.docto_index, pd.id_documento, pd.serie, pd.folio, pd.monto_dr]
      );
    }

    // Insert pago_traslados
    for (const pt of pagoTraslados) {
      await conn.query(
        `INSERT INTO pago_traslados (uuid, pago_index, local_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [pt.uuid, pt.pago_index, pt.local_index, pt.impuesto, pt.tipo_factor, pt.tasa_o_cuota, pt.base, pt.importe]
      );
    }

    // Insert cfdi_relacionados
    for (const cr of cfdiRelacionados) {
      await conn.query(
        `INSERT INTO cfdi_relacionados (uuid, tipo_relacion, uuid_relacionado)
         VALUES (?, ?, ?)`,
        [cr.uuid, cr.tipo_relacion, cr.uuid_relacionado]
      );
    }

    await conn.commit();
    return { inserted: true, uuid: c.uuid };

  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { insertCFDI };
