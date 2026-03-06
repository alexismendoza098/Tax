/**
 * Seed script: creates demo users, contribuyentes, and sample comprobantes.
 * Run: node seed.js
 */
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function seed() {
  console.log('Seeding database...');

  // 1. Create demo users
  const users = [
    { username: 'cesar', password: 'tax2025', role: 'admin' },
    { username: 'admin', password: 'admin123', role: 'admin' },
    { username: 'demo', password: 'demo123', role: 'user' }
  ];

  const userIds = {};
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    try {
      const [result] = await pool.query(
        'INSERT INTO usuarios (username, password_hash, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)',
        [u.username, hash, u.role]
      );
      const [rows] = await pool.query('SELECT id FROM usuarios WHERE username = ?', [u.username]);
      userIds[u.username] = rows[0].id;
      console.log(`  Usuario '${u.username}' -> id ${userIds[u.username]}`);
    } catch (err) {
      console.error(`  Error creando usuario ${u.username}:`, err.message);
    }
  }

  // 2. Create contribuyentes
  const contribuyentes = [
    { rfc: 'AAA010101AAA', nombre: 'EMPRESA DEMO SA DE CV', regimen: '601', user: 'cesar' },
    { rfc: 'BBB020202BBB', nombre: 'CORPORATIVO FISCAL MX', regimen: '601', user: 'cesar' },
    { rfc: 'XXX111111XXX', nombre: 'CLIENTE EJEMPLO SA', regimen: '601', user: 'demo' }
  ];

  const contribIds = {};
  for (const c of contribuyentes) {
    try {
      await pool.query(
        'INSERT INTO contribuyentes (rfc, nombre, regimen_fiscal, usuario_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)',
        [c.rfc, c.nombre, c.regimen, userIds[c.user]]
      );
      const [rows] = await pool.query('SELECT id FROM contribuyentes WHERE rfc = ? AND usuario_id = ?', [c.rfc, userIds[c.user]]);
      contribIds[c.rfc] = rows[0].id;
      console.log(`  Contribuyente '${c.rfc}' -> id ${contribIds[c.rfc]}`);
    } catch (err) {
      console.error(`  Error creando contribuyente ${c.rfc}:`, err.message);
    }
  }

  // 3. Create sample comprobantes for AAA010101AAA (cesar)
  const contribuyenteId = contribIds['AAA010101AAA'];
  const sampleComprobantes = [
    // Ingresos PUE (IVA Trasladado PUE)
    {
      uuid: 'A0000001-1111-4000-8000-000000000001',
      version: '4.0', fecha: '2025-01-10 12:00:00', tipo: 'I', forma: '03', metodo: 'PUE',
      subtotal: 50000, total: 58000, traslados: 8000,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'PROV123456789', nom_r: 'PROVEEDOR UNO SA',
      serie: 'A', folio: '1001',
      concepto: { clave: '84111506', desc: 'Servicios profesionales de consultoría', importe: 50000 }
    },
    {
      uuid: 'A0000001-1111-4000-8000-000000000002',
      version: '4.0', fecha: '2025-01-20 14:30:00', tipo: 'I', forma: '01', metodo: 'PUE',
      subtotal: 120000, total: 139200, traslados: 19200,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'PROV987654321', nom_r: 'PROVEEDOR DOS SA',
      serie: 'A', folio: '1002',
      concepto: { clave: '43232408', desc: 'Licencias de software', importe: 120000 }
    },
    // Ingresos PPD (will have pagos)
    {
      uuid: 'A0000001-1111-4000-8000-000000000003',
      version: '4.0', fecha: '2025-01-05 10:00:00', tipo: 'I', forma: '99', metodo: 'PPD',
      subtotal: 80000, total: 92800, traslados: 12800,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'PROV456789123', nom_r: 'PROVEEDOR TRES SA',
      serie: 'B', folio: '2001',
      concepto: { clave: '84111506', desc: 'Consultoría fiscal', importe: 80000 }
    },
    // Comprobante de Pago (P) for the PPD above
    {
      uuid: 'A0000001-1111-4000-8000-000000000004',
      version: '4.0', fecha: '2025-01-25 16:00:00', tipo: 'P', forma: null, metodo: null,
      subtotal: 0, total: 0, traslados: 0,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'PROV456789123', nom_r: 'PROVEEDOR TRES SA',
      serie: 'P', folio: '3001',
      concepto: null,
      pago: {
        fecha: '2025-01-25 16:00:00', forma: '03', moneda: 'MXN',
        docto: { id_doc: 'A0000001-1111-4000-8000-000000000003', serie: 'B', folio: '2001', monto: 92800 },
        traslado: { impuesto: '002', factor: 'Tasa', tasa: 0.16, base: 80000, importe: 12800 }
      }
    },
    // Comprobantes recibidos (IVA Acreditable - receptor = AAA010101AAA)
    {
      uuid: 'A0000001-1111-4000-8000-000000000005',
      version: '4.0', fecha: '2025-01-10 09:00:00', tipo: 'I', forma: '03', metodo: 'PUE',
      subtotal: 100000, total: 116000, traslados: 16000,
      rfc_e: 'PROV111222333', nom_e: 'PROVEEDOR ALPHA SA',
      rfc_r: 'AAA010101AAA', nom_r: 'EMPRESA DEMO SA DE CV',
      serie: 'C', folio: '3001',
      concepto: { clave: '84111506', desc: 'Servicios contables', importe: 100000 },
      retenciones: { iva: 1066.67, isr: 10000 }
    },
    {
      uuid: 'A0000001-1111-4000-8000-000000000006',
      version: '4.0', fecha: '2025-01-12 11:00:00', tipo: 'I', forma: '01', metodo: 'PUE',
      subtotal: 250000, total: 290000, traslados: 40000,
      rfc_e: 'PROV444555666', nom_e: 'PROVEEDOR BETA SA',
      rfc_r: 'AAA010101AAA', nom_r: 'EMPRESA DEMO SA DE CV',
      serie: 'C', folio: '3002',
      concepto: { clave: '43232408', desc: 'Equipo de cómputo', importe: 250000 }
    },
    // Egreso
    {
      uuid: 'A0000001-1111-4000-8000-000000000007',
      version: '4.0', fecha: '2025-01-15 08:00:00', tipo: 'E', forma: '03', metodo: 'PUE',
      subtotal: 5000, total: 5800, traslados: 800,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'PROV123456789', nom_r: 'PROVEEDOR UNO SA',
      serie: 'NC', folio: '101',
      concepto: { clave: '84111506', desc: 'Nota de crédito - ajuste', importe: 5000 }
    },
    // More January comprobantes for demo richness
    {
      uuid: 'A0000001-1111-4000-8000-000000000008',
      version: '4.0', fecha: '2025-01-18 13:00:00', tipo: 'I', forma: '03', metodo: 'PUE',
      subtotal: 35000, total: 40600, traslados: 5600,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'CLI001002003', nom_r: 'CLIENTE PRIMERO SA',
      serie: 'A', folio: '1003',
      concepto: { clave: '84111506', desc: 'Servicios de asesoría', importe: 35000 }
    },
    {
      uuid: 'A0000001-1111-4000-8000-000000000009',
      version: '4.0', fecha: '2025-01-22 15:00:00', tipo: 'I', forma: '04', metodo: 'PUE',
      subtotal: 75000, total: 87000, traslados: 12000,
      rfc_e: 'AAA010101AAA', nom_e: 'EMPRESA DEMO SA DE CV',
      rfc_r: 'CLI004005006', nom_r: 'CLIENTE SEGUNDO SA',
      serie: 'A', folio: '1004',
      concepto: { clave: '84111506', desc: 'Desarrollo de software', importe: 75000 }
    },
    {
      uuid: 'A0000001-1111-4000-8000-000000000010',
      version: '4.0', fecha: '2025-01-28 10:00:00', tipo: 'I', forma: '03', metodo: 'PUE',
      subtotal: 15000, total: 17400, traslados: 2400,
      rfc_e: 'PROV777888999', nom_e: 'PROVEEDOR GAMMA SA',
      rfc_r: 'AAA010101AAA', nom_r: 'EMPRESA DEMO SA DE CV',
      serie: 'D', folio: '4001',
      concepto: { clave: '84111506', desc: 'Asesoría legal', importe: 15000 },
      retenciones: { iva: 800, isr: 1500 }
    }
  ];

  for (const comp of sampleComprobantes) {
    try {
      // Check if exists
      const [existing] = await pool.query('SELECT uuid FROM comprobantes WHERE uuid = ?', [comp.uuid]);
      if (existing.length > 0) {
        console.log(`  Comprobante ${comp.uuid.slice(0, 8)}... ya existe, saltando`);
        continue;
      }

      await pool.query(
        `INSERT INTO comprobantes (uuid, version, fecha, tipo_de_comprobante, forma_pago, metodo_pago,
          subtotal, descuento, moneda, tipo_cambio, lugar_expedicion, total, total_traslados,
          total_retenciones, rfc_emisor, nombre_emisor, rfc_receptor, nombre_receptor,
          serie, folio, estado, contribuyente_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'MXN', 1, '06600', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Vigente', ?)`,
        [comp.uuid, comp.version, comp.fecha, comp.tipo, comp.forma, comp.metodo,
         comp.subtotal, comp.total, comp.traslados,
         (comp.retenciones ? (comp.retenciones.iva || 0) + (comp.retenciones.isr || 0) : 0),
         comp.rfc_e, comp.nom_e, comp.rfc_r, comp.nom_r,
         comp.serie, comp.folio, contribuyenteId]
      );

      // Insert concepto
      if (comp.concepto) {
        await pool.query(
          `INSERT INTO conceptos (uuid, concepto_index, clave_prod_serv, cantidad, clave_unidad, unidad,
            descripcion, valor_unitario, importe, objeto_imp)
           VALUES (?, 0, ?, 1, 'E48', 'Servicio', ?, ?, ?, '02')`,
          [comp.uuid, comp.concepto.clave, comp.concepto.desc, comp.concepto.importe, comp.concepto.importe]
        );

        // IVA traslado at concepto level
        if (comp.traslados > 0) {
          await pool.query(
            `INSERT INTO concepto_traslados (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
             VALUES (?, 0, '002', 'Tasa', 0.160000, ?, ?)`,
            [comp.uuid, comp.subtotal, comp.traslados]
          );
        }

        // Retenciones at concepto level
        if (comp.retenciones) {
          if (comp.retenciones.iva > 0) {
            await pool.query(
              `INSERT INTO concepto_retenciones (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
               VALUES (?, 0, '002', 'Tasa', 0.106667, ?, ?)`,
              [comp.uuid, comp.subtotal, comp.retenciones.iva]
            );
          }
          if (comp.retenciones.isr > 0) {
            await pool.query(
              `INSERT INTO concepto_retenciones (uuid, concepto_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
               VALUES (?, 0, '001', 'Tasa', 0.100000, ?, ?)`,
              [comp.uuid, comp.subtotal, comp.retenciones.isr]
            );
          }
        }
      }

      // IVA traslado at comprobante level
      if (comp.traslados > 0) {
        await pool.query(
          `INSERT INTO impuesto_traslados (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
           VALUES (?, '002', 'Tasa', 0.160000, ?, ?)`,
          [comp.uuid, comp.subtotal, comp.traslados]
        );
      }

      // Retenciones at comprobante level
      if (comp.retenciones) {
        if (comp.retenciones.iva > 0) {
          await pool.query(
            `INSERT INTO impuesto_retenciones (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
             VALUES (?, '002', 'Tasa', 0.106667, ?, ?)`,
            [comp.uuid, comp.subtotal, comp.retenciones.iva]
          );
        }
        if (comp.retenciones.isr > 0) {
          await pool.query(
            `INSERT INTO impuesto_retenciones (uuid, impuesto, tipo_factor, tasa_o_cuota, base, importe)
             VALUES (?, '001', 'Tasa', 0.100000, ?, ?)`,
            [comp.uuid, comp.subtotal, comp.retenciones.isr]
          );
        }
      }

      // Insert pago data
      if (comp.pago) {
        await pool.query(
          `INSERT INTO pagos (uuid, pago_index, fecha_pago, forma_de_pago, moneda_dr)
           VALUES (?, 0, ?, ?, ?)`,
          [comp.uuid, comp.pago.fecha, comp.pago.forma, comp.pago.moneda]
        );
        await pool.query(
          `INSERT INTO pago_doctos (uuid, pago_index, docto_index, id_documento, serie, folio, monto_dr)
           VALUES (?, 0, 0, ?, ?, ?, ?)`,
          [comp.uuid, comp.pago.docto.id_doc, comp.pago.docto.serie, comp.pago.docto.folio, comp.pago.docto.monto]
        );
        await pool.query(
          `INSERT INTO pago_traslados (uuid, pago_index, local_index, impuesto, tipo_factor, tasa_o_cuota, base, importe)
           VALUES (?, 0, 0, ?, ?, ?, ?, ?)`,
          [comp.uuid, comp.pago.traslado.impuesto, comp.pago.traslado.factor,
           comp.pago.traslado.tasa, comp.pago.traslado.base, comp.pago.traslado.importe]
        );
      }

      console.log(`  Comprobante ${comp.uuid.slice(0, 8)}... (${comp.tipo}) insertado`);
    } catch (err) {
      console.error(`  Error insertando ${comp.uuid}:`, err.message);
    }
  }

  console.log('\nSeed completado!');
  console.log('\nCredenciales de acceso:');
  console.log('  cesar / tax2025');
  console.log('  admin / admin123');
  console.log('  demo / demo123');

  await pool.end();
  process.exit(0);
}

seed().catch(err => {
  console.error('Error en seed:', err);
  process.exit(1);
});
