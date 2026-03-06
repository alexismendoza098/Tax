const xml2js = require('xml2js');

// Helper: get attribute value from parsed XML node, handling namespaced attrs
function attr(node, name) {
  if (!node || !node.$) return null;
  // Try direct match first
  if (node.$[name] !== undefined) return node.$[name];
  // Try case-insensitive match
  const key = Object.keys(node.$).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? node.$[key] : null;
}

// Helper: find child elements regardless of namespace prefix
function findChild(node, localName) {
  if (!node) return null;
  for (const key of Object.keys(node)) {
    const parts = key.split(':');
    const local = parts.length > 1 ? parts[1] : parts[0];
    if (local === localName) {
      const val = node[key];
      return Array.isArray(val) ? val[0] : val;
    }
  }
  return null;
}

function findChildren(node, localName) {
  if (!node) return [];
  for (const key of Object.keys(node)) {
    const parts = key.split(':');
    const local = parts.length > 1 ? parts[1] : parts[0];
    if (local === localName) {
      return Array.isArray(node[key]) ? node[key] : [node[key]];
    }
  }
  return [];
}

async function parseXML(xmlString) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    ignoreAttrs: false,
    tagNameProcessors: [],
    attrNameProcessors: []
  });

  const result = await parser.parseStringPromise(xmlString);

  // Find the root Comprobante node
  let comprobante = null;
  for (const key of Object.keys(result)) {
    if (key.includes('Comprobante')) {
      comprobante = result[key];
      break;
    }
  }

  if (!comprobante) {
    throw new Error('No se encontró el nodo Comprobante en el XML');
  }

  // Extract UUID from TimbreFiscalDigital
  let uuid = null;
  const complemento = findChild(comprobante, 'Complemento');
  if (complemento) {
    const timbre = findChild(complemento, 'TimbreFiscalDigital');
    if (timbre) {
      uuid = attr(timbre, 'UUID');
    }
  }

  if (!uuid) {
    // CFDI sin TimbreFiscalDigital no es un documento timbrado válido.
    // Se retorna null para que el llamador lo descarte en lugar de
    // insertar un registro con UUID sintético que contaminaría los datos fiscales.
    return null;
  }

  // Extract Emisor
  const emisor = findChild(comprobante, 'Emisor');
  // Extract Receptor
  const receptor = findChild(comprobante, 'Receptor');

  // Extract extra Timbre fields
  let timbreData = {};
  if (complemento) {
      const timbre = findChild(complemento, 'TimbreFiscalDigital');
      if (timbre) {
          timbreData = {
              fecha_timbrado: attr(timbre, 'FechaTimbrado'),
              rfc_prov_certif: attr(timbre, 'RfcProvCertif'),
              sello_cfd: attr(timbre, 'SelloCFD'),
              no_certificado_sat: attr(timbre, 'NoCertificadoSAT'),
              sello_sat: attr(timbre, 'SelloSAT')
          };
      }
  }

  // Main comprobante data
  const comprobanteData = {
    uuid,
    version: attr(comprobante, 'Version') || attr(comprobante, 'version') || '4.0',
    fecha: attr(comprobante, 'Fecha') || attr(comprobante, 'fecha'),
    tipo_de_comprobante: attr(comprobante, 'TipoDeComprobante') || attr(comprobante, 'tipoDeComprobante') || 'I',
    forma_pago: attr(comprobante, 'FormaPago') || attr(comprobante, 'formaPago'),
    metodo_pago: attr(comprobante, 'MetodoPago') || attr(comprobante, 'metodoPago'),
    subtotal: parseFloat(attr(comprobante, 'SubTotal') || attr(comprobante, 'subTotal') || 0),
    descuento: parseFloat(attr(comprobante, 'Descuento') || attr(comprobante, 'descuento') || 0),
    moneda: attr(comprobante, 'Moneda') || attr(comprobante, 'moneda') || 'MXN',
    tipo_cambio: parseFloat(attr(comprobante, 'TipoCambio') || attr(comprobante, 'tipoCambio') || 1),
    lugar_expedicion: attr(comprobante, 'LugarExpedicion') || attr(comprobante, 'lugarExpedicion'),
    total: parseFloat(attr(comprobante, 'Total') || attr(comprobante, 'total') || 0),
    serie: attr(comprobante, 'Serie') || attr(comprobante, 'serie'),
    folio: attr(comprobante, 'Folio') || attr(comprobante, 'folio'),
    rfc_emisor: emisor ? (attr(emisor, 'Rfc') || attr(emisor, 'rfc')) : null,
    nombre_emisor: emisor ? (attr(emisor, 'Nombre') || attr(emisor, 'nombre')) : null,
    regimen_fiscal_emisor: emisor ? (attr(emisor, 'RegimenFiscal') || attr(emisor, 'regimenFiscal')) : null,
    rfc_receptor: receptor ? (attr(receptor, 'Rfc') || attr(receptor, 'rfc')) : null,
    nombre_receptor: receptor ? (attr(receptor, 'Nombre') || attr(receptor, 'nombre')) : null,
    uso_cfdi_receptor: receptor ? (attr(receptor, 'UsoCFDI') || attr(receptor, 'usoCFDI')) : null,
    regimen_fiscal_receptor: receptor ? (attr(receptor, 'RegimenFiscalReceptor') || attr(receptor, 'regimenFiscalReceptor')) : null,
    domicilio_fiscal_receptor: receptor ? (attr(receptor, 'DomicilioFiscalReceptor') || attr(receptor, 'domicilioFiscalReceptor')) : null,
    ...timbreData,
    total_traslados: 0,
    total_retenciones: 0,
    estado: 'Vigente'
  };

  // Parse Conceptos
  const conceptosData = [];
  const conceptoTrasladosData = [];
  const conceptoRetencionesData = [];

  const conceptosNode = findChild(comprobante, 'Conceptos');
  if (conceptosNode) {
    const conceptoList = findChildren(conceptosNode, 'Concepto');
    conceptoList.forEach((concepto, idx) => {
      conceptosData.push({
        uuid,
        concepto_index: idx,
        clave_prod_serv: attr(concepto, 'ClaveProdServ') || attr(concepto, 'claveProdServ'),
        no_identificacion: attr(concepto, 'NoIdentificacion') || attr(concepto, 'noIdentificacion'),
        cantidad: parseFloat(attr(concepto, 'Cantidad') || attr(concepto, 'cantidad') || 1),
        clave_unidad: attr(concepto, 'ClaveUnidad') || attr(concepto, 'claveUnidad'),
        unidad: attr(concepto, 'Unidad') || attr(concepto, 'unidad'),
        descripcion: attr(concepto, 'Descripcion') || attr(concepto, 'descripcion'),
        valor_unitario: parseFloat(attr(concepto, 'ValorUnitario') || attr(concepto, 'valorUnitario') || 0),
        importe: parseFloat(attr(concepto, 'Importe') || attr(concepto, 'importe') || 0),
        objeto_imp: attr(concepto, 'ObjetoImp') || attr(concepto, 'objetoImp')
      });

      // Concept-level taxes
      const impuestos = findChild(concepto, 'Impuestos');
      if (impuestos) {
        const traslados = findChild(impuestos, 'Traslados');
        if (traslados) {
          findChildren(traslados, 'Traslado').forEach(t => {
            conceptoTrasladosData.push({
              uuid,
              concepto_index: idx,
              impuesto: attr(t, 'Impuesto') || attr(t, 'impuesto'),
              tipo_factor: attr(t, 'TipoFactor') || attr(t, 'tipoFactor'),
              tasa_o_cuota: parseFloat(attr(t, 'TasaOCuota') || attr(t, 'tasaOCuota') || 0),
              base: parseFloat(attr(t, 'Base') || attr(t, 'base') || 0),
              importe: parseFloat(attr(t, 'Importe') || attr(t, 'importe') || 0)
            });
          });
        }
        const retenciones = findChild(impuestos, 'Retenciones');
        if (retenciones) {
          findChildren(retenciones, 'Retencion').forEach(r => {
            conceptoRetencionesData.push({
              uuid,
              concepto_index: idx,
              impuesto: attr(r, 'Impuesto') || attr(r, 'impuesto'),
              tipo_factor: attr(r, 'TipoFactor') || attr(r, 'tipoFactor'),
              tasa_o_cuota: parseFloat(attr(r, 'TasaOCuota') || attr(r, 'tasaOCuota') || 0),
              base: parseFloat(attr(r, 'Base') || attr(r, 'base') || 0),
              importe: parseFloat(attr(r, 'Importe') || attr(r, 'importe') || 0)
            });
          });
        }
      }
    });
  }

  // Parse comprobante-level Impuestos
  const impuestoTrasladosData = [];
  const impuestoRetencionesData = [];

  const impuestosNode = findChild(comprobante, 'Impuestos');
  if (impuestosNode) {
    comprobanteData.total_traslados = parseFloat(attr(impuestosNode, 'TotalImpuestosTrasladados') || 0);
    comprobanteData.total_retenciones = parseFloat(attr(impuestosNode, 'TotalImpuestosRetenidos') || 0);

    const traslados = findChild(impuestosNode, 'Traslados');
    if (traslados) {
      findChildren(traslados, 'Traslado').forEach(t => {
        impuestoTrasladosData.push({
          uuid,
          impuesto: attr(t, 'Impuesto') || attr(t, 'impuesto'),
          tipo_factor: attr(t, 'TipoFactor') || attr(t, 'tipoFactor'),
          tasa_o_cuota: parseFloat(attr(t, 'TasaOCuota') || attr(t, 'tasaOCuota') || 0),
          base: parseFloat(attr(t, 'Base') || attr(t, 'base') || 0),
          importe: parseFloat(attr(t, 'Importe') || attr(t, 'importe') || 0)
        });
      });
    }

    const retenciones = findChild(impuestosNode, 'Retenciones');
    if (retenciones) {
      findChildren(retenciones, 'Retencion').forEach(r => {
        impuestoRetencionesData.push({
          uuid,
          impuesto: attr(r, 'Impuesto') || attr(r, 'impuesto'),
          tipo_factor: attr(r, 'TipoFactor') || attr(r, 'tipoFactor'),
          tasa_o_cuota: parseFloat(attr(r, 'TasaOCuota') || attr(r, 'tasaOCuota') || 0),
          base: parseFloat(attr(r, 'Base') || attr(r, 'base') || 0),
          importe: parseFloat(attr(r, 'Importe') || attr(r, 'importe') || 0)
        });
      });
    }
  }

  // Parse Pagos complement
  const pagosData = [];
  const pagosDoctosData = [];
  const pagosTrasladosData = [];

  if (complemento) {
    const pagosNode = findChild(complemento, 'Pagos');
    if (pagosNode) {
      const pagoList = findChildren(pagosNode, 'Pago');
      pagoList.forEach((pago, pIdx) => {
        pagosData.push({
          uuid,
          pago_index: pIdx,
          fecha_pago: attr(pago, 'FechaPago') || attr(pago, 'fechaPago'),
          forma_de_pago: attr(pago, 'FormaDePagoP') || attr(pago, 'formaDePagoP'),
          moneda_dr: attr(pago, 'MonedaP') || attr(pago, 'monedaP') || 'MXN'
        });

        // DoctoRelacionado
        const doctos = findChildren(pago, 'DoctoRelacionado');
        doctos.forEach((doc, dIdx) => {
          pagosDoctosData.push({
            uuid,
            pago_index: pIdx,
            docto_index: dIdx,
            id_documento: attr(doc, 'IdDocumento') || attr(doc, 'idDocumento'),
            serie: attr(doc, 'Serie') || attr(doc, 'serie'),
            folio: attr(doc, 'Folio') || attr(doc, 'folio'),
            monto_dr: parseFloat(attr(doc, 'ImpPagado') || attr(doc, 'MontoD R') || attr(doc, 'impPagado') || 0)
          });

          // Pago-level traslados within DoctoRelacionado
          const impuestosDR = findChild(doc, 'ImpuestosDR');
          if (impuestosDR) {
            const trasladosDR = findChild(impuestosDR, 'TrasladosDR');
            if (trasladosDR) {
              findChildren(trasladosDR, 'TrasladoDR').forEach((t, tIdx) => {
                pagosTrasladosData.push({
                  uuid,
                  pago_index: pIdx,
                  local_index: pagosTrasladosData.filter(pt => pt.pago_index === pIdx).length, // Auto-increment local index
                  impuesto: attr(t, 'ImpuestoDR') || attr(t, 'impuestoDR'),
                  tipo_factor: attr(t, 'TipoFactorDR') || attr(t, 'tipoFactorDR'),
                  tasa_o_cuota: parseFloat(attr(t, 'TasaOCuotaDR') || attr(t, 'tasaOCuotaDR') || 0),
                  base: parseFloat(attr(t, 'BaseDR') || attr(t, 'baseDR') || 0),
                  importe: parseFloat(attr(t, 'ImporteDR') || attr(t, 'importeDR') || 0)
                });
              });
            }
          }
        });

        // Pago-level traslados (ImpuestosP - Pagos 2.0)
        const impuestosP = findChild(pago, 'ImpuestosP');
        if (impuestosP) {
            const trasladosP = findChild(impuestosP, 'TrasladosP');
            if (trasladosP) {
                findChildren(trasladosP, 'TrasladoP').forEach((t, tIdx) => {
                    pagosTrasladosData.push({
                        uuid,
                        pago_index: pIdx,
                        local_index: pagosTrasladosData.filter(pt => pt.pago_index === pIdx).length,
                        impuesto: attr(t, 'ImpuestoP') || attr(t, 'impuestoP'),
                        tipo_factor: attr(t, 'TipoFactorP') || attr(t, 'tipoFactorP'),
                        tasa_o_cuota: parseFloat(attr(t, 'TasaOCuotaP') || attr(t, 'tasaOCuotaP') || 0),
                        base: parseFloat(attr(t, 'BaseP') || attr(t, 'baseP') || 0),
                        importe: parseFloat(attr(t, 'ImporteP') || attr(t, 'importeP') || 0)
                    });
                });
            }
        }

      });
    }
  }

  // Parse CfdiRelacionados
  const cfdiRelacionadosData = [];
  const relacionados = findChild(comprobante, 'CfdiRelacionados');
  if (relacionados) {
    const tipoRelacion = attr(relacionados, 'TipoRelacion') || attr(relacionados, 'tipoRelacion');
    findChildren(relacionados, 'CfdiRelacionado').forEach(rel => {
      cfdiRelacionadosData.push({
        uuid,
        tipo_relacion: tipoRelacion,
        uuid_relacionado: attr(rel, 'UUID') || attr(rel, 'uuid')
      });
    });
  }

  return {
    comprobante: comprobanteData,
    conceptos: conceptosData,
    concepto_traslados: conceptoTrasladosData,
    concepto_retenciones: conceptoRetencionesData,
    impuesto_traslados: impuestoTrasladosData,
    impuesto_retenciones: impuestoRetencionesData,
    pagos: pagosData,
    pago_doctos: pagosDoctosData,
    pago_traslados: pagosTrasladosData,
    cfdi_relacionados: cfdiRelacionadosData
  };
}

