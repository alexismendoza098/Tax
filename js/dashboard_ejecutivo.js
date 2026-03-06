/**
 * ============================================================
 * DASHBOARD EJECUTIVO + ESTADOS FINANCIEROS — ETX Tax Recovery
 * ============================================================
 */

let dashYear = new Date().getFullYear();
let dashMes  = new Date().getMonth() + 1;

async function initDashboardEjecutivo() {
  dashYear = document.getElementById('dashYear')?.value || dashYear;
  dashMes  = document.getElementById('dashMes')?.value  || dashMes;
  await dashLoadKPIs();
  await dashLoadResultados();
  await dashLoadBalance();
  await dashLoadFlujo();
  await dashLoadKPIsFinancieros();
}

// ─── KPIs Generales ───────────────────────────────────────────
async function dashLoadKPIs() {
  try {
    const data = await apiFetch(`/estados-financieros/dashboard?year=${dashYear}&mes=${dashMes}`);
    const k = data.kpis;

    setDashVal('dashTotalCFDIs',   k.total_cfdis?.toLocaleString('es-MX'));
    setDashVal('dashVolOps',       fmtMXN(k.volumen_operaciones));
    setDashVal('dashIVATras',      fmtMXN(k.iva_trasladado));
    setDashVal('dashIVAActed',     fmtMXN(k.iva_acreditable));
    setDashVal('dashSaldoIVA',     fmtMXN(k.saldo_iva));
    setDashVal('dashISRAcum',      fmtMXN(k.isr_acumulado));
    setDashVal('dashActivos',      k.activos_fijos?.toLocaleString('es-MX'));
    setDashVal('dashValorActivos', fmtMXN(k.valor_activos));
    setDashVal('dashAlertas',      k.alertas_activas);
    setDashVal('dashPapelera',     k.registros_papelera);

    // Colorear saldo IVA
    const saldoEl = document.getElementById('dashSaldoIVA');
    if (saldoEl) {
      const saldo = parseFloat(k.saldo_iva);
      saldoEl.className = saldo > 0 ? 'kpi-val text-danger' : saldo < 0 ? 'kpi-val text-success' : 'kpi-val';
    }

    // Alertas badge
    const alertBadge = document.getElementById('dashAlertasBadge');
    if (alertBadge && k.alertas_activas > 0) {
      alertBadge.style.display = 'inline';
      alertBadge.textContent = k.alertas_activas;
    }

    // Gráfica de tendencia
    if (data.tendencia?.length) dashRenderTendencia(data.tendencia);
  } catch (e) { showToast('Error dashboard: ' + e.message, 'error'); }
}

// ─── Estado de Resultados ─────────────────────────────────────
async function dashLoadResultados() {
  try {
    const data = await apiFetch(`/estados-financieros/resultados?year=${dashYear}&mes=${dashMes}`);
    const r = data.resultados;

    setDashVal('erIngresos',    fmtMXN(data.ingresos.netos));
    setDashVal('erGastos',      fmtMXN(data.costos_gastos.total));
    setDashVal('erUtilidadBruta', fmtMXN(r.utilidad_bruta));
    setDashVal('erUtilidadOper',  fmtMXN(r.utilidad_operativa));
    setDashVal('erImpuesto',      fmtMXN(r.impuesto_estimado_30pct));
    setDashVal('erUtilidadNeta',  fmtMXN(r.utilidad_neta));
    setDashVal('erMargen',        r.margen_utilidad_pct + '%');

    const utilNeta = parseFloat(r.utilidad_neta);
    const el = document.getElementById('erUtilidadNeta');
    if (el) el.className = utilNeta >= 0 ? 'kpi-val text-success' : 'kpi-val text-danger';

    // Detalle gastos
    setDashVal('erGastosOper',  fmtMXN(data.costos_gastos.gastos_operativos));
    setDashVal('erNomina',      fmtMXN(data.costos_gastos.nomina));
    setDashVal('erDepreciacion',fmtMXN(data.costos_gastos.depreciacion));

    // Gráfica mensual
    if (data.por_mes?.length) dashRenderResultadosChart(data.por_mes);
  } catch (e) { console.warn('Resultados:', e.message); }
}

// ─── Balance General ──────────────────────────────────────────
async function dashLoadBalance() {
  try {
    const data = await apiFetch(`/estados-financieros/balance?year=${dashYear}&mes=${dashMes}`);

    setDashVal('balActivoTotal',  fmtMXN(data.activo.total));
    setDashVal('balPasivoTotal',  fmtMXN(data.pasivo.total));
    setDashVal('balCapitalTotal', fmtMXN(data.capital.total));

    const ecuacion = data.ecuacion_contable;
    const ecuEl = document.getElementById('balEcuacion');
    if (ecuEl) {
      ecuEl.innerHTML = ecuacion.cuadra
        ? `<span class="text-success">✓ Ecuación cuadra: Activo = Pasivo + Capital = ${fmtMXN(ecuacion.activo)}</span>`
        : `<span class="text-danger">⚠ Ecuación descuadrada — revisar pólizas</span>`;
    }

    // Listas
    renderCuentasList('balActivoCirc',    data.activo.circulante);
    renderCuentasList('balActivoNoCir',   data.activo.no_circulante);
    renderCuentasList('balPasivoCP',      data.pasivo.corto_plazo);
    renderCuentasList('balPasivoLP',      data.pasivo.largo_plazo);
    renderCuentasList('balCapital',       data.capital.cuentas);
  } catch (e) { console.warn('Balance:', e.message); }
}

