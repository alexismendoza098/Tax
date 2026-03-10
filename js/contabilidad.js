/**
 * ============================================================
 * CONTABILIDAD ELECTRÓNICA — ETX Tax Recovery
 * Catálogo de Cuentas, Pólizas, Balanza de Comprobación
 * ============================================================
 */

// ─── Estado ──────────────────────────────────────────────────
let contCatalogo  = [];
let contPolizas   = [];
let contBalanza   = [];
let contYearSel   = new Date().getFullYear();
let contMesSel    = new Date().getMonth() + 1;

// ─── Init ─────────────────────────────────────────────────────
async function initContabilidad() {
  contYearSel = document.getElementById('contYear')?.value || contYearSel;
  contMesSel  = document.getElementById('contMes')?.value  || contMesSel;
  await contLoadCatalogo();
  await contLoadPolizas();
  await contLoadBalanza();
}

// ─── CATÁLOGO DE CUENTAS ──────────────────────────────────────
async function contLoadCatalogo() {
  try {
    const data = await apiFetch('/contabilidad/catalogo');
    contCatalogo = data;
    contRenderCatalogo(data);
    document.getElementById('contCatCount').textContent = data.length;
  } catch (e) {
    showToast('error', 'Error', 'Error al cargar catálogo: ' + e.message);
  }
}

