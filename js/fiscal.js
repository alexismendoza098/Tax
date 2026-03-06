/**
 * ================================================================
 * DASHBOARD FISCAL — ETX Tax Recovery
 * IVA · ISR · Estado SAT · EFOS/EDOS · Limpiador de Sistema
 * ================================================================
 */

/* ─── Helpers globales ─────────────────────────────────────── */
// fmtMXN definida en auditoria.js (carga antes)

/** Escapa caracteres HTML para prevenir XSS al usar innerHTML */
function fiscalEsc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fiscalAuthHeaders() {
    const token = localStorage.getItem('token') || '';
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

function fiscalApiBase() {
    return (typeof API_URL !== 'undefined' ? API_URL : 'http://localhost:3000/api');
}

const MESES_ES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

/* ═══════════════════════════════════════════════════════════════
   CARGA PRINCIPAL DEL DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
async function loadFiscalDashboard() {
    if (typeof backendOnline !== 'undefined' && !backendOnline) {
        const errHtml = '<div class="fiva-loading" style="color:#f87171"><i class="fas fa-wifi-slash"></i> Backend offline — conecta el servidor</div>';
        ['fiscal-iva-card','fiscal-sat-card'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = errHtml;
        });
        return;
    }

    const year  = document.getElementById('fiscal-year')?.value || '2025';
    const badge = document.getElementById('fiscal-year-badge');
    if (badge) badge.textContent = year === 'todos' ? 'Todos' : year;

    setFiscalSpinners();

    const base = fiscalApiBase();

    // Lanzar todas las peticiones en paralelo
    const [ivaData, satData, isrData, efosData, declData] = await Promise.allSettled([
        fetch(`${base}/fiscal/resumen-iva?year=${year}`,       { headers: fiscalAuthHeaders() }).then(r => r.json()),
        fetch(`${base}/fiscal/estado-sat?year=${year}`,        { headers: fiscalAuthHeaders() }).then(r => r.json()),
        fetch(`${base}/fiscal/deducibilidad?year=${year}`,     { headers: fiscalAuthHeaders() }).then(r => r.json()),
        fetch(`${base}/fiscal/efos-check?year=${year}`,        { headers: fiscalAuthHeaders() }).then(r => r.json()),
        fetch(`${base}/fiscal/declaracion-previa?year=${year}`,{ headers: fiscalAuthHeaders() }).then(r => r.json()),
    ]);

    renderIvaResumen(ivaData.status === 'fulfilled' ? ivaData.value : { _err: ivaData.reason?.message });
    renderEstadoSat(satData.status === 'fulfilled' ? satData.value : { _err: satData.reason?.message });
    renderDeducibilidad(isrData.status === 'fulfilled' ? isrData.value : { _err: isrData.reason?.message });
    renderEfosCheck(efosData.status === 'fulfilled' ? efosData.value : { _err: efosData.reason?.message });
    renderDeclaracionPrevia(declData.status === 'fulfilled' ? declData.value : { _err: declData.reason?.message });
}

function setFiscalSpinners() {
    const spin = '<div class="fiva-loading"><i class="fas fa-spinner fa-spin"></i></div>';
    ['fiscal-iva-card','fiscal-sat-card','fiscal-declaracion-wrap',
     'fiscal-deducibilidad-wrap','fiscal-efos-wrap'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = spin;
    });
}

/* ═══════════════════════════════════════════════════════════════
   1. WIDGET IVA — SALDO A FAVOR / A PAGAR
   Backend: { saldo_iva: { iva_trasladado, iva_acreditable, iva_retenido, iva_neto, status },
              emitidas: { ppd_pendientes, cancelados, total_facturas },
              recibidas: { total_facturas } }
   ═══════════════════════════════════════════════════════════════ */
function renderIvaResumen(data) {
    const el = document.getElementById('fiscal-iva-card');
    if (!el) return;

    if (!data || data.error || data._err || !data.saldo_iva) {
        el.innerHTML = `<div class="fiva-loading" style="color:#f87171">
            <i class="fas fa-exclamation-triangle"></i>
            ${data?.error || data?._err || 'Sin datos de IVA — descarga CFDIs primero'}
        </div>`;
        return;
    }

    const s      = data.saldo_iva;
    const emit   = data.emitidas   || {};
    const recib  = data.recibidas  || {};
    const neto   = parseFloat(s.iva_neto || 0);
    const status = s.status || 'EQUILIBRADO'; // A_PAGAR | SALDO_FAVOR | EQUILIBRADO

    const isFavor = status === 'SALDO_FAVOR';
    const isPagar = status === 'A_PAGAR';

    const montoClass = isFavor ? 'iva-favor' : isPagar ? 'iva-pagar' : 'iva-equilibrio';
    const badgeClass = isFavor ? 'iva-favor-bg' : isPagar ? 'iva-pagar-bg' : 'iva-equilibrio-bg';
    const cardClass  = isFavor ? 'estado-favor' : isPagar ? 'estado-pagar' : '';
    const iconBg     = isFavor ? 'rgba(74,222,128,0.15)' : isPagar ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)';
    const iconColor  = isFavor ? '#4ade80' : isPagar ? '#f87171' : '#fbbf24';
    const iconName   = isFavor ? 'arrow-circle-up' : isPagar ? 'arrow-circle-down' : 'equals';
    const badgeText  = isFavor ? '✅ SALDO A FAVOR' : isPagar ? '⚠️ IVA A PAGAR' : '⚖️ EQUILIBRADO';
    const statusDesc = isFavor
        ? 'Tienes derecho a devolución o compensación ante el SAT (Art. 6 LIVA)'
        : isPagar ? 'Declara y paga este IVA antes del día 17 del mes siguiente'
        : 'IVA trasladado igual al acreditable';

    const yearSel = document.getElementById('fiscal-year')?.value || '2025';

    el.className = `fiscal-iva-card ${cardClass}`;
    el.innerHTML = `
        <div class="iva-widget-header">
            <div class="iva-widget-header-icon" style="background:${iconBg}; color:${iconColor}; width:36px; height:36px; border-radius:9px; display:flex; align-items:center; justify-content:center;">
                <i class="fas fa-${iconName}"></i>
            </div>
            <span class="iva-widget-title">Posición IVA — ${yearSel === 'todos' ? 'Todos los años' : yearSel}</span>
        </div>

        <div class="iva-resultado-bloque">
            <div class="iva-monto-principal">
                <span class="iva-monto-label">${isFavor ? 'Saldo a Favor (Art. 6 LIVA)' : isPagar ? 'IVA a Pagar (Art. 1 LIVA)' : 'IVA Neto'}</span>
                <span class="iva-monto-valor ${montoClass}">${fmtMXN(Math.abs(neto))}</span>
            </div>
            <div>
                <div class="iva-status-badge ${badgeClass}">${badgeText}</div>
                <div style="font-size:0.72rem; color:var(--text-secondary); max-width:260px; margin-top:0.3rem;">${statusDesc}</div>
            </div>
        </div>

        <div class="iva-desglose">
            <div class="iva-desglose-item">
                <span class="iva-desglose-label">IVA Trasladado</span>
                <span class="iva-desglose-value iva-pagar">${fmtMXN(s.iva_trasladado || 0)}</span>
                <span class="iva-desglose-sub">${emit.total_facturas || 0} fact. emitidas</span>
            </div>
            <div class="iva-desglose-item">
                <span class="iva-desglose-label">IVA Acreditable</span>
                <span class="iva-desglose-value iva-favor">${fmtMXN(s.iva_acreditable || 0)}</span>
                <span class="iva-desglose-sub">${recib.total_facturas || 0} fact. recibidas</span>
            </div>
            <div class="iva-desglose-item">
                <span class="iva-desglose-label">IVA Retenido</span>
                <span class="iva-desglose-value" style="color:#fbbf24;">${fmtMXN(s.iva_retenido || 0)}</span>
                <span class="iva-desglose-sub">Retenciones emitidas</span>
            </div>
            <div class="iva-desglose-item">
                <span class="iva-desglose-label">PPD Sin Pago</span>
                <span class="iva-desglose-value" style="color:${(emit.ppd_pendientes||0) > 0 ? '#f87171' : '#94a3b8'};">
                    ${emit.ppd_pendientes || 0}
                </span>
                <span class="iva-desglose-sub">Sin complemento pago</span>
            </div>
        </div>

        ${s.sin_recibidas ? `<div style="margin-top:1rem; padding:0.6rem 0.85rem; background:rgba(251,191,36,0.08); border:1px solid rgba(251,191,36,0.2); border-radius:8px; font-size:0.75rem; color:#fbbf24;">
            <i class="fas fa-info-circle"></i> <strong>Sin CFDIs Recibidos:</strong> El IVA acreditable es $0. Descarga tus facturas de proveedores (CFDIs Recibidos) en el Paso 2 para un análisis completo.
        </div>` : ''}
    `;
}

