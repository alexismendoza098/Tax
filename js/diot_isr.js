/**
 * ============================================================
 * DIOT + ISR — ETX Tax Recovery
 * Módulo de declaraciones fiscales mensuales
 * ============================================================
 */

// ─── DIOT ─────────────────────────────────────────────────────
let diotYearSel = new Date().getFullYear();
let diotMesSel  = new Date().getMonth() + 1;

async function initDIOT() {
  diotYearSel = document.getElementById('diotYear')?.value || diotYearSel;
  diotMesSel  = document.getElementById('diotMes')?.value  || diotMesSel;
  await diotLoadListado();
  await diotLoadDetalle();
}

async function diotLoadListado() {
  try {
    const data = await apiFetch('/diot');
    const tbody = document.getElementById('diotListadoBody');
    if (!tbody) return;
    tbody.innerHTML = data.length ? data.map(d => `
      <tr>
        <td>${d.periodo_year}-${String(d.periodo_mes).padStart(2,'0')}</td>
        <td>${d.proveedores}</td>
        <td>${d.total_cfdis}</td>
        <td class="text-right money">${fmtMXN(d.valor_total)}</td>
        <td class="text-right money">${fmtMXN(d.iva_total)}</td>
        <td><span class="badge-estado estado-${d.estado}">${d.estado}</span></td>
        <td>
          <button class="btn-xs btn-info" onclick="diotDescargarTXT(${d.periodo_year},${d.periodo_mes})">TXT SAT</button>
          <button class="btn-xs btn-success" onclick="diotDescargarExcel(${d.periodo_year},${d.periodo_mes})">Excel</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="7" class="text-center muted">Sin periodos calculados.</td></tr>';
  } catch (e) { showToast('error', 'Error', 'Error DIOT: ' + e.message); }
}

async function diotLoadDetalle() {
  try {
    const data = await apiFetch(`/diot/${diotYearSel}/${diotMesSel}`);
    const tbody = document.getElementById('diotDetalleBody');
    if (!tbody) return;
    tbody.innerHTML = data.length ? data.map(d => `
      <tr ${d.es_efos ? 'class="row-efos"' : ''}>
        <td><code>${d.rfc_proveedor || 'XAXX010101000'}</code></td>
        <td>${d.nombre_proveedor || '-'}</td>
        <td>${d.tipo_tercero === '04' ? 'Nacional' : d.tipo_tercero === '05' ? 'Extranjero' : 'Global'}</td>
        <td class="text-right money">${fmtMXN(d.valor_actos_16)}</td>
        <td class="text-right money">${fmtMXN(d.iva_pagado_16)}</td>
        <td class="text-right money">${fmtMXN(d.iva_retenido)}</td>
        <td>${d.num_cfdis}</td>
        ${d.es_efos ? '<td><span class="badge-danger">EFOS</span></td>' : '<td>-</td>'}
      </tr>`).join('') : '<tr><td colspan="8" class="text-center muted">Sin datos. Genera el DIOT primero.</td></tr>';
  } catch (e) { /* sin datos */ }
}

async function diotGenerar() {
  try {
    showToast('info', 'Procesando', 'Calculando DIOT...');
    const r = await apiFetch('/diot/generar', 'POST',
      { year: diotYearSel, mes: diotMesSel });
    showToast('success', 'DIOT generado', `${r.proveedores} proveedores, ${r.cfdis_procesados} CFDIs`);
    await diotLoadListado();
    await diotLoadDetalle();
  } catch (e) { showToast('error', 'Error', e.message); }
}

function diotDescargarTXT(year, mes) {
  window.open(`${API_URL}/diot/${year}/${mes}/archivo`, '_blank');
}

function diotDescargarExcel(year, mes) {
  window.open(`${API_URL}/diot/${year}/${mes}/excel`, '_blank');
}

function diotCambiarPeriodo() {
  diotYearSel = document.getElementById('diotYear')?.value || diotYearSel;
  diotMesSel  = document.getElementById('diotMes')?.value  || diotMesSel;
  initDIOT();
}

// ─── ISR ─────────────────────────────────────────────────────
let isrYearSel = new Date().getFullYear();
let isrMesSel  = new Date().getMonth() + 1;
let isrConfig  = null;

async function initISR() {
  isrYearSel = document.getElementById('isrYear')?.value || isrYearSel;
  isrMesSel  = document.getElementById('isrMes')?.value  || isrMesSel;
  await isrLoadConfig();
  await isrLoadListado();
  await isrLoadDetalle();
  await isrLoadAnual();
}

async function isrLoadConfig() {
  try {
    isrConfig = await apiFetch('/isr/config');
    const tp = document.getElementById('isrTipoPersona');
    if (tp) tp.value = isrConfig.tipo_persona || 'PM';
    const tasa = document.getElementById('isrTasa');
    if (tasa) tasa.value = isrConfig.tasa_isr || 30;
    const coef = document.getElementById('isrCoeficiente');
    if (coef) coef.value = isrConfig.coeficiente_utilidad || 0;
  } catch (e) { /* no config aún */ }
}

async function isrGuardarConfig() {
  try {
    await apiFetch('/isr/config', 'POST', {
      tipo_persona: document.getElementById('isrTipoPersona')?.value || 'PM',
      tasa_isr: parseFloat(document.getElementById('isrTasa')?.value || 30),
      coeficiente_utilidad: parseFloat(document.getElementById('isrCoeficiente')?.value || 0),
    });
    showToast('success', 'Guardado', 'Configuración ISR guardada');
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function isrLoadListado() {
  try {
    const data = await apiFetch('/isr');
    const tbody = document.getElementById('isrListadoBody');
    if (!tbody) return;
    tbody.innerHTML = data.length ? data.map(d => `
      <tr>
        <td>${d.ejercicio}-${String(d.periodo).padStart(2,'0')}</td>
        <td class="text-right money">${fmtMXN(d.ingresos_periodo)}</td>
        <td class="text-right money">${fmtMXN(d.ingresos_acumulados)}</td>
        <td class="text-right money">${fmtMXN(d.utilidad_fiscal)}</td>
        <td class="text-right money text-warning">${fmtMXN(d.isr_causado)}</td>
        <td class="text-right money text-danger">${fmtMXN(d.isr_a_pagar)}</td>
        <td><span class="badge-estado estado-${d.estado}">${d.estado}</span></td>
        <td>
          <button class="btn-xs btn-success" onclick="isrMarcarPagado(${d.ejercicio},${d.periodo})">
            ${d.estado === 'pagado' ? '✓ Pagado' : 'Marcar pagado'}
          </button>
        </td>
      </tr>`).join('') : '<tr><td colspan="8" class="text-center muted">Sin cálculos. Genera el ISR del periodo.</td></tr>';
  } catch (e) { showToast('error', 'Error', 'Error ISR: ' + e.message); }
}

async function isrLoadDetalle() {
  try {
    const data = await apiFetch(`/isr/${isrYearSel}/${isrMesSel}`);
    renderISRDetalle(data);
  } catch (e) {
    // No calculado aún
    renderISRDetalle(null);
  }
}

function renderISRDetalle(d) {
  const panel = document.getElementById('isrDetallePanel');
  if (!panel) return;
  if (!d) {
    panel.innerHTML = '<p class="muted text-center">Sin cálculo para este periodo. Usa "Calcular ISR".</p>';
    return;
  }
  panel.innerHTML = `
    <div class="isr-grid">
      <div class="isr-card"><label>Ingresos periodo</label><span class="money">${fmtMXN(d.ingresos_periodo)}</span></div>
      <div class="isr-card"><label>Ingresos acumulados</label><span class="money">${fmtMXN(d.ingresos_acumulados)}</span></div>
      <div class="isr-card"><label>Deducciones acumuladas</label><span class="money text-success">${fmtMXN(d.deducciones_acumuladas)}</span></div>
      <div class="isr-card"><label>Depreciaciones</label><span class="money text-success">${fmtMXN(d.depreciacion_acumulada)}</span></div>
      <div class="isr-card highlight"><label>Utilidad fiscal</label><span class="money">${fmtMXN(d.utilidad_fiscal)}</span></div>
      <div class="isr-card"><label>Base ISR</label><span class="money">${fmtMXN(d.base_isr)}</span></div>
      <div class="isr-card"><label>ISR causado (${d.tasa_isr}%)</label><span class="money text-warning">${fmtMXN(d.isr_causado)}</span></div>
      <div class="isr-card"><label>ISR retenido clientes</label><span class="money text-success">${fmtMXN(d.isr_retenido)}</span></div>
      <div class="isr-card"><label>Pagos provisionales previos</label><span class="money text-success">${fmtMXN(d.isr_pagos_anteriores)}</span></div>
      <div class="isr-card highlight danger"><label>ISR A PAGAR</label><span class="money big">${fmtMXN(d.isr_a_pagar)}</span></div>
    </div>
    <div class="isr-meta">
      <span>Tipo persona: <strong>${d.tipo_persona}</strong></span>
      <span>Estado: <span class="badge-estado estado-${d.estado}">${d.estado}</span></span>
      ${d.fecha_pago ? `<span>Pagado: ${d.fecha_pago}</span>` : ''}
    </div>`;
}

async function isrLoadAnual() {
  try {
    const data = await apiFetch(`/isr/anual/${isrYearSel}`);
    const tbody = document.getElementById('isrAnualBody');
    if (!tbody) return;
    const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    tbody.innerHTML = data.periodos.length ? data.periodos.map(d => `
      <tr>
        <td>${meses[d.periodo]}</td>
        <td class="text-right money">${fmtMXN(d.ingresos_periodo)}</td>
        <td class="text-right money">${fmtMXN(d.utilidad_fiscal)}</td>
        <td class="text-right money text-warning">${fmtMXN(d.isr_causado)}</td>
        <td class="text-right money text-danger">${fmtMXN(d.isr_a_pagar)}</td>
        <td><span class="badge-estado estado-${d.estado}">${d.estado}</span></td>
      </tr>`).join('') + `
      <tr class="totales-row">
        <td><strong>TOTAL ${isrYearSel}</strong></td>
        <td class="text-right money"><strong>${fmtMXN(data.totales.total_ingresos)}</strong></td>
        <td class="text-right money"><strong>-</strong></td>
        <td class="text-right money"><strong>${fmtMXN(data.totales.total_isr_causado)}</strong></td>
        <td class="text-right money text-danger"><strong>${fmtMXN(data.totales.total_isr_pagado)}</strong></td>
        <td>-</td>
      </tr>` : '<tr><td colspan="6" class="text-center muted">Sin datos anuales.</td></tr>';
  } catch (e) { /* sin datos */ }
}

async function isrCalcular() {
  try {
    showToast('info', 'Procesando', 'Calculando ISR...');
    const r = await apiFetch('/isr/calcular', 'POST',
      { year: isrYearSel, mes: isrMesSel });
    showToast('success', 'ISR calculado', `A pagar: ${fmtMXN(r.datos.isr_a_pagar)}`);
    await isrLoadListado();
    await isrLoadDetalle();
    await isrLoadAnual();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function isrMarcarPagado(year, mes) {
  const ref = prompt('Referencia de pago (opcional):');
  try {
    await apiFetch(`/isr/${year}/${mes}`, 'PUT', {
      estado: 'pagado',
      fecha_pago: new Date().toISOString().slice(0,10),
      referencia_pago: ref || null
    });
    showToast('success', 'ISR', 'Marcado como pagado');
    await isrLoadListado();
  } catch (e) { showToast('error', 'Error', e.message); }
}

function isrCambiarPeriodo() {
  isrYearSel = document.getElementById('isrYear')?.value || isrYearSel;
  isrMesSel  = document.getElementById('isrMes')?.value  || isrMesSel;
  initISR();
}
