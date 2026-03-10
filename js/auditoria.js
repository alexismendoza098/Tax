/**
 * MÓDULO DE AUDITORÍA FISCAL — ETX Tax Recovery
 * Frontend: Semáforo de Salud Fiscal + Detección de Errores + DIOT
 */

// ─────────────────────────────────────────────────────────────────────
// Estado del módulo
// ─────────────────────────────────────────────────────────────────────
const AuditoriaModule = {
  currentData: null,
  contribuyentes: [],
  selectedContribuyenteId: null,
};

// ─────────────────────────────────────────────────────────────────────
// Helpers de formato
// ─────────────────────────────────────────────────────────────────────
const fmtMXN = (n) => {
  const num = parseFloat(n) || 0;
  return new Intl.NumberFormat('es-MX', {
    style: 'currency', currency: 'MXN', minimumFractionDigits: 2
  }).format(num);
};
const fmtNum = (n) => (parseFloat(n) || 0).toLocaleString('es-MX');
const truncUUID = (uuid) => uuid ? `${uuid.substring(0, 8)}...` : '-';

// ─────────────────────────────────────────────────────────────────────
// INICIALIZACIÓN — se llama cuando se muestra la sección
// ─────────────────────────────────────────────────────────────────────
async function initAuditoria() {
  await loadContribuyentesAudit();
  renderAuditPlaceholder();
}

