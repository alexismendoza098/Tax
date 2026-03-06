// ============================================================
//  Módulo Validación SAT — Frontend
//  Compara Metadata descargada vs CFDIs descargados
// ============================================================

let _valPollingTimer = null;
let _valActualId     = null;

/** Escapa caracteres HTML para prevenir XSS al usar innerHTML */
function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Inicializar sección ──────────────────────────────────────
function valInit() {
    valFillRfc();
    valCargarHistorial();
}

function valFillRfc() {
    const rfc = sessionStorage.getItem('sat_rfc') || window._satRfc || '';
    const el  = document.getElementById('val-rfc');
    if (el && rfc) { el.value = rfc; el.dispatchEvent(new Event('input')); }
}

// ── Iniciar validación ───────────────────────────────────────
async function valIniciar() {
    const rfc    = (document.getElementById('val-rfc')?.value || '').trim().toUpperCase();
    const inicio = document.getElementById('val-inicio')?.value;
    const fin    = document.getElementById('val-fin')?.value;

    if (!rfc || !inicio || !fin)
        return showToast('warning', 'Aviso', 'Completa RFC y periodo');

    valSetEstado('procesando');
    document.getElementById('val-btn-iniciar').disabled = true;

    try {
        const res  = await apiFetch('/validacion/iniciar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rfc, periodo_inicio: inicio, periodo_fin: fin })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al iniciar');

        _valActualId = data.validacion_id;
        showToast('info', 'Validación', 'Validación iniciada, procesando...');
        valPolling(_valActualId);
    } catch (e) {
        showToast('danger', 'Error', e.message);
        valSetEstado('idle');
        document.getElementById('val-btn-iniciar').disabled = false;
    }
}

// ── Polling de estado ────────────────────────────────────────
function valPolling(id) {
    if (_valPollingTimer) clearInterval(_valPollingTimer);
    _valPollingTimer = setInterval(async () => {
        try {
            const res  = await apiFetch(`/validacion/estado/${id}`);
            const data = await res.json();
            if (data.status === 'completo' || data.status === 'error') {
                clearInterval(_valPollingTimer);
                _valPollingTimer = null;
                document.getElementById('val-btn-iniciar').disabled = false;
                valMostrarResultado(data);
                valCargarHistorial();
                if (data.status === 'completo') {
                    valCargarIncongruencias(id);
                    showToast('success', 'Completado', '✅ Validación completada');
                } else {
                    showToast('danger', 'Error', 'Error en validación: ' + data.error_msg);
                }
            } else {
                valSetEstado('procesando');
            }
        } catch (e) {
            clearInterval(_valPollingTimer);
        }
    }, 2500);
}

// ── Mostrar resultado resumen ────────────────────────────────
function valMostrarResultado(v) {
    valSetEstado(v.status);
    const pct = parseFloat(v.completitud_pct || 0);

    // Emitidos
    document.getElementById('val-meta-emi').textContent  = (v.total_metadata_emitidos  || 0).toLocaleString();
    document.getElementById('val-cfdi-emi').textContent  = (v.total_cfdi_emitidos       || 0).toLocaleString();
    document.getElementById('val-falt-emi').textContent  = (v.faltantes_emitidos        || 0).toLocaleString();
    document.getElementById('val-canc-emi').textContent  = (v.cancelados_emitidos       || 0).toLocaleString();
    // Recibidos
    document.getElementById('val-meta-rec').textContent  = (v.total_metadata_recibidos  || 0).toLocaleString();
    document.getElementById('val-cfdi-rec').textContent  = (v.total_cfdi_recibidos      || 0).toLocaleString();
    document.getElementById('val-falt-rec').textContent  = (v.faltantes_recibidos       || 0).toLocaleString();
    document.getElementById('val-canc-rec').textContent  = (v.cancelados_recibidos      || 0).toLocaleString();
    // Barra de completitud
    const bar   = document.getElementById('val-pct-bar');
    const label = document.getElementById('val-pct-label');
    if (bar) {
        bar.style.width      = pct + '%';
        bar.className        = 'progress-bar ' + (pct >= 99 ? 'bg-success' : pct >= 90 ? 'bg-warning' : 'bg-danger');
        bar.setAttribute('aria-valuenow', pct);
    }
    if (label) label.textContent = pct.toFixed(1) + '%';

    document.getElementById('val-resultado-panel').style.display = 'block';
}

// ── Cargar tabla de incongruencias ───────────────────────────
async function valCargarIncongruencias(id, filtroTipo = '', filtroDireccion = '') {
    const tbody = document.getElementById('val-inc-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-3">
        <i class="fas fa-spinner fa-spin"></i> Cargando...</td></tr>`;

    try {
        let url = `/validacion/${id}/incongruencias?`;
        if (filtroTipo)      url += `tipo=${filtroTipo}&`;
        if (filtroDireccion) url += `direccion=${filtroDireccion}&`;

        const res  = await apiFetch(url);
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-success">
                <i class="fas fa-check-circle fa-2x mb-2 d-block"></i>
                Sin incongruencias encontradas ✅</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(inc => {
            const tipoBadge = {
                faltante:   '<span class="badge bg-danger">🔴 Faltante</span>',
                monto:      '<span class="badge bg-warning text-dark">🟡 Monto</span>',
                rfc:        '<span class="badge bg-warning text-dark">🟡 RFC</span>',
                fecha:      '<span class="badge bg-warning text-dark">🟡 Fecha</span>',
                cancelado:  '<span class="badge bg-info text-dark">🔵 Cancelado</span>'
            }[inc.tipo] || inc.tipo;

            const dirBadge = inc.direccion === 'emitido'
                ? '<span class="badge bg-success"><i class="fas fa-arrow-circle-up"></i> Emitido</span>'
                : '<span class="badge bg-primary"><i class="fas fa-arrow-circle-down"></i> Recibido</span>';

            const resuelta = inc.resuelta
                ? '<span class="badge bg-secondary">Resuelta</span>'
                : `<button class="btn btn-xs btn-outline-success" onclick="valResolver(${inc.id})">
                     <i class="fas fa-check"></i> Resolver
                   </button>`;

            return `<tr class="${inc.resuelta ? 'opacity-50' : ''}">
                <td>${tipoBadge}</td>
                <td>${dirBadge}</td>
                <td><code style="font-size:0.72rem">${esc(inc.uuid?.substring(0,18))}…</code></td>
                <td><small>${esc(inc.rfc_emisor) || '—'}</small></td>
                <td><small>${esc(inc.fecha_emision?.substring(0,10)) || '—'}</small></td>
                <td>
                    <small class="text-muted">SAT: </small>${esc(inc.dato_metadata) || '—'}<br>
                    <small class="text-muted">XML: </small>${esc(inc.dato_cfdi) || '—'}
                </td>
                <td>${resuelta}</td>
            </tr>`;
        }).join('');

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error: ${e.message}</td></tr>`;
    }
}

