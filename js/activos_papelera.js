/**
 * ============================================================
 * ACTIVOS FIJOS + PAPELERA — ETX Tax Recovery
 * ============================================================
 */

// ─── ACTIVOS FIJOS ────────────────────────────────────────────
let activosYearSel = new Date().getFullYear();
let activosMesSel  = new Date().getMonth() + 1;

const TIPOS_ACTIVO = {
  Edificio: '5% anual (Art. 34 LISR)',
  Mobiliario: '10% anual',
  Equipo: '10% anual',
  Vehiculo: '25% anual',
  Computacion: '30% anual',
  Maquinaria: '10% anual',
  Otro: '10% anual',
};

async function initActivos() {
  activosYearSel = document.getElementById('activosYear')?.value || activosYearSel;
  activosMesSel  = document.getElementById('activosMes')?.value  || activosMesSel;
  await activosLoadListado();
  await activosLoadResumen();
}

async function activosLoadListado() {
  try {
    const data = await apiFetch('/activos');
    const tbody = document.getElementById('activosBody');
    if (!tbody) return;
    tbody.innerHTML = data.length ? data.map(a => `
      <tr class="${!a.activo ? 'row-baja' : ''}">
        <td>${a.descripcion}</td>
        <td><span class="badge-tipo tipo-${a.tipo?.toLowerCase()}">${a.tipo}</span></td>
        <td>${a.fecha_adquisicion?.slice(0,10)}</td>
        <td class="text-right money">${fmtMXN(a.costo_adquisicion)}</td>
        <td class="text-right">${(parseFloat(a.tasa_depreciacion)*100).toFixed(0)}%</td>
        <td class="text-right money text-warning">${fmtMXN(a.depreciacion_mensual)}/mes</td>
        <td class="text-right money">${fmtMXN(a.depreciacion_acumulada)}</td>
        <td class="text-right money ${parseFloat(a.valor_en_libros) < parseFloat(a.costo_adquisicion)*0.1 ? 'text-danger' : 'text-success'}">${fmtMXN(a.valor_en_libros)}</td>
        <td class="cont-actions">
          <button class="btn-xs btn-info" onclick="activosVerHistorial(${a.id})">Dep</button>
          ${a.activo ? `<button class="btn-xs btn-danger" onclick="activosDarBaja(${a.id})">Baja</button>` : '<span class="badge-baja">Dado de baja</span>'}
        </td>
      </tr>`).join('') : '<tr><td colspan="9" class="text-center muted">Sin activos registrados.</td></tr>';

    // Actualizar contador
    const total = data.filter(a => a.activo).length;
    const el = document.getElementById('activosCount');
    if (el) el.textContent = total;
  } catch (e) { showToast('error', 'Error', 'Error activos: ' + e.message); }
}

async function activosLoadResumen() {
  try {
    const data = await apiFetch(`/activos/resumen/${activosYearSel}`);
    const tbl = document.getElementById('activosResumenBody');
    if (tbl && data.por_mes) {
      const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      tbl.innerHTML = data.por_mes.map(r => `
        <tr>
          <td>${meses[r.periodo]}</td>
          <td class="text-right">${r.activos}</td>
          <td class="text-right money text-warning">${fmtMXN(r.depreciacion_mes)}</td>
          <td class="text-right money">${fmtMXN(r.dep_acumulada)}</td>
        </tr>`).join('');
    }
    if (data.totales) {
      const t = data.totales;
      document.getElementById('activosCostoTotal') && (document.getElementById('activosCostoTotal').textContent = fmtMXN(t.costo_total));
      document.getElementById('activosDepAcum')    && (document.getElementById('activosDepAcum').textContent    = fmtMXN(t.dep_acumulada_total));
      document.getElementById('activosValorLibros')&& (document.getElementById('activosValorLibros').textContent= fmtMXN(t.valor_libros_total));
    }
  } catch (e) { /* sin datos */ }
}

