/**
 * ================================================================
 * PARSER UNIVERSAL DE ESTADOS DE CUENTA BANCARIOS — ETX Tax
 * ================================================================
 * Bancos soportados: BBVA, Santander, HSBC, Banamex, Banorte, Scotiabank
 * Formatos: CSV (auto-detect separador) y Excel (.xlsx)
 * ================================================================
 */

const { parse } = require('csv-parse/sync');
const ExcelJS   = require('exceljs');

// ─── Detectar separador CSV ───────────────────────────────────────────────────
function detectSeparator(text) {
  const sample = text.substring(0, 2000);
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  for (const ch of sample) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ─── Limpiar número mexicano "$1,234,567.89" → 1234567.89 ─────────────────────
function parseMXN(str) {
  if (!str && str !== 0) return 0;
  const s = String(str).replace(/[$\s]/g, '').replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.abs(n);
}

// ─── Parsear fecha en múltiples formatos ──────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();

  // DD/MM/YYYY o DD-MM-YYYY
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;

  // YYYY-MM-DD (ISO)
  const m2 = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

  // DD/MM/YY
  const m3 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m3) {
    const yy = parseInt(m3[3]);
    const yyyy = yy >= 50 ? `19${m3[3]}` : `20${m3[3]}`;
    return `${yyyy}-${m3[2].padStart(2,'0')}-${m3[1].padStart(2,'0')}`;
  }

  // Número de serie Excel (días desde 1/1/1900)
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899,11,30) + parseInt(s) * 86400000);
    return d.toISOString().substring(0, 10);
  }

  return null;
}

// ─── Normalizar cabecera de columna ──────────────────────────────────────────
function normalizeHeader(h) {
  return String(h || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar acentos
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// ─── Detectar banco por cabeceras ─────────────────────────────────────────────
function detectBank(headers) {
  const flat = headers.map(h => String(h).toLowerCase()).join(' ');

  if (flat.includes('depositos') || flat.includes('depósitos') ||
      flat.includes('retiros') || (flat.includes('bbva') || flat.includes('bancomer'))) return 'BBVA';

  if (flat.includes('santander')) return 'SANTANDER';
  if (flat.includes('hsbc')) return 'HSBC';
  if (flat.includes('banamex') || flat.includes('citibanamex') || flat.includes('citi')) return 'BANAMEX';
  if (flat.includes('banorte')) return 'BANORTE';
  if (flat.includes('scotiabank')) return 'SCOTIABANK';
  if (flat.includes('inbursa')) return 'INBURSA';

  // Detectar por estructura de columnas
  if (flat.includes('deposito') || flat.includes('retiro')) return 'BBVA';
  if (flat.includes('cargo') && flat.includes('abono'))     return 'GENERIC';

  return 'OTRO';
}

// ─── Mapear fila CSV → movimiento normalizado ─────────────────────────────────
function mapRow(row, headers, bank) {
  const norm = {};
  headers.forEach((h, i) => { norm[normalizeHeader(h)] = row[i]; });

  // Aliases de campo por banco
  const FIELD_MAP = {
    fecha:     ['fecha', 'fecha_de_operacion', 'fecha_operacion', 'date', 'dia'],
    concepto:  ['descripcion', 'concepto', 'descripci_n', 'movimiento', 'referencia_detalle', 'detail', 'description'],
    referencia:['referencia', 'num_de_referencia', 'numero_de_movimiento', 'folio', 'num_operacion', 'no_operacion'],
    cargo:     ['cargo', 'cargos', 'retiro', 'retiros', 'egreso', 'egresos', 'debit', 'debito'],
    abono:     ['abono', 'abonos', 'deposito', 'depositos', 'dep_sito', 'credito', 'credit', 'ingreso'],
    saldo:     ['saldo', 'saldo_disponible', 'balance', 'saldo_final'],
  };

  const get = (aliases) => {
    for (const a of aliases) {
      if (norm[a] !== undefined && norm[a] !== '') return norm[a];
    }
    return null;
  };

  const fecha     = parseDate(get(FIELD_MAP.fecha));
  const concepto  = String(get(FIELD_MAP.concepto) || '').trim();
  const referencia= String(get(FIELD_MAP.referencia) || '').trim();
  const cargo     = parseMXN(get(FIELD_MAP.cargo));
  const abono     = parseMXN(get(FIELD_MAP.abono));
  const saldo     = parseMXN(get(FIELD_MAP.saldo));

  if (!fecha) return null; // fila inválida o encabezado

  const tipo = abono > 0 ? 'ABONO' : 'CARGO';
  const monto = abono > 0 ? abono : cargo;
  if (monto === 0) return null; // ignorar filas sin importe

  return { fecha, concepto, referencia, cargo, abono, saldo, tipo };
}

// ─── PARSER CSV ───────────────────────────────────────────────────────────────
function parseCSV(buffer) {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const sep  = detectSeparator(text);

  // Buscar la primera línea que parece encabezado (contiene "fecha" o "date")
  const lines = text.split('\n');
  let headerIdx = 0;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const l = lines[i].toLowerCase();
    if (l.includes('fecha') || l.includes('date') || l.includes('dia')) {
      headerIdx = i;
      break;
    }
  }

  // Extraer metadata de las líneas antes del encabezado (cuenta, titular)
  const metaLines = lines.slice(0, headerIdx).join('\n');
  const meta = extractMeta(metaLines);

  // Parsear CSV desde el encabezado
  const csvContent = lines.slice(headerIdx).join('\n');
  let records;
  try {
    records = parse(csvContent, {
      delimiter:        sep,
      skip_empty_lines: true,
      relax_column_count: true,
      bom:              true,
    });
  } catch (e) {
    throw new Error(`Error parseando CSV: ${e.message}`);
  }

  if (records.length < 2) throw new Error('CSV sin datos de movimientos');

  const headers  = records[0];
  const bank     = detectBank(headers);
  const rows     = records.slice(1);
  const movimientos = [];

  for (const row of rows) {
    const mov = mapRow(row, headers, bank);
    if (mov) movimientos.push(mov);
  }

  return { banco: meta.banco || bank, cuenta: meta.cuenta, titular: meta.titular, movimientos };
}

// ─── PARSER EXCEL ─────────────────────────────────────────────────────────────
async function parseExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel sin hojas de cálculo');

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push(row.values.slice(1)); // exceljs index starts at 1
  });

  if (rows.length < 2) throw new Error('Excel sin datos');

  // Buscar fila de encabezado
  let headerIdx = 0;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const l = rows[i].join(' ').toLowerCase();
    if (l.includes('fecha') || l.includes('date')) { headerIdx = i; break; }
  }

  const metaRows   = rows.slice(0, headerIdx);
  const meta       = extractMeta(metaRows.map(r => r.join(',')).join('\n'));
  const headers    = rows[headerIdx].map(c => String(c || ''));
  const bank       = detectBank(headers);
  const movimientos= [];

  for (const row of rows.slice(headerIdx + 1)) {
    const arr = headers.map((_, i) => {
      const v = row[i];
      if (v instanceof Date) return v.toLocaleDateString('es-MX');
      return v !== undefined && v !== null ? String(v) : '';
    });
    const mov = mapRow(arr, headers, bank);
    if (mov) movimientos.push(mov);
  }

  return { banco: meta.banco || bank, cuenta: meta.cuenta, titular: meta.titular, movimientos };
}