/* ═══════════════════════════════════════════════════════════════
   2. ESTADO SAT — SEMÁFORO DE CUMPLIMIENTO
   Backend: { alertas: [{tipo, nivel, titulo, detalle, cantidad, accion}], score, estado }
   ═══════════════════════════════════════════════════════════════ */
function renderEstadoSat(data) {
    const el = document.getElementById('fiscal-sat-card');
    if (!el) return;

    if (!data || data.error || data._err) {
        el.innerHTML = `<div class="fiva-loading" style="color:#f87171">
            <i class="fas fa-exclamation-triangle"></i> ${data?.error || data?._err || 'Sin datos'}
        </div>`;
        return;
    }

    const score  = parseInt(data.score || 100);
    const estado = data.estado || 'AMARILLO'; // VERDE | AMARILLO | ROJO
    const alertas = data.alertas || [];

    const estadoClass = estado === 'VERDE' ? 'verde' : estado === 'ROJO' ? 'rojo' : 'amarillo';
    const estadoColor = estado === 'VERDE' ? '#4ade80' : estado === 'ROJO' ? '#f87171' : '#fbbf24';
    const estadoDesc  = estado === 'VERDE' ? 'Cumplimiento fiscal correcto'
        : estado === 'ROJO' ? 'Riesgo fiscal alto — atención inmediata'
        : 'Observaciones pendientes por atender';

    const barColor = estado === 'VERDE' ? 'linear-gradient(90deg,#22c55e,#4ade80)'
        : estado === 'ROJO' ? 'linear-gradient(90deg,#ef4444,#f87171)'
        : 'linear-gradient(90deg,#f59e0b,#fbbf24)';

    const alertasHtml = alertas.length === 0
        ? `<li class="sat-alerta-item">
            <span class="sat-alerta-icon sat-alerta-ok"><i class="fas fa-check-circle"></i></span>
            <span>Sin observaciones — todo en orden</span>
           </li>`
        : alertas.map(a => {
            const lvl  = a.nivel || 'info';
            const cls  = lvl === 'error' ? 'sat-alerta-error' : lvl === 'ok' ? 'sat-alerta-ok' : 'sat-alerta-warn';
            const icon = lvl === 'error' ? 'times-circle' : lvl === 'ok' ? 'check-circle' : 'exclamation-triangle';
            return `<li class="sat-alerta-item" title="${a.accion || ''}">
                <span class="sat-alerta-icon ${cls}"><i class="fas fa-${icon}"></i></span>
                <span><strong>${a.titulo || ''}</strong> — ${a.detalle || ''}</span>
            </li>`;
          }).join('');

    el.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:1rem;">
            <div style="width:36px; height:36px; border-radius:9px; background:rgba(124,58,237,0.15); color:#a78bfa; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <i class="fas fa-shield-alt"></i>
            </div>
            <span class="iva-widget-title">Estado Fiscal SAT</span>
        </div>

        <div class="sat-semaforo-wrap">
            <div class="sat-semaforo-circle ${estadoClass}">
                <span>${score}</span>
                <span style="font-size:0.52rem; font-weight:400; opacity:0.8;">/ 100</span>
            </div>
            <div class="sat-semaforo-estado" style="color:${estadoColor};">${estado}</div>
            <div class="sat-semaforo-desc">${estadoDesc}</div>
            <div class="sat-score-bar" style="width:90%; margin-top:0.6rem;">
                <div class="sat-score-fill" style="width:${score}%; background:${barColor};"></div>
            </div>
        </div>

        <ul class="sat-alertas-list">${alertasHtml}</ul>
    `;
}

/* ═══════════════════════════════════════════════════════════════
   3. DEDUCIBILIDAD ISR (Art. 28 LISR)
   Backend: { ingresos: { total, facturas }, gastos_deducibles: { total, nomina },
              estimacion_isr: { base_gravable, isr_estimado } }
   ═══════════════════════════════════════════════════════════════ */
function renderDeducibilidad(data) {
    const el = document.getElementById('fiscal-deducibilidad-wrap');
    if (!el) return;

    if (!data || data.error || data._err) {
        el.innerHTML = `<div class="fiva-loading" style="color:#f87171">
            ${data?.error || data?._err || 'Sin datos ISR'}
        </div>`;
        return;
    }

    const ingresos  = parseFloat(data.ingresos?.total || 0);
    const gastos    = parseFloat(data.gastos_deducibles?.total || 0);
    const nomina    = parseFloat(data.gastos_deducibles?.nomina || 0);
    const baseISR   = parseFloat(data.estimacion_isr?.base_gravable || 0);
    const isrEst    = parseFloat(data.estimacion_isr?.isr_estimado || 0);
    const facEmit   = parseInt(data.ingresos?.facturas || 0);
    const ratio     = data.gastos_deducibles?.porcentaje_sobre_ingresos || 0;
    const sinDatos  = data.sin_datos_recibidas;

    el.innerHTML = `
        <div class="isr-resumen-grid">
            <div class="isr-res-item">
                <span class="isr-res-label">Ingresos Totales</span>
                <span class="isr-res-value highlight-green">${fmtMXN(ingresos)}</span>
            </div>
            <div class="isr-res-item">
                <span class="isr-res-label">Deducciones</span>
                <span class="isr-res-value highlight-red">${fmtMXN(gastos)}</span>
            </div>
            <div class="isr-res-item">
                <span class="isr-res-label">Nómina</span>
                <span class="isr-res-value" style="color:#a78bfa;">${fmtMXN(nomina)}</span>
            </div>
            <div class="isr-res-item">
                <span class="isr-res-label">Base Gravable</span>
                <span class="isr-res-value highlight-gold">${fmtMXN(baseISR)}</span>
            </div>
            <div class="isr-res-item">
                <span class="isr-res-label">ISR Estimado (30%)</span>
                <span class="isr-res-value highlight-red">${fmtMXN(isrEst)}</span>
            </div>
            <div class="isr-res-item">
                <span class="isr-res-label">Fact. Emitidas</span>
                <span class="isr-res-value">${facEmit.toLocaleString('es-MX')}</span>
            </div>
        </div>

        <div class="isr-progress-wrap">
            <div class="isr-progress-label">
                <span>Ratio de Deducibilidad</span>
                <span>${parseFloat(ratio).toFixed(1)}%</span>
            </div>
            <div class="isr-progress-bar">
                <div class="isr-progress-fill" style="width:${Math.min(parseFloat(ratio||0),100)}%;"></div>
            </div>
        </div>

        ${sinDatos ? `<div style="margin-bottom:0.75rem; padding:0.5rem 0.75rem; background:rgba(251,191,36,0.08); border-left:3px solid #fbbf24; border-radius:0 6px 6px 0; font-size:0.73rem; color:#fbbf24;">
            <i class="fas fa-info-circle"></i> Sin CFDIs Recibidos — las deducciones muestran solo nómina y egresos propios
        </div>` : ''}

        <div class="isr-articulo-note">
            <strong>Art. 28 LISR:</strong> Son deducibles los gastos estrictamente indispensables,
            soportados con CFDI 4.0 vigente. PPD sin complemento de pago no deducible hasta cubrir el pago.
            ISR estimado al 30% para personas morales. <em>Consulte a su contador para cálculo preciso.</em>
        </div>
    `;
}

/* ═══════════════════════════════════════════════════════════════
   4. EFOS / EDOS — RIESGO (Art. 69-B CFF)
   Backend: { proveedores_riesgo: [{rfc_emisor, nombre_emisor, num_facturas,
              monto_total, iva_total, nivel_riesgo, alertas:[{tipo,msg}]}] }
   ═══════════════════════════════════════════════════════════════ */
function renderEfosCheck(data) {
    const el    = document.getElementById('fiscal-efos-wrap');
    const badge = document.getElementById('efos-count-badge');
    if (!el) return;

    if (!data || data.error || data._err) {
        el.innerHTML = `<div class="fiva-loading" style="color:#f87171">${fiscalEsc(data?.error || data?._err || 'Sin datos EFOS')}</div>`;
        return;
    }

    const proveedores = data.proveedores_riesgo || [];
    const total = proveedores.length;

    if (badge) {
        badge.textContent = total;
        badge.className   = 'efos-count-badge ' + (total === 0 ? 'efos-badge-ok' : 'efos-badge-riesgo');
    }

    if (total === 0) {
        el.innerHTML = `
            <div class="efos-empty-state">
                <i class="fas fa-check-circle"></i>
                Sin señales de riesgo EFOS/EDOS detectadas<br>
                <small style="opacity:0.7;">${data.total_revisados || 0} proveedor(es) revisado(s) — Art. 69-B CFF</small>
            </div>`;
        return;
    }

    const rows = proveedores.map(p => {
        const nivel    = p.nivel_riesgo || 'MEDIO';
        const riesgoCls = nivel === 'ALTO' ? 'efos-riesgo-alto' : nivel === 'MEDIO' ? 'efos-riesgo-medio' : 'efos-riesgo-bajo';
        const razon    = (p.alertas || []).map(a => a.msg).join('; ') || '—';
        return `<tr>
            <td style="font-family:'Courier New',monospace; font-size:0.77rem;">${p.rfc_emisor || '—'}</td>
            <td style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${p.nombre_emisor || ''}">${p.nombre_emisor || '—'}</td>
            <td class="td-r">${fmtMXN(p.monto_total || 0)}</td>
            <td class="td-r">${p.num_facturas || 0}</td>
            <td><span class="efos-riesgo-badge ${riesgoCls}">${nivel}</span></td>
            <td style="font-size:0.71rem; color:var(--text-secondary); max-width:160px; white-space:normal;" title="${razon}">${razon}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
        <div class="efos-table-wrap">
            <table class="efos-table">
                <thead>
                    <tr>
                        <th>RFC Proveedor</th>
                        <th>Nombre</th>
                        <th class="th-r">Monto</th>
                        <th class="th-r">Facts.</th>
                        <th>Riesgo</th>
                        <th>Razón detectada</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div style="margin-top:0.75rem; font-size:0.72rem; color:var(--text-secondary); padding:0.5rem 0.75rem; background:rgba(251,191,36,0.06); border-radius:6px;">
            <i class="fas fa-info-circle" style="color:#fbbf24;"></i>
            Análisis por patrones locales. Verificación definitiva EFOS: <strong>omawww.sat.gob.mx</strong> (Art. 69-B CFF)
        </div>
    `;
}

/* ═══════════════════════════════════════════════════════════════
   5. DECLARACIÓN PREVIA MENSUAL
   Backend: { mensual: [{mes, anio, facturas_emitidas, iva_trasladado,
              iva_notas_credito, iva_neto_mes, cancelados, comp_pago}],
              totales: { facturas_emitidas, iva_trasladado, iva_trasladado_neto } }
   ═══════════════════════════════════════════════════════════════ */
function renderDeclaracionPrevia(data) {
    const el = document.getElementById('fiscal-declaracion-wrap');
    if (!el) return;

    if (!data || data.error || data._err || !data.mensual) {
        el.innerHTML = `<div class="fiva-loading" style="color:#f87171">${fiscalEsc(data?.error || data?._err || 'Sin datos')}</div>`;
        return;
    }

    const meses   = data.mensual || [];
    const totales = data.totales || {};

    if (meses.length === 0) {
        el.innerHTML = '<div class="fiva-loading">Sin movimientos en el periodo seleccionado</div>';
        return;
    }

    const rows = meses.map(m => {
        const neto = parseFloat(m.iva_neto_mes || m.iva_trasladado || 0);
        const notas = parseFloat(m.iva_notas_credito || 0);
        const netoReal = parseFloat(m.iva_trasladado || 0) - notas;
        const statusCls  = netoReal < -0.01 ? 'decl-status-favor' : netoReal > 0.01 ? 'decl-status-pagar' : 'decl-status-cero';
        const statusText = netoReal < -0.01 ? '↑ Favor' : netoReal > 0.01 ? '↓ Pagar' : '—';
        return `<tr>
            <td class="td-mes">${MESES_ES[m.mes] || m.mes} ${m.anio}</td>
            <td class="td-r">${parseInt(m.facturas_emitidas || 0).toLocaleString()}</td>
            <td class="td-r">${fmtMXN(m.iva_trasladado || 0)}</td>
            <td class="td-r" style="color:${notas > 0 ? '#fbbf24' : 'var(--text-secondary)'};">${notas > 0 ? fmtMXN(notas) : '—'}</td>
            <td class="td-r">${parseInt(m.cancelados || 0).toLocaleString()}</td>
            <td class="td-r">${parseInt(m.comp_pago || 0).toLocaleString()}</td>
            <td class="td-r ${statusCls}">${fmtMXN(Math.abs(netoReal))}</td>
            <td class="${statusCls}">${statusText}</td>
        </tr>`;
    }).join('');

    const netoTot = parseFloat(totales.iva_trasladado_neto || totales.iva_trasladado || 0);
    const totCls  = netoTot < -0.01 ? 'decl-status-favor' : netoTot > 0.01 ? 'decl-status-pagar' : '';

    el.innerHTML = `
        <table class="decl-table">
            <thead>
                <tr>
                    <th>Mes</th>
                    <th class="th-r">Fact. Emit.</th>
                    <th class="th-r">IVA Trasladado</th>
                    <th class="th-r">Notas Crédito</th>
                    <th class="th-r">Canceladas</th>
                    <th class="th-r">Comp. Pago</th>
                    <th class="th-r">IVA Neto</th>
                    <th>Estado</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
                <tr class="decl-total-row">
                    <td><strong>TOTALES ${data.year && data.year !== 'todos' ? data.year : ''}</strong></td>
                    <td class="td-r"><strong>${parseInt(totales.facturas_emitidas||0).toLocaleString()}</strong></td>
                    <td class="td-r"><strong>${fmtMXN(totales.iva_trasladado||0)}</strong></td>
                    <td class="td-r"><strong>${fmtMXN(totales.iva_notas_credito||0)}</strong></td>
                    <td class="td-r">—</td>
                    <td class="td-r">—</td>
                    <td class="td-r ${totCls}"><strong>${fmtMXN(Math.abs(netoTot))}</strong></td>
                    <td class="${totCls}"><strong>${netoTot < -0.01 ? '✅ A Favor' : netoTot > 0.01 ? '⚠️ A Pagar' : '—'}</strong></td>
                </tr>
            </tbody>
        </table>
    `;
}

/* ═══════════════════════════════════════════════════════════════
   MODAL LIMPIADOR DE SISTEMA
   ═══════════════════════════════════════════════════════════════ */
async function openCleanupModal() {
    const modal = document.getElementById('cleanup-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    // Resetear log y botón
    const logEl = document.getElementById('cleanup-log');
    if (logEl) { logEl.innerHTML = ''; logEl.style.display = 'none'; }

    const btn = document.getElementById('cleanup-exec-btn');
    if (btn) {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fas fa-broom"></i> Limpiar Ahora';
        btn.style.background = '';
    }

    // Cargar vista previa
    await loadCleanupPreview();
}

function closeCleanupModal() {
    const modal = document.getElementById('cleanup-modal');
    if (modal) modal.style.display = 'none';
}

async function loadCleanupPreview() {
    try {
        const base = fiscalApiBase();
        const resp = await fetch(`${base}/admin/cleanup/preview`, { headers: fiscalAuthHeaders() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const d = await resp.json();

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('prev-cfdis', (parseInt(d.db?.comprobantes || 0)).toLocaleString('es-MX') + ' registros');
        set('prev-files', (parseInt(d.files?.downloads?.count || 0)) + ' archivos');
        set('prev-certs', (parseInt(d.files?.certs?.count || 0)) + ' archivos');
        set('prev-size',  d.files?.downloads?.size || '0 B');
    } catch (err) {
        console.warn('[Cleanup Preview] Error:', err.message);
        ['prev-cfdis','prev-files','prev-certs','prev-size'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = 'Error';
        });
    }
}

async function executeCleanup() {
    const btn   = document.getElementById('cleanup-exec-btn');
    const logEl = document.getElementById('cleanup-log');
    if (!btn || !logEl) return;

    if (!confirm('⚠️ ¿Confirmas limpiar el sistema?\n\nEsta acción eliminará los datos seleccionados de forma PERMANENTE.\nLos usuarios y contraseñas se conservarán.')) return;

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Limpiando...';
    logEl.style.display = 'block';
    logEl.innerHTML     = '<div class="cleanup-log-line">🔄 Iniciando limpieza del sistema...</div>';

    const opts = {
        limpiar_db:        document.getElementById('opt-db')?.checked        ?? true,
        limpiar_downloads: document.getElementById('opt-downloads')?.checked  ?? true,
        limpiar_reportes:  document.getElementById('opt-reportes')?.checked   ?? true,
        limpiar_certs:     document.getElementById('opt-certs')?.checked      ?? true,
        mantener_usuarios: true,
    };

    try {
        const base = fiscalApiBase();
        const resp = await fetch(`${base}/admin/cleanup`, {
            method:  'POST',
            headers: fiscalAuthHeaders(),
            body:    JSON.stringify(opts),
        });

        const result = await resp.json();

        if (Array.isArray(result.log)) {
            logEl.innerHTML = result.log.map(line => {
                const cls = line.startsWith('🗑') || line.startsWith('✅') ? 'cleanup-log-ok'
                    : line.startsWith('⚠️') ? 'cleanup-log-warn'
                    : line.startsWith('❌') ? 'cleanup-log-err'
                    : '';
                return `<div class="cleanup-log-line ${cls}">${line}</div>`;
            }).join('');
        }

        if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);

        logEl.innerHTML += '<div class="cleanup-log-line cleanup-log-ok">✅ Limpieza completada con éxito.</div>';
        btn.innerHTML    = '<i class="fas fa-check"></i> Completado';
        btn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';

        if (typeof showToast === 'function') showToast('✅ Sistema limpiado correctamente', 'success');

        // Actualizar vista previa
        setTimeout(loadCleanupPreview, 600);

    } catch (err) {
        logEl.innerHTML += `<div class="cleanup-log-line cleanup-log-err">❌ Error: ${fiscalEsc(err.message)}</div>`;
        btn.disabled  = false;
        btn.innerHTML = '<i class="fas fa-redo"></i> Reintentar';
        if (typeof showToast === 'function') showToast(`Error en limpieza: ${err.message}`, 'error');
    }
}

/* Cerrar modal al clic en el overlay */
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('cleanup-modal');
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeCleanupModal(); });
});