function flattenXML(parsedData) {
  const rows = [];
  const header = parsedData.comprobante;

  // Helper to find taxes for a concept
  const findTaxes = (cIdx, type) => {
    const source = type === 'traslado' ? parsedData.concepto_traslados : parsedData.concepto_retenciones;
    return source.filter(t => t.concepto_index === cIdx);
  };

  // Check if it's a Payment complement
  if (header.tipo_de_comprobante === 'P' && parsedData.pagos && parsedData.pagos.length > 0) {
    parsedData.pagos.forEach(p => {
      const docs = parsedData.pago_doctos.filter(d => d.pago_index === p.pago_index);
      if (docs.length > 0) {
        docs.forEach(d => {
          rows.push({
            ...header,
            'pago_fecha': p.fecha_pago,
            'pago_forma': p.forma_de_pago,
            'pago_moneda': p.moneda_dr,
            'docto_id': d.id_documento,
            'docto_serie': d.serie,
            'docto_folio': d.folio,
            'docto_importe': d.monto_dr
          });
        });
      } else {
        rows.push({
          ...header,
          'pago_fecha': p.fecha_pago,
          'pago_forma': p.forma_de_pago,
          'pago_moneda': p.moneda_dr
        });
      }
    });
    return rows;
  }

  // Standard Invoice (Ingreso/Egreso)
  if (parsedData.conceptos && parsedData.conceptos.length > 0) {
    parsedData.conceptos.forEach(c => {
      const traslados = findTaxes(c.concepto_index, 'traslado');
      const retenciones = findTaxes(c.concepto_index, 'retencion');

      let iva16 = 0, iva8 = 0, iva0 = 0, exento = 0;
      let retIva = 0, retIsr = 0;

      traslados.forEach(t => {
        const imp = t.impuesto;
        const tasa = parseFloat(t.tasa_o_cuota);
        const importe = parseFloat(t.importe);
        if (imp === '002') { // IVA
          if (tasa > 0.15) iva16 += importe;
          else if (tasa > 0.07) iva8 += importe;
          else if (tasa === 0) iva0 += importe;
        }
      });

      retenciones.forEach(r => {
        const imp = r.impuesto;
        const importe = parseFloat(r.importe);
        if (imp === '002') retIva += importe;
        else if (imp === '001') retIsr += importe;
      });

      rows.push({
        ...header,
        'concepto_clave_prod_serv': c.clave_prod_serv,
        'concepto_no_identificacion': c.no_identificacion,
        'concepto_cantidad': c.cantidad,
        'concepto_clave_unidad': c.clave_unidad,
        'concepto_unidad': c.unidad,
        'concepto_descripcion': c.descripcion,
        'concepto_valor_unitario': c.valor_unitario,
        'concepto_importe': c.importe,
        'concepto_descuento': c.descuento || 0,
        'concepto_objeto_imp': c.objeto_imp,
        'concepto_iva_16': iva16,
        'concepto_iva_8': iva8,
        'concepto_iva_0': iva0,
        'concepto_ret_iva': retIva,
        'concepto_ret_isr': retIsr
      });
    });
  } else {
    // No concepts, just header
    rows.push(header);
  }

  return rows;
}

module.exports = { parseXML, flattenXML };
