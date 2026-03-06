/**
 * ================================================================
 * ESTADOS DE CUENTA BANCARIOS — ETX Tax Recovery
 * Conciliación CFDI vs movimientos bancarios
 * ================================================================
 */

/* ─── Config ─────────────────────────────────────────────────── */
function ecApiBase() {
    return (typeof API_URL !== 'undefined' ? API_URL : 'http://localhost:3000/api');
}
function ecHeaders() {
    const tok = localStorage.getItem('token') || '';
    return { 'Authorization': `Bearer ${tok}` };
}
function ecJsonHeaders() {
    return { ...ecHeaders(), 'Content-Type': 'application/json' };
}

// fmtMXN definida en auditoria.js (carga antes)
const MESES = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function fmtFecha(d) {
    if (!d) return '—';
    const p = String(d).substring(0, 10).split('-');
    return `${p[2]}/${MESES[parseInt(p[1])]}/${p[0]}`;
}

/* Estado interno */
let ecCurrentId   = null;
let ecMovAll      = [];  // todos los movimientos cargados del detalle actual
let ecTabActual   = 'todos';

/* ═══════════════════════════════════════════════════════════════
   CARGA PRINCIPAL DEL DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
async function ecLoadDashboard() {
    if (typeof backendOnline !== 'undefined' && !backendOnline) {
        ecShowOffline(); return;
    }
    const year = document.getElementById('ec-year')?.value || 'todos';

    // KPIs en loading
    ['ec-kpi-estados','ec-kpi-movimientos','ec-kpi-abonos','ec-kpi-cargos',
     'ec-kpi-sin-cfdi','ec-kpi-pct'].forEach(id => {
        const v = document.querySelector(`#${id} .ec-kpi-value`);
        if (v) v.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:0.9rem;"></i>';
    });

    const base = ecApiBase();
    const qs   = year !== 'todos' ? `?year=${year}` : '';

    const [globalRes, listaRes] = await Promise.allSettled([
        fetch(`${base}/estados-cuenta/resumen/global${qs}`, { headers: ecHeaders() }).then(r => r.json()),
        fetch(`${base}/estados-cuenta${qs}`,                { headers: ecHeaders() }).then(r => r.json()),
    ]);

    const global = globalRes.status === 'fulfilled' ? globalRes.value : {};
    const lista  = listaRes.status  === 'fulfilled' ? listaRes.value  : [];

    ecRenderKPIs(global);
    ecRenderLista(Array.isArray(lista) ? lista : []);

    // Botón "Conciliar Todo" — mostrar solo si hay estados sin conciliar
    const btn = document.getElementById('ec-conciliar-all-btn');
    if (btn) btn.style.display = lista.length > 0 ? '' : 'none';
}

/* ═══════════════════════════════════════════════════════════════
   KPIs GLOBALES
   ═══════════════════════════════════════════════════════════════ */
function ecRenderKPIs(g) {
    const set = (id, val) => {
        const el = document.querySelector(`#${id} .ec-kpi-value`);
        if (el) el.innerHTML = val;
    };

    if (g.sin_datos) {
        ['ec-kpi-estados','ec-kpi-movimientos','ec-kpi-abonos',
         'ec-kpi-cargos','ec-kpi-sin-cfdi','ec-kpi-pct'].forEach(id => set(id, '—'));
        return;
    }

    set('ec-kpi-estados',     parseInt(g.estados_cargados || 0));
    set('ec-kpi-movimientos', parseInt(g.total_movimientos || 0).toLocaleString('es-MX'));
    set('ec-kpi-abonos',      fmtMXN(g.total_abonos));
    set('ec-kpi-cargos',      fmtMXN(g.total_cargos));

    const sinCFDI = parseFloat(g.abonos_sin_cfdi || 0);
    set('ec-kpi-sin-cfdi', sinCFDI > 0
        ? `<span style="color:#f87171;">${fmtMXN(sinCFDI)}</span>`
        : '<span style="color:#4ade80;">$0.00</span>');

    const pct = parseInt(g.pct_conciliado || 0);
    const pctColor = pct >= 80 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171';
    set('ec-kpi-pct', `<span style="color:${pctColor}; font-size:1.4rem;">${pct}%</span>`);
}

/* ═══════════════════════════════════════════════════════════════
   LISTA DE ESTADOS DE CUENTA
   ═══════════════════════════════════════════════════════════════ */