async function activosRegistrar() {
  const form = document.getElementById('activosForm');
  if (!form) return;
  const tipo = document.getElementById('activoTipo')?.value;
  const data = {
    descripcion:      document.getElementById('activoDescripcion')?.value,
    tipo,
    fecha_adquisicion:document.getElementById('activoFecha')?.value,
    costo_adquisicion:parseFloat(document.getElementById('activoCosto')?.value || 0),
    uuid_cfdi:        document.getElementById('activoUUID')?.value || null,
    tasa_depreciacion:parseFloat(document.getElementById('activoTasa')?.value || 0) / 100,
  };
  if (!data.descripcion || !data.tipo || !data.fecha_adquisicion || !data.costo_adquisicion) {
    showToast('error', 'Validación', 'Completa todos los campos requeridos'); return;
  }
  try {
    const r = await apiFetch('/activos', 'POST', data);
    showToast('success', 'Activo registrado', `Tasa aplicada: ${(r.tasa_aplicada*100).toFixed(0)}% (Art. 34 LISR)`);
    form.reset();
    await activosLoadListado();
    await activosLoadResumen();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function activosCalcularDep() {
  try {
    showToast('info', 'Procesando', 'Calculando depreciaciones del periodo...');
    const r = await apiFetch('/activos/calcular-dep', 'POST',
      { year: activosYearSel, mes: activosMesSel });
    showToast('success', 'Depreciación calculada', `$${r.total_depreciacion_periodo} en ${r.activos_calculados} activos`);
    await activosLoadListado();
    await activosLoadResumen();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function activosVerHistorial(id) {
  try {
    const data = await apiFetch(`/activos/${id}/depreciaciones`);
    const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const html = `<table class="cont-table">
      <thead><tr><th>Año</th><th>Mes</th><th>Dep. Periodo</th><th>Dep. Acum.</th><th>Saldo</th></tr></thead>
      <tbody>${data.map(d => `<tr>
        <td>${d.ejercicio}</td><td>${meses[d.periodo]}</td>
        <td class="text-right money text-warning">${fmtMXN(d.depreciacion_periodo)}</td>
        <td class="text-right money">${fmtMXN(d.depreciacion_acumulada_al_periodo)}</td>
        <td class="text-right money ${parseFloat(d.saldo_por_depreciar) <= 0 ? 'text-danger' : ''}">${fmtMXN(d.saldo_por_depreciar)}</td>
      </tr>`).join('')}</tbody></table>`;
    showModal('Historial de Depreciaciones', html);
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function activosDarBaja(id) {
  const motivo = prompt('Motivo de baja (ej: venta, robo, obsolescencia):');
  if (!motivo) return;
  try {
    await apiFetch(`/activos/${id}`, 'DELETE', {
      motivo_baja: motivo,
      fecha_baja: new Date().toISOString().slice(0,10)
    });
    showToast('success', 'Baja registrada', 'Activo dado de baja correctamente');
    await activosLoadListado();
  } catch (e) { showToast('error', 'Error', e.message); }
}

// Auto-llenar tasa cuando cambia tipo
function activoTipoChange() {
  const tipo = document.getElementById('activoTipo')?.value;
  const tasas = { Edificio: 5, Mobiliario: 10, Equipo: 10, Vehiculo: 25, Computacion: 30, Maquinaria: 10, Otro: 10 };
  const el = document.getElementById('activoTasa');
  const info = document.getElementById('activoTasaInfo');
  if (el && tasas[tipo]) {
    el.value = tasas[tipo];
    if (info) info.textContent = TIPOS_ACTIVO[tipo] || '';
  }
}

// ─── PAPELERA ─────────────────────────────────────────────────
let papeleraFiltroTipo = '';

async function initPapelera() {
  await papeleraLoadStats();
  await papeleraLoadListado();
}

async function papeleraLoadStats() {
  try {
    const data = await apiFetch('/papelera/stats');
    const r = data.resumen;
    document.getElementById('papeleraTotal')     && (document.getElementById('papeleraTotal').textContent     = r.total);
    document.getElementById('papeleraCFDIs')     && (document.getElementById('papeleraCFDIs').textContent     = r.cfdis);
    document.getElementById('papeleraSolicitudes')&& (document.getElementById('papeleraSolicitudes').textContent= r.solicitudes);
    document.getElementById('papeleraExpirados') && (document.getElementById('papeleraExpirados').textContent = r.expirados);
  } catch (e) { /* no hay papelera aún */ }
}

async function papeleraLoadListado() {
  try {
    const url = `/papelera${papeleraFiltroTipo ? '?tipo=' + papeleraFiltroTipo : ''}`;
    const data = await apiFetch(url);
    const tbody = document.getElementById('papeleraBody');
    if (!tbody) return;
    tbody.innerHTML = data.data?.length ? data.data.map(r => `
      <tr class="${r.expirado ? 'row-expirado' : ''}">
        <td>${r.id}</td>
        <td><span class="badge-tipo tipo-${r.tipo_registro}">${r.tipo_registro}</span></td>
        <td><code>${r.registro_id?.slice(0,16)}…</code></td>
        <td>${r.rfc || '-'}</td>
        <td>${r.motivo || '-'}</td>
        <td>${r.fecha_eliminacion?.slice(0,10)}</td>
        <td class="${r.expirado ? 'text-danger' : 'text-success'}">${r.fecha_expiracion}</td>
        <td>
          ${r.expirado ? `<button class="btn-xs btn-danger" onclick="papeleraEliminarDefinitivo(${r.id})">Purgar</button>` : '<span class="badge-retencion">Retenido</span>'}
        </td>
      </tr>`).join('') : '<tr><td colspan="8" class="text-center muted">Papelera vacía.</td></tr>';
  } catch (e) { showToast('error', 'Error', 'Error papelera: ' + e.message); }
}

async function papeleraPurgar() {
  if (!confirm('¿Eliminar definitivamente todos los registros expirados (>5 años)?')) return;
  try {
    const r = await apiFetch('/papelera/purgar', 'POST');
    showToast('success', 'Papelera purgada', r.mensaje);
    await initPapelera();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function papeleraEliminarDefinitivo(id) {
  if (!confirm('¿Eliminar este registro definitivamente? Esta acción es irreversible.')) return;
  try {
    await apiFetch(`/papelera/${id}`, 'DELETE', { forzar: true });
    showToast('success', 'Eliminado', 'Registro eliminado definitivamente');
    await initPapelera();
  } catch (e) { showToast('error', 'Error', e.message); }
}

async function papeleraEliminarSolicitud(idSolicitud) {
  if (!confirm(`¿Mover la solicitud ${idSolicitud} y sus CFDIs a la papelera?`)) return;
  try {
    showToast('info', 'Procesando', 'Moviendo a papelera...');
    const r = await apiFetch(`/papelera/solicitud/${idSolicitud}`, 'DELETE', {
      motivo: 'Eliminado por usuario'
    });
    showToast('success', 'Archivado', `${r.cfdis_archivados} CFDIs archivados, ${r.archivos_eliminados} archivos eliminados`);
    await papeleraLoadStats();
    return true;
  } catch (e) {
    showToast('error', 'Error', e.message);
    return false;
  }
}

function papeleraFiltrar(tipo) {
  papeleraFiltroTipo = tipo;
  papeleraLoadListado();
}
