const express = require('express');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/reportes/iva-trasladado — detailed IT data
router.get('/iva-trasladado', async (req, res) => {
  try {
    const { contribuyente_id, year, mes } = req.query;
    if (!contribuyente_id) {
      return res.status(400).json({ error: 'contribuyente_id es requerido' });
    }

    // Verificar que el contribuyente pertenezca al usuario autenticado
    const [owns] = await pool.query(
      'SELECT id FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (!owns.length) return res.status(403).json({ error: 'Acceso denegado: contribuyente no pertenece a tu cuenta' });

    let where = ['c.contribuyente_id = ?', "c.tipo_de_comprobante IN ('I')"];
    let params = [contribuyente_id];

    if (year) { where.push('YEAR(c.fecha) = ?'); params.push(year); }
    if (mes) { where.push('MONTH(c.fecha) = ?'); params.push(mes); }

    const [rows] = await pool.query(`
      SELECT
        CASE WHEN c.rfc_emisor = cont.rfc THEN 'E' ELSE 'R' END as LF,
        'A' as T_A,
        c.metodo_pago as PPD_PUE,
        c.uuid as CFDI_P,
        c.serie as SERIE,
        c.folio as FOLIO,
        c.tipo_de_comprobante as TipoComp,
        c.metodo_pago as METODOPAGO,
        c.rfc_emisor as RFC_E,
        c.nombre_emisor as NOM_E,
        c.rfc_receptor as RFC_R,
        c.nombre_receptor as NOM_R,
        c.fecha as FechaDePago,
        c.fecha as FechaE,
        GROUP_CONCAT(DISTINCT con.clave_prod_serv) as CLAVE_SAT,
        GROUP_CONCAT(DISTINCT con.descripcion SEPARATOR '; ') as \`DESC\`,
        c.subtotal as Sub_Mo_CDscto,
        COALESCE(c.total_traslados, 0) as IVA_PAG,
        c.subtotal as Val_MXN,
        COALESCE(c.total_traslados, 0) as IVA_PAGO_MXN,
        YEAR(c.fecha) as Year,
        MONTH(c.fecha) as Mes
      FROM comprobantes c
      JOIN contribuyentes cont ON c.contribuyente_id = cont.id
      LEFT JOIN conceptos con ON c.uuid = con.uuid
      WHERE ${where.join(' AND ')}
      GROUP BY c.uuid
      ORDER BY c.fecha
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('Error en reporte IT:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/reportes/iva-acreditable — detailed IA data
router.get('/iva-acreditable', async (req, res) => {
  try {
    const { contribuyente_id, year, mes } = req.query;
    if (!contribuyente_id) {
      return res.status(400).json({ error: 'contribuyente_id es requerido' });
    }

    // Get the RFC for this contributor — verificando ownership al mismo tiempo
    const [contrib] = await pool.query(
      'SELECT rfc FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (contrib.length === 0) {
      return res.status(403).json({ error: 'Acceso denegado: contribuyente no pertenece a tu cuenta' });
    }
    const rfc = contrib[0].rfc;

    let where = ['c.rfc_receptor = ?', "c.tipo_de_comprobante IN ('I', 'E')"];
    let params = [rfc];

    if (year) { where.push('YEAR(c.fecha) = ?'); params.push(year); }
    if (mes) { where.push('MONTH(c.fecha) = ?'); params.push(mes); }

    const [rows] = await pool.query(`
      SELECT
        'R' as LF,
        'A' as T_A,
        c.metodo_pago as PPD_PUE,
        c.uuid as CFDI_P,
        c.serie as SERIE,
        c.folio as FOLIO,
        c.tipo_de_comprobante as TipoComp,
        c.metodo_pago as METODOPAGO,
        c.rfc_emisor as RFC_E,
        c.nombre_emisor as NOM_E,
        c.rfc_receptor as RFC_R,
        c.nombre_receptor as NOM_R,
        c.fecha as FechaDePago,
        c.fecha as FechaE,
        GROUP_CONCAT(DISTINCT con.clave_prod_serv) as CLAVE_SAT,
        GROUP_CONCAT(DISTINCT con.descripcion SEPARATOR '; ') as \`DESC\`,
        c.subtotal as Sub_Mo_CDscto,
        -- FIX: Las notas de crédito (tipo E) reducen el IVA acreditable (signo negativo)
        CASE
          WHEN c.tipo_de_comprobante = 'E' THEN -1 * COALESCE(c.total_traslados, 0)
          ELSE COALESCE(c.total_traslados, 0)
        END as IVA_PAG,
        CASE
          WHEN c.tipo_de_comprobante = 'E' THEN -1 * c.subtotal
          ELSE c.subtotal
        END as Val_MXN,
        CASE
          WHEN c.tipo_de_comprobante = 'E' THEN -1 * COALESCE(c.total_traslados, 0)
          ELSE COALESCE(c.total_traslados, 0)
        END as IVA_PAGO_MXN,
        COALESCE((SELECT SUM(ir.importe) FROM impuesto_retenciones ir WHERE ir.uuid = c.uuid AND ir.impuesto = '002'), 0) as IVA_RET,
        COALESCE((SELECT SUM(ir.importe) FROM impuesto_retenciones ir WHERE ir.uuid = c.uuid AND ir.impuesto = '001'), 0) as ISR_RET,
        YEAR(c.fecha) as Year,
        MONTH(c.fecha) as Mes
      FROM comprobantes c
      LEFT JOIN conceptos con ON c.uuid = con.uuid
      WHERE ${where.join(' AND ')}
        -- Solo incluir PPD si tiene complemento de pago (IVA efectivamente acreditable)
        -- Las facturas PUE siempre se incluyen; las PPD solo con su complemento
        AND (
          c.metodo_pago != 'PPD'
          OR EXISTS (SELECT 1 FROM pago_doctos pd WHERE pd.id_documento = c.uuid)
        )
      GROUP BY c.uuid
      ORDER BY c.fecha
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('Error en reporte IA:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/reportes/export-excel/:tipo — generate and download Excel
router.get('/export-excel/:tipo', async (req, res) => {
  try {
    const { tipo } = req.params;
    const { contribuyente_id, year, mes } = req.query;

    if (!contribuyente_id) {
      return res.status(400).json({ error: 'contribuyente_id es requerido' });
    }

    // Get contributor info — verificando ownership al mismo tiempo
    const [contrib] = await pool.query(
      'SELECT * FROM contribuyentes WHERE id = ? AND usuario_id = ?',
      [contribuyente_id, req.user.id]
    );
    if (!contrib.length) return res.status(403).json({ error: 'Acceso denegado: contribuyente no pertenece a tu cuenta' });
    const rfc = contrib[0].rfc;

    let data;
    let sheetName;
    let filename;

    if (tipo === 'trasladado' || tipo === 'IT') {
      // Fetch IT data
      let where = ['c.contribuyente_id = ?', "c.tipo_de_comprobante IN ('I')"];
      let params = [contribuyente_id];
      if (year) { where.push('YEAR(c.fecha) = ?'); params.push(year); }
      if (mes) { where.push('MONTH(c.fecha) = ?'); params.push(mes); }

      const [rows] = await pool.query(`
        SELECT c.uuid, c.serie, c.folio, c.tipo_de_comprobante, c.metodo_pago,
          c.rfc_emisor, c.nombre_emisor, c.rfc_receptor, c.nombre_receptor,
          c.fecha, c.subtotal, c.total, c.total_traslados,
          YEAR(c.fecha) as anio, MONTH(c.fecha) as mes_num
        FROM comprobantes c
        WHERE ${where.join(' AND ')}
        ORDER BY c.fecha
      `, params);

      data = rows;
      sheetName = 'IVA Trasladado';
      filename = `IT_${rfc}_${year || 'all'}_${mes || 'all'}.xlsx`;
    } else if (tipo === 'acreditable' || tipo === 'IA') {
      const rfcContrib = contrib.length > 0 ? contrib[0].rfc : '';
      let where = ['c.rfc_receptor = ?', "c.tipo_de_comprobante IN ('I', 'E')"];
      let params = [rfcContrib];
      if (year) { where.push('YEAR(c.fecha) = ?'); params.push(year); }
      if (mes) { where.push('MONTH(c.fecha) = ?'); params.push(mes); }

      const [rows] = await pool.query(`
        SELECT c.uuid, c.serie, c.folio, c.tipo_de_comprobante, c.metodo_pago,
          c.rfc_emisor, c.nombre_emisor, c.rfc_receptor, c.nombre_receptor,
          c.fecha, c.subtotal, c.total, c.total_traslados, c.total_retenciones,
          YEAR(c.fecha) as anio, MONTH(c.fecha) as mes_num
        FROM comprobantes c
        WHERE ${where.join(' AND ')}
        ORDER BY c.fecha
      `, params);

      data = rows;
      sheetName = 'IVA Acreditable';
      filename = `IA_${rfc}_${year || 'all'}_${mes || 'all'}.xlsx`;
    } else if (tipo === 'resumen') {
      const [rows] = await pool.query(`
        SELECT r.*, c.rfc, c.nombre
        FROM reportes_iva r
        JOIN contribuyentes c ON r.contribuyente_id = c.id
        WHERE r.contribuyente_id = ?
        ORDER BY r.periodo_year, r.periodo_mes
      `, [contribuyente_id]);

      data = rows;
      sheetName = 'Resumen IVA';
      filename = `Resumen_IVA_${rfc}.xlsx`;
    } else {
      return res.status(400).json({ error: 'Tipo de reporte no válido. Use: trasladado, acreditable, resumen' });
    }

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'IVA Tax Recovery System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(sheetName);

    if (data.length > 0) {
      // Add headers
      const columns = Object.keys(data[0]).map(key => ({
        header: key.toUpperCase(),
        key,
        width: Math.max(key.length + 5, 15)
      }));
      sheet.columns = columns;

      // Style header row
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2332' } };

      // Add data rows
      data.forEach(row => sheet.addRow(row));

      // Format number columns
      sheet.eachRow((row, rowNum) => {
        if (rowNum > 1) {
          row.eachCell((cell) => {
            if (typeof cell.value === 'number') {
              cell.numFmt = '#,##0.00';
            }
          });
        }
      });
    }

    // Send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generando Excel:', err);
    res.status(500).json({ error: 'Error generando reporte' });
  }
});

module.exports = router;