function ecRenderLista(lista) {
    const wrap = document.getElementById('ec-lista-wrap');
    if (!wrap) return;

    if (!lista || lista.length === 0) {
        wrap.innerHTML = `
            <div class="fiva-loading" style="padding:2rem; text-align:center;">
                <i class="fas fa-university" style="font-size:2.5rem; opacity:0.25; display:block; margin-bottom:0.75rem;"></i>
                Sin estados de cuenta cargados<br>
                <span style="font-size:0.8rem; opacity:0.6;">Sube tu primer estado de cuenta usando el área de arriba</span>
            </div>`;
        return;
    }

    const BANCO_ICON = {
        BBVA: '🟦', SANTANDER: '🔴', HSBC: '🔴', BANAMEX: '🔵',
        BANORTE: '🟠', SCOTIABANK: '🟡', INBURSA: '⚪', OTRO: '🏦'
    };

    const rows = lista.map(ec => {
        const total = parseInt(ec.total_movimientos || 0);
        const conc  = parseInt(ec.movimientos_conciliados || 0);
        const pct   = total > 0 ? Math.round((conc / total) * 100) : 0;
        const pctColor = pct >= 80 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171';
        const icono = BANCO_ICON[ec.banco] || '🏦';
        const periodo = ec.periodo_inicio
            ? `${fmtFecha(ec.periodo_inicio)} — ${fmtFecha(ec.periodo_fin)}`
            : '—';

        return `
        <tr class="ec-lista-row" onclick="ecVerDetalle(${ec.id})">
            <td>
                <span class="ec-banco-badge">${icono} ${ec.banco}</span>
                ${ec.cuenta ? `<span class="ec-cuenta-num">····${String(ec.cuenta).slice(-4)}</span>` : ''}
            </td>
            <td class="ec-periodo">${periodo}</td>
            <td class="td-r ec-abono-cell">${fmtMXN(ec.total_abonos)}</td>
            <td class="td-r ec-cargo-cell">${fmtMXN(ec.total_cargos)}</td>
            <td class="td-r">${total.toLocaleString('es-MX')}</td>
            <td>
                <div class="ec-pct-wrap">
                    <div class="ec-pct-bar-bg">
                        <div class="ec-pct-bar-fill" style="width:${pct}%; background:${pctColor};"></div>
                    </div>
                    <span style="color:${pctColor}; font-size:0.8rem; font-weight:600;">${pct}%</span>
                </div>
            </td>
            <td>
                <button class="ec-btn-conciliar" onclick="event.stopPropagation(); ecConciliar(${ec.id})"
                        title="Ejecutar conciliación">
                    <i class="fas fa-magic"></i>
                </button>
                <button class="ec-btn-delete" onclick="event.stopPropagation(); ecEliminar(${ec.id}, '${ec.banco}')"
                        title="Eliminar">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <table class="ec-lista-table">
            <thead>
                <tr>
                    <th>Banco / Cuenta</th>
                    <th>Período</th>
                    <th class="th-r">Abonos</th>
                    <th class="th-r">Cargos</th>
                    <th class="th-r">Movimientos</th>
                    <th>Conciliación</th>
                    <th>Acciones</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

/* ═══════════════════════════════════════════════════════════════
   UPLOAD — DRAG & DROP
   ═══════════════════════════════════════════════════════════════ */
function ecDragOver(e) {
    e.preventDefault();
    document.getElementById('ec-drop-area')?.classList.add('ec-drag-over');
}
function ecDragLeave(e) {
    document.getElementById('ec-drop-area')?.classList.remove('ec-drag-over');
}
function ecDrop(e) {
    e.preventDefault();
    document.getElementById('ec-drop-area')?.classList.remove('ec-drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) ecHandleFile(file);
}

async function ecHandleFile(file) {
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    if (!['csv','xlsx','xls','txt'].includes(ext)) {
        ecToast('Formato no soportado. Usa CSV o Excel (.xlsx)', 'error'); return;
    }

    // Mostrar progreso
    const prog = document.getElementById('ec-upload-progress');
    const fill = document.getElementById('ec-progress-fill');
    const lbl  = document.getElementById('ec-progress-label');
    if (prog) prog.style.display = '';
    if (fill) { fill.style.width = '10%'; fill.style.transition = 'width 0.3s'; }
    if (lbl)  lbl.textContent = `Subiendo ${file.name}...`;

    try {
        const rfc  = (typeof currentUser !== 'undefined') ? currentUser?.rfc : null;
        const form = new FormData();
        form.append('file', file);
        if (rfc) form.append('rfc', rfc);

        if (fill) fill.style.width = '40%';

        const resp = await fetch(`${ecApiBase()}/estados-cuenta/upload`, {
            method:  'POST',
            headers: ecHeaders(),
            body:    form,
        });

        if (fill) fill.style.width = '80%';
        const data = await resp.json();

        if (!resp.ok) {
            if (resp.status === 409) {
                ecToast(`⚠️ ${data.error}`, 'warning');
            } else {
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            if (prog) prog.style.display = 'none';
            return;
        }

        if (fill) fill.style.width = '100%';
        if (lbl)  lbl.textContent = `✅ ${data.banco} — ${data.total_movimientos} movimientos importados`;

        ecToast(`✅ Estado de cuenta ${data.banco} cargado — ${data.total_movimientos} movimientos`, 'success');

        setTimeout(() => {
            if (prog) prog.style.display = 'none';
            if (fill) fill.style.width = '0%';
            // Limpiar input
            const inp = document.getElementById('ec-file-input');
            if (inp) inp.value = '';
        }, 1800);

        // Recargar dashboard y auto-conciliar
        await ecLoadDashboard();
        await ecConciliar(data.estado_cuenta_id);

    } catch (err) {
        if (prog) prog.style.display = 'none';
        ecToast(`Error al cargar: ${err.message}`, 'error');
        console.error('[EC] upload:', err);
    }
}

/* ═══════════════════════════════════════════════════════════════
   CONCILIACIÓN
   ═══════════════════════════════════════════════════════════════ */
async function ecConciliar(ecId) {
    ecToast('Ejecutando conciliación...', 'info');
    try {
        const resp = await fetch(`${ecApiBase()}/estados-cuenta/${ecId}/conciliar`, {
            method:  'POST',
            headers: ecJsonHeaders(),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        ecToast(
            `✅ Conciliación: ${data.conciliados}/${data.total} movimientos (${data.pct_conciliado}%)`,
            data.pct_conciliado >= 80 ? 'success' : 'warning'
        );

        // Mostrar alerta de ingresos sin CFDI si aplica
        if (data.riesgo_fiscal?.monto > 0) {
            ecToast(`⚠️ Ingresos sin CFDI: ${fmtMXN(data.riesgo_fiscal.monto)} — riesgo fiscal`, 'error');
        }

        await ecLoadDashboard();
        if (ecCurrentId === ecId) ecVerDetalle(ecId);

    } catch (err) {
        ecToast(`Error en conciliación: ${err.message}`, 'error');
        console.error('[EC] conciliar:', err);
    }
}

async function ecConciliarTodos() {
    const base = ecApiBase();
    const resp = await fetch(`${base}/estados-cuenta`, { headers: ecHeaders() });
    const lista = await resp.json();
    if (!Array.isArray(lista) || lista.length === 0) return;

    ecToast(`Conciliando ${lista.length} estado(s) de cuenta...`, 'info');
    for (const ec of lista) {
        await ecConciliar(ec.id);
        await new Promise(r => setTimeout(r, 300));
    }
    ecToast('✅ Conciliación completa en todos los estados', 'success');
}

/* ═══════════════════════════════════════════════════════════════
   DETALLE DE MOVIMIENTOS
   ═══════════════════════════════════════════════════════════════ */
async function ecVerDetalle(ecId) {
    ecCurrentId = ecId;
    const panel = document.getElementById('ec-detalle-panel');
    if (!panel) return;

    panel.style.display = '';
    const tbody = document.getElementById('ec-mov-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;"><i class="fas fa-spinner fa-spin"></i> Cargando...</td></tr>';

    try {
        const resp = await fetch(`${ecApiBase()}/estados-cuenta/${ecId}`, { headers: ecHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);

        // Header del panel
        const header = document.getElementById('ec-detalle-header');
        if (header) header.innerHTML = `
            <i class="fas fa-search-dollar"></i>
            Detalle — ${data.banco} ${data.cuenta ? '····' + String(data.cuenta).slice(-4) : ''}
            <span style="font-size:0.78rem; font-weight:400; color:var(--text-secondary); margin-left:0.5rem;">
                ${fmtFecha(data.periodo_inicio)} al ${fmtFecha(data.periodo_fin)}
            </span>
            <button class="ec-btn-close-detalle" onclick="ecCerrarDetalle()"><i class="fas fa-times"></i></button>`;

        ecMovAll = data.movimientos || [];
        ecTabActual = 'todos';
        ecRenderTablaMovimientos(ecMovAll, data.conciliacion);

        // Scroll al panel
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:#f87171; text-align:center;">${err.message}</td></tr>`;
    }
}

function ecCerrarDetalle() {
    const p = document.getElementById('ec-detalle-panel');
    if (p) p.style.display = 'none';
    ecCurrentId = null;
}

function ecSwitchTab(btn, tab) {
    document.querySelectorAll('.ec-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ecTabActual = tab;

    let movs = ecMovAll;
    if (tab === 'sin-cfdi')    movs = ecMovAll.filter(m => !m.conciliado);
    if (tab === 'conciliados') movs = ecMovAll.filter(m => m.conciliado);

    ecRenderTablaMovimientos(movs, null);
}

function ecRenderTablaMovimientos(movs, concStats) {
    const tbody  = document.getElementById('ec-mov-tbody');
    const footer = document.getElementById('ec-tabla-footer');
    if (!tbody) return;

    if (!movs || movs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:1.5rem; color:var(--text-secondary);">Sin movimientos en esta vista</td></tr>';
        return;
    }

    const rows = movs.map(m => {
        const monto = m.tipo === 'ABONO' ? m.abono : m.cargo;
        const concicls = m.conciliado ? 'ec-mov-conciliado' : 'ec-mov-sin-conciliar';
        const estadoHtml = m.conciliado
            ? `<span class="ec-mov-badge ec-badge-ok" title="${m.nota_conciliacion || ''}">
                ✅ ${m.confianza || ''}%
               </span>`
            : `<span class="ec-mov-badge ec-badge-err">⚠️ Sin CFDI</span>`;

        const cfdiHtml = m.cfdi_uuid
            ? `<span class="ec-uuid-mini" title="${m.cfdi_uuid}">${m.cfdi_uuid.substring(0,8)}…</span>`
            : '—';

        return `
        <tr class="${concicls}">
            <td class="ec-fecha">${fmtFecha(m.fecha)}</td>
            <td class="ec-concepto" title="${m.concepto}">${String(m.concepto || '').substring(0,40)}${(m.concepto || '').length > 40 ? '…' : ''}</td>
            <td class="ec-ref">${m.referencia || '—'}</td>
            <td class="td-r ec-cargo-cell">${m.cargo > 0 ? fmtMXN(m.cargo) : '—'}</td>
            <td class="td-r ec-abono-cell">${m.abono > 0 ? fmtMXN(m.abono) : '—'}</td>
            <td class="td-r" style="color:var(--text-secondary); font-size:0.8rem;">${m.saldo != null ? fmtMXN(m.saldo) : '—'}</td>
            <td>${estadoHtml}</td>
            <td>${cfdiHtml}</td>
        </tr>`;
    }).join('');

    tbody.innerHTML = rows;

    // Footer con estadísticas
    if (footer && concStats) {
        const sinCFDI = parseInt(concStats.abonos_sin_cfdi || 0);
        footer.innerHTML = `
            <div class="ec-footer-stats">
                <span><strong>${movs.length}</strong> movimientos</span>
                <span class="ec-footer-sep">·</span>
                <span style="color:#4ade80;"><strong>${concStats.conciliados}</strong> conciliados</span>
                <span class="ec-footer-sep">·</span>
                <span style="color:${sinCFDI > 0 ? '#f87171' : '#4ade80'};">
                    <strong>${sinCFDI}</strong> abonos sin CFDI
                    ${sinCFDI > 0 ? '(⚠️ ' + fmtMXN(concStats.monto_abonos_sin_cfdi) + ')' : ''}
                </span>
            </div>`;
    }
}

/* ═══════════════════════════════════════════════════════════════
   ELIMINAR ESTADO DE CUENTA
   ═══════════════════════════════════════════════════════════════ */
async function ecEliminar(ecId, banco) {
    if (!confirm(`¿Eliminar el estado de cuenta ${banco}?\n\nSe borrarán todos sus movimientos bancarios. Esta acción no se puede deshacer.`)) return;
    try {
        const resp = await fetch(`${ecApiBase()}/estados-cuenta/${ecId}`, {
            method:  'DELETE',
            headers: ecHeaders(),
        });
        if (!resp.ok) throw new Error((await resp.json()).error || 'Error');
        ecToast(`Estado de cuenta ${banco} eliminado`, 'success');
        if (ecCurrentId === ecId) ecCerrarDetalle();
        await ecLoadDashboard();
    } catch (err) {
        ecToast(`Error al eliminar: ${err.message}`, 'error');
    }
}

/* ═══════════════════════════════════════════════════════════════
   OFFLINE
   ═══════════════════════════════════════════════════════════════ */
function ecShowOffline() {
    const wrap = document.getElementById('ec-lista-wrap');
    if (wrap) wrap.innerHTML = `
        <div class="fiva-loading" style="color:#f87171;">
            <i class="fas fa-wifi-slash"></i> Backend offline — conecta el servidor para usar estados de cuenta
        </div>`;
}

/* ─── Toast helper (reutiliza showToast de main.js si existe) ─ */
function ecToast(msg, type = 'info') {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    console.log(`[EC Toast ${type}]`, msg);
}

/* ═══════════════════════════════════════════════════════════════
   INICIALIZACIÓN
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    // Cargar dashboard cuando se muestra la sección
    const obs = new MutationObserver(() => {
        const sec = document.getElementById('estados-cuenta');
        if (sec && sec.style.display !== 'none') {
            ecLoadDashboard();
        }
    });
    const sec = document.getElementById('estados-cuenta');
    if (sec) obs.observe(sec, { attributes: true, attributeFilter: ['style'] });
});