// ─── Extraer metadata del texto previo al encabezado ─────────────────────────
function extractMeta(text) {
  const meta = { banco: null, cuenta: null, titular: null };
  const t = text.toUpperCase();

  // Banco
  const BANCOS = ['BBVA','SANTANDER','HSBC','BANAMEX','CITIBANAMEX','BANORTE','SCOTIABANK','INBURSA'];
  for (const b of BANCOS) {
    if (t.includes(b)) { meta.banco = b === 'CITIBANAMEX' ? 'BANAMEX' : b; break; }
  }

  // Número de cuenta (4 a 18 dígitos)
  const cuentaM = text.match(/\b(\d{4,18})\b/);
  if (cuentaM) meta.cuenta = cuentaM[1];

  // Titular (línea con nombre)
  const lines = text.split('\n');
  for (const l of lines) {
    const c = l.trim();
    if (c.length > 5 && c.length < 100 &&
        /^[A-ZÁÉÍÓÚÑa-záéíóúñ\s,\.]+$/.test(c) &&
        !BANCOS.some(b => c.toUpperCase().includes(b))) {
      meta.titular = c;
      break;
    }
  }

  return meta;
}

// ─── Estadísticas de movimientos ─────────────────────────────────────────────
function calcStats(movimientos) {
  let totalCargos = 0, totalAbonos = 0, saldoInicial = null, saldoFinal = null;
  let fechaMin = null, fechaMax = null;

  for (const m of movimientos) {
    totalCargos += m.cargo;
    totalAbonos += m.abono;
    if (m.saldo !== null && m.saldo !== undefined) {
      if (saldoInicial === null) saldoInicial = m.saldo;
      saldoFinal = m.saldo;
    }
    if (!fechaMin || m.fecha < fechaMin) fechaMin = m.fecha;
    if (!fechaMax || m.fecha > fechaMax) fechaMax = m.fecha;
  }

  return {
    total_movimientos: movimientos.length,
    total_cargos:  Math.round(totalCargos * 100) / 100,
    total_abonos:  Math.round(totalAbonos * 100) / 100,
    saldo_inicial: saldoInicial,
    saldo_final:   saldoFinal,
    periodo_inicio: fechaMin,
    periodo_fin:    fechaMax,
  };
}

// ─── EXPORT PRINCIPAL ─────────────────────────────────────────────────────────
async function parseBankStatement(buffer, mimeType, filename) {
  const isExcel = /xlsx?$/.test((filename || '').toLowerCase()) ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel';

  let result;
  if (isExcel) {
    result = await parseExcel(buffer);
  } else {
    result = parseCSV(buffer);
  }

  if (!result.movimientos || result.movimientos.length === 0) {
    throw new Error('No se encontraron movimientos en el archivo. Verifica el formato.');
  }

  // Ordenar por fecha
  result.movimientos.sort((a, b) => a.fecha.localeCompare(b.fecha));

  return {
    ...result,
    formato:  isExcel ? 'EXCEL' : 'CSV',
    stats:    calcStats(result.movimientos),
  };
}

module.exports = { parseBankStatement };