async function loadContribuyentesAudit() {
  try {
    const token = localStorage.getItem('token');
    if (!token || token === 'offline-token') return;

    const res = await fetch(`${API_URL}/contribuyentes`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;

    const data = await res.json();
    AuditoriaModule.contribuyentes = data;

    const select = document.getElementById('audit-contribuyente');
    if (!select) return;

    // Filtrar GENERIC y contribuyentes sin RFC real
    const reales = data.filter(c => c.rfc && c.rfc !== 'GENERIC' && c.rfc !== 'AAA010101AAA' && c.rfc !== 'BBB020202BBB' && c.rfc !== 'XXX111111XXX');

    select.innerHTML = '<option value="">— Selecciona RFC —</option>';
    reales.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nombre ? `${c.rfc} — ${c.nombre}` : c.rfc;
      select.appendChild(opt);
    });

    // Auto-selección inteligente:
    // 1. Si el usuario logueado tiene RFC asignado, buscar ese contribuyente
    // 2. Si solo hay uno real, seleccionarlo directamente
    const userRfc = (typeof currentUser !== 'undefined' && currentUser?.rfc) || null;
    let autoSelect = null;

    if (userRfc) {
      autoSelect = reales.find(c => c.rfc === userRfc);
    }
    if (!autoSelect && reales.length === 1) {
      autoSelect = reales[0];
    }

    if (autoSelect) {
      select.value = autoSelect.id;
      AuditoriaModule.selectedContribuyenteId = autoSelect.id;
    }
  } catch (err) {
    console.error('[AUDITORIA] Error cargando contribuyentes:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────
// EJECUTAR AUDITORÍA
// ─────────────────────────────────────────────────────────────────────
async function runAuditoria() {
  const contribuyente_id = document.getElementById('audit-contribuyente')?.value;
  const year  = document.getElementById('audit-year')?.value;
  const mes   = document.getElementById('audit-mes')?.value;

  if (!contribuyente_id) {
    showToast('warning', 'Selecciona un RFC', 'Elige el contribuyente a auditar');
    return;
  }

  AuditoriaModule.selectedContribuyenteId = contribuyente_id;

  renderAuditLoading();

  try {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams({ contribuyente_id });
    if (year) params.append('year', year);
    if (mes)  params.append('mes', mes);

    const res = await fetch(`${API_URL}/auditoria/salud?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error ${res.status}`);
    }

    const data = await res.json();
    AuditoriaModule.currentData = data;
    renderAuditResults(data);

  } catch (err) {
    console.error('[AUDITORIA] Error:', err);
    showToast('error', 'Error en Auditoría', err.message);
    renderAuditPlaceholder(`Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: PLACEHOLDER INICIAL
// ─────────────────────────────────────────────────────────────────────
function renderAuditPlaceholder(msg = null) {
  const container = document.getElementById('audit-results');
  if (!container) return;
  container.innerHTML = `
    <div class="audit-placeholder">
      <div class="audit-placeholder-icon"><i class="fas fa-search-dollar"></i></div>
      <h3>${msg || 'Selecciona un RFC y ejecuta la auditoría'}</h3>
      <p>El motor analizará 7 tipos de errores fiscales en tus CFDIs y calculará el IVA correcto</p>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: CARGANDO
// ─────────────────────────────────────────────────────────────────────
function renderAuditLoading() {
  const container = document.getElementById('audit-results');
  if (!container) return;
  container.innerHTML = `
    <div class="audit-loading">
      <div class="audit-spinner"></div>
      <span>Analizando CFDIs... Ejecutando 7 detecciones fiscales</span>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: RESULTADOS COMPLETOS
// ─────────────────────────────────────────────────────────────────────
function renderAuditResults(data) {
  const container = document.getElementById('audit-results');
  if (!container) return;

  const { score, nivel, color, resumen, errores, meta } = data;

  // Descripción del nivel
  const nivelesDesc = {
    EXCELENTE: 'Tus CFDIs están en orden. La declaración puede proceder con confianza.',
    BUENO:     'Hay advertencias menores. Revísalas antes de declarar.',
    ATENCIÓN:  'Se detectaron problemas importantes. Corrígelos para evitar observaciones del SAT.',
    CRÍTICO:   'Errores graves detectados. El IVA calculado podría estar incorrecto.'
  };

  // Contar errores totales
  const totalCriticos = errores.criticos.reduce((s, e) => s + e.count, 0);
  const totalAdvertencias = errores.advertencias.reduce((s, e) => s + e.count, 0);

  const periodoLabel = meta.mes
    ? `${['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][parseInt(meta.mes)]} ${meta.year}`
    : meta.year ? `Año ${meta.year}` : 'Todo el período';

  // Determinar color del balance IVA
  const balanceClass = resumen.iva_balance < 0 ? 'positive' : resumen.iva_balance > 0 ? 'negative' : '';
  const balanceLabel = resumen.iva_balance < 0 ? 'A Favor' : resumen.iva_balance > 0 ? 'A Pagar' : 'Neutro';

  container.innerHTML = `
    <!-- SCORE CARD -->
    <div class="audit-score-card score-${color}">
      <div class="score-circle">
        <span class="score-num">${score}</span>
        <span class="score-label">/ 100</span>
      </div>
      <div class="score-info">
        <div class="score-nivel">${nivel}</div>
        <div class="score-desc">${nivelesDesc[nivel] || ''}</div>
        <div class="score-meta">
          <span><i class="fas fa-user"></i> ${meta.rfc} — ${meta.nombre}</span>
          <span><i class="fas fa-calendar"></i> ${periodoLabel}</span>
          <span><i class="fas fa-file-invoice"></i> ${fmtNum(resumen.total_cfdi)} CFDIs</span>
        </div>
      </div>
      <div class="score-stats">
        <div class="score-stat-item">
          <span class="ss-label">🔴 Críticos</span>
          <span class="ss-value ${totalCriticos > 0 ? 'danger' : 'success'}">${totalCriticos}</span>
        </div>
        <div class="score-stat-item">
          <span class="ss-label">🟡 Advertencias</span>
          <span class="ss-value ${totalAdvertencias > 0 ? 'warning' : 'success'}">${totalAdvertencias}</span>
        </div>
        <div class="score-stat-item">
          <span class="ss-label">IVA en Riesgo</span>
          <span class="ss-value ${resumen.iva_en_riesgo > 0 ? 'danger' : 'success'}">${fmtMXN(resumen.iva_en_riesgo)}</span>
        </div>
        <div class="score-stat-item">
          <span class="ss-label">Nóminas</span>
          <span class="ss-value info">${fmtNum(resumen.nominas)}</span>
        </div>
      </div>
    </div>

    <!-- IVA GRID -->
    <div class="audit-iva-grid">
      <div class="audit-iva-card iva-traslado">
        <div class="iva-card-label"><i class="fas fa-arrow-up"></i> IVA Trasladado (Ventas)</div>
        <div class="iva-card-amount">${fmtMXN(resumen.iva_trasladado_bruto)}</div>
        <div class="iva-card-sub">${fmtNum(resumen.emitidos)} CFDIs emitidos</div>
      </div>
      <div class="audit-iva-card iva-acreditable">
        <div class="iva-card-label"><i class="fas fa-arrow-down"></i> IVA Acreditable (Compras)</div>
        <div class="iva-card-amount">${fmtMXN(resumen.iva_acreditable_real)}</div>
        <div class="iva-card-sub">Bruto: ${fmtMXN(resumen.iva_acreditable_bruto)} · Corregido por errores</div>
      </div>
      <div class="audit-iva-card iva-riesgo">
        <div class="iva-card-label"><i class="fas fa-exclamation-triangle"></i> IVA en Riesgo / Errores</div>
        <div class="iva-card-amount ${resumen.iva_en_riesgo > 0 ? 'negative' : ''}">${fmtMXN(resumen.iva_en_riesgo)}</div>
        <div class="iva-card-sub">IVA que podría ser objetado por el SAT</div>
      </div>
      <div class="audit-iva-card iva-balance">
        <div class="iva-card-label"><i class="fas fa-balance-scale"></i> Balance IVA — ${balanceLabel}</div>
        <div class="iva-card-amount ${balanceClass}">${fmtMXN(Math.abs(resumen.iva_balance))}</div>
        <div class="iva-card-sub">Trasladado − Acreditable real</div>
      </div>
    </div>

    <!-- ACCIONES: DIOT Y PPD -->
    <div class="audit-actions-bar">
      <h4><i class="fas fa-download"></i> Exportar</h4>
      <button class="btn btn-primary" onclick="downloadDIOT()" style="font-size:0.85rem;">
        <i class="fas fa-file-alt"></i> Generar DIOT .txt
      </button>
      <button class="btn" onclick="downloadIVAPPD()" style="font-size:0.85rem; background:rgba(99,102,241,0.2); color:#a5b4fc; border:1px solid rgba(99,102,241,0.3);">
        <i class="fas fa-calculator"></i> IVA PPD Correcto (Excel-CSV)
      </button>
    </div>

    <!-- ERRORES CRÍTICOS -->
    <div class="audit-errors-section">
      <div class="audit-errors-title">
        <i class="fas fa-times-circle" style="color:#ef4444;"></i>
        Errores Críticos — Bloquean la Declaración
      </div>
      ${errores.criticos.map(e => renderErrorCard(e)).join('')}
    </div>

    <!-- ADVERTENCIAS -->
    <div class="audit-errors-section">
      <div class="audit-errors-title">
        <i class="fas fa-exclamation-triangle" style="color:#eab308;"></i>
        Advertencias — Revisar con Contador
      </div>
      ${errores.advertencias.map(e => renderErrorCard(e)).join('')}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: TARJETA DE ERROR EXPANDIBLE
// ─────────────────────────────────────────────────────────────────────
function renderErrorCard(error) {
  const sinErrores = error.count === 0;
  const cardClass = sinErrores ? 'sin-errores' : `severidad-${error.severidad}`;
  const iconClass = sinErrores ? 'fa-check-circle' : (error.severidad === 'critico' ? 'fa-times-circle' : 'fa-exclamation-triangle');
  const badgeClass = sinErrores ? 'badge-count-ok' : (error.severidad === 'critico' ? 'badge-count-critico' : 'badge-count-advertencia');

  let tablaHTML = '';
  if (!sinErrores && error.datos && error.datos.length > 0) {
    tablaHTML = renderErrorTable(error);
  }

  const ivaHTML = error.impacto_iva > 0
    ? `<span class="audit-badge badge-iva">IVA: ${fmtMXN(error.impacto_iva)}</span>`
    : '';

  return `
    <div class="audit-error-card ${cardClass}" id="card-${error.id}">
      <div class="audit-error-header" onclick="toggleErrorCard('${error.id}')">
        <div class="audit-error-icon"><i class="fas ${iconClass}"></i></div>
        <div class="audit-error-title-wrap">
          <div class="audit-error-title">${error.titulo}</div>
          <div class="audit-error-desc">${error.descripcion}</div>
        </div>
        <div class="audit-error-badges">
          <span class="audit-badge ${badgeClass}">${sinErrores ? '✓ Sin errores' : `${error.count} encontrado${error.count !== 1 ? 's' : ''}`}</span>
          ${ivaHTML}
        </div>
        ${sinErrores ? '' : '<i class="fas fa-chevron-down audit-error-toggle"></i>'}
      </div>
      ${sinErrores ? '' : `
        <div class="audit-error-body">
          <div class="audit-error-accion">
            <i class="fas fa-lightbulb"></i>
            <span><strong>Acción recomendada:</strong> ${error.accion}</span>
          </div>
          ${tablaHTML}
        </div>
      `}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: TABLAS ESPECÍFICAS POR TIPO DE ERROR
// ─────────────────────────────────────────────────────────────────────
function renderErrorTable(error) {
  const MAX_ROWS = 10;
  const rows = error.datos.slice(0, MAX_ROWS);
  const extraRows = error.datos.length - MAX_ROWS;

  switch (error.id) {
    case 'uuid_duplicado':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>UUID</th><th>Emisor</th><th>Tipo</th>
            <th>Veces</th><th>Total</th><th>IVA Inflado</th><th>Acción</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid}">${truncUUID(r.uuid)}</td>
              <td>${r.nombre_emisor || r.rfc_emisor || '-'}</td>
              <td>${r.tipo || '-'}</td>
              <td style="text-align:center;">${r.veces}</td>
              <td class="td-ok">${fmtMXN(r.total)}</td>
              <td class="td-monto">${fmtMXN(r.monto_duplicado * 0.16)}</td>
              <td><button class="audit-btn-fix" onclick="fixDuplicado('${r.uuid}')"><i class="fas fa-trash-alt"></i> Eliminar duplicado</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    case 'ppd_sin_complemento':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>UUID</th><th>Fecha</th><th>Emisor</th>
            <th>Total</th><th>IVA en Riesgo</th><th>Días sin pago</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid}">${truncUUID(r.uuid)}</td>
              <td>${r.fecha ? r.fecha.substring(0,10) : '-'}</td>
              <td>${r.nombre_emisor || r.rfc_emisor || '-'}</td>
              <td>${fmtMXN(r.total)}</td>
              <td class="td-monto">${fmtMXN(r.iva_en_riesgo)}</td>
              <td style="color:${r.dias_sin_pago > 90 ? '#ef4444' : '#eab308'}">${r.dias_sin_pago} días</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    case 'complemento_excede_factura':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>Factura UUID</th><th>Emisor</th><th>Total Factura</th>
            <th>Total Pagado</th><th>Excedente</th><th>Pagos</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid_factura}">${truncUUID(r.uuid_factura)}</td>
              <td>${r.nombre_emisor || r.rfc_emisor || '-'}</td>
              <td>${fmtMXN(r.total_factura)}</td>
              <td>${fmtMXN(r.total_pagado_acumulado)}</td>
              <td class="td-monto">${fmtMXN(r.excedente)}</td>
              <td style="text-align:center;">${r.num_pagos}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    case 'descuadre_matematico':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>UUID</th><th>Fecha</th><th>Emisor</th>
            <th>Subtotal</th><th>IVA</th><th>Total</th><th>Diferencia</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid}">${truncUUID(r.uuid)}</td>
              <td>${r.fecha ? r.fecha.substring(0,10) : '-'}</td>
              <td>${r.nombre_emisor || r.rfc_emisor || '-'}</td>
              <td>${fmtMXN(r.subtotal)}</td>
              <td>${fmtMXN(r.iva)}</td>
              <td>${fmtMXN(r.total)}</td>
              <td class="td-monto">${fmtMXN(r.diferencia)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    case 'nota_credito_sin_relacionada':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>UUID</th><th>Fecha</th><th>Emisor</th><th>Total</th><th>IVA Afectado</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid}">${truncUUID(r.uuid)}</td>
              <td>${r.fecha ? r.fecha.substring(0,10) : '-'}</td>
              <td>${r.nombre_emisor || r.rfc_emisor || '-'}</td>
              <td>${fmtMXN(r.total)}</td>
              <td class="td-monto">${fmtMXN(r.iva_afectado)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    case 'nomina_isr_invalido':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>UUID</th><th>Fecha</th><th>Empleado</th>
            <th>Monto Nómina</th><th>ISR Retenido</th><th>% ISR</th><th>Diagnóstico</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid}">${truncUUID(r.uuid)}</td>
              <td>${r.fecha ? r.fecha.substring(0,10) : '-'}</td>
              <td>${r.empleado_nombre || r.empleado_rfc || '-'}</td>
              <td>${fmtMXN(r.monto_nomina)}</td>
              <td class="td-monto">${fmtMXN(r.isr_retenido)}</td>
              <td>${r.pct_isr}%</td>
              <td>
                <span style="color:${r.diagnostico === 'SIN_ISR' ? '#eab308' : '#ef4444'};font-size:0.75rem;">
                  ${r.diagnostico === 'SIN_ISR' ? 'Sin ISR' : r.diagnostico === 'ISR_NEGATIVO' ? 'ISR Negativo' : 'ISR > 35%'}
                </span>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    case 'complemento_huerfano':
      return `
        <table class="audit-mini-table">
          <thead><tr>
            <th>UUID Complemento</th><th>Fecha Pago</th>
            <th>UUID Factura Faltante</th><th>Monto Pagado</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="td-uuid" title="${r.uuid_pago}">${truncUUID(r.uuid_pago)}</td>
              <td>${r.fecha_pago ? r.fecha_pago.substring(0,10) : '-'}</td>
              <td class="td-uuid" style="color:#f87171;" title="${r.uuid_factura_faltante}">${truncUUID(r.uuid_factura_faltante)}</td>
              <td>${fmtMXN(r.imp_pagado)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${extraRows > 0 ? `<div class="audit-more-rows">+ ${extraRows} más...</div>` : ''}`;

    default:
      return '<p style="color:var(--text-secondary);font-size:0.85rem;">Sin datos disponibles</p>';
  }
}

// ─────────────────────────────────────────────────────────────────────
// INTERACCIONES
// ─────────────────────────────────────────────────────────────────────
function toggleErrorCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  card.classList.toggle('open');
}

// ─────────────────────────────────────────────────────────────────────
// ACCIÓN: Eliminar duplicado
// ─────────────────────────────────────────────────────────────────────
async function fixDuplicado(uuid) {
  if (!AuditoriaModule.selectedContribuyenteId) return;

  const confirmed = confirm(`¿Eliminar el UUID duplicado?\n\n${uuid}\n\nSe conservará el primer registro importado y se eliminarán los extras.`);
  if (!confirmed) return;

  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/auditoria/duplicados/${uuid}?contribuyente_id=${AuditoriaModule.selectedContribuyenteId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (res.ok) {
      showToast('success', 'Duplicado eliminado', data.message);
      // Reejecutar auditoría para actualizar resultados
      setTimeout(runAuditoria, 800);
    } else {
      showToast('error', 'Error', data.error || 'No se pudo eliminar');
    }
  } catch (err) {
    showToast('error', 'Error de conexión', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// ACCIÓN: Descargar DIOT
// ─────────────────────────────────────────────────────────────────────
async function downloadDIOT() {
  const contribuyente_id = AuditoriaModule.selectedContribuyenteId
    || document.getElementById('audit-contribuyente')?.value;
  const year  = document.getElementById('audit-year')?.value;
  const mes   = document.getElementById('audit-mes')?.value;

  if (!contribuyente_id) {
    showToast('warning', 'Selecciona un RFC', 'Necesitas seleccionar el contribuyente');
    return;
  }
  if (!year || !mes) {
    showToast('warning', 'Período requerido', 'La DIOT requiere año y mes específicos');
    return;
  }

  try {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams({ contribuyente_id, year, mes });
    const res = await fetch(`${API_URL}/auditoria/diot?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1]
      || `DIOT_${year}_${String(mes).padStart(2,'0')}.txt`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast('success', 'DIOT Generada', `Archivo ${filename} descargado`);
  } catch (err) {
    showToast('error', 'Error generando DIOT', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// ACCIÓN: Descargar IVA PPD Correcto como CSV
// ─────────────────────────────────────────────────────────────────────
async function downloadIVAPPD() {
  const contribuyente_id = AuditoriaModule.selectedContribuyenteId
    || document.getElementById('audit-contribuyente')?.value;
  const year  = document.getElementById('audit-year')?.value;
  const mes   = document.getElementById('audit-mes')?.value;

  if (!contribuyente_id) {
    showToast('warning', 'Selecciona un RFC', '');
    return;
  }

  try {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams({ contribuyente_id });
    if (year) params.append('year', year);
    if (mes)  params.append('mes', mes);

    const res = await fetch(`${API_URL}/auditoria/iva-ppd-correcto?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    // Generar CSV
    const headers = ['UUID','Fecha','Emisor','Total Factura','IVA Original','Total Pagado','Complementos','IVA Correcto','IVA Pendiente'];
    const csvRows = [headers.join(',')];

    data.facturas.forEach(r => {
      csvRows.push([
        `"${r.uuid}"`,
        r.fecha_factura ? r.fecha_factura.substring(0,10) : '',
        `"${(r.nombre_emisor || r.rfc_emisor || '').replace(/"/g,'""')}"`,
        (r.total_factura || 0).toFixed(2),
        (r.iva_original || 0).toFixed(2),
        (r.total_pagado || 0).toFixed(2),
        r.num_complementos || 0,
        (r.iva_acreditable_correcto || 0).toFixed(2),
        (r.iva_pendiente || 0).toFixed(2),
      ].join(','));
    });

    // Agregar totales
    csvRows.push('');
    csvRows.push(`TOTALES,,,,${data.totales.iva_original.toFixed(2)},,,"${data.totales.iva_correcto.toFixed(2)}","${data.totales.iva_pendiente.toFixed(2)}"`);
    csvRows.push(`DIFERENCIA IVA,,,,,,,${data.diferencia_iva.toFixed(2)},`);

    const csvContent = '\uFEFF' + csvRows.join('\n'); // BOM para Excel
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `IVA_PPD_Correcto_${year || 'all'}_${mes || 'all'}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showToast('success', 'CSV Descargado', `${data.facturas.length} facturas PPD. Diferencia IVA: ${fmtMXN(data.diferencia_iva)}`);
  } catch (err) {
    showToast('error', 'Error', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: Llenar años en select
// ─────────────────────────────────────────────────────────────────────
function fillAuditYears() {
  const sel = document.getElementById('audit-year');
  if (!sel) return;
  const currentYear = new Date().getFullYear();
  sel.innerHTML = '<option value="">Todos los años</option>';
  for (let y = currentYear; y >= 2017; y--) {
    sel.innerHTML += `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`;
  }
}

// Inicializar años al cargar
document.addEventListener('DOMContentLoaded', fillAuditYears);

// ═════════════════════════════════════════════════════════════════════
// TABS — alternancia entre Salud Fiscal y Libro Mayor Fiscal
// ═════════════════════════════════════════════════════════════════════
function showAuditTab(tab) {
  document.querySelectorAll('.audit-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.audit-tab-panel').forEach(p => p.classList.remove('active'));
  const btn   = document.getElementById(`tab-btn-${tab}`);
  const panel = document.getElementById(`audit-panel-${tab}`);
  if (btn)   btn.classList.add('active');
  if (panel) panel.classList.add('active');

  // Filtros compartidos (RFC / Año / Mes) solo aplican en Salud Fiscal y Libro Mayor
  const filtrosDiv = document.querySelector('.audit-filters');
  if (filtrosDiv) {
    filtrosDiv.style.display = (tab === 'salud' || tab === 'libro-mayor') ? '' : 'none';
  }
}

// ═════════════════════════════════════════════════════════════════════
// MÓDULO LIBRO MAYOR FISCAL
// Tabla dinámica: cada CFDI con la regla IVA que se le aplica
// ═════════════════════════════════════════════════════════════════════

const LibroMayorModule = {
  currentData:  null,
  reglaLabels:  null,
  groupedByRfc: {},
};

// Etiquetas y colores por regla IVA
const REGLA_INFO = {
  PUE:           { label: 'PUE — Pago en una sola exhibición',    color: '#22c55e', icon: 'fa-check-circle' },
  PPD_LIQUIDADO: { label: 'PPD — Liquidado (≥ 99%)',              color: '#4ade80', icon: 'fa-check-double' },
  PPD_PARCIAL:   { label: 'PPD — Parcialmente pagado',            color: '#f59e0b', icon: 'fa-clock' },
  PPD_PENDIENTE: { label: 'PPD — Sin complemento de pago',        color: '#ef4444', icon: 'fa-exclamation-circle' },
  NOTA_CREDITO:  { label: 'Nota de Crédito (resta IVA)',          color: '#a78bfa', icon: 'fa-minus-circle' },
  CANCELADO:     { label: 'Cancelado (IVA = 0)',                   color: '#6b7280', icon: 'fa-ban' },
  NOMINA:        { label: 'Nómina',                                color: '#60a5fa', icon: 'fa-users' },
  COMP_PAGO:     { label: 'Complemento de Pago',                  color: '#34d399', icon: 'fa-receipt' },
  TRASLADO:      { label: 'Traslado (exento)',                     color: '#94a3b8', icon: 'fa-truck' },
  OTRO:          { label: 'Otro tipo',                             color: '#94a3b8', icon: 'fa-file-invoice' },
};

// ─────────────────────────────────────────────────────────────────────
// CARGAR Libro Mayor desde API
// ─────────────────────────────────────────────────────────────────────
async function runLibroMayor() {
  const contribuyente_id = document.getElementById('audit-contribuyente')?.value;
  const year = document.getElementById('audit-year')?.value;
  const mes  = document.getElementById('audit-mes')?.value;

  if (!contribuyente_id) {
    showToast('warning', 'Selecciona un RFC', 'Elige el contribuyente para cargar el Libro Mayor');
    return;
  }

  // Loading state
  const container = document.getElementById('libro-mayor-container');
  if (container) {
    container.innerHTML = `
      <div class="audit-loading">
        <div class="audit-spinner"></div>
        <span>Cargando Libro Mayor Fiscal... Calculando reglas IVA por CFDI</span>
      </div>`;
  }

  try {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams({ contribuyente_id });
    if (year) params.append('year', year);
    if (mes)  params.append('mes', mes);

    const res = await fetch(`${API_URL}/auditoria/libro-mayor?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || err.error || `Error ${res.status}`);
    }

    const data = await res.json();
    LibroMayorModule.currentData = data;
    LibroMayorModule.reglaLabels = REGLA_INFO;
    renderLibroMayor(data);

  } catch (err) {
    console.error('[LIBRO MAYOR] Error:', err);
    showToast('error', 'Error en Libro Mayor', err.message);
    if (container) {
      container.innerHTML = `
        <div class="audit-placeholder">
          <div class="audit-placeholder-icon"><i class="fas fa-exclamation-triangle" style="color:#ef4444;"></i></div>
          <h3>Error: ${err.message}</h3>
          <p>Verifica la conexión con el servidor y vuelve a intentarlo</p>
        </div>`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: Libro Mayor completo
// ─────────────────────────────────────────────────────────────────────
function renderLibroMayor(data) {
  const container = document.getElementById('libro-mayor-container');
  if (!container) return;

  const { cfdi, summary, totales, meta } = data;

  // Mostrar botón de exportar
  const exportBtn = document.getElementById('btn-export-libro-mayor');
  if (exportBtn) exportBtn.style.display = '';

  // Agrupar por RFC emisor
  const grupos = agruparPorRfc(cfdi);

  // Etiqueta de período
  const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
                  'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const periodoLabel = meta.mes
    ? `${MESES[parseInt(meta.mes)]} ${meta.year}`
    : (meta.year ? `Año ${meta.year}` : 'Todo el período');

  const diferenciaSig = totales.diferencia > 0.01;

  container.innerHTML = `
    <!-- ENCABEZADO TOTALES -->
    <div class="lm-header">
      <div class="lm-title-wrap">
        <h3 class="lm-title"><i class="fas fa-table"></i> Libro Mayor Fiscal</h3>
        <p class="lm-subtitle">
          ${meta.rfc} — ${meta.nombre} &nbsp;·&nbsp; ${periodoLabel}
          &nbsp;·&nbsp; ${fmtNum(totales.total_cfdi)} CFDIs
        </p>
      </div>
      <div class="lm-totals-pill">
        <span>IVA en CFDI: <strong>${fmtMXN(totales.iva_cfdi)}</strong></span>
        <span class="lm-arrow">→</span>
        <span>IVA Real Acreditable:
          <strong style="color:${diferenciaSig ? '#ef4444' : '#22c55e'}">
            ${fmtMXN(totales.iva_real)}
          </strong>
        </span>
        ${diferenciaSig ? `<span class="lm-diff-badge">Δ ${fmtMXN(totales.diferencia)}</span>` : ''}
      </div>
    </div>

    <!-- RESUMEN POR REGLA IVA (pills clicables) -->
    <div class="lm-regla-summary">
      ${Object.entries(summary).map(([key, s]) => {
        const info = REGLA_INFO[key] || { label: key, color: '#94a3b8', icon: 'fa-file' };
        const dif = Math.abs(s.iva_cfdi - s.iva_real);
        return `
          <div class="lm-regla-pill" style="border-left:3px solid ${info.color};"
               onclick="filterLibroMayorByRegla('${key}')" title="Filtrar por ${info.label}">
            <i class="fas ${info.icon}" style="color:${info.color};font-size:1.1rem;"></i>
            <div class="lm-pill-content">
              <div class="lm-pill-label">${info.label}</div>
              <div class="lm-pill-stats">
                <span>${s.count} CFDIs</span>
                <span style="color:${info.color}; font-weight:600;">IVA Real: ${fmtMXN(s.iva_real)}</span>
                ${dif > 0.01 ? `<span class="lm-pill-dif">Δ ${fmtMXN(dif)}</span>` : ''}
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>

    <!-- BARRA DE FILTROS / BÚSQUEDA -->
    <div class="lm-toolbar">
      <input type="text" class="form-input" id="lm-search"
             placeholder="🔍 RFC o nombre emisor..."
             oninput="filterLibroMayor()" style="flex:1; min-width:180px; max-width:300px;">
      <select class="form-input" id="lm-filter-tipo" onchange="filterLibroMayor()" style="width:auto; min-width:160px;">
        <option value="">Todos los tipos</option>
        <option value="I">I — Ingreso</option>
        <option value="E">E — Nota Crédito</option>
        <option value="P">P — Complemento Pago</option>
        <option value="N">N — Nómina</option>
        <option value="T">T — Traslado</option>
      </select>
      <select class="form-input" id="lm-filter-regla" onchange="filterLibroMayor()" style="width:auto; min-width:200px;">
        <option value="">Todas las reglas IVA</option>
        ${Object.entries(REGLA_INFO).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
      </select>
      <button class="btn lm-btn-sm" onclick="toggleAllLibroMayorGroups(true)">
        <i class="fas fa-expand-alt"></i> Expandir
      </button>
      <button class="btn lm-btn-sm" onclick="toggleAllLibroMayorGroups(false)">
        <i class="fas fa-compress-alt"></i> Colapsar
      </button>
    </div>

    <!-- TABLA AGRUPADA -->
    <div id="lm-table-container">
      ${renderLibroMayorGroups(Object.values(grupos))}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: Grupos por RFC emisor
// ─────────────────────────────────────────────────────────────────────
function agruparPorRfc(cfdi) {
  const grupos = {};
  for (const r of cfdi) {
    const key = r.rfc_emisor || 'SIN_RFC';
    if (!grupos[key]) grupos[key] = { rfc: key, nombre: r.nombre_emisor || key, rows: [] };
    grupos[key].rows.push(r);
  }
  return grupos;
}

function renderLibroMayorGroups(gruposList) {
  if (!gruposList || gruposList.length === 0) {
    return `
      <div class="audit-placeholder">
        <div class="audit-placeholder-icon"><i class="fas fa-inbox"></i></div>
        <h3>Sin resultados para el filtro aplicado</h3>
      </div>`;
  }

  return gruposList.map(grupo => {
    const safeId  = `lm-grp-${grupo.rfc.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const ivaReal = grupo.rows.reduce((s, r) => s + (parseFloat(r.iva_real)  || 0), 0);
    const ivaCfdi = grupo.rows.reduce((s, r) => s + (parseFloat(r.iva_cfdi)  || 0), 0);
    const total   = grupo.rows.reduce((s, r) => s + (parseFloat(r.total)     || 0), 0);
    const subtot  = grupo.rows.reduce((s, r) => s + (parseFloat(r.subtotal)  || 0), 0);
    const pagado  = grupo.rows.reduce((s, r) => s + (parseFloat(r.total_pagado) || 0), 0);
    const dif     = Math.abs(ivaCfdi - ivaReal) > 0.01;

    return `
      <div class="lm-group" id="${safeId}-wrapper">
        <div class="lm-group-header" onclick="toggleLmGroup('${safeId}')">
          <i class="fas fa-chevron-right lm-chevron" id="${safeId}-icon"></i>
          <div class="lm-group-rfc">${grupo.rfc}</div>
          <div class="lm-group-nombre">${grupo.nombre}</div>
          <div class="lm-group-stats">
            <span class="lm-stat-chip">${grupo.rows.length} CFDIs</span>
            <span class="lm-stat-chip">Total: ${fmtMXN(total)}</span>
            <span class="lm-stat-chip">IVA CFDI: ${fmtMXN(ivaCfdi)}</span>
            <span class="lm-stat-chip ${dif ? 'chip-warn' : 'chip-ok'}">
              IVA Real: ${fmtMXN(ivaReal)}
            </span>
          </div>
        </div>
        <div class="lm-group-body" id="${safeId}" style="display:none;">
          <div style="overflow-x:auto;">
            <table class="lm-table">
              <thead>
                <tr>
                  <th>Fecha</th><th>UUID</th><th>Tipo</th><th>Método</th>
                  <th>Estado</th><th class="th-num">Subtotal</th>
                  <th class="th-num">IVA CFDI</th><th class="th-num">Total</th>
                  <th class="th-num">Pagado</th><th class="th-num">IVA Real</th>
                  <th>Regla IVA</th><th>Mon.</th>
                </tr>
              </thead>
              <tbody>
                ${grupo.rows.map(r => renderLmRow(r)).join('')}
              </tbody>
              <tfoot>
                <tr class="lm-subtotal-row">
                  <td colspan="5" style="text-align:right; font-weight:600; padding-right:1rem;">
                    SUBTOTAL ${grupo.rfc}
                  </td>
                  <td class="td-num">${fmtMXN(subtot)}</td>
                  <td class="td-num">${fmtMXN(ivaCfdi)}</td>
                  <td class="td-num">${fmtMXN(total)}</td>
                  <td class="td-num">${fmtMXN(pagado)}</td>
                  <td class="td-num ${dif ? 'td-diferencia' : 'td-ok'}">${fmtMXN(ivaReal)}</td>
                  <td colspan="2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────
// RENDER: Fila individual
// ─────────────────────────────────────────────────────────────────────
function renderLmRow(r) {
  const info      = REGLA_INFO[r.regla_iva] || { label: r.regla_iva, color: '#94a3b8' };
  const ivaReal   = parseFloat(r.iva_real) || 0;
  const ivaCfdi   = parseFloat(r.iva_cfdi) || 0;
  const dif       = Math.abs(ivaCfdi - ivaReal) > 0.01;
  const cancelado = r.estado === 'Cancelado';
  const extraMon  = r.moneda && r.moneda !== 'MXN';

  return `
    <tr class="${cancelado ? 'lm-row-cancelado' : ''}">
      <td class="td-fecha">${r.fecha ? r.fecha.substring(0,10) : '—'}</td>
      <td class="td-uuid" title="${r.uuid}">${truncUUID(r.uuid)}</td>
      <td><span class="lm-tipo tipo-${r.tipo || 'X'}">${r.tipo || '?'}</span></td>
      <td class="td-metodo">${r.metodo_pago || '—'}</td>
      <td class="${cancelado ? 'td-cancelado' : 'td-vigente'}">${cancelado ? 'Cancelado' : (r.estado || 'Vigente')}</td>
      <td class="td-num">${fmtMXN(r.subtotal)}</td>
      <td class="td-num">${fmtMXN(r.iva_cfdi)}</td>
      <td class="td-num">${fmtMXN(r.total)}</td>
      <td class="td-num">
        ${parseFloat(r.num_complementos) > 0
          ? fmtMXN(r.total_pagado)
          : '<span style="color:var(--text-secondary)">—</span>'}
      </td>
      <td class="td-num ${dif ? 'td-diferencia' : (ivaReal < 0 ? 'td-negativo' : 'td-ok')}">
        ${fmtMXN(ivaReal)}
      </td>
      <td>
        <span class="lm-regla-badge" style="border-color:${info.color}; color:${info.color};"
              title="${info.label}">
          ${r.regla_iva}
        </span>
      </td>
      <td class="${extraMon ? 'td-moneda-ext' : 'td-moneda'}">${r.moneda || 'MXN'}</td>
    </tr>`;
}

// ─────────────────────────────────────────────────────────────────────
// INTERACCIONES: Colapsar/expandir grupos
// ─────────────────────────────────────────────────────────────────────
function toggleLmGroup(id) {
  const body = document.getElementById(id);
  const icon = document.getElementById(`${id}-icon`);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (icon) icon.style.transform = open ? '' : 'rotate(90deg)';
}

function toggleAllLibroMayorGroups(expand) {
  document.querySelectorAll('.lm-group-body').forEach(b => {
    b.style.display = expand ? 'block' : 'none';
  });
  document.querySelectorAll('.lm-chevron').forEach(i => {
    i.style.transform = expand ? 'rotate(90deg)' : '';
  });
}

// ─────────────────────────────────────────────────────────────────────
// FILTRAR tabla (búsqueda + dropdowns)
// ─────────────────────────────────────────────────────────────────────
function filterLibroMayor() {
  const data = LibroMayorModule.currentData;
  if (!data) return;

  const search      = (document.getElementById('lm-search')?.value || '').toLowerCase();
  const filterTipo  = document.getElementById('lm-filter-tipo')?.value  || '';
  const filterRegla = document.getElementById('lm-filter-regla')?.value || '';

  const filtered = data.cfdi.filter(r => {
    const matchSearch = !search
      || (r.rfc_emisor   || '').toLowerCase().includes(search)
      || (r.nombre_emisor || '').toLowerCase().includes(search);
    const matchTipo  = !filterTipo  || r.tipo      === filterTipo;
    const matchRegla = !filterRegla || r.regla_iva === filterRegla;
    return matchSearch && matchTipo && matchRegla;
  });

  const grupos = agruparPorRfc(filtered);
  const tableContainer = document.getElementById('lm-table-container');
  if (tableContainer) {
    tableContainer.innerHTML = renderLibroMayorGroups(Object.values(grupos));
  }
}

// Clic en pill de resumen → activa filtro de regla
function filterLibroMayorByRegla(regla) {
  const sel = document.getElementById('lm-filter-regla');
  if (!sel) return;
  sel.value = (sel.value === regla) ? '' : regla;
  filterLibroMayor();
}

// ─────────────────────────────────────────────────────────────────────
// EXPORTAR CSV
// ─────────────────────────────────────────────────────────────────────
function exportLibroMayorCSV() {
  const data = LibroMayorModule.currentData;
  if (!data || !data.cfdi) return;

  const headers = [
    'UUID','Fecha','RFC Emisor','Nombre Emisor','RFC Receptor','Nombre Receptor',
    'Tipo','Metodo Pago','Estado','Subtotal','IVA CFDI','Total',
    'Total Pagado','Num Complementos','IVA Real','Regla IVA','Moneda','Tipo Cambio'
  ];

  const escapeCSV = (v) => {
    if (v === null || v === undefined) return '';
    const str = String(v).replace(/"/g, '""');
    return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
  };

  const rows = [headers.join(',')];
  for (const r of data.cfdi) {
    rows.push([
      escapeCSV(r.uuid),
      r.fecha ? r.fecha.substring(0, 10) : '',
      escapeCSV(r.rfc_emisor),
      escapeCSV(r.nombre_emisor),
      escapeCSV(r.rfc_receptor),
      escapeCSV(r.nombre_receptor),
      escapeCSV(r.tipo),
      escapeCSV(r.metodo_pago),
      escapeCSV(r.estado),
      parseFloat(r.subtotal  || 0).toFixed(2),
      parseFloat(r.iva_cfdi  || 0).toFixed(2),
      parseFloat(r.total     || 0).toFixed(2),
      parseFloat(r.total_pagado     || 0).toFixed(2),
      r.num_complementos || 0,
      parseFloat(r.iva_real  || 0).toFixed(2),
      escapeCSV(r.regla_iva),
      escapeCSV(r.moneda || 'MXN'),
      parseFloat(r.tipo_cambio || 1).toFixed(6),
    ].join(','));
  }

  // Totales al final
  const t = data.totales;
  rows.push('');
  rows.push(`TOTALES,,,,,,,,,${t.subtotal.toFixed(2)},${t.iva_cfdi.toFixed(2)},,,,${t.iva_real.toFixed(2)},,,`);
  rows.push(`DIFERENCIA IVA CFDI vs REAL,,,,,,,,,,,,,,,${t.diferencia.toFixed(2)},,,`);

  const meta     = data.meta;
  const filename = `LibroMayor_${meta.rfc}_${meta.year || 'all'}_${meta.mes ? String(meta.mes).padStart(2,'0') : 'all'}.csv`;
  const csv      = '\uFEFF' + rows.join('\n');
  const blob     = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);

  showToast('success', 'CSV Exportado', `${data.cfdi.length} registros · ${filename}`);
}

// ═════════════════════════════════════════════════════════════════════
// MÓDULO REPOSITORIO — Gestión de paquetes ZIP descargados del SAT
// ═════════════════════════════════════════════════════════════════════

const RepositorioModule = {
  packages: [],
  lastUpdate: null,
};

async function loadRepositorio() {
  const container = document.getElementById('repo-pkg-list');
  if (!container) return;

  container.innerHTML = `
    <div class="audit-placeholder">
      <div class="audit-placeholder-icon"><i class="fas fa-spinner fa-spin"></i></div>
      <h3>Cargando repositorio...</h3>
    </div>`;

  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/flatten/packages`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const packages = await res.json();

    RepositorioModule.packages = packages;
    RepositorioModule.lastUpdate = new Date();

    // Stats
    const processed = packages.filter(p => p.processed).length;
    const pending   = packages.length - processed;
    let totalBytes  = packages.reduce((sum, p) => {
      const kb = parseFloat(p.size) || 0;
      return sum + kb;
    }, 0);
    const sizeLabel = totalBytes > 1024
      ? (totalBytes / 1024).toFixed(1) + ' MB'
      : totalBytes.toFixed(0) + ' KB';

    document.getElementById('repo-total-pkgs').textContent  = packages.length;
    document.getElementById('repo-procesados').textContent  = processed;
    document.getElementById('repo-pendientes').textContent  = pending;
    document.getElementById('repo-total-size').textContent  = sizeLabel;

    renderRepositorio(packages);

    // Refrescar selectores de comparación si hay nuevos reportes
    initComparacion();

  } catch (e) {
    container.innerHTML = `
      <div class="audit-placeholder">
        <div class="audit-placeholder-icon" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i></div>
        <h3 style="color:#f87171;">Error al cargar el repositorio</h3>
        <p>${e.message}</p>
      </div>`;
    showToast('error', 'Repositorio', e.message);
  }
}

function renderRepositorio(packages) {
  const container = document.getElementById('repo-pkg-list');
  if (!packages.length) {
    container.innerHTML = `
      <div class="audit-placeholder">
        <div class="audit-placeholder-icon"><i class="fas fa-box-open"></i></div>
        <h3>No hay paquetes en el repositorio</h3>
        <p>Descarga paquetes desde el Módulo SAT y aparecerán aquí</p>
      </div>`;
    return;
  }

  const rows = packages.map(pkg => {
    const badge = pkg.processed
      ? '<span class="repo-badge repo-badge-ok">Procesado</span>'
      : '<span class="repo-badge repo-badge-warn">Sin procesar</span>';
    const date = pkg.date ? new Date(pkg.date).toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' }) : '—';
    const typeIcon = pkg.name.endsWith('.txt') ? 'fa-file-alt' : 'fa-file-archive';
    const typeLabel = pkg.type || (pkg.name.endsWith('.txt') ? 'Metadata' : 'CFDI');

    return `
      <div class="repo-pkg-card">
        <div class="repo-pkg-icon">
          <i class="fas ${typeIcon}"></i>
        </div>
        <div class="repo-pkg-info">
          <div class="repo-pkg-name" title="${pkg.name}">${pkg.name}</div>
          <div class="repo-pkg-meta">
            <span><i class="fas fa-tag"></i> ${typeLabel}</span>
            <span><i class="fas fa-weight-hanging"></i> ${pkg.size}</span>
            <span><i class="fas fa-calendar"></i> ${date}</span>
          </div>
        </div>
        <div class="repo-pkg-status">${badge}</div>
        <div class="repo-pkg-actions">
          <button class="btn-xs btn-info" onclick="downloadZip('${pkg.name}')" title="Descargar ZIP">
            <i class="fas fa-download"></i> Descargar
          </button>
          <button class="btn-xs btn-danger" onclick="deleteZipFromRepo('${pkg.name}')" title="Eliminar">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="repo-pkg-list-inner">${rows}</div>`;
}

async function downloadZip(filename) {
  try {
    const token = localStorage.getItem('token');
    const url = `${API_URL}/flatten/download/${encodeURIComponent(filename)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('success', 'Descarga', `${filename} descargado correctamente`);
  } catch (e) {
    showToast('error', 'Error al descargar', e.message);
  }
}

async function deleteZipFromRepo(filename) {
  if (!confirm(`¿Eliminar "${filename}" del repositorio? Esta acción es irreversible.`)) return;
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/flatten/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageIds: [filename] })
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    showToast('success', 'Eliminado', `${filename} eliminado del repositorio`);
    await loadRepositorio();
  } catch (e) {
    showToast('error', 'Error al eliminar', e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════
// MÓDULO COMPARACIÓN — Vista Espejo: Metadata SAT vs XMLs procesados
// ═════════════════════════════════════════════════════════════════════

const ComparacionModule = {
  data: null,
  filtroAlerta: 'todos',
  filtroAño: '',
};

// Pobla un <select> con la lista de CSVs disponibles
function _poblarSelectReportes(selectId, items) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  if (!items || items.length === 0) {
    sel.innerHTML = '<option value="">— Sin reportes disponibles —</option>';
    return;
  }
  sel.innerHTML = items.map((it, i) =>
    `<option value="${it.nombre}"${i === 0 ? ' selected' : ''}>${it.nombre} · ${it.fecha}</option>`
  ).join('');
}

// Cambia el filtro de año y re-ejecuta la comparación (usado por los chips del banner)
function _filtrarPorAño(year) {
  const sel = document.getElementById('comp-year-select');
  if (sel) sel.value = year;
  runComparacion();
}

// Carga los años disponibles en el CSV de Metadata y puebla el dropdown #comp-year-select
async function _actualizarAñosComparacion(metaFilename) {
  const yearSel = document.getElementById('comp-year-select');
  if (!yearSel || !metaFilename) return;
  try {
    const token = localStorage.getItem('token');
    const r = await fetch(
      `${API_URL}/auditoria/años-reporte?filename=${encodeURIComponent(metaFilename)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return;
    const { años } = await r.json();
    if (años.length > 0) {
      // Auto-seleccionar el primer año (más reciente); mover "Todos" al final
      yearSel.innerHTML =
        años.map((y, i) => `<option value="${y}"${i === 0 ? ' selected' : ''}>${y}</option>`).join('') +
        '<option value="">— Todos los años —</option>';
    } else {
      yearSel.innerHTML = '<option value="">Todos los años</option>';
    }
  } catch (_) {}
}

async function initComparacion() {
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/auditoria/listar-reportes`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const listas = await res.json();
      _poblarSelectReportes('comp-meta-select', listas.metadata);
      _poblarSelectReportes('comp-cfdi-select', listas.cfdi);
      const btn = document.getElementById('btn-run-comp');
      if (btn) btn.disabled = !listas.metadata.length || !listas.cfdi.length;

      // Poblar años del primer Metadata disponible
      const firstMeta = listas.metadata[0]?.nombre;
      if (firstMeta) await _actualizarAñosComparacion(firstMeta);

      // Refrescar años cuando el usuario cambia el selector de Metadata
      const metaSel = document.getElementById('comp-meta-select');
      if (metaSel && !metaSel._yearListenerAdded) {
        metaSel.addEventListener('change', () => _actualizarAñosComparacion(metaSel.value));
        metaSel._yearListenerAdded = true;
      }
    }
  } catch (_) {}
}

async function runComparacion() {
  ComparacionModule.filtroAño = '';  // resetear filtro de año al iniciar nueva comparación
  const container = document.getElementById('comp-mirror-container');
  const statsRow  = document.getElementById('comp-stats-row');
  if (statsRow) statsRow.style.display = 'none';

  container.innerHTML = `
    <div class="audit-placeholder">
      <div class="audit-placeholder-icon"><i class="fas fa-spinner fa-spin"></i></div>
      <h3>Cruzando Metadata vs CFDI por UUID...</h3>
    </div>`;

  const btn = document.getElementById('btn-run-comp');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Comparando...'; }

  try {
    const token = localStorage.getItem('token');
    const metaCsv = document.getElementById('comp-meta-select')?.value;
    const cfdiCsv = document.getElementById('comp-cfdi-select')?.value;
    const year    = document.getElementById('comp-year-select')?.value;
    const params  = new URLSearchParams();
    if (metaCsv) params.set('meta_csv', metaCsv);
    if (cfdiCsv) params.set('cfdi_csv', cfdiCsv);
    if (year)    params.set('year', year);
    const res = await fetch(`${API_URL}/auditoria/comparar?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || `Error ${res.status}`);
    }
    const data = await res.json();

    ComparacionModule.data = data;

    // Sincronizar dropdown con el año efectivo que aplicó el backend
    if (data.effectiveYear) {
      const yearSel = document.getElementById('comp-year-select');
      if (yearSel && !yearSel.value) yearSel.value = data.effectiveYear;
    }

    renderMirrorTable(data);

    // Banner de chips de año — aparece si el archivo tiene datos de múltiples años
    const oldBanner = document.getElementById('comp-year-banner');
    if (oldBanner) oldBanner.remove();
    if (data.availableYears?.length > 1) {
      const currentYear = document.getElementById('comp-year-select')?.value || '';
      const chipsHtml = data.availableYears.map(y =>
        `<button class="comp-year-chip${y === currentYear ? ' active' : ''}" onclick="_filtrarPorAño('${y}')">${y}</button>`
      ).join('');
      const banner = document.createElement('div');
      banner.id = 'comp-year-banner';
      banner.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem;padding:0.6rem 1rem;background:var(--surface-2,#1e293b);border-radius:8px;border:1px solid var(--border,#334155);font-size:0.82rem;';
      banner.innerHTML = `<i class="fas fa-info-circle" style="color:var(--accent-blue,#38bdf8);"></i>
        <span style="color:var(--text-secondary);">Años en este reporte:</span>
        ${chipsHtml}
        <button class="comp-year-chip${currentYear === '' ? ' active' : ''}" onclick="_filtrarPorAño('')">Todos</button>`;
      const container = document.getElementById('comp-mirror-container');
      if (container) container.insertBefore(banner, container.firstChild);
    }

    // Mostrar stats
    if (statsRow) {
      document.getElementById('comp-ok').textContent        = data.stats.ok;
      document.getElementById('comp-solo-meta').textContent = data.stats.solo_metadata;
      document.getElementById('comp-solo-cfdi').textContent = data.stats.solo_cfdi;
      document.getElementById('comp-mismatch').textContent  = data.stats.total_mismatch;
      statsRow.style.display = 'flex';
    }

  } catch (e) {
    container.innerHTML = `
      <div class="audit-placeholder">
        <div class="audit-placeholder-icon" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i></div>
        <h3 style="color:#f87171;">Error en la comparación</h3>
        <p>${e.message}</p>
      </div>`;
    showToast('error', 'Error en comparación', e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-columns"></i> Comparar'; }
  }
}

function renderMirrorTable(data) {
  const container = document.getElementById('comp-mirror-container');
  const { filas, stats } = data;
  const total = filas.length;

  if (!filas.length) {
    container.innerHTML = `
      <div class="audit-placeholder">
        <div class="audit-placeholder-icon"><i class="fas fa-check-circle" style="color:#4ade80;"></i></div>
        <h3>Sin registros en los reportes</h3>
        <p>Los archivos Metadata y CFDI están vacíos o sin UUIDs</p>
      </div>`;
    return;
  }

  // Opciones de filtro
  const filterBar = `
    <div class="comp-filter-bar">
      <span class="comp-filter-label">Filtrar:</span>
      <button class="comp-filter-btn active" data-filter="todos"          onclick="filterMirrorTable('todos')">Todos (${total})</button>
      <button class="comp-filter-btn" data-filter="errores"               onclick="filterMirrorTable('errores')">Con alertas (${total - stats.ok})</button>
      <button class="comp-filter-btn" data-filter="ok"                    onclick="filterMirrorTable('ok')"><i class="fas fa-check"></i> OK (${stats.ok})</button>
      <button class="comp-filter-btn comp-filter-red" data-filter="solo_metadata" onclick="filterMirrorTable('solo_metadata')">Solo Metadata (${stats.solo_metadata})</button>
      <button class="comp-filter-btn comp-filter-red" data-filter="solo_cfdi"     onclick="filterMirrorTable('solo_cfdi')">Solo CFDI (${stats.solo_cfdi})</button>
      <button class="comp-filter-btn comp-filter-yellow" data-filter="total_mismatch" onclick="filterMirrorTable('total_mismatch')">Total ≠ (${stats.total_mismatch})</button>
    </div>`;

  // Cabecera de la tabla espejo — colspan 6 por lado (+ 2 cols IVA)
  const thead = `
    <thead>
      <tr class="mirror-header-main">
        <th colspan="6" class="mirror-side-header mirror-left-header"><i class="fas fa-file-alt"></i> METADATA (Reporte_Consolidado_Metadata_RyE)</th>
        <th class="mirror-uuid-col"></th>
        <th colspan="6" class="mirror-side-header mirror-right-header"><i class="fas fa-file-invoice"></i> CFDI (Reporte_Consolidado_Cfdi_RyE)</th>
        <th class="mirror-alert-col"></th>
      </tr>
      <tr class="mirror-header-sub">
        <th>RFC Emisor</th>
        <th class="mirror-th-fecha">Fecha
          <select id="mirror-year-filter" class="mirror-year-select"
                  onchange="filterMirrorByYear(this.value)" title="Filtrar por año">
            <option value="">Todos</option>
          </select>
        </th>
        <th>Total</th>
        <th class="mirror-iva-col">IVA Trsd.</th>
        <th class="mirror-iva-col">IVA Acred.</th>
        <th>Estado</th>
        <th class="mirror-uuid-col">UUID</th>
        <th>RFC Emisor</th>
        <th>Fecha</th>
        <th>Total</th>
        <th class="mirror-iva-col">IVA Trsd.</th>
        <th class="mirror-iva-col">IVA Acred.</th>
        <th>Estado</th>
        <th>Alertas</th>
      </tr>
    </thead>`;

  // Construir tbody agrupando por Año → Mes con filas de totales de período
  const _fmtM = (v) => new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN' })
                          .format(parseFloat((v || '0').toString().replace(/,/g, '')) || 0);
  const _sumField = (rows, side, ...keys) => rows.reduce((acc, r) => {
    const v = r[side] ? _getCol(r[side], ...keys) : null;
    return acc + (parseFloat(String(v || '0').replace(/,/g, '')) || 0);
  }, 0);

  // Ordenar filas por fecha ascendente
  const sortedFilas = [...filas].sort((a, b) => {
    const fa = String(_getCol(a.metadata || {}, 'Fecha', 'fecha', 'FechaEmision') || '').slice(0, 10);
    const fb = String(_getCol(b.metadata || {}, 'Fecha', 'fecha', 'FechaEmision') || '').slice(0, 10);
    return fa.localeCompare(fb);
  });

  // Agrupar por año → mes
  const byYear = {};
  sortedFilas.forEach(r => {
    const fecha = _getCol(r.metadata || {}, 'Fecha', 'fecha', 'FechaEmision') || '';
    const yr    = String(fecha).slice(0, 4) || '----';
    const ym    = String(fecha).slice(0, 7) || '----';
    if (!byYear[yr])      byYear[yr]      = {};
    if (!byYear[yr][ym])  byYear[yr][ym]  = [];
    byYear[yr][ym].push(r);
  });

  let tbodyHtml = '';
  Object.keys(byYear).sort().forEach(yr => {
    const months       = byYear[yr];
    const allYearRows  = Object.values(months).flat();
    const monthKeys    = Object.keys(months).sort();

    monthKeys.forEach(ym => {
      // Filas del mes
      months[ym].forEach(r => { tbodyHtml += buildMirrorRow(r); });
      // Subtotal mensual (solo si el año tiene más de un mes)
      if (monthKeys.length > 1) {
        tbodyHtml += buildPeriodTotalRow(ym, months[ym], 'month', _sumField, _fmtM);
      }
    });
    // Total anual
    tbodyHtml += buildPeriodTotalRow(yr, allYearRows, 'year', _sumField, _fmtM);
  });

  const tbody = `<tbody id="mirror-table-body">${tbodyHtml}</tbody>`;

  container.innerHTML = filterBar + `
    <div class="mirror-table-wrap">
      <table class="mirror-table" id="mirror-table">${thead}${tbody}</table>
    </div>`;

  // Poblar el select de año con los valores únicos presentes en las filas
  const yearSelect = document.getElementById('mirror-year-filter');
  if (yearSelect) {
    const years = [...new Set(
      filas
        .map(r => {
          const f = r.metadata
            ? (_getCol(r.metadata, 'Fecha', 'fecha', 'FechaEmision') || '')
            : '';
          return String(f).slice(0, 4);
        })
        .filter(y => /^\d{4}$/.test(y))
    )].sort();
    years.forEach(y => {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      yearSelect.appendChild(opt);
    });

    if (ComparacionModule.filtroAño) {
      // Restaurar filtro activo si ya había uno (ej: al cambiar el filtro de alerta)
      yearSelect.value = ComparacionModule.filtroAño;
    } else if (years.length > 1) {
      // Auto-seleccionar el año más reciente y aplicar el filtro de inmediato
      const latestYear = years[years.length - 1];
      yearSelect.value = latestYear;
      ComparacionModule.filtroAño = latestYear;
      _applyMirrorFilters();
    }
  }
}

// Busca un valor en un objeto de fila usando múltiples posibles nombres de columna
function _getCol(row, ...keys) {
  if (!row) return null;
  for (const k of keys) {
    const found = Object.keys(row).find(c => c.toLowerCase() === k.toLowerCase());
    if (found && row[found] != null && row[found] !== '') return row[found];
  }
  return null;
}

// Genera una fila de resumen (total mensual o anual) para la tabla espejo
// label   = 'YYYY' (año) o 'YYYY-MM' (mes)
// rows    = array de filas del período
// type    = 'year' | 'month'
// sumFn   = función _sumField inyectada (evita dependencia circular)
// fmtFn   = función de formateo de moneda inyectada
function buildPeriodTotalRow(label, rows, type, sumFn, fmtFn) {
  const isYear = type === 'year';
  const yr     = label.slice(0, 4);
  const icon   = isYear ? 'calendar-check' : 'calendar-day';
  const cls    = isYear ? 'mirror-year-row' : 'mirror-month-row';
  const title  = isYear ? `Total ${label}` : label;

  const mTot  = fmtFn(sumFn(rows, 'metadata', 'Total',       'total',       'Monto'));
  const mTrs  = fmtFn(sumFn(rows, 'metadata', ..._IVA_TRAS_KEYS));
  const mAcr  = fmtFn(sumFn(rows, 'metadata', ..._IVA_ACRED_KEYS));
  const cTot  = fmtFn(sumFn(rows, 'cfdi',     'Total',       'total',       'Monto'));
  const cTrs  = fmtFn(sumFn(rows, 'cfdi',     ..._IVA_TRAS_KEYS));
  const cAcr  = fmtFn(sumFn(rows, 'cfdi',     ..._IVA_ACRED_KEYS));

  return `
    <tr class="mirror-period-row ${cls}" data-year="${yr}" data-period="${label}">
      <td colspan="2" class="period-label">
        <i class="fas fa-${icon}"></i> ${title}
        <span style="font-weight:400;font-size:0.72rem;opacity:0.7;"> — ${rows.length} reg.</span>
      </td>
      <td class="money period-total">${mTot}</td>
      <td class="money period-total mirror-iva-col">${mTrs}</td>
      <td class="money period-total mirror-iva-col">${mAcr}</td>
      <td></td>
      <td class="mirror-uuid-col"></td>
      <td colspan="2"></td>
      <td class="money period-total">${cTot}</td>
      <td class="money period-total mirror-iva-col">${cTrs}</td>
      <td class="money period-total mirror-iva-col">${cAcr}</td>
      <td></td>
      <td></td>
    </tr>`;
}

// Alias de columnas IVA — se intentan en orden hasta encontrar la que exista en el CSV
const _IVA_TRAS_KEYS  = ['TotalTraslados', 'total_traslados', 'IvaTrasladado',
                          'TotalIvaTrasladado', 'Trasladados', 'TotalImpuestosTrasladados'];
const _IVA_ACRED_KEYS = ['TotalRetenciones', 'total_retenciones', 'IvaAcreditable',
                          'TotalIvaAcreditable', 'Retenciones', 'TotalImpuestosRetenidos'];

function buildMirrorRow(row) {
  const { uuid, metadata, cfdi, alertas } = row;
  const fmtMoney = (v) => {
    const n = parseFloat((v || '0').toString().replace(/,/g, '')) || 0;
    return new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN' }).format(n);
  };
  const fmtDate  = (d) => d ? String(d).slice(0, 10) : '—';
  const fmtIva   = (v) => v != null ? fmtMoney(v) : '<span class="mirror-empty">—</span>';

  // UUID más legible: 10 chars + … + 6 chars al final
  const uuidShort = (uuid || '').length > 16 ? uuid.slice(0,10) + '…' + uuid.slice(-6) : (uuid || '—');

  // Clase de fila
  let rowClass = 'mirror-row-ok';
  if (alertas.includes('total_mismatch'))                                    rowClass = 'mirror-row-yellow';
  if (alertas.includes('solo_metadata') || alertas.includes('solo_cfdi'))   rowClass = 'mirror-row-red';

  // ── Lado METADATA ──
  const metaRfc      = metadata ? (_getCol(metadata, 'RfcEmisor', 'rfc_emisor', 'RFC Emisor') || '—') : '<span class="mirror-empty">—</span>';
  const metaFecha    = metadata ? fmtDate(_getCol(metadata, 'Fecha', 'fecha', 'FechaEmision')) : '<span class="mirror-empty">—</span>';
  const metaTotalRaw = metadata ? _getCol(metadata, 'Total', 'total', 'Monto') : null;
  const metaIvaTrs   = metadata ? _getCol(metadata, ..._IVA_TRAS_KEYS)  : null;
  const metaIvaAcr   = metadata ? _getCol(metadata, ..._IVA_ACRED_KEYS) : null;
  const metaEstado   = metadata ? (_getCol(metadata, 'Estado_Calculo', 'estado', 'Estatus', 'EfectoComprobante') || '—') : null;
  const metaEstCell  = metadata ? `<span class="mirror-estado">${metaEstado}</span>` : '<span class="mirror-empty">—</span>';

  // ── Lado CFDI ──
  const cfdiRfc      = cfdi ? (_getCol(cfdi, 'RfcEmisor', 'rfc_emisor', 'RFC Emisor') || '—') : '<span class="mirror-empty">—</span>';
  const cfdiFecha    = cfdi ? fmtDate(_getCol(cfdi, 'Fecha', 'fecha')) : '<span class="mirror-empty">—</span>';
  const cfdiTotal    = cfdi ? _getCol(cfdi, 'Total', 'total', 'Monto') : null;
  const cfdiIvaTrs   = cfdi ? _getCol(cfdi, ..._IVA_TRAS_KEYS)  : null;
  const cfdiIvaAcr   = cfdi ? _getCol(cfdi, ..._IVA_ACRED_KEYS) : null;
  const cfdiEstado   = cfdi ? (_getCol(cfdi, 'Estado_Calculo', 'estado', 'Estatus') || '—') : null;
  const cfdiEstCell  = cfdi ? `<span class="mirror-estado">${cfdiEstado}</span>` : '<span class="mirror-empty">—</span>';

  // Total con diferencia destacada
  const metaTotalCell = alertas.includes('total_mismatch') && metadata
    ? `<span class="mirror-diff-val">${fmtMoney(metaTotalRaw)}</span>`
    : (metadata ? fmtMoney(metaTotalRaw) : '<span class="mirror-empty">—</span>');
  const cfdiTotalCell = alertas.includes('total_mismatch') && cfdi
    ? `<span class="mirror-diff-val">${fmtMoney(cfdiTotal)}</span>`
    : (cfdi ? fmtMoney(cfdiTotal) : '<span class="mirror-empty">—</span>');

  // Columna de alertas
  const alertIcons = [];
  if (alertas.includes('solo_metadata'))  alertIcons.push('<span class="mirror-alert-icon red" title="UUID solo en Metadata, no en CFDI"><i class="fas fa-times-circle"></i></span>');
  if (alertas.includes('solo_cfdi'))      alertIcons.push('<span class="mirror-alert-icon red" title="UUID solo en CFDI, no en Metadata"><i class="fas fa-times-circle"></i></span>');
  if (alertas.includes('total_mismatch')) alertIcons.push('<span class="mirror-alert-icon yellow" title="Total no coincide"><i class="fas fa-exclamation-triangle"></i></span>');
  const alertaCell = alertIcons.length ? alertIcons.join(' ') : '<span class="mirror-ok-icon"><i class="fas fa-check"></i></span>';

  // Atributos de filtro (alerta + año + mes)
  const rowYear    = metaFecha && metaFecha !== '—' ? metaFecha.slice(0, 4) : '';
  const rowMonth   = metaFecha && metaFecha !== '—' ? metaFecha.slice(0, 7) : '';
  const filterAttr = `data-alertas="${alertas.join(' ')}" data-year="${rowYear}" data-month="${rowMonth}"`;

  return `
    <tr class="mirror-row ${rowClass}" ${filterAttr}>
      <td>${metaRfc}</td>
      <td>${metaFecha}</td>
      <td class="money">${metaTotalCell}</td>
      <td class="money mirror-iva-col">${fmtIva(metaIvaTrs)}</td>
      <td class="money mirror-iva-col">${fmtIva(metaIvaAcr)}</td>
      <td>${metaEstCell}</td>
      <td class="mirror-uuid-col" title="${uuid}"><code>${uuidShort}</code></td>
      <td>${cfdiRfc}</td>
      <td>${cfdiFecha}</td>
      <td class="money">${cfdiTotalCell}</td>
      <td class="money mirror-iva-col">${fmtIva(cfdiIvaTrs)}</td>
      <td class="money mirror-iva-col">${fmtIva(cfdiIvaAcr)}</td>
      <td>${cfdiEstCell}</td>
      <td class="mirror-alerts-cell">${alertaCell}</td>
    </tr>`;
}

// Aplica en paralelo filtro de alerta + filtro de año sobre la tabla espejo
function _applyMirrorFilters() {
  const filtro = ComparacionModule.filtroAlerta;
  const año    = ComparacionModule.filtroAño;

  // Filas de datos — filtrar por alerta Y por año
  document.querySelectorAll('#mirror-table-body .mirror-row').forEach(row => {
    const alertas = row.dataset.alertas || '';
    const rowYear = row.dataset.year    || '';

    let alertaOk;
    if (filtro === 'todos')        alertaOk = true;
    else if (filtro === 'ok')      alertaOk = alertas === 'ok';
    else if (filtro === 'errores') alertaOk = alertas !== 'ok';
    else                           alertaOk = alertas.includes(filtro);

    const añoOk = !año || rowYear === año;
    row.style.display = (alertaOk && añoOk) ? '' : 'none';
  });

  // Filas de período — solo filtro de año (siempre visibles si el año coincide)
  document.querySelectorAll('#mirror-table-body .mirror-period-row').forEach(row => {
    const rowYear = row.dataset.year || '';
    row.style.display = (!año || rowYear === año) ? '' : 'none';
  });
}

// Llamada por el <select> en <th>Fecha</th>
function filterMirrorByYear(year) {
  ComparacionModule.filtroAño = year;
  _applyMirrorFilters();
}

function filterMirrorTable(filtro) {
  ComparacionModule.filtroAlerta = filtro;

  // Actualizar botones activos
  document.querySelectorAll('.comp-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filtro);
  });

  _applyMirrorFilters();
}
