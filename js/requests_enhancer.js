// ===== MEJORADOR DE TABLA DE SOLICITUDES =====

class RequestsEnhancer {
    constructor() {
        this.init();
    }

    init() {
        this.enhanceTable();
        // this.addFilters(); // Replaced by ui_enhancements.js
        // this.addSearch(); // Replaced by ui_enhancements.js
        this.addSorting();
        this.updateProgressBars();
        // this.setupAutoRefresh(); // Replaced by ui_enhancements.js
        this.addSelectionCheckboxes(); // New: Checkboxes
        this.addBulkActions(); // New: Bulk buttons
        this.observeTableChanges();
    }

    observeTableChanges() {
        const tbody = document.querySelector('#requests-table-body');
        if (!tbody) return;

        const observer = new MutationObserver(() => {
            this.enhanceTable(); // Re-apply styles
            this.createMobileCards(); // Re-create cards
            this.updateProgressBars(); // Update bars
            // this.applyFilters(); // Removed to avoid conflict with ui_enhancements.js
            this.restoreSelection(); // Restore checked state
            
            // Re-apply ui_enhancements filter if active
            if (window.filterRequests) {
                window.filterRequests();
            }
        });

        observer.observe(tbody, { childList: true, subtree: true });
    }

    addSelectionCheckboxes() {
        const table = document.querySelector('#requestsTable');
        if (!table) return;

        // Header Checkbox
        // Note: main.js might add its own header checkbox in future, or we rely on this one.
        // Currently main.js does NOT add a header checkbox, but it DOES add row checkboxes.
        // We need to align with main.js structure:
        // main.js creates: <thead><tr><th width="40"><input type="checkbox" id="select-all-requests"></th>...
        
        // So we should check if header checkbox exists (added by main.js or us)
        let selectAll = document.getElementById('select-all-requests');
        
        if (!selectAll) {
             // Try to find if we added it previously with class
             selectAll = table.querySelector('.select-all-checkbox');
        }

        if (!selectAll) {
             // Check if main.js structure is present (it has <th><input...>)
             // If not, we add it.
             const theadRow = table.querySelector('thead tr');
             if (theadRow) {
                 // Check if first column is checkbox column
                 const firstTh = theadRow.cells[0];
                 if (firstTh && firstTh.querySelector('input[type="checkbox"]')) {
                     selectAll = firstTh.querySelector('input[type="checkbox"]');
                 } else {
                     // Insert new column
                     const th = document.createElement('th');
                     th.className = 'select-all-header';
                     th.width = '40px';
                     th.innerHTML = '<input type="checkbox" class="select-all-checkbox" title="Seleccionar todo">';
                     theadRow.insertBefore(th, theadRow.firstChild);
                     selectAll = th.querySelector('input[type="checkbox"]');
                 }
             }
        }

        if (selectAll) {
            // Re-attach event listener (safe to do multiple times if we remove old one, but better to be idempotent)
            // Clone and replace to strip old listeners is a quick hack, or just add if not present
            // Let's use a flag or just add it.
            if (!selectAll.dataset.listenerAttached) {
                selectAll.addEventListener('change', (e) => {
                    // Support both .row-checkbox (ours) and .request-checkbox (main.js)
                    const checkboxes = document.querySelectorAll('.row-checkbox, .request-checkbox');
                    checkboxes.forEach(cb => {
                        if (cb.closest('tr').style.display !== 'none') {
                            cb.checked = e.target.checked;
                        }
                    });
                    this.updateBulkButtonState();
                });
                selectAll.dataset.listenerAttached = "true";
            }
        }

        // Row Checkboxes
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            // Check if main.js already added a checkbox (class .request-checkbox)
            const existingCb = row.querySelector('.request-checkbox');
            
            if (existingCb) {
                // Ensure it triggers our bulk state update
                if (!existingCb.dataset.listenerAttached) {
                    existingCb.addEventListener('change', () => this.updateBulkButtonState());
                    existingCb.dataset.listenerAttached = "true";
                }
                return; // Skip adding new one
            }

            if (row.querySelector('.row-checkbox-cell')) return;
            
            // If main.js didn't add it (legacy row?), add ours
            const td = document.createElement('td');
            // ID is in the first cell if no checkbox, or second if checkbox exists?
            // Safer: look for ID in cell with monospace font or just first text cell
            const id = row.cells[0].textContent.trim(); 
            
            td.className = 'row-checkbox-cell align-middle';
            td.innerHTML = `<input type="checkbox" class="row-checkbox" value="${id}">`;
            row.insertBefore(td, row.firstChild);
            
            const checkbox = td.querySelector('.row-checkbox');
            checkbox.addEventListener('change', () => this.updateBulkButtonState());
        });
    }

    restoreSelection() {
        // Re-attach checkboxes to new rows if needed
        this.addSelectionCheckboxes();
    }

    addBulkActions() {
        const container = document.querySelector('.requests-filters');
        if (!container || document.querySelector('.bulk-actions')) return;

        const bulkHTML = `
            <div class="bulk-actions" style="display:none; margin-left: auto; align-items: center; gap: 10px;">
                <span class="selected-count text-sm text-gray-600">0 seleccionados</span>
                <button id="btnConsolidate" class="btn-primary btn-sm" style="background-color: #2c3e50;">
                    <i class="fas fa-file-archive"></i> Descargar Unificado (ZIP)
                </button>
                <button id="btnDeleteBulk" class="btn-sm" style="background-color: #ef4444; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    <i class="fas fa-trash-alt"></i> Eliminar
                </button>
            </div>
        `;
        
        // Insert after filters or inside
        container.insertAdjacentHTML('beforeend', bulkHTML);
        
        document.getElementById('btnConsolidate').addEventListener('click', () => this.downloadConsolidated());
        document.getElementById('btnDeleteBulk').addEventListener('click', () => this.deleteSelected());
    }

    async deleteSelected() {
        const checked = document.querySelectorAll('.row-checkbox:checked, .request-checkbox:checked');
        const ids = Array.from(checked).map(cb => cb.value.trim()); // Trim IDs
        
        if (ids.length === 0) return;

        const confirmMsg = `¿Estás seguro de que deseas eliminar ${ids.length} registros?\n\nEsta acción borrará el historial y los archivos descargados.`;
        if (!confirm(confirmMsg)) return;

        const btn = document.getElementById('btnDeleteBulk');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ...';
        btn.disabled = true;

        try {
            const rfc = document.getElementById('filterRFC')?.value || localStorage.getItem('sat_rfc');
            
            // Fix: Use global API_URL from main.js if available, else relative path
            const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : '/api';
            const endpoint = `${apiUrl}/sat/delete`;

            console.log('Sending delete request to:', endpoint, ids);

            const token = localStorage.getItem('token') || '';
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    ids: ids,
                    rfc: rfc,
                    deleteFiles: true
                })
            });

            const contentType = response.headers.get("content-type");
            if (!contentType || !contentType.includes("application/json")) {
                 const text = await response.text();
                 throw new Error(`Server returned non-JSON response (${response.status}): ${text.substring(0, 100)}...`);
            }

            const data = await response.json();
            
            if (response.ok) {
                const count = data.affectedRows !== undefined ? data.affectedRows : ids.length;
                alert(`✅ ${count} registros eliminados correctamente.`);
                
                // Remove rows from UI immediately
                checked.forEach(cb => {
                    const tr = cb.closest('tr');
                    if(tr) tr.remove();
                });
                
                // Also reload to sync
                if (typeof loadSatRequestHistory === 'function') {
                    setTimeout(() => loadSatRequestHistory(), 500); // Small delay to ensure DB sync
                } else {
                    window.location.reload();
                }

                // Reset bulk actions
                this.updateBulkButtonState();
            } else {
                alert('Error: ' + (data.error || 'No se pudieron eliminar los registros'));
            }
        } catch (error) {
            console.error(error);
            alert('Error de conexión al eliminar: ' + error.message);
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    updateBulkButtonState() {
        const checked = document.querySelectorAll('.row-checkbox:checked, .request-checkbox:checked');
        const bulkActions = document.querySelector('.bulk-actions');
        const countSpan = document.querySelector('.selected-count');
        
        if (checked.length > 0) {
            bulkActions.style.display = 'flex';
            countSpan.textContent = `${checked.length} seleccionados`;
        } else {
            bulkActions.style.display = 'none';
        }
    }

    async downloadConsolidated() {
        const checked = document.querySelectorAll('.row-checkbox:checked, .request-checkbox:checked');
        
        let allPackageIds = [];
        checked.forEach(cb => {
            try {
                // Try to get packages from data attribute (main.js style)
                const packagesStr = cb.getAttribute('data-packages');
                if (packagesStr) {
                    const packets = JSON.parse(packagesStr);
                    if (Array.isArray(packets)) {
                        allPackageIds = allPackageIds.concat(packets);
                    }
                } else {
                    // Fallback: if no data-packages, assume value might be useful or log warning
                    // But typically value is RequestID, not PackageID.
                    // We'll skip if no packages found to avoid sending RequestIDs as PackageIDs
                    console.warn('No packages found for checkbox value:', cb.value);
                }
            } catch (e) {
                console.error('Error parsing packages for checkbox', e);
            }
        });
        
        // Deduplicate
        allPackageIds = [...new Set(allPackageIds)];
        
        if (allPackageIds.length === 0) {
            alert('Las solicitudes seleccionadas no contienen paquetes para descargar.');
            return;
        }

        const btn = document.getElementById('btnConsolidate');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando...';
        btn.disabled = true;

        try {
            // Get RFC from filter or first row?
            // Ideally we need the RFC. Let's try to find it from the filter or assume currently active user.
            // If the user has a mix of RFCs (unlikely in this view), we might have an issue.
            // But usually we filter by RFC or it's the logged in user.
            // Let's grab it from the "RFC" column if it exists, or the filter.
            
            // Heuristic: Get RFC from the filter dropdown if selected
            let rfc = document.getElementById('filterRFC')?.value;
            
            // Fix: Use global API_URL
            const apiUrl = (typeof API_URL !== 'undefined') ? API_URL : '/api';
            
            let response;
            // Use apiFetch if available (handles auth), otherwise fallback to fetch
            if (typeof apiFetch === 'function') {
                response = await apiFetch('/sat/consolidate', {
                    method: 'POST',
                    body: JSON.stringify({ 
                        packageIds: allPackageIds,
                        rfc: rfc || undefined
                    })
                });
            } else {
                const token = localStorage.getItem('token');
                response = await fetch(`${apiUrl}/sat/consolidate`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': token ? `Bearer ${token}` : ''
                    },
                    body: JSON.stringify({ 
                        packageIds: allPackageIds,
                        rfc: rfc || undefined
                    })
                });
            }

            if (response.ok) {
                // It returns a blob/download
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                
                // Get filename from header
                const disposition = response.headers.get('Content-Disposition');
                let filename = `Consolidado_${new Date().toISOString().slice(0,10)}.zip`;
                if (disposition && disposition.indexOf('attachment') !== -1) {
                    const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
                    const matches = filenameRegex.exec(disposition);
                    if (matches != null && matches[1]) { 
                        filename = matches[1].replace(/['"]/g, '');
                    }
                }
                
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                a.remove();
            } else {
                const err = await response.json();
                alert('Error: ' + (err.error || 'Error al consolidar'));
            }
        } catch (error) {
            console.error(error);
            alert('Error de conexión al consolidar');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    enhanceTable() {
        const table = document.querySelector('#requestsTable');
        if (!table) return;

        // Agregar clases modernas
        table.classList.add('requests-table');
        
        // Mejorar encabezados
        const headers = table.querySelectorAll('thead th');
        headers.forEach(header => {
            header.classList.add('text-left', 'font-medium');
        });

        // Mejorar celdas
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            cells.forEach(cell => {
                cell.classList.add('align-middle');
            });

            // Agregar efecto hover
            row.addEventListener('mouseenter', () => {
                row.classList.add('hover:bg-gray-50');
            });
            row.addEventListener('mouseleave', () => {
                row.classList.remove('hover:bg-gray-50');
            });
        });

        this.createMobileCards();
    }

    createMobileCards() {
        const table = document.querySelector('#requestsTable');
        if (!table) return;

        const container = document.querySelector('#requestsContainer');
        if (!container) return;

        let cardsContainer = document.getElementById('requestsCards');
        if (!cardsContainer) {
            cardsContainer = document.createElement('div');
            cardsContainer.id = 'requestsCards';
            cardsContainer.className = 'requests-cards';
            container.appendChild(cardsContainer);
        } else {
            cardsContainer.innerHTML = '';
        }

        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 6) return;

            const card = this.createCardFromRow(cells);
            cardsContainer.appendChild(card);
        });
    }

    createCardFromRow(cells) {
        const card = document.createElement('div');
        card.className = 'request-card';

        // Detect offset if first cell is checkbox
        let offset = 0;
        if (cells[0].querySelector('input[type="checkbox"]')) {
            offset = 1;
        }

        const id = cells[offset].textContent.trim();
        const fecha = cells[offset + 1].textContent.trim();
        const tipo = cells[offset + 2].textContent.trim();
        const estado = cells[offset + 3].textContent.trim();
        const paquetes = cells[offset + 4].textContent.trim();
        const acciones = cells[offset + 5] ? cells[offset + 5].innerHTML : '';

        const estadoClass = this.getEstadoClass(estado);

        card.innerHTML = `
            <div class="card-header">
                <div>
                    <div class="card-title">Solicitud #${id}</div>
                    <div class="card-id">ID: ${id}</div>
                </div>
                <span class="status-badge ${estadoClass}">${estado}</span>
            </div>
            
            <div class="card-details">
                <div class="detail-item">
                    <span class="detail-label">Fecha</span>
                    <span class="detail-value">${fecha}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Tipo</span>
                    <span class="detail-value font-medium">${tipo}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Paquetes</span>
                    <span class="detail-value">${paquetes}</span>
                </div>
            </div>
            
            <div class="progress-wrapper">
                <div class="progress-bar-request">
                    <div class="progress-fill ${estadoClass}" style="width: ${this.getProgressWidth(estado)}%"></div>
                </div>
                <span class="progress-status ${estadoClass}">${this.getProgressText(estado)}</span>
            </div>
            
            <div class="action-buttons">
                ${acciones}
            </div>
        `;

        return card;
    }

    getEstadoClass(estado) {
        const estados = {
            'Pendiente': 'status-pending',
            'Aceptada': 'status-pending', // Warning color
            'En Proceso': 'status-processing', // Info color
            'Procesando': 'status-processing',
            'Completado': 'status-completed',
            'Terminada': 'status-completed', // Success color
            'Error': 'status-error',
            'Rechazada': 'status-error',
            'Vencida': 'status-pending' // Gray/Secondary
        };
        return estados[estado] || 'status-pending';
    }

    getProgressWidth(estado) {
        const progress = {
            'Pendiente': 25,
            'Aceptada': 10,
            'En Proceso': 50,
            'Procesando': 50,
            'Completado': 100,
            'Terminada': 100,
            'Error': 100,
            'Rechazada': 100,
            'Vencida': 100
        };
        return progress[estado] || 25;
    }

    getProgressText(estado) {
        const texts = {
            'Pendiente': 'Pendiente',
            'Aceptada': 'Aceptada',
            'En Proceso': 'Procesando',
            'Procesando': 'Procesando',
            'Completado': '100%',
            'Terminada': '100%',
            'Error': 'Error',
            'Rechazada': 'Rechazada',
            'Vencida': 'Vencida'
        };
        return texts[estado] || '...';
    }

    addFilters() {
        const container = document.querySelector('#requestsContainer');
        if (!container) return;

        const filtersHTML = `
            <div class="requests-filters">
                <div class="filter-group">
                    <label class="filter-label">Estado</label>
                    <select class="filter-select" id="filterEstado">
                        <option value="">Todos los estados</option>
                        <option value="Aceptada">Aceptada</option>
                        <option value="En Proceso">En Proceso</option>
                        <option value="Terminada">Terminada</option>
                        <option value="Error">Error</option>
                        <option value="Rechazada">Rechazada</option>
                        <option value="Vencida">Vencida</option>
                    </select>
                </div>
                
                <div class="filter-group">
                    <label class="filter-label">RFC</label>
                    <select class="filter-select" id="filterRFC">
                        <option value="">Todos los RFC</option>
                        <!-- Se llenará dinámicamente -->
                    </select>
                </div>
                
                <div class="filter-group">
                    <label class="filter-label">Fecha</label>
                    <input type="date" class="filter-input" id="filterFecha">
                </div>
                
                <div class="filter-group">
                    <label class="filter-label">Buscar</label>
                    <input type="text" class="filter-input" id="filterSearch" placeholder="Buscar solicitud...">
                </div>
            </div>
        `;

        container.insertAdjacentHTML('afterbegin', filtersHTML);
        this.setupFilterEvents();
    }

    setupFilterEvents() {
        const filterEstado = document.getElementById('filterEstado');
        const filterRFC = document.getElementById('filterRFC');
        const filterFecha = document.getElementById('filterFecha');
        const filterSearch = document.getElementById('filterSearch');

        if (filterEstado) {
            filterEstado.addEventListener('change', () => this.applyFilters());
        }
        if (filterRFC) {
            filterRFC.addEventListener('change', () => this.applyFilters());
        }
        if (filterFecha) {
            filterFecha.addEventListener('change', () => this.applyFilters());
        }
        if (filterSearch) {
            filterSearch.addEventListener('input', () => this.applyFilters());
        }
    }

    applyFilters() {
        const estado = document.getElementById('filterEstado')?.value || '';
        const rfc = document.getElementById('filterRFC')?.value || '';
        const fecha = document.getElementById('filterFecha')?.value || '';
        const search = document.getElementById('filterSearch')?.value || '';

        const rows = document.querySelectorAll('#requestsTable tbody tr, .request-card');
        
        rows.forEach(row => {
            let show = true;
            
            // Filtrar por estado
            if (estado) {
                const rowEstado = row.querySelector('.status-badge')?.textContent || 
                                 row.cells[3]?.textContent.trim();
                if (rowEstado !== estado) show = false;
            }
            
            // Filtrar por búsqueda
            if (search) {
                const rowText = row.textContent.toLowerCase();
                if (!rowText.includes(search.toLowerCase())) show = false;
            }
            
            // Aplicar visibilidad
            row.style.display = show ? '' : 'none';
        });
    }

    addSearch() {
        // Ya implementado en filters
    }

    addSorting() {
        const headers = document.querySelectorAll('#requestsTable thead th');
        headers.forEach((header, index) => {
            header.style.cursor = 'pointer';
            header.addEventListener('click', () => this.sortTable(index));
        });
    }

    sortTable(columnIndex) {
        const table = document.querySelector('#requestsTable');
        if (!table) return;

        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));

        rows.sort((a, b) => {
            const aValue = a.cells[columnIndex]?.textContent.trim();
            const bValue = b.cells[columnIndex]?.textContent.trim();
            
            // Ordenar numéricamente para IDs, fechas, etc.
            if (columnIndex === 0) {
                return aValue.localeCompare(bValue, undefined, { numeric: true });
            } else if (columnIndex === 1) {
                return new Date(aValue) - new Date(bValue);
            } else {
                return aValue.localeCompare(bValue);
            }
        });

        // Limpiar y reordenar
        tbody.innerHTML = '';
        rows.forEach(row => tbody.appendChild(row));
    }

    updateProgressBars() {
        const progressCells = document.querySelectorAll('.progress-cell');
        progressCells.forEach(cell => {
            const estado = cell.previousElementSibling?.textContent.trim();
            if (estado) {
                const progressHTML = `
                    <div class="progress-wrapper">
                        <div class="progress-bar-request">
                            <div class="progress-fill ${this.getEstadoClass(estado)}" 
                                 style="width: ${this.getProgressWidth(estado)}%"></div>
                        </div>
                        <span class="progress-status ${this.getEstadoClass(estado)}">
                            ${this.getProgressText(estado)}
                        </span>
                    </div>
                `;
                cell.innerHTML = progressHTML;
            }
        });
    }

    setupAutoRefresh() {
        // Auto-refresh cada 30 segundos para actualizar estados
        setInterval(() => {
            if (document.visibilityState === 'visible') {
                this.refreshRequests();
            }
        }, 30000);
    }

    refreshRequests() {
        // Aquí iría la lógica para actualizar las solicitudes
        console.log('Actualizando estados de solicitudes...');
        // location.reload(); // O hacer fetch a la API
    }

    addSkeletonLoading() {
        const container = document.querySelector('#requestsContainer');
        if (!container) return;

        const skeletonHTML = `
            <div class="requests-container">
                <div class="requests-header">
                    <div class="skeleton skeleton-text" style="width: 200px; height: 32px;"></div>
                    <div class="skeleton skeleton-button"></div>
                </div>
                
                <div class="requests-filters">
                    <div class="filter-group">
                        <div class="skeleton skeleton-text" style="width: 80px;"></div>
                        <div class="skeleton skeleton-text" style="width: 120px; height: 38px;"></div>
                    </div>
                    <div class="filter-group">
                        <div class="skeleton skeleton-text" style="width: 80px;"></div>
                        <div class="skeleton skeleton-text" style="width: 120px; height: 38px;"></div>
                    </div>
                </div>
                
                <div class="skeleton skeleton-text" style="height: 300px; border-radius: 12px;"></div>
            </div>
        `;

        container.innerHTML = skeletonHTML;
    }
}

// Inicializar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    window.requestsEnhancer = new RequestsEnhancer();
});

// Exportar para uso global
window.RequestsEnhancer = RequestsEnhancer;