// ── Marcar incongruencia como resuelta ───────────────────────
async function valResolver(incId) {
    const nota = prompt('Nota de resolución (opcional):') ?? '';
    try {
        await apiFetch(`/validacion/incongruencia/${incId}/resolver`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nota })
        });
        showToast('success', 'Resuelto', 'Marcada como resuelta');
        if (_valActualId) valCargarIncongruencias(_valActualId);
    } catch (e) {
        showToast('danger', 'Error', e.message);
    }
}

// ── Historial de validaciones ────────────────────────────────
async function valCargarHistorial() {
    const tbody = document.getElementById('val-hist-tbody');
    if (!tbody) return;

    const rfc = (document.getElementById('val-rfc')?.value || '').trim().toUpperCase();
    const url = rfc ? `/validacion/historial/${rfc}` : '/validacion/historial';

    try {
        const res  = await apiFetch(url);
        const data = await res.json();

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">
                Sin validaciones anteriores</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(v => {
            const statusBadge = {
                completo:    '<span class="badge bg-success">✅ Completo</span>',
                procesando:  '<span class="badge bg-info text-dark"><i class="fas fa-spinner fa-spin"></i> Procesando</span>',
                error:       '<span class="badge bg-danger">❌ Error</span>'
            }[v.status] || v.status;

            const pct     = parseFloat(v.completitud_pct || 0);
            const pctColor = pct >= 99 ? 'success' : pct >= 90 ? 'warning' : 'danger';
            const fecha   = new Date(v.fecha_validacion).toLocaleString('es-MX');
            const totalProb = (v.faltantes_emitidos||0) + (v.faltantes_recibidos||0) +
                              (v.cancelados_emitidos||0) + (v.cancelados_recibidos||0);

            return `<tr style="cursor:pointer" onclick="valVerDetalle(${v.id})">
                <td><code style="font-size:0.75rem">${esc(v.rfc)}</code></td>
                <td><small>${esc(v.periodo_inicio)} → ${esc(v.periodo_fin)}</small></td>
                <td>${esc(fecha)}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="d-flex align-items-center gap-2">
                        <div class="progress flex-grow-1" style="height:8px;min-width:80px">
                            <div class="progress-bar bg-${pctColor}" style="width:${pct}%"></div>
                        </div>
                        <small class="text-${pctColor}">${pct.toFixed(1)}%</small>
                    </div>
                    ${totalProb > 0 ? `<small class="text-danger">${totalProb} problema${totalProb!==1?'s':''}</small>` : ''}
                </td>
                <td>
                    <button class="btn btn-xs btn-outline-primary" onclick="event.stopPropagation();valVerDetalle(${v.id})">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn btn-xs btn-outline-danger ms-1" onclick="event.stopPropagation();valEliminar(${v.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-danger text-center">Error: ${e.message}</td></tr>`;
    }
}

// ── Ver detalle de validación histórica ──────────────────────
async function valVerDetalle(id) {
    try {
        const res  = await apiFetch(`/validacion/estado/${id}`);
        const data = await res.json();
        _valActualId = id;
        valMostrarResultado(data);
        valCargarIncongruencias(id);
        document.getElementById('val-resultado-panel').scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        showToast('danger', 'Error', 'Error al cargar detalle');
    }
}

// ── Eliminar validación ──────────────────────────────────────
async function valEliminar(id) {
    if (!confirm('¿Eliminar esta validación y sus incongruencias?')) return;
    try {
        await apiFetch(`/validacion/${id}`, { method: 'DELETE' });
        showToast('success', 'Eliminado', 'Validación eliminada');
        valCargarHistorial();
        if (_valActualId === id) {
            document.getElementById('val-resultado-panel').style.display = 'none';
            _valActualId = null;
        }
    } catch (e) {
        showToast('danger', 'Error', e.message);
    }
}

// ── Estado visual del proceso ────────────────────────────────
function valSetEstado(estado) {
    const spinner = document.getElementById('val-spinner');
    const idle    = document.getElementById('val-idle-msg');
    if (estado === 'procesando') {
        if (spinner) spinner.style.display = 'flex';
        if (idle)    idle.style.display    = 'none';
    } else {
        if (spinner) spinner.style.display = 'none';
        if (idle)    idle.style.display    = 'block';
    }
}

// ── Filtros de incongruencias ────────────────────────────────
function valFiltrar() {
    if (!_valActualId) return;
    const tipo      = document.getElementById('val-filtro-tipo')?.value      || '';
    const direccion = document.getElementById('val-filtro-dir')?.value || '';
    valCargarIncongruencias(_valActualId, tipo, direccion);
}
