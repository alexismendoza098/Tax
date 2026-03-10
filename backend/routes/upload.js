const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parse: parseCsv } = require('csv-parse/sync');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { parseXML } = require('../utils/xmlParser');

const router = express.Router();
router.use(authMiddleware);

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xml', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos XML y CSV'));
    }
  }
});

// Helper: insert parsed CFDI data into DB
async function insertCFDI(parsed, contribuyenteId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const c = parsed.comprobante;
    c.contribuyente_id = contribuyenteId || null;

    // Check if UUID already exists
    const [existing] = await conn.query('SELECT uuid FROM comprobantes WHERE uuid = ?', [c.uuid]);
    if (existing.length > 0) {
      await conn.rollback();
      return { skipped: true, uuid: c.uuid, reason: 'UUID ya existe' };
    }

    // Insert comprobante
    await conn.query(
      `INSERT INTO comprobantes (uuid, version, fecha, tipo_de_comprobante, forma_pago, metodo_pago,
        subtotal, descuento, moneda, tipo_cambio, lugar_expedicion, total, total_traslados,
        total_retenciones, rfc_emisor, nombre_emisor, rfc_receptor, nombre_receptor,
        serie, folio, estado, contribuyente_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.uuid, c.version, c.fecha, c.tipo_de_comprobante, c.forma_pago, c.metodo_pago,
       c.subtotal, c.descuento, c.moneda, c.tipo_cambio, c.lugar_expedicion, c.total,
       c.total_traslados, c.total_retenciones, c.rfc_emisor, c.nombre_emisor,
       c.rfc_receptor, c.nombre_receptor, c.serie, c.folio, c.estado, c.contribuyente_id]
    );

    // Insert conceptos
    for (const concepto of parsed.conceptos) {
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
    for (const ct of parsed.concepto_traslados) {
      await conn.query(
        `INSERT INTO concepto_traslados (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ct.uuid, ct.concepto_index, ct.impuesto, ct.tipo_factor, ct.tasa_o_cuota, ct.base, ct.importe]
      );
    }

    // Insert concepto_retenciones
    for (const cr of parsed.concepto_retenciones) {
      await conn.query(
        `INSERT INTO concepto_retenciones (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cr.uuid, cr.concepto_index, cr.impuesto, cr.tipo_factor, cr.tasa_o_cuota, cr.base, cr.importe]
      );
    }

    // Insert impuesto_traslados
    for (const it of parsed.impuesto_traslados) {
      await conn.query(
        `INSERT INTO impuesto_traslados (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [it.uuid, it.impuesto, it.tipo_factor, it.tasa_o_cuota, it.base, it.importe]
      );
    }

    // Insert impuesto_retenciones
    for (const ir of parsed.impuesto_retenciones) {
      await conn.query(
        `INSERT INTO impuesto_retenciones (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ir.uuid, ir.impuesto, ir.tipo_factor, ir.tasa_o_cuota, ir.base, ir.importe]
      );
    }

    // Insert pagos
    for (const p of parsed.pagos) {
      await conn.query(
        `INSERT INTO pagos (uuid, pago_index, fecha_pago, forma_de_pago, moneda_dr)
         VALUES (?, ?, ?, ?, ?)`,
        [p.uuid, p.pago_index, p.fecha_pago, p.forma_de_pago, p.moneda_dr]
      );
    }

    // Insert pago_doctos
    for (const pd of parsed.pago_doctos) {
      await conn.query(
        `INSERT INTO pago_doctos (uuid, pago_index, docto_index, id_documento, serie, folio, monto_dr)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pd.uuid, pd.pago_index, pd.docto_index, pd.id_documento, pd.serie, pd.folio, pd.monto_dr]
      );
    }

    // Insert pago_traslados
    for (const pt of parsed.pago_traslados) {
      await conn.query(
        `INSERT INTO pago_traslados (uuid, pago_index, local_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [pt.uuid, pt.pago_index, pt.local_index, pt.impuesto, pt.tipo_factor, pt.tasa_o_cuota, pt.base, pt.importe]
      );
    }

    // Insert cfdi_relacionados
    for (const cr of parsed.cfdi_relacionados) {
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

// Helper: valida que contribuyenteId pertenezca al usuario autenticado
async function assertContribOwnership(contribuyenteId, userId) {
  if (!contribuyenteId) return; // Sin contribuyente asignado, se permite (admin puede subir sin asignar)
  const [rows] = await pool.query(
    'SELECT id FROM contribuyentes WHERE id = ? AND usuario_id = ?',
    [contribuyenteId, userId]
  );
  if (!rows.length) {
    const err = new Error('El contribuyente indicado no pertenece a tu cuenta');
    err.statusCode = 403;
    throw err;
  }
}

// POST /api/upload/xml — upload and parse XML files
router.post('/xml', upload.array('files', 100), async (req, res) => {
  try {
    const contribuyenteId = req.body.contribuyente_id || null;
    const results = [];

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se enviaron archivos' });
    }

    // Validar ownership del contribuyente antes de insertar
    try {
      await assertContribOwnership(contribuyenteId, req.user.id);
    } catch (ownerErr) {
      // Limpiar archivos subidos
      for (const f of req.files) {
        try { fs.unlinkSync(f.path); } catch (_) { /* cleanup */ }
      }
      return res.status(ownerErr.statusCode || 403).json({ error: ownerErr.message });
    }

    for (const file of req.files) {
      try {
        const xmlContent = fs.readFileSync(file.path, 'utf-8');
        const parsed = await parseXML(xmlContent);
        const result = await insertCFDI(parsed, contribuyenteId);
        results.push({ file: file.originalname, ...result });
      } catch (err) {
        results.push({ file: file.originalname, error: err.message });
      } finally {
        // Clean up uploaded file
        try { fs.unlinkSync(file.path); } catch (_) { /* cleanup-upload */ }
      }
    }

    const inserted = results.filter(r => r.inserted).length;
    const skipped = results.filter(r => r.skipped).length;
    const errors = results.filter(r => r.error).length;

    res.json({
      message: `Procesados: ${results.length} archivos. Insertados: ${inserted}, Duplicados: ${skipped}, Errores: ${errors}`,
      results
    });
  } catch (err) {
    console.error('Error en upload XML:', err);
    res.status(500).json({ error: 'Error procesando archivos' });
  }
});

// POST /api/upload/csv — upload CSV metadata
router.post('/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se envió archivo' });
    }

    const contribuyenteId = req.body.contribuyente_id || null;

    // Validar ownership del contribuyente antes de procesar
    try {
      await assertContribOwnership(contribuyenteId, req.user.id);
    } catch (ownerErr) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* cleanup */ }
      return res.status(ownerErr.statusCode || 403).json({ error: ownerErr.message });
    }

    const csvContent = fs.readFileSync(req.file.path, 'utf-8');

    let rows;
    try {
      rows = parseCsv(csvContent, {
        columns: true,          // primera fila como headers
        skip_empty_lines: true,
        trim: true,
        bom: true               // elimina BOM si existe
      });
    } catch (parseErr) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* cleanup-upload */ }
      return res.status(400).json({ error: `CSV inválido: ${parseErr.message}` });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'El archivo CSV está vacío o no tiene datos' });
    }

    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        // Map CSV columns to comprobante fields
        const uuid = row.UUID || row.uuid;
        if (!uuid) {
          results.push({ line: i + 1, error: 'UUID faltante' });
          continue;
        }

        // Check if exists
        const [existing] = await pool.query('SELECT uuid FROM comprobantes WHERE uuid = ?', [uuid]);
        if (existing.length > 0) {
          results.push({ line: i + 1, uuid, skipped: true, reason: 'UUID ya existe' });
          continue;
        }

        const subtotal = parseFloat(row.SubTotal || row.subtotal || row.Sub_Mo_CDscto || 0);
        const total = parseFloat(row.Total || row.total || 0);
        const totalTraslados = parseFloat(row.TotalTraslados || row.IVA_PAG || 0);

        await pool.query(
          `INSERT INTO comprobantes (uuid, version, fecha, tipo_de_comprobante, forma_pago, metodo_pago,
            subtotal, descuento, moneda, tipo_cambio, lugar_expedicion, total, total_traslados,
            total_retenciones, rfc_emisor, nombre_emisor, rfc_receptor, nombre_receptor,
            serie, folio, estado, contribuyente_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuid,
            row.Version || '4.0',
            row.FechaEmision || row.Fecha || row.FechaE || null,
            row.TipoComprobante || row.TipoDeComprobante || row.tipo_de_comprobante || 'I',
            row.FormaPago || row.forma_pago || null,
            row.MetodoPago || row.metodo_pago || null,
            subtotal,
            parseFloat(row.Descuento || row.descuento || 0),
            row.Moneda || row.moneda || 'MXN',
            parseFloat(row.TipoCambio || row.tipo_cambio || 1),
            row.LugarExpedicion || row.lugar_expedicion || null,
            total,
            totalTraslados,
            parseFloat(row.TotalRetenciones || row.total_retenciones || 0),
            row.RfcEmisor || row.rfc_emisor || row.RFC_E || null,
            row.NombreEmisor || row.nombre_emisor || row.NOM_E || null,
            row.RfcReceptor || row.rfc_receptor || row.RFC_R || null,
            row.NombreReceptor || row.nombre_receptor || row.NOM_R || null,
            row.Serie || row.serie || null,
            row.Folio || row.folio || null,
            row.Estado || row.estado || 'Vigente',
            contribuyenteId
          ]
        );

        // If CSV has IVA data, insert into impuesto_traslados
        if (totalTraslados > 0) {
          await pool.query(
            `INSERT INTO impuesto_traslados (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
             VALUES (?, '002', 'Tasa', 0.160000, ?, ?)`,
            [uuid, subtotal, totalTraslados]
          );
        }

        results.push({ line: i + 1, uuid, inserted: true });
      } catch (err) {
        results.push({ line: i + 1, error: err.message });
      }
    }

    // Clean up
    try { fs.unlinkSync(req.file.path); } catch (_) { /* cleanup-upload */ }

    const inserted = results.filter(r => r.inserted).length;
    const skipped = results.filter(r => r.skipped).length;
    const errors = results.filter(r => r.error).length;

    res.json({
      message: `Procesados: ${results.length} registros. Insertados: ${inserted}, Duplicados: ${skipped}, Errores: ${errors}`,
      results
    });
  } catch (err) {
    console.error('Error en upload CSV:', err);
    res.status(500).json({ error: 'Error procesando CSV' });
  }
});

module.exports = router;