function contRenderCatalogo(cuentas) {
  const tbody = document.getElementById('contCatalogoBody');
  if (!tbody) return;
  const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  tbody.innerHTML = cuentas.length ? cuentas.map(c => `
    <tr class="cont-row nivel-${c.nivel}">
      <td><code>${c.numero_cuenta}</code></td>
      <td>${'&nbsp;'.repeat((c.nivel-1)*4)}${c.descripcion}</td>
      <td><span class="badge-tipo tipo-${c.tipo?.toLowerCase()}">${c.tipo}</span></td>
      <td><span class="badge-nat ${c.naturaleza === 'D' ? 'nat-d' : 'nat-a'}">${c.naturaleza === 'D' ? 'Deudora' : 'Acreedora'}</span></td>
      <td>${c.codigo_agrupador || '-'}</td>
      <td class="cont-actions">
        <button class="btn-xs btn-danger" onclick="contEliminarCuenta(${c.id})" title="Eliminar">✕</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="text-center muted">Sin cuentas. Inicializa el catálogo SAT.</td></tr>';
}

async function contInicializarCatalogo() {
  if (!confirm('Esto cargará el catálogo de cuentas SAT estándar. ¿Continuar?')) return;
  try {
    showToast('info', 'Procesando', 'Inicializando catálogo...');
    const r = await apiFetch('/contabilidad/catalogo/inicializar', 'POST', { forzar: false });
    showToast('success', 'Catálogo inicializado', `${r.cuentas_creadas} cuentas cargadas`);
    await contLoadCatalogo();
  } catch (e) {
    showToast('error', 'Error', e.message);
  }
}

async function contExportarCatalogoXML() {
  window.open(`${API_URL}/contabilidad/catalogo/xml?mes=${contMesSel}&anio=${contYearSel}`, '_blank');
}

async function contEliminarCuenta(id) {
  if (!confirm('¿Eliminar esta cuenta?')) return;
  try {
    await apiFetch(`/contabilidad/catalogo/${id}`, 'DELETE');
    showToast('success', 'Eliminado', 'Cuenta eliminada correctamente');
    await contLoadCatalogo();
  } catch (e) { showToast('error', 'Error', e.message); }
}

// ─── PÓLIZAS ──────────────────────────────────────────────────
async function contLoadPolizas() {
  try {
    const data = await apiFetch(`/contabilidad/polizas?year=${contYearSel}&mes=${contMesSel}`);
    contPolizas = data;
    contRenderPolizas(data);
    document.getElementById('contPolizasCount').textContent = data.length;
  } catch (e) {
    showToast('error', 'Error', 'Error al cargar pólizas: ' + e.message);
  }
}

function contRenderPolizas(polizas) {
  const tbody = document.getElementById('contPolizasBody');
  if (!tbody) return;
  const tipos = { I: 'Ingreso', E: 'Egreso', D: 'Diario', N: 'Nómina', T: 'Transferencia' };
  tbody.innerHTML = polizas.length ? polizas.map(p => `
    <tr>
      <td>${p.fecha?.slice(0,10) || '-'}</td>
      <td><span class="badge-tipo tipo-poliza-${p.tipo_poliza?.toLowerCase()}">${tipos[p.tipo_poliza]||p.tipo_poliza}</span> ${p.numero}</td>
      <td>${p.concepto}</td>
      <td class="text-right money">${fmtMXN(p.total_debe)}</td>
      <td class="text-right money">${fmtMXN(p.total_haber)}</td>
      <td>${p.generada_auto ? '<span class="badge-auto">AUTO</span>' : '<span class="badge-manual">Manual</span>'}</td>
      <td class="cont-actions">
        <button class="btn-xs btn-info" onclick="contVerPoliza(${p.id})">Ver</button>
        <button class="btn-xs btn-danger" onclick="contEliminarPoliza(${p.id})">✕</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="text-center muted">Sin pólizas para este periodo.</td></tr>';
}

async function contGenerarPolizasCFDI() {
  try {
    showToast('info', 'Procesando', 'Generando pólizas automáticas...');
    const r = await apiFetch('/contabilidad/polizas/generar-cfdi', 'POST',
      { year: contYearSel, mes: contMesSel });
    showToast('success', 'Pólizas generadas', `${r.polizas_generadas} pólizas (${r.emitidas} emitidas + ${r.recibidas} recibidas)`);
    await contLoadPolizas();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function contVerPoliza(id) {
  try {
    const data = await apiFetch(`/contabilidad/polizas/${id}`);
    const movHTML = data.movimientos.map(m => `
      <tr>
        <td><code>${m.numero_cuenta}</code></td>
        <td>${m.descripcion}</td>
        <td class="text-right money">${parseFloat(m.debe) > 0 ? fmtMXN(m.debe) : '-'}</td>
        <td class="text-right money">${parseFloat(m.haber) > 0 ? fmtMXN(m.haber) : '-'}</td>
      </tr>`).join('');
    const html = `
      <div class="poliza-detalle">
        <h4>Póliza ${data.tipo_poliza}-${data.numero} — ${data.fecha?.slice(0,10)}</h4>
        <p>${data.concepto}</p>
        <table class="cont-table"><thead><tr><th>Cuenta</th><th>Descripción</th><th>Debe</th><th>Haber</th></tr></thead>
        <tbody>${movHTML}</tbody>
        <tfoot><tr><th colspan="2">Total</th><th class="text-right">${fmtMXN(data.total_debe)}</th><th class="text-right">${fmtMXN(data.total_haber)}</th></tr></tfoot>
        </table>
      </div>`;
    showModal('Detalle de Póliza', html);
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function contEliminarPoliza(id) {
  if (!confirm('¿Eliminar esta póliza y sus movimientos?')) return;
  try {
    await apiFetch(`/contabilidad/polizas/${id}`, 'DELETE');
    showToast('success', 'Eliminado', 'Póliza eliminada correctamente');
    await contLoadPolizas();
  } catch (e) { showToast('error', 'Error', e.message); }
}

// ─── BALANZA DE COMPROBACIÓN ──────────────────────────────────
async function contLoadBalanza() {
  try {
    const data = await apiFetch(`/contabilidad/balanza?year=${contYearSel}&mes=${contMesSel}`);
    contBalanza = data;
    contRenderBalanza(data);
  } catch (e) {
    showToast('error', 'Error', 'Error al cargar balanza: ' + e.message);
  }
}

function contRenderBalanza(filas) {
  const tbody = document.getElementById('contBalanzaBody');
  if (!tbody) return;
  tbody.innerHTML = filas.length ? filas.map(f => `
    <tr>
      <td><code>${f.numero_cuenta}</code></td>
      <td>${f.descripcion}</td>
      <td class="text-right money">${fmtMXN(f.saldo_inicial_debe)}</td>
      <td class="text-right money">${fmtMXN(f.saldo_inicial_haber)}</td>
      <td class="text-right money text-info">${fmtMXN(f.movimientos_debe)}</td>
      <td class="text-right money text-info">${fmtMXN(f.movimientos_haber)}</td>
      <td class="text-right money text-success">${fmtMXN(f.saldo_final_debe)}</td>
      <td class="text-right money text-success">${fmtMXN(f.saldo_final_haber)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-center muted">Sin movimientos. Calcula la balanza primero.</td></tr>';
}

async function contCalcularBalanza() {
  try {
    showToast('info', 'Procesando', 'Calculando balanza de comprobación...');
    const r = await apiFetch('/contabilidad/balanza/calcular', 'POST',
      { year: contYearSel, mes: contMesSel });
    showToast('success', 'Balanza calculada', `${r.cuentas_en_balanza} cuentas`);
    await contLoadBalanza();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function contExportarBalanzaXML() {
  window.open(`${API_URL}/contabilidad/balanza/xml?year=${contYearSel}&mes=${contMesSel}`, '_blank');
}

// ─── Cambio de periodo ────────────────────────────────────────
function contCambiarPeriodo() {
  contYearSel = document.getElementById('contYear')?.value || contYearSel;
  contMesSel  = document.getElementById('contMes')?.value  || contMesSel;
  initContabilidad();
}

// ─── Helpers ──────────────────────────────────────────────────
function fmtMXN(val) {
  const n = parseFloat(val) || 0;
  if (n === 0) return '-';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n);
}

function showModal(title, bodyHTML) {
  let modal = document.getElementById('globalModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'globalModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <span id="globalModalTitle"></span>
          <button onclick="document.getElementById('globalModal').style.display='none'">✕</button>
        </div>
        <div id="globalModalBody"></div>
      </div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('globalModalTitle').textContent = title;
  document.getElementById('globalModalBody').innerHTML = bodyHTML;
  modal.style.display = 'flex';
}