function renderCuentasList(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = items?.length
    ? items.map(i => `<div class="bal-item"><span>${i.descripcion}</span><span class="money">${fmtMXN(i.saldo)}</span></div>`).join('')
    : '<div class="muted text-center">-</div>';
}

// ─── Flujo de Efectivo ────────────────────────────────────────
async function dashLoadFlujo() {
  try {
    const data = await apiFetch(`/estados-financieros/flujo?year=${dashYear}&mes=${dashMes}`);

    setDashVal('flujoOper',   fmtMXN(data.actividades_operacion.flujo_operativo));
    setDashVal('flujoInv',    fmtMXN(data.actividades_inversion.flujo_inversion));
    setDashVal('flujoFin',    fmtMXN(data.actividades_financiamiento.flujo_financiamiento));
    setDashVal('flujoNeto',   fmtMXN(data.flujo_neto));

    const flujoEl = document.getElementById('flujoNeto');
    if (flujoEl) {
      const fn = parseFloat(data.flujo_neto);
      flujoEl.className = fn >= 0 ? 'kpi-val text-success' : 'kpi-val text-danger';
    }
    if (data.alerta) {
      showToast(data.alerta, 'warning');
    }
  } catch (e) { console.warn('Flujo:', e.message); }
}

// ─── KPIs Financieros / Razones ───────────────────────────────
async function dashLoadKPIsFinancieros() {
  try {
    const data = await apiFetch(`/estados-financieros/kpis?year=${dashYear}&mes=${dashMes}`);

    setDashVal('kpiEficiencia', data.razon_eficiencia || '-');
    setDashVal('kpiMargen',     (data.margen_utilidad_pct || '0') + '%');
    setDashVal('kpiDeudaIngreso', data.ratio_deuda_ingreso || '-');
    setDashVal('kpiCobertura',    data.cobertura_gastos || '-');

    // Interpretaciones
    setDashVal('kpiEficienciaDesc', data.interpretacion?.eficiencia || '');
    setDashVal('kpiMargenDesc',     data.interpretacion?.margen || '');
  } catch (e) { console.warn('KPIs financieros:', e.message); }
}

// ─── Gráfica de tendencia (Canvas básico) ─────────────────────
function dashRenderTendencia(tendencia) {
  const canvas = document.getElementById('dashTendenciaChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const labels    = tendencia.map(t => meses[t.mes]);
  const ingresos  = tendencia.map(t => parseFloat(t.ingresos || 0));
  const egresos   = tendencia.map(t => parseFloat(t.egresos || 0));
  const maxVal    = Math.max(...ingresos, ...egresos, 1);
  const W = canvas.width, H = canvas.height;
  const pad = 40;
  const innerW = W - pad*2, innerH = H - pad*2;
  const n = tendencia.length;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1a2332';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#2a3a52'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + innerH - (i / 4) * innerH;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }

  // Barras
  const barW = innerW / n * 0.35;
  for (let i = 0; i < n; i++) {
    const x = pad + (i / n) * innerW + (innerW / n) * 0.15;
    const hI = (ingresos[i] / maxVal) * innerH;
    const hE = (egresos[i]  / maxVal) * innerH;

    ctx.fillStyle = '#4ade80aa';
    ctx.fillRect(x, pad + innerH - hI, barW, hI);
    ctx.fillStyle = '#f87171aa';
    ctx.fillRect(x + barW + 2, pad + innerH - hE, barW, hE);

    ctx.fillStyle = '#8a9bb5'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(labels[i], x + barW, H - pad/2 + 10);
  }

  // Leyenda
  ctx.fillStyle = '#4ade80'; ctx.fillRect(pad, 8, 12, 10);
  ctx.fillStyle = '#e2e8f0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Ingresos', pad + 16, 17);
  ctx.fillStyle = '#f87171'; ctx.fillRect(pad + 80, 8, 12, 10);
  ctx.fillStyle = '#e2e8f0'; ctx.fillText('Egresos', pad + 96, 17);
}

function dashRenderResultadosChart(porMes) {
  const canvas = document.getElementById('dashResultadosChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const W = canvas.width, H = canvas.height;
  const pad = 40, innerW = W - pad*2, innerH = H - pad*2;
  const maxV = Math.max(...porMes.map(m => parseFloat(m.ingresos||0)), 1);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1a2332';
  ctx.fillRect(0, 0, W, H);

  // Línea de ingresos
  ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2;
  ctx.beginPath();
  porMes.forEach((m, i) => {
    const x = pad + (i / (porMes.length - 1 || 1)) * innerW;
    const y = pad + innerH - (parseFloat(m.ingresos||0) / maxV) * innerH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#8a9bb5'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  porMes.forEach((m, i) => {
    const x = pad + (i / (porMes.length - 1 || 1)) * innerW;
    ctx.fillText(meses[m.mes], x, H - 5);
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function setDashVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '-';
}

function dashCambiarPeriodo() {
  dashYear = document.getElementById('dashYear')?.value || dashYear;
  dashMes  = document.getElementById('dashMes')?.value  || dashMes;
  initDashboardEjecutivo();
}

function dashExportarPDF() {
  window.print();
}
