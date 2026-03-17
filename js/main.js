
// Global state
let currentUser = null;
let backendOnline = false;

// =====================================================
// CLAVE localStorage para persistir jobs SAT en curso
// Si la página se recarga durante un download, el job
// se recupera automáticamente sin perder el progreso.
// =====================================================
const PENDING_JOB_KEY = 'etx_sat_pending_job';

// =====================================================
// API URL — determina el endpoint correcto según entorno
//
// ESTRATEGIA ANTI-CORS (3 capas):
//   1. Node directo (puerto 3000) → /api relativo
//   2. Apache con proxy .htaccess → /api relativo (mismo origen, sin CORS)
//   3. Fallback directo → http://localhost:3000/api (con CORS headers en Node)
//
// La ruta relativa /api funciona porque el .htaccess hace ProxyPass
// de /ETX/Tax/api/ → http://localhost:3000/api/
// =====================================================
function resolveApiUrl() {
    const { port, pathname } = window.location;
    // Running directly on Node backend
    if (port === '3000') return '/api';
    // Apache: construye la URL relativa al sitio actual
    // pathname ejemplo: /ETX/Tax/index.html → base = /ETX/Tax
    const base = pathname.replace(/\/[^/]*$/, '') // quita el archivo final
                         .replace(/\/$/, '');       // quita trailing slash
    // Si estamos en la raíz o en subdirectorio, el proxy hace /ETX/Tax/api/ → Node
    if (base) return `${base}/api`;
    return '/api';
}
const API_URL = resolveApiUrl();

// URL directa al Node (fallback de emergencia)
// ─ En desarrollo local (XAMPP): intenta conectar directo al puerto 3000 de Node
// ─ En producción cloud: NO hay localhost:3000 accesible desde el navegador,
//   así que reutilizamos API_URL (el proxy Nginx ya apunta a Node).
//   Si el proxy falla en cloud, ambas URLs fallan igual — offline mode se activa.
const _isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const API_URL_DIRECT = _isLocalhost ? 'http://localhost:3000/api' : API_URL;

let currentStep = 1;

const _NGROK_H = window.location.hostname.includes('ngrok') ? { 'ngrok-skip-browser-warning': 'true' } : {};

// =====================================================
// SPLASH SCREEN
// =====================================================
function hideSplash(msg) {
    const hint = document.getElementById('splash-hint-text');
    if (hint && msg) hint.textContent = msg;
    setTimeout(() => {
        const s = document.getElementById('splash-screen');
        if (s) s.classList.add('splash-hidden');
    }, 600);
}

// =====================================================
// TOAST NOTIFICATIONS
// =====================================================
const TOAST_ICONS = {
    success: 'fas fa-check-circle',
    error:   'fas fa-times-circle',
    warning: 'fas fa-exclamation-triangle',
    info:    'fas fa-info-circle'
};

function showToast(type, title, message, duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <i class="toast-icon ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i>
        <div class="toast-body">
            <div class="toast-title">${title}</div>
            ${message ? `<div class="toast-msg">${message}</div>` : ''}
        </div>
        <button class="toast-close" onclick="dismissToast(this.parentElement)" title="Cerrar">
            <i class="fas fa-times"></i>
        </button>`;

    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => dismissToast(toast), duration);
    }
    return toast;
}

function dismissToast(toast) {
    if (!toast || toast.classList.contains('toast-hiding')) return;
    toast.classList.add('toast-hiding');
    setTimeout(() => toast.remove(), 300);
}

// =====================================================
// LOGIN STATUS PANEL helpers
// =====================================================
function setLoginStatus(id, state, valueText) {
    const item = document.getElementById(id);
    if (!item) return;
    const dot = item.querySelector('.ls-dot');
    const val = item.querySelector('.ls-value');
    if (dot) {
        dot.className = 'ls-dot ls-dot-' + state;
    }
    if (val && valueText !== undefined) val.textContent = valueText;
}

// =====================================================
// BACKEND STATUS CHECK
// Usa /api/health (no requiere token → sin 401 en consola)
// Prueba proxy Apache primero, luego Node directo
// =====================================================
async function checkBackendStatus() {
    const badge = document.getElementById('backend-status-badge');
    const text = document.getElementById('backend-status-text');
    if (!badge) return;

    // No mostrar "verificando" en checks silenciosos (solo al inicio)
    if (badge.className.includes('status-offline') || badge.className.includes('status-checking')) {
        badge.className = 'status-badge status-checking';
        if (text) text.textContent = 'Verificando...';
    }

    for (const baseUrl of [API_URL, API_URL_DIRECT]) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`${baseUrl}/health`, { signal: controller.signal, headers: _NGROK_H });
            clearTimeout(tid);

            if (res.ok) {
                backendOnline = true;
                badge.className = 'status-badge status-online';
                if (text) text.textContent = 'Servidor activo';

                // Actualizar login status panel
                setLoginStatus('ls-backend', 'ok', 'Activo');
                // Intentar obtener estado de DB desde /health
                try {
                    const health = await res.clone().json().catch(() => ({}));
                    if (health.db === 'ok' || health.database === 'ok') {
                        setLoginStatus('ls-db', 'ok', 'Conectada');
                    } else {
                        setLoginStatus('ls-db', 'error', 'Sin conexión');
                    }
                } catch (_) {
                    setLoginStatus('ls-db', 'ok', 'OK');
                }
                setLoginStatus('ls-mode', 'ok', 'En línea');

                // Quitar bloqueo offline si había
                updateOfflineLocks(true);
                hideSplash('Sistema listo');
                return;
            }
        } catch (_) { /* try next url */ }
    }

    backendOnline = false;
    badge.className = 'status-badge status-offline';
    if (text) text.textContent = 'Servidor offline';

    // Actualizar login status panel
    setLoginStatus('ls-backend', 'error', 'No responde');
    setLoginStatus('ls-db', 'offline', 'N/A');
    setLoginStatus('ls-mode', 'offline', 'Sin servidor');

    // Aplicar bloqueo offline a secciones que requieren backend
    updateOfflineLocks(false);
    hideSplash('Modo sin servidor activo');
}

// =====================================================
// OFFLINE LOCK — bloquea paneles que requieren backend
// =====================================================
function updateOfflineLocks(online) {
    // IDs de paneles que NO funcionan sin backend
    const lockedPanels = ['panel-2', 'panel-3', 'auditoria-section'];
    const banner = document.querySelector('.offline-banner');

    lockedPanels.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (online) {
            el.classList.remove('offline-locked');
        } else {
            el.classList.add('offline-locked');
        }
    });

    if (banner) {
        banner.classList.toggle('visible', !online);
    }

    // Toast cuando el estado cambia
    if (!online && backendOnline === false) {
        // Solo mostrar 1 vez al iniciar, no en cada check periódico
    }
}

// =====================================================
// PASSWORD TOGGLE
// =====================================================
function togglePasswordVisibility() {
    const input = document.getElementById('login-password');
    const icon = document.getElementById('eye-icon');
    if (!input || !icon) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fas fa-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'fas fa-eye';
    }
}

// =====================================================
// AUTHENTICATION & STARTUP
// =====================================================

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');

    // FIX BUG 3: Siempre mostrar el login-overlay por defecto.
    // Solo se oculta si hay token Y se verifica con el servidor que sigue siendo válido.
    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.style.display = 'flex';

    if (token && userStr) {
        try {
            currentUser = JSON.parse(userStr);
            // Verificar con el servidor que el token sigue siendo válido
            // antes de ocultar el login. Usamos /api/auth/verify o /api/health con token.
            verifyTokenAndInit(token, loginOverlay);
        } catch (e) {
            console.error('Error parsing stored user:', e);
            localStorage.clear();
            // loginOverlay ya está visible, no hace falta más
        }
    }
    // Si no hay token, loginOverlay queda visible (correcto)

    // Limitar inputs de fecha al día de hoy (SAT no acepta fechas futuras)
    const todayStr = new Date().toISOString().slice(0, 10);
    ['date-start', 'date-end', 'date-full-start', 'date-full-end'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.max = todayStr;
            // Si el valor guardado es futuro, corregirlo a hoy
            if (el.value && el.value > todayStr) el.value = todayStr;
        }
    });

    // Pre-fill RFC if available
    const lastRfc = localStorage.getItem('last_rfc');
    const rfcInput = document.getElementById('rfc-input');
    if (lastRfc && rfcInput) rfcInput.value = lastRfc;

    // Check backend status (también oculta el splash cuando termina)
    checkBackendStatus().finally(() => {
        // Garantizar que el splash se oculte incluso si checkBackendStatus lanza error
        hideSplash();
    });
    setInterval(checkBackendStatus, 30000);

    // RFC input formatting
    if (rfcInput) {
        rfcInput.addEventListener('input', function() {
            this.value = this.value.toUpperCase().replace(/[^A-Z0-9&]/g, '');
        });
    }
});

// FIX BUG 3 — Valida el token contra el servidor antes de mostrar el dashboard.
// Si el servidor confirma que es válido → oculta el login y muestra el sistema.
// Si el token expiró o el servidor no responde → deja el login visible.
// Usa /auth/session que ya existe en el backend.
async function verifyTokenAndInit(token, loginOverlay) {
    const urlsToTry = [`${API_URL}/auth/session`, `${API_URL_DIRECT}/auth/session`];
    for (const url of urlsToTry) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}`, ..._NGROK_H },
                signal: controller.signal
            });
            clearTimeout(tid);
            if (res.ok) {
                // Token válido: mostrar el sistema
                if (loginOverlay) loginOverlay.style.display = 'none';
                updateAdminUI();
                selectStep(1);
                return;
            } else if (res.status === 401) {
                // Token inválido o expirado: limpiar y dejar login visible
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                currentUser = null;
                return;
            }
        } catch (_) {
            // Si el servidor no responde, asumimos token posiblemente válido
            // y dejamos entrar (modo offline / servidor caído)
        }
    }
    // Si ninguna URL respondió (servidor offline): confiar en el token local
    if (loginOverlay) loginOverlay.style.display = 'none';
    updateAdminUI();
    selectStep(1);
}

async function attemptLogin(event) {
    event.preventDefault();

    const userInput = document.getElementById('login-user');
    const passInput = document.getElementById('login-password');
    const errorDiv = document.getElementById('login-error');
    const errorMsg = document.getElementById('login-error-msg');
    const infoDiv = document.getElementById('login-info');
    const infoMsg = document.getElementById('login-info-msg');
    const submitBtn = document.getElementById('login-submit-btn');

    // Reset state
    errorDiv.style.display = 'none';
    infoDiv.style.display = 'none';
    userInput.classList.remove('error');
    passInput.classList.remove('error');

    const username = userInput.value.trim();
    const password = passInput.value;

    if (!username || !password) {
        errorMsg.textContent = 'Por favor ingresa usuario y contraseña';
        errorDiv.style.display = 'flex';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Conectando...</span>';

    // Try proxy first, then direct Node URL (anti-CORS fallback)
    const loginUrls = [
        `${API_URL}/auth/login`,
        `${API_URL_DIRECT}/auth/login`
    ];

    let lastError = null;
    let loginOk = false;

    for (const loginUrl of loginUrls) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(loginUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ..._NGROK_H },
                body: JSON.stringify({ username, password }),
                signal: controller.signal
            });
            clearTimeout(tid);

            const data = await response.json();

            if (response.ok) {
                backendOnline = true;
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                currentUser = data.user;
                loginOk = true;
                showToast('success', 'Sesión iniciada', `Bienvenido, ${data.user.username}`);
                onLoginSuccess();
                break;
            } else {
                // Server responded with error (wrong credentials, etc.) — don't try next URL
                lastError = new Error(data.error || 'Credenciales incorrectas');
                break;
            }
        } catch (e) {
            lastError = e;
            // Only continue to next URL on network errors
            const isNetwork = e.name === 'AbortError' || e.name === 'TypeError';
            if (!isNetwork) break;
        }
    }

    if (!loginOk) {
        const isNetworkError = lastError && (lastError.name === 'AbortError' || lastError.name === 'TypeError');

        if (isNetworkError) {
            errorMsg.textContent = 'El servidor no está disponible. Verifica tu conexión e intenta de nuevo.';
            errorDiv.style.display = 'flex';
        } else {
            errorMsg.textContent = (lastError && lastError.message) || 'Credenciales incorrectas';
            errorDiv.style.display = 'flex';
        }
        userInput.classList.add('error');
        passInput.classList.add('error');
    }

    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> <span>Iniciar Sesión</span>';
}

function onLoginSuccess() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) {
        overlay.style.animation = 'loginFadeOut 0.3s ease-out forwards';
        setTimeout(() => {
            overlay.style.display = 'none';
            overlay.style.animation = '';
        }, 300);
    }
    updateAdminUI();
    // Mostrar/ocultar banner offline según estado del servidor
    updateOfflineLocks(backendOnline);
    checkBackendStatus();
    // Recuperar cualquier job SAT que estuviera en curso antes de recargar la página
    if (backendOnline) setTimeout(checkPendingJob, 3000); // dar 3s al servidor para que responda
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    currentUser = null;
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.style.display = 'flex';
    // Clear sensitive session data
    sessionStorage.removeItem('sat_password');
    sessionStorage.removeItem('sat_rfc');
    location.reload();
}

// FIX BUG 2 — Control de sesión expirada sin expulsar al usuario de forma brusca.
// En vez de llamar logout() directamente al primer 401, mostramos un aviso
// y esperamos confirmación del usuario antes de cerrar sesión.
let _sessionExpiredShown = false;
function handleSessionExpired() {
    if (_sessionExpiredShown) return; // evitar múltiples avisos simultáneos
    _sessionExpiredShown = true;
    showToast('warning', 'Sesión expirada',
        'Tu sesión ha vencido. Por favor vuelve a iniciar sesión.', 0);
    // Dar 2 segundos de gracia para que el usuario lea el mensaje, luego cerrar sesión limpiamente
    setTimeout(() => {
        _sessionExpiredShown = false;
        logout();
    }, 2500);
}

// Helper for authorized fetch
// Intenta primero con proxy (/api), luego URL directa (http://localhost:3000/api) anti-CORS
async function apiFetch(endpoint, options = {}) {
    const token = localStorage.getItem('token');

    const headers = {
        ...options.headers,
        'Authorization': token ? `Bearer ${token}` : '',
        ..._NGROK_H
    };

    if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const config = { ...options, headers };

    // Try proxy first, then direct
    const urlsToTry = [`${API_URL}${endpoint}`, `${API_URL_DIRECT}${endpoint}`];

    for (const url of urlsToTry) {
        try {
            const res = await fetch(url, config);

            // FIX BUG 2: mostrar aviso antes de cerrar sesión, no cerrarla de golpe
            if (res.status === 401) {
                handleSessionExpired();
                throw new Error('Sesión expirada');
            }

            // If proxy returns 502/503 (gateway error), try direct URL
            if ((res.status === 502 || res.status === 503) && url === urlsToTry[0]) {
                console.warn('[apiFetch] Proxy error, retrying direct...');
                continue;
            }

            return res;
        } catch (e) {
            if (e.message === 'Sesión expirada') throw e;
            // Network error — try next URL
        }
    }

    throw new TypeError('No se pudo conectar al servidor. Verifica que Node.js esté corriendo en el puerto 3000.');
}

// Helper for file upload (multipart/form-data) - same dual-URL strategy
async function apiFetchForm(endpoint, formData) {
    const token = localStorage.getItem('token');
    const headers = { 'Authorization': token ? `Bearer ${token}` : '', ..._NGROK_H };

    const urlsToTry = [`${API_URL}${endpoint}`, `${API_URL_DIRECT}${endpoint}`];

    for (const url of urlsToTry) {
        try {
            const res = await fetch(url, { method: 'POST', headers, body: formData });
            // FIX BUG 2: mismo tratamiento de 401 que apiFetch
            if (res.status === 401) {
                handleSessionExpired();
                throw new Error('Sesión expirada');
            }
            return res;
        } catch (e) {
            if (e.message === 'Sesión expirada') throw e;
        }
    }

    throw new TypeError('No se pudo conectar al servidor.');
}

// =====================================================
// UI NAVIGATION
// =====================================================

function selectStep(step) {
    // Solo módulos activos: 1 (Autenticación), 2 (Adquisición), 3 (Procesamiento)
    if (step > 3) return;
    currentStep = step;

    // Update cards
    document.querySelectorAll('.process-card').forEach(c => {
        c.classList.remove('active');
        if (parseInt(c.dataset.step) === step) c.classList.add('active');
    });

    // Update panels
    document.querySelectorAll('.detail-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById(`panel-${step}`);
    if (panel) panel.style.display = 'block';
    
    // Load data for specific steps
    if (step === 2) { loadDownloadHistory(); updateStep2Rfc(); }
    if (step === 3) loadFlattenPackages();

    // Scroll to process section
    const section = document.getElementById('proceso');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── RFC activo en cabecera Paso 2 ───────────────────────────────────────────
function updateStep2Rfc() {
    const rfc = sessionStorage.getItem('sat_rfc') || window._satRfc || '';
    const el  = document.getElementById('step2-rfc-value');
    const col = document.getElementById('step2-rfc-display');
    if (!el) return;
    if (rfc) {
        el.textContent = rfc;
        el.classList.remove('empty');
        if (col) col.classList.add('rfc-activo');
    } else {
        el.textContent = 'Sin autenticar';
        el.classList.add('empty');
        if (col) col.classList.remove('rfc-activo');
    }
}

function showTab(step, tabName) {
    // Update buttons
    const panel = document.getElementById(`panel-${step}`);
    panel.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    
    // Find button that triggered this (rough approximation)
    const buttons = panel.querySelectorAll('.detail-tab');
    buttons.forEach(b => {
        if (b.getAttribute('onclick').includes(`'${tabName}'`)) {
            b.classList.add('active');
        }
    });

    // Update content
    panel.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`panel-${step}-${tabName}`).classList.add('active');

    // Auto-reload history when opening that tab
    if (step === 2 && tabName === 'history') loadDownloadHistory();
}

function showSection(mode) {
    const sections = document.querySelectorAll('main > section');
    const auditoriaSection = document.getElementById('auditoria-section');

    // Ocultar todo primero
    sections.forEach(s => s.style.display = 'none');
    if (auditoriaSection) auditoriaSection.classList.remove('active');

    // Secciones especiales (no se muestran en modo estándar)
    const ESPECIALES = [
      'admin','auditoria-section','fiscal','estados-cuenta','validacion-section','contribuyentes'
    ];

    const secMap = {
      'admin':           () => {
          // Solo administradores pueden acceder a la gestión de usuarios
          if (!currentUser || currentUser.role !== 'admin') {
              showToast('warning', 'Acceso restringido', 'Solo los administradores pueden ver esta sección.');
              return;
          }
          const s = document.getElementById('admin'); if(s) s.style.display='block'; loadUsers();
      },
      'fiscal':          () => { const s = document.getElementById('fiscal'); if(s) s.style.display='block'; if(typeof loadFiscalDashboard==='function') loadFiscalDashboard(); },
      'estados-cuenta':  () => { const s = document.getElementById('estados-cuenta'); if(s) s.style.display='block'; if(typeof ecLoadDashboard==='function') ecLoadDashboard(); },
      'auditoria':       () => { if(auditoriaSection){ auditoriaSection.style.display='block'; auditoriaSection.classList.add('active'); if(typeof initAuditoria==='function') initAuditoria(); } },
      'validacion':      () => { const s = document.getElementById('validacion-section'); if(s) s.style.display='block'; if(typeof valInit==='function') valInit(); },
      'contribuyentes':  () => { const s = document.getElementById('contribuyentes'); if(s) s.style.display='block'; loadContribuyentes(); },
    };

    if (secMap[mode]) {
        secMap[mode]();
    } else {
        // Modo estándar: mostrar secciones normales
        sections.forEach(s => {
            if (!ESPECIALES.includes(s.id)) s.style.display = 'block';
        });
        selectStep(currentStep);
    }
}


// =====================================================
// DOWNLOAD MODE SWITCHER (Step 2)
// =====================================================

function switchDownloadMode(mode) {
    document.getElementById('mode-custom-panel').style.display  = mode === 'custom'  ? '' : 'none';
    document.getElementById('mode-annual-panel').style.display  = mode === 'annual'  ? '' : 'none';
    document.getElementById('mode-custom').classList.toggle('active', mode === 'custom');
    document.getElementById('mode-annual').classList.toggle('active', mode === 'annual');
}

// =====================================================
// ANNUAL BULK DOWNLOAD (Step 2 — new)
// =====================================================

let annualJobId   = null;
let annualPollInt = null;

async function startAnnualDownload() {
    if (!window._satRfc || !window._satPassword) {
        showNotification('Primero completa el Paso 1 — Autenticación con e.Firma', 'error');
        selectStep(1);
        return;
    }

    const yearFrom  = document.getElementById('annual-year-from').value;
    const yearTo    = document.getElementById('annual-year-to').value;
    const type      = document.getElementById('annual-type').value;
    const cfdiType  = document.getElementById('annual-cfdi-type').value;
    const btn       = document.getElementById('btn-annual-download');

    if (parseInt(yearFrom) > parseInt(yearTo)) {
        showNotification('El año inicial no puede ser mayor que el año final', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Iniciando...';

    const panel = document.getElementById('annual-progress-panel');
    panel.style.display = '';
    document.getElementById('annual-download-btn-wrap').style.display = 'none';
    document.getElementById('annual-months-grid').innerHTML = '';

    try {
        const res = await fetch(`${API_URL}/sat/bulk-year`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
            },
            body: JSON.stringify({
                rfc:            window._satRfc,
                password:       window._satPassword,
                yearFrom,
                yearTo,
                type,
                cfdi_type:      cfdiType,
                status:         'Todos',
                autoConsolidate: true,
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            showNotification(`Error al iniciar: ${err.error || res.statusText}`, 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-file-archive"></i> Iniciar Descarga Anual → 1 ZIP';
            return;
        }

        const data    = await res.json();
        annualJobId   = data.jobId;
        showNotification(`Descarga anual iniciada — ${data.totalMonths} meses en cola`, 'info');

        // Start polling
        annualPollInt = setInterval(pollAnnualJob, 4000);

    } catch (err) {
        showNotification(`Error de conexión: ${err.message}`, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-file-archive"></i> Iniciar Descarga Anual → 1 ZIP';
    }
}

async function pollAnnualJob() {
    if (!annualJobId) return;

    try {
        const res  = await fetch(`${API_URL}/sat/bulk-job/${annualJobId}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (!res.ok) return;
        const job  = await res.json();

        // Update progress bar
        const pct  = job.progress || 0;
        document.getElementById('annual-progress-fill').style.width = pct + '%';
        document.getElementById('annual-pct-label').textContent = pct + '%';

        // Update phase label
        const phaseLabels = {
            requesting:    '<i class="fas fa-paper-plane"></i> Enviando solicitudes al SAT...',
            verifying:     '<i class="fas fa-search"></i> Esperando que el SAT prepare los paquetes...',
            downloading:   '<i class="fas fa-cloud-download-alt"></i> Descargando paquetes ZIP...',
            consolidating: '<i class="fas fa-file-archive"></i> Consolidando en un solo ZIP...',
            done:          '<i class="fas fa-check-circle" style="color:var(--accent-green)"></i> ¡Completado!',
            error:         '<i class="fas fa-times-circle" style="color:var(--accent-red)"></i> Error',
        };
        document.getElementById('annual-phase-label').innerHTML =
            phaseLabels[job.phase] || `<i class="fas fa-spinner fa-spin"></i> ${job.message || ''}`;

        // Render month badges
        if (job.requests && job.requests.length > 0) {
            renderMonthBadges(job.requests);
        }

        // Done
        if (job.status === 'done' || job.status === 'done_with_errors' || job.status === 'partial' || job.status === 'error') {
            clearInterval(annualPollInt);
            annualPollInt = null;

            const btn = document.getElementById('btn-annual-download');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-file-archive"></i> Nueva Descarga Anual';

            if (job.downloadUrl) {
                const wrap = document.getElementById('annual-download-btn-wrap');
                const link = document.getElementById('annual-zip-link');
                link.href = API_URL + job.downloadUrl.replace('/api', '');
                document.getElementById('annual-zip-size').textContent =
                    `${(job.zipSize / 1024 / 1024).toFixed(1)} MB`;
                wrap.style.display = '';
            }

            const type = job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : 'warning';
            showNotification(job.message || 'Descarga anual finalizada', type);
        }

    } catch (err) {
        console.warn('[AnnualPoll] Error:', err.message);
    }
}

function renderMonthBadges(requests) {
    const grid = document.getElementById('annual-months-grid');
    grid.innerHTML = '';
    requests.forEach(req => {
        const div  = document.createElement('div');
        const stateClass = req.status === '3' ? 'month-done' :
                           req.status === 'error' ? 'month-error' :
                           req.status === '2' ? 'month-processing' : 'month-pending';
        const stateIcon  = req.status === '3' ? '✅' :
                           req.status === 'error' ? '❌' :
                           req.status === '2' ? '⏳' : '○';
        div.className  = `month-badge ${stateClass}`;
        div.title      = req.error || (req.packages?.length ? `${req.packages.length} paquetes` : 'Sin paquetes');
        div.textContent = `${stateIcon} ${req.month || ''}`;
        grid.appendChild(div);
    });
}

// =====================================================
// STEP 1: AUTHENTICATION (SAT)
// =====================================================

function validateRFC(rfc) {
    // RFC format: 3-4 letters + 6 digits (YYMMDD) + 3 alphanumeric
    const rfcPersonaMoral = /^[A-Z]{3}[0-9]{6}[A-Z0-9]{3}$/;
    const rfcPersonaFisica = /^[A-Z]{4}[0-9]{6}[A-Z0-9]{3}$/;
    return rfcPersonaMoral.test(rfc) || rfcPersonaFisica.test(rfc);
}

function addSimLine(outputEl, text, type = '') {
    const line = document.createElement('div');
    line.className = 'sim-line';
    line.innerHTML = `<span class="sim-prompt">$</span> <span class="sim-output ${type}">${text}</span>`;
    outputEl.appendChild(line);
    outputEl.scrollTop = outputEl.scrollHeight;
}

async function authenticateSat() {
    const rfcInput = document.getElementById('rfc-input');
    const rfc = rfcInput ? rfcInput.value.trim().toUpperCase() : '';
    const cerFile = document.getElementById('cer-file').files[0];
    const keyFile = document.getElementById('key-file').files[0];
    const password = document.getElementById('password-input').value;
    const output = document.getElementById('auth-output');
    const btn = document.getElementById('btn-auth');

    // Validations
    if (!rfc) {
        showAuthError(output, 'RFC es requerido');
        return;
    }
    if (!validateRFC(rfc)) {
        showAuthError(output, `RFC inválido: "${rfc}". Formato esperado: XAXX010101000 (PM) o XAXX010101XXX (PF)`);
        return;
    }
    if (!cerFile) {
        showAuthError(output, 'Debes seleccionar el archivo .cer (certificado)');
        return;
    }
    if (!cerFile.name.endsWith('.cer')) {
        showAuthError(output, 'El archivo de certificado debe tener extensión .cer');
        return;
    }
    if (!keyFile) {
        showAuthError(output, 'Debes seleccionar el archivo .key (llave privada)');
        return;
    }
    if (!keyFile.name.endsWith('.key')) {
        showAuthError(output, 'El archivo de llave debe tener extensión .key');
        return;
    }
    if (!password) {
        showAuthError(output, 'La contraseña de la FIEL es requerida');
        return;
    }

    if (!backendOnline) {
        showAuthError(output, 'El servidor backend no está disponible. Inicia el servidor Node.js primero.');
        return;
    }

    btn.disabled = true;
    output.innerHTML = '';
    addSimLine(output, `Iniciando autenticación para RFC: ${rfc}...`);
    addSimLine(output, `Cargando certificado: ${cerFile.name} (${(cerFile.size/1024).toFixed(1)} KB)`);
    addSimLine(output, `Cargando llave privada: ${keyFile.name} (${(keyFile.size/1024).toFixed(1)} KB)`);
    addSimLine(output, 'Conectando con servicios SAT...');

    const formData = new FormData();
    formData.append('rfc', rfc);
    formData.append('cer', cerFile);
    formData.append('key', keyFile);
    formData.append('password', password);

    try {
        const res = await apiFetchForm('/sat/config', formData);
        const data = await res.json();

        if (res.ok) {
            addSimLine(output, `✅ ${data.message || 'Autenticación exitosa con el SAT'}`, 'success');
            addSimLine(output, `🔑 Token SAT válido por 5 minutos`, 'info');
            addSimLine(output, `📋 RFC configurado: ${rfc}`, 'info');

            // Enable step 2
            const step2Status = document.querySelector('.process-card[data-step="2"] .process-status');
            if (step2Status) {
                step2Status.innerHTML = '<span class="badge-dot"></span> Habilitado';
                step2Status.style.color = 'var(--accent-green)';
            }
            document.getElementById('btn-download').disabled = false;

            // Store credentials for annual download
            window._satRfc      = rfc;
            window._satPassword = password;
            updateStep2Rfc();
            const annualBtn = document.getElementById('btn-annual-download');
            if (annualBtn) annualBtn.disabled = false;
            const fullBtn = document.getElementById('btn-full-download');
            if (fullBtn) fullBtn.disabled = false;

            sessionStorage.setItem('sat_password', password);
            sessionStorage.setItem('sat_rfc', rfc);
            localStorage.setItem('last_rfc', rfc);

            setTimeout(() => selectStep(2), 1800);
        } else {
            const errMsg = data.error || 'Error desconocido';
            addSimLine(output, `❌ Error SAT: ${errMsg}`, 'error');
            if (errMsg.includes('contraseña') || errMsg.includes('password') || errMsg.includes('invalid')) {
                addSimLine(output, '⚠️ Verifica que la contraseña de la FIEL sea correcta', 'error');
            }
            if (errMsg.includes('certificado') || errMsg.includes('certificate')) {
                addSimLine(output, '⚠️ El certificado (.cer) puede estar vencido o ser incorrecto', 'error');
            }
        }
    } catch (e) {
        console.error(e);
        addSimLine(output, `❌ Error de conexión: ${e.message}`, 'error');
        addSimLine(output, '💡 Verifica que el servidor backend esté corriendo en el puerto 3000', 'error');
    } finally {
        btn.disabled = false;
    }
}

function showAuthError(output, message) {
    addSimLine(output, `⚠️ ${message}`, 'error');
}

// =====================================================
// STEP 2: DOWNLOAD
// =====================================================

async function requestDownloadSat() {
    const start = document.getElementById('date-start').value;
    const end = document.getElementById('date-end').value;
    const type = document.getElementById('download-type').value;
    const cfdiType = document.getElementById('cfdi-type').value;
    const cfdiStatus = document.getElementById('cfdi-status') ? document.getElementById('cfdi-status').value : 'Todos';
    const output = document.getElementById('download-output');
    const btn = document.getElementById('btn-download');
    
    const rfc = sessionStorage.getItem('sat_rfc');
    const password = sessionStorage.getItem('sat_password');

    // Validation for SAT restrictions
    if (type === 'CFDI') {
        if (cfdiStatus === 'Cancelado') {
            alert('Error: El SAT no permite la descarga de XMLs (CFDI) cancelados mediante este servicio. Por favor selecciona "Metadata" si necesitas información de cancelados.');
            btn.disabled = false;
            return;
        }
        if (cfdiStatus === 'Todos') {
            if (!confirm('Aviso SAT: Para descargas de XML (CFDI), el servicio solo permite descargar comprobantes VIGENTES. Los cancelados serán omitidos automáticamente para evitar errores. ¿Deseas continuar?')) {
                btn.disabled = false;
                return;
            }
        }
    }

    if (!rfc || !password) {
        alert('Por favor autentícate primero en el Paso 1.');
        selectStep(1);
        return;
    }

    btn.disabled = true;
    output.innerHTML = '';
    const progBar = document.getElementById('download-progress');
    const progFill = document.getElementById('progress-fill');
    const progPct = document.getElementById('progress-percent');
    if (progBar) progBar.style.display = 'block';
    if (progFill) { progFill.style.width = '5%'; progFill.style.backgroundColor = ''; }
    if (progPct) progPct.innerText = '0%';

    addSimLine(output, `Solicitando descarga: ${type} / ${cfdiType} del ${start} al ${end}`);
    addSimLine(output, `RFC: ${rfc} — enviando al SAT...`);

    try {
        const res = await apiFetch('/sat/request', {
            method: 'POST',
            body: JSON.stringify({ rfc, password, start, end, type, cfdi_type: cfdiType, status: cfdiStatus })
        });

        // Fix 3: manejar respuestas no-JSON (HTML de error 502/503)
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`El servidor devolvió una respuesta inesperada (${res.status}). Verifica que el backend Node.js esté corriendo.`);
        }

        const data = await res.json();

        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

        // El backend ahora responde INMEDIATAMENTE con un jobId
        if (data.jobId) {
            addSimLine(output, `✅ Solicitud aceptada — Job ID: ${data.jobId.substring(0, 8)}...`, 'success');
            // Avisar si la fecha final fue capeada a hoy
            if (data.effectiveEnd && data.effectiveEnd !== document.getElementById('date-end')?.value) {
                addSimLine(output, `⚠️ Fecha final ajustada a ${data.effectiveEnd} (SAT no acepta fechas futuras)`, 'warning');
            }
            addSimLine(output, `⏳ Procesando ${data.totalChunks} período(s) en background...`, 'info');
            // Poll for job completion
            await pollJobStatus(data.jobId, output, progFill, progPct, data.totalChunks);
        } else {
            // Legacy sync response
            addSimLine(output, `✅ ${data.message}`, 'success');
            if (progFill) progFill.style.width = '100%';
            if (progPct) progPct.innerText = '100%';
            loadDownloadHistory();
        }
    } catch (e) {
        console.error('[Download]', e);
        addSimLine(output, `❌ Error: ${e.message}`, 'error');
        addSimLine(output, '💡 Si el error persiste, verifica que el backend Node.js esté corriendo en el puerto 3000.', 'error');
        if (progFill) progFill.style.backgroundColor = '#ef4444';
    } finally {
        btn.disabled = false;
    }
}

// =====================================================
// HELPER: Traduce errores SAT a mensajes legibles
// Detecta códigos 5002, 5011, etc. dentro de cualquier texto de error
// =====================================================
function parseSatWarning(text) {
    if (!text) return 'Error desconocido';
    const t = String(text);
    if (t.includes('5002')) {
        return `El SAT rechazó esta solicitud (código 5002): ya existe una solicitud con ese periodo exacto. Cambia la fecha de inicio o fin aunque sea un día para crear un periodo diferente.`;
    }
    if (t.includes('5011')) {
        return `El SAT rechazó esta solicitud (código 5011): alcanzaste el límite diario de solicitudes. Espera 24 horas antes de intentar de nuevo.`;
    }
    if (t.includes('5003')) {
        return `El SAT rechazó esta solicitud (código 5003): el periodo contiene más de 200,000 CFDIs. Divide el rango en periodos más cortos (por semana o quincena).`;
    }
    if (t.includes('5004')) {
        return `El SAT indica que no hay información (código 5004): no existen CFDIs en ese periodo para tu RFC.`;
    }
    if (t.includes('5005')) {
        return `El SAT rechazó esta solicitud (código 5005): solicitud duplicada. Ya hay una solicitud en proceso con los mismos parámetros.`;
    }
    if (t.includes('300') || t.includes('usuario inválido') || t.includes('FIEL')) {
        return `El SAT rechazó la autenticación (código 300): verifica que tu FIEL no esté vencida y que el RFC sea correcto.`;
    }
    return t;
}

// Polling para el job asíncrono de /sat/request
async function pollJobStatus(jobId, output, progFill, progPct, totalChunks) {
    const maxWait = 180000; // 3 min max
    const interval = 3000;  // poll cada 3s
    const started = Date.now();

    // ── Persistir en localStorage para recuperación tras recarga ──
    localStorage.setItem(PENDING_JOB_KEY, JSON.stringify({
        jobId, totalChunks, startedAt: Date.now()
    }));

    return new Promise((resolve) => {
        const tick = async () => {
            if (Date.now() - started > maxWait) {
                addSimLine(output, '⚠️ Tiempo de espera agotado. Verifica el historial en unos minutos.', 'error');
                localStorage.removeItem(PENDING_JOB_KEY);
                loadDownloadHistory();
                return resolve();
            }

            try {
                const res = await apiFetch(`/sat/job/${jobId}`);
                if (!res.ok) { setTimeout(tick, interval); return; }
                const job = await res.json();

                // Update progress bar
                const pct = totalChunks > 0 ? Math.round(((job.progress || 0) / totalChunks) * 90) + 5 : 50;
                if (progFill) progFill.style.width = `${pct}%`;
                if (progPct) progPct.innerText = `${pct}%`;

                if (job.status === 'done') {
                    if (progFill) progFill.style.width = '100%';
                    if (progPct) progPct.innerText = '100%';
                    addSimLine(output, `✅ ${job.message}`, 'success');
                    if (job.warnings && job.warnings.length > 0) {
                        job.warnings.forEach(w => {
                            // Detectar errores SAT específicos y mostrar mensaje claro
                            const satMsg = parseSatWarning(w);
                            addSimLine(output, `⚠️ ${satMsg}`, 'error');
                        });
                    }
                    localStorage.removeItem(PENDING_JOB_KEY); // ← limpiar al terminar
                    loadDownloadHistory();
                    resolve();
                } else if (job.status === 'error') {
                    const satMsg = parseSatWarning(job.error || '');
                    addSimLine(output, `❌ ${satMsg}`, 'error');
                    if (progFill) progFill.style.backgroundColor = '#ef4444';
                    localStorage.removeItem(PENDING_JOB_KEY); // ← limpiar en error
                    resolve();
                } else {
                    // Still processing
                    const lastLine = output.querySelector('.sim-line:last-child .sim-output');
                    if (lastLine && lastLine.textContent.startsWith('⏳')) {
                        lastLine.textContent = `⏳ ${job.message}`;
                    } else {
                        addSimLine(output, `⏳ ${job.message}`, 'info');
                    }
                    setTimeout(tick, interval);
                }
            } catch (_) {
                setTimeout(tick, interval);
            }
        };
        setTimeout(tick, interval);
    });
}

// =====================================================
// DESCARGA COMPLETA 4 EN 1
// Lanza Metadata+CFDI × Recibidos+Emitidos en paralelo
// =====================================================

async function startFullDownload() {
    const rfc = sessionStorage.getItem('sat_rfc');
    const password = sessionStorage.getItem('sat_password');

    if (!rfc || !password) {
        alert('Por favor autentícate primero en el Paso 1.');
        selectStep(1);
        return;
    }

    const start = document.getElementById('date-full-start').value;
    const end = document.getElementById('date-full-end').value;
    const status = document.getElementById('full-cfdi-status').value;

    if (!start || !end) {
        alert('Por favor selecciona las fechas de inicio y fin.');
        return;
    }

    const output = document.getElementById('full-output');
    const btn = document.getElementById('btn-full-download');
    btn.disabled = true;
    output.innerHTML = '';

    const requests = [
        { type: 'Metadata', cfdi_type: 'RECEIVED', label: 'Metadata Recibidos', cardId: 'mr' },
        { type: 'Metadata', cfdi_type: 'ISSUED',   label: 'Metadata Emitidos',  cardId: 'me' },
        { type: 'CFDI',     cfdi_type: 'RECEIVED', label: 'CFDI Recibidos',     cardId: 'cr' },
        { type: 'CFDI',     cfdi_type: 'ISSUED',   label: 'CFDI Emitidos',      cardId: 'ce' },
    ];

    // Reset all cards to "En proceso"
    requests.forEach(req => {
        const fill = document.getElementById(`full-fill-${req.cardId}`);
        const st = document.getElementById(`full-status-${req.cardId}`);
        const msg = document.getElementById(`full-msg-${req.cardId}`);
        if (fill) { fill.style.width = '0%'; fill.style.backgroundColor = ''; }
        if (st)   { st.textContent = 'En proceso...'; st.style.color = 'var(--accent-blue)'; }
        if (msg)  { msg.textContent = 'Enviando solicitud al SAT...'; }
    });

    addSimLine(output, `Iniciando 4 solicitudes simultáneas: ${start} → ${end}`);
    addSimLine(output, `RFC: ${rfc} — Estatus: ${status}`);

    // Launch all 4 POST /sat/request in parallel
    const jobResults = await Promise.all(requests.map(async (req) => {
        const fill = document.getElementById(`full-fill-${req.cardId}`);
        const st   = document.getElementById(`full-status-${req.cardId}`);
        const msg  = document.getElementById(`full-msg-${req.cardId}`);
        if (fill) fill.style.width = '5%';

        // CFDI + Cancelado no es válido — usar Todos si status es Cancelado
        const effectiveStatus = (req.type === 'CFDI' && status === 'Cancelado') ? 'Todos' : status;

        try {
            const res = await apiFetch('/sat/request', {
                method: 'POST',
                body: JSON.stringify({ rfc, password, start, end, type: req.type, cfdi_type: req.cfdi_type, status: effectiveStatus })
            });

            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                throw new Error(`Respuesta inesperada del servidor (${res.status})`);
            }

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

            addSimLine(output, `✅ ${req.label} — Job ${data.jobId.substring(0, 8)}... aceptado`, 'success');
            if (msg) msg.textContent = `Job: ${data.jobId.substring(0, 8)}...`;
            return { req, jobId: data.jobId, totalChunks: data.totalChunks || 1 };
        } catch (e) {
            if (st)  { st.textContent = '❌ Error'; st.style.color = 'var(--danger)'; }
            if (msg) { msg.textContent = e.message; }
            if (fill) { fill.style.backgroundColor = '#ef4444'; }
            addSimLine(output, `❌ ${req.label}: ${e.message}`, 'error');
            return null;
        }
    }));

    const valid = jobResults.filter(r => r !== null);
    addSimLine(output, `⏳ Monitoreando ${valid.length}/4 jobs en paralelo...`, 'info');

    await Promise.allSettled(valid.map(({ req, jobId, totalChunks }) =>
        pollFullJob(jobId, req.cardId, req.label, totalChunks, output)
    ));

    addSimLine(output, '✅ Proceso completado. Revisa el historial de solicitudes.', 'success');
    loadDownloadHistory();
    btn.disabled = false;
}

async function pollFullJob(jobId, cardId, label, totalChunks, output) {
    const maxWait = 180000; // 3 min
    const interval = 3000;
    const started = Date.now();

    const fillEl   = document.getElementById(`full-fill-${cardId}`);
    const statusEl = document.getElementById(`full-status-${cardId}`);
    const msgEl    = document.getElementById(`full-msg-${cardId}`);

    return new Promise((resolve) => {
        const tick = async () => {
            if (Date.now() - started > maxWait) {
                if (statusEl) { statusEl.textContent = '⚠️ Timeout'; statusEl.style.color = 'var(--warning, #f59e0b)'; }
                if (msgEl)    { msgEl.textContent = 'Tiempo agotado. Verifica el historial.'; }
                addSimLine(output, `⚠️ ${label}: Timeout — verifica el historial`, 'error');
                return resolve();
            }

            try {
                const res = await apiFetch(`/sat/job/${jobId}`);
                if (!res.ok) { setTimeout(tick, interval); return; }
                const job = await res.json();

                const pct = totalChunks > 0 ? Math.round(((job.progress || 0) / totalChunks) * 90) + 5 : 50;
                if (fillEl) fillEl.style.width = `${Math.min(pct, 99)}%`;

                if (job.status === 'done') {
                    if (fillEl)   { fillEl.style.width = '100%'; }
                    if (statusEl) { statusEl.textContent = '✅ Listo'; statusEl.style.color = 'var(--accent-green)'; }
                    if (msgEl)    { msgEl.textContent = job.message || 'Completado'; }

                    if (job.warnings && job.warnings.length > 0) {
                        job.warnings.forEach(w => addSimLine(output, `⚠️ ${label}: ${parseSatWarning(w)}`, 'error'));
                    } else {
                        addSimLine(output, `✅ ${label}: ${job.message}`, 'success');
                    }
                    resolve();
                } else if (job.status === 'error') {
                    const satMsg = parseSatWarning(job.error || '');
                    if (statusEl) { statusEl.textContent = '❌ Error'; statusEl.style.color = 'var(--danger)'; }
                    if (msgEl)    { msgEl.textContent = satMsg; }
                    if (fillEl)   { fillEl.style.backgroundColor = '#ef4444'; }
                    addSimLine(output, `❌ ${label}: ${satMsg}`, 'error');
                    resolve();
                } else {
                    if (statusEl) { statusEl.textContent = '⏳ Procesando'; }
                    if (msgEl)    { msgEl.textContent = job.message || 'Procesando...'; }
                    setTimeout(tick, interval);
                }
            } catch (_) {
                setTimeout(tick, interval);
            }
        };
        setTimeout(tick, interval);
    });
}

// =====================================================
// RECUPERACIÓN TRAS RECARGA DE PÁGINA
// Detecta si había un job en curso y lo reanuda en
// background (sin necesitar los elementos de UI).
// Se llama desde onLoginSuccess().
// =====================================================
function checkPendingJob() {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    if (!raw) return;

    let meta;
    try { meta = JSON.parse(raw); } catch (_) { localStorage.removeItem(PENDING_JOB_KEY); return; }

    const { jobId, startedAt } = meta;
    const ageMin = Math.round((Date.now() - startedAt) / 60000);

    // Si tiene más de 30 min, el servidor ya lo limpió — descartar
    if (Date.now() - startedAt > 30 * 60 * 1000) {
        localStorage.removeItem(PENDING_JOB_KEY);
        return;
    }

    showToast('info', 'Descarga en progreso',
        `Hay una solicitud SAT iniciada hace ${ageMin} min. Verificando estado...`, 8000);

    apiFetch(`/sat/job/${jobId}`)
        .then(r => r.json())
        .then(job => {
            if (job.status === 'done') {
                localStorage.removeItem(PENDING_JOB_KEY);
                showToast('success', 'Descarga completada ✅', job.message || 'Solicitudes guardadas en historial.', 7000);
                loadDownloadHistory();
            } else if (job.status === 'error') {
                localStorage.removeItem(PENDING_JOB_KEY);
                showToast('error', 'Error en descarga', job.error || 'Revisa el historial.', 8000);
            } else {
                // Todavía procesando — arrancar polling silencioso
                backgroundPollJob(jobId);
            }
        })
        .catch(() => {
            // El servidor se reinició y perdió el job en memoria
            // Los datos que alcanzó a guardar en DB siguen intactos
            localStorage.removeItem(PENDING_JOB_KEY);
            showToast('warning', 'Servidor reiniciado',
                'El servidor se reinició mientras procesaba. Los períodos completados ya están en el historial.', 9000);
            setTimeout(loadDownloadHistory, 2000);
        });
}

// Polling silencioso (sin UI), solo actualiza historial al terminar
function backgroundPollJob(jobId) {
    const poll = async () => {
        try {
            const res = await apiFetch(`/sat/job/${jobId}`);
            if (!res.ok) { localStorage.removeItem(PENDING_JOB_KEY); return; }
            const job = await res.json();

            if (job.status === 'done') {
                localStorage.removeItem(PENDING_JOB_KEY);
                showToast('success', '✅ Descarga finalizada', job.message, 6000);
                loadDownloadHistory();
            } else if (job.status === 'error') {
                localStorage.removeItem(PENDING_JOB_KEY);
                showToast('error', 'Error en descarga', job.error, 6000);
            } else {
                setTimeout(poll, 5000); // sigue esperando
            }
        } catch (_) {
            // Error de red — reintentar en 10s, máx 3 veces implícito
            localStorage.removeItem(PENDING_JOB_KEY);
        }
    };
    setTimeout(poll, 5000);
}

async function loadDownloadHistory() {
    const rfc = sessionStorage.getItem('sat_rfc') || document.getElementById('rfc-input').value;
    const tbody = document.getElementById('requests-table-body');
    if (!tbody) return;

    if (!rfc) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-secondary);">
            <i class="fas fa-user-lock" style="font-size:2rem;margin-bottom:0.5rem;display:block;opacity:0.4"></i>
            Autentícate con el SAT en el Paso 1 para ver tu historial.
        </td></tr>`;
        return;
    }

    // Show loading spinner
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-secondary);">
        <i class="fas fa-spinner fa-spin" style="font-size:1.5rem;margin-bottom:0.5rem;display:block;"></i>
        Cargando historial para <strong>${rfc}</strong>…
    </td></tr>`;

    try {
        const res = await apiFetch(`/sat/history/${rfc}`);

        if (!res.ok) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--danger);">
                <i class="fas fa-exclamation-circle" style="font-size:1.5rem;margin-bottom:0.5rem;display:block;"></i>
                Error ${res.status} al cargar el historial. Intenta de nuevo.
            </td></tr>`;
            return;
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            console.error('[SAT /history] Respuesta no-JSON:', res.status, text.slice(0, 200));
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--danger);">
                <i class="fas fa-exclamation-triangle" style="font-size:1.5rem;margin-bottom:0.5rem;display:block;"></i>
                El servidor devolvió una respuesta inesperada. Verifica que Node.js esté corriendo.
            </td></tr>`;
            return;
        }

        const history = await res.json();
        tbody.innerHTML = '';

        if (history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-secondary);">
                <i class="fas fa-inbox" style="font-size:2rem;margin-bottom:0.5rem;display:block;opacity:0.4"></i>
                No hay solicitudes registradas para <strong>${rfc}</strong>.<br>
                <small>Las solicitudes aparecerán aquí después de usar "Solicitar Descarga".</small>
            </td></tr>`;
            return;
        }

        // Grouping Logic
        const groups = {};
        history.forEach(req => {
            const gid = req.group_id || req.id_solicitud;
            if (!groups[gid]) groups[gid] = [];
            groups[gid].push(req);
        });

        // Sort groups by latest date
        const sortedGroupIds = Object.keys(groups).sort((a, b) => {
            const dateA = Math.max(...groups[a].map(r => new Date(r.fecha_solicitud).getTime()));
            const dateB = Math.max(...groups[b].map(r => new Date(r.fecha_solicitud).getTime()));
            return dateB - dateA;
        });

        let processCounter = sortedGroupIds.length;

        for (const gid of sortedGroupIds) {
            const groupRequests = groups[gid];
            if (groupRequests.length === 1 && !groupRequests[0].group_id) {
                renderRow(groupRequests[0], tbody);
            } else {
                renderGroupRow(gid, groupRequests, tbody, processCounter);
            }
            processCounter--;
        }

    } catch (e) {
        console.error('Error loading history:', e);
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--danger);">
            <i class="fas fa-wifi" style="font-size:1.5rem;margin-bottom:0.5rem;display:block;"></i>
            No se pudo conectar al servidor. Verifica que el backend esté activo.<br>
            <small style="opacity:0.7">${e.message}</small>
        </td></tr>`;
    }
}

// SAT status codes dictionary (mirrors satHelpers.js SAT_STATUS_CODES)
const SAT_CODES_UI = {
    '5000': { label: 'Recibida',          pillClass: 'sat-code-ok',      icon: '✅', tip: null },
    '5001': { label: 'En proceso',        pillClass: 'sat-code-pending',  icon: '⏳', tip: null },
    '5002': { label: 'Límite de vida',    pillClass: 'sat-code-error',    icon: '🚫', tip: 'Cambia fecha ±1 s para crear un periodo diferente.' },
    '5003': { label: '>200k CFDIs',       pillClass: 'sat-code-warn',     icon: '⚠️', tip: 'Divide el rango en periodos más cortos.' },
    '5004': { label: 'Sin información',   pillClass: 'sat-code-info',     icon: 'ℹ️', tip: 'No hay CFDIs en ese periodo.' },
    '5005': { label: 'Duplicada',         pillClass: 'sat-code-warn',     icon: '🔁', tip: 'Ya existe una solicitud con esos parámetros.' },
    '5011': { label: 'Límite diario',     pillClass: 'sat-code-error',    icon: '⛔', tip: 'Espera 24 h antes de continuar.' },
    '300':  { label: 'Usuario inválido',  pillClass: 'sat-code-error',    icon: '❌', tip: 'FIEL vencida o datos incorrectos.' },
    '301':  { label: 'XML mal formado',   pillClass: 'sat-code-error',    icon: '❌', tip: 'Actualiza la librería SAT.' },
};

function buildSatCodePill(codigoEstado) {
    if (!codigoEstado) return '';
    const code = String(codigoEstado);
    const info = SAT_CODES_UI[code];
    if (!info) return `<span class="sat-code-pill sat-code-info" title="Código ${code}">${code}</span>`;
    const tipAttr = info.tip ? ` title="${info.tip}"` : ` title="${info.label}"`;
    return `<span class="sat-code-pill ${info.pillClass}"${tipAttr}>${info.icon} ${code}</span>`;
}

function renderRow(req, tbody, isChild = false) {
    const packets = parsePackets(req.paquetes);
    const packetCount = packets.length;

    const rawType    = req.tipo_solicitud || req.tipo || 'Desconocido';
    const isMetadata = rawType.toLowerCase().includes('metadata');
    const tipoBase   = isMetadata ? 'Metadata' : 'CFDI';
    const comprobante = (req.tipo_comprobante || '').toUpperCase();
    const esRecibidos = comprobante === 'RECEIVED';
    const esEmitidos  = comprobante === 'ISSUED';
    const direccion   = esRecibidos ? 'Recibidos' : esEmitidos ? 'Emitidos' : '';
    const typeLabel   = direccion ? `${tipoBase} ${direccion}` : tipoBase;
    const typeClass   = isMetadata
        ? (esEmitidos ? 'bg-secondary'   : 'bg-info text-dark')
        : (esEmitidos ? 'bg-success'     : 'bg-primary');
    const typeIcon    = esEmitidos  ? 'fa-arrow-circle-up'
                      : esRecibidos ? 'fa-arrow-circle-down'
                      : (isMetadata  ? 'fa-list-alt' : 'fa-file-invoice');

    let statusClass = 'bg-secondary';
    let statusText = 'Desconocido';
    let statusIcon = '○';
    const status = parseInt(req.estado_solicitud);

    if (status === 0)      { statusClass = 'bg-light text-dark border'; statusText = 'Pendiente';  statusIcon = '○';  }
    else if (status === 1) { statusClass = 'bg-warning text-dark';      statusText = 'Aceptada';   statusIcon = '✔';  }
    else if (status === 2) { statusClass = 'bg-info text-dark';         statusText = 'En Proceso'; statusIcon = '⏳'; }
    else if (status === 3) { statusClass = 'bg-success';                statusText = 'Terminada';  statusIcon = '✅'; }
    else if (status === 4) { statusClass = 'bg-danger';                 statusText = 'Error';      statusIcon = '❌'; }
    else if (status === 5) { statusClass = 'bg-danger';                 statusText = 'Rechazada';  statusIcon = '🚫'; }
    else if (status === 6) { statusClass = 'bg-secondary';              statusText = 'Vencida';    statusIcon = '⏰'; }
    // null/NaN → defaults 'bg-secondary' / 'Desconocido' / '○'

    // SAT response code pill (5000, 5002, etc.)
    const satCodePill = buildSatCodePill(req.codigo_estado_solicitud);

    const tr = document.createElement('tr');
    if (isChild) {
        tr.classList.add('table-light');
        tr.style.fontSize = '0.9em';
    }

    // Friendly date format
    const fmtDate = d => { try { return new Date(d).toLocaleDateString('es-MX', {day:'2-digit',month:'short',year:'numeric'}); } catch(_){ return d; } };

    tr.innerHTML = `
        <td><input type="checkbox" class="request-checkbox" value="${req.id_solicitud}" data-packages='${JSON.stringify(packets)}'></td>
        <td>
            <span class="badge bg-light text-dark border font-monospace" style="font-size:0.72rem;letter-spacing:-0.3px" title="${req.id_solicitud}">
                ${req.id_solicitud ? req.id_solicitud.substring(0, 16) + '…' : '—'}
            </span>
        </td>
        <td>
            <code class="hist-rfc-cell" data-rfc="${req.rfc || ''}">${req.rfc || '<span class="text-muted" style="font-size:0.7rem;">—</span>'}</code>
        </td>
        <td>
            <small class="text-muted">
                <i class="fas fa-calendar-alt" style="color:var(--accent-blue);margin-right:2px"></i>
                ${fmtDate(req.fecha_inicio)}<br>
                <i class="fas fa-calendar-check" style="color:var(--accent-green);margin-right:2px"></i>
                ${fmtDate(req.fecha_fin)}
            </small>
        </td>
        <td>
            <span class="badge ${typeClass}">
                <i class="fas ${typeIcon}"></i> ${typeLabel}
            </span>
        </td>
        <td>
            <span class="badge ${statusClass}" style="margin-bottom:3px">${statusIcon} ${statusText}</span>
            ${satCodePill ? `<br>${satCodePill}` : ''}
        </td>
        <td>
            ${packetCount > 0
                ? `<span class="badge bg-light text-success border"><i class="fas fa-box"></i> ${packetCount} paquete${packetCount!==1?'s':''}</span>`
                : '<span class="text-muted small">Sin paquetes</span>'}
        </td>
        <td>
            <div class="btn-group shadow-sm" role="group">
                <button class="btn btn-sm btn-outline-primary" onclick="verifyRequest('${req.id_solicitud}')" title="Verificar Estado en SAT">
                    <i class="fas fa-sync-alt"></i>
                </button>
                <button class="btn btn-sm btn-outline-success" onclick="downloadRequest('${req.id_solicitud}')" title="Descargar Paquetes al Servidor" ${status !== 3 ? 'disabled' : ''}>
                    <i class="fas fa-cloud-download-alt"></i>
                </button>
            </div>
        </td>
    `;
    tbody.appendChild(tr);
    return tr;
}

function renderGroupRow(gid, requests, tbody, processIndex) {
    // Calculate Aggregates
    const dates = requests.map(r => [new Date(r.fecha_inicio), new Date(r.fecha_fin)]).flat();
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    
    // Determine Type (Metadata/CFDI) + direction (Recibidos/Emitidos)
    const firstReq   = requests[0];
    const rawType    = firstReq.tipo_solicitud || firstReq.tipo || 'Desconocido';
    const isMetadata = rawType.toLowerCase().includes('metadata');
    const tipoBase   = isMetadata ? 'Metadata' : 'CFDI';
    const comprobante = (firstReq.tipo_comprobante || '').toUpperCase();
    const esRecibidos = comprobante === 'RECEIVED';
    const esEmitidos  = comprobante === 'ISSUED';
    const direccion   = esRecibidos ? 'Recibidos' : esEmitidos ? 'Emitidos' : '';
    const typeLabel   = direccion ? `${tipoBase} ${direccion}` : tipoBase;
    const grpTypeClass = isMetadata
        ? (esEmitidos ? 'bg-secondary'   : 'bg-info text-dark')
        : (esEmitidos ? 'bg-success'     : 'bg-primary');
    const grpTypeIcon  = esEmitidos  ? 'fa-arrow-circle-up'
                       : esRecibidos ? 'fa-arrow-circle-down'
                       : (isMetadata  ? 'fa-list-alt' : 'fa-file-invoice');
    
    const totalPackets = requests.reduce((acc, r) => acc + parsePackets(r.paquetes).length, 0);
    
    // Determine overall status
    const statuses = requests.map(r => parseInt(r.estado_solicitud));
    let groupStatusText = 'En Proceso';
    let groupStatusClass = 'bg-info text-dark';
    
    if (statuses.some(s => s === 4 || s === 5)) {
        groupStatusText = 'Error/Rechazada';
        groupStatusClass = 'bg-danger';
    } else if (statuses.every(s => s === 3)) {
        groupStatusText = 'Terminada';
        groupStatusClass = 'bg-success';
    } else if (statuses.every(s => s === 1 || s === 3)) {
        groupStatusText = 'Aceptada';
        groupStatusClass = 'bg-warning text-dark';
    }

    // Create Parent Row
    const tr = document.createElement('tr');
    tr.className = 'group-header table-active fw-bold';
    tr.style.cursor = 'pointer';
    tr.dataset.groupId = gid;
    
    // Toggle Collapse Logic
    tr.onclick = (e) => {
        if (e.target.type === 'checkbox' || e.target.closest('button')) return;
        const children = document.querySelectorAll(`.group-child-${gid}`);
        children.forEach(c => c.style.display = c.style.display === 'none' ? 'table-row' : 'none');
        const icon = tr.querySelector('.fa-chevron-down');
        if (icon) icon.classList.toggle('fa-rotate-180');
    };

    // Format Date Range
    const dateRangeStr = `${minDate.toLocaleDateString()} - ${maxDate.toLocaleDateString()}`;

    const groupRfc = firstReq.rfc || '—';
    tr.innerHTML = `
        <td><input type="checkbox" class="group-checkbox" onchange="toggleGroupSelection('${gid}', this)"></td>
        <td>
            <i class="fas fa-chevron-down text-muted me-2 transition-transform"></i>
            Proceso #${processIndex}
        </td>
        <td>
            <code class="hist-rfc-cell" data-rfc="${groupRfc}">${groupRfc}</code>
        </td>
        <td>
            ${dateRangeStr}
            <br><small class="text-muted">${requests.length} periodos</small>
        </td>
        <td>
            <span class="badge ${grpTypeClass}"><i class="fas ${grpTypeIcon}"></i> ${typeLabel}</span>
        </td>
        <td><span class="badge ${groupStatusClass}">${groupStatusText}</span></td>
        <td><span class="badge bg-light text-dark border"><i class="fas fa-boxes"></i> ${totalPackets}</span></td>
        <td>
            <div class="btn-group shadow-sm">
                <button class="btn btn-sm btn-outline-primary" onclick="verifyGroup('${gid}')" title="Verificar Todo el Lote">
                    <i class="fas fa-sync-alt"></i> Todo
                </button>
                <button class="btn btn-sm btn-outline-success" onclick="downloadGroup('${gid}')" title="Descargar Todo el Lote">
                    <i class="fas fa-cloud-download-alt"></i> Todo
                </button>
            </div>
        </td>
    `;
    tbody.appendChild(tr);

    // Render Children (Hidden by default)
    requests.forEach(req => {
        const childTr = renderRow(req, tbody, true);
        childTr.classList.add(`group-child-${gid}`);
        childTr.style.display = 'none'; // Initially collapsed
        // Add indentation to first cell content?
        childTr.cells[1].innerHTML = `<span class="ms-4">↳ ${req.id_solicitud}</span>`;
    });
}

// Group Actions
window.toggleGroupSelection = (gid, checkbox) => {
    const children = document.querySelectorAll(`.group-child-${gid} .request-checkbox`);
    children.forEach(cb => {
        cb.checked = checkbox.checked;
        // Trigger change event for bulk actions listener
        cb.dispatchEvent(new Event('change'));
    });
};

window.verifyGroup = async (gid) => {
    const children = document.querySelectorAll(`.group-child-${gid} .request-checkbox`);
    const ids = Array.from(children).map(cb => cb.value);
    
    if (ids.length === 0) return;

    if (confirm(`¿Verificar estado de ${ids.length} solicitudes? Esto puede tomar un momento.`)) {
        // Find group button
        const groupRow = document.querySelector(`tr[data-group-id="${gid}"]`);
        const btn = groupRow ? groupRow.querySelector('button[onclick^="verifyGroup"]') : null;
        const originalContent = btn ? btn.innerHTML : '';
        
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ...';
        }

        let successCount = 0;
        for (const id of ids) {
            try {
                await verifyRequest(id, { silent: true });
                successCount++;
            } catch (e) {
                console.error(`Error verifying ${id}:`, e);
            }
        }
        
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
        
        // Reload once
        loadDownloadHistory();
        alert(`Verificación completada: ${successCount}/${ids.length} solicitudes actualizadas.`);
    }
};

window.downloadGroup = async (gid) => {
    const children = document.querySelectorAll(`.group-child-${gid} .request-checkbox`);
    const ids = Array.from(children).map(cb => cb.value);
    
    if (ids.length === 0) return;

    if (confirm(`¿Descargar paquetes de ${ids.length} solicitudes?`)) {
        const groupRow = document.querySelector(`tr[data-group-id="${gid}"]`);
        const btn = groupRow ? groupRow.querySelector('button[onclick^="downloadGroup"]') : null;
        const originalContent = btn ? btn.innerHTML : '';
        
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ...';
        }

        let count = 0;
        for (const id of ids) {
            try {
                await downloadRequest(id, { silent: true });
                count++;
            } catch(e) { console.error(e); }
        }
        
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }

        loadDownloadHistory();
        alert(`Se iniciaron ${count} descargas. Revisa el progreso en unos momentos.`);
    }
};


async function verifyRequest(id, options = {}) {
    const rfc = sessionStorage.getItem('sat_rfc');
    const password = sessionStorage.getItem('sat_password');
    
    if (!rfc || !password) {
        if (!options.silent) alert('Credenciales no encontradas. Por favor re-autentícate.');
        return;
    }

    // Find button to show loading state (only if not silent batch)
    let btn = null;
    let originalContent = '';
    
    if (!options.silent) {
        btn = document.querySelector(`button[onclick="verifyRequest('${id}')"]`);
        originalContent = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }
    }

    try {
        const res = await apiFetch('/sat/verify', {
            method: 'POST',
            body: JSON.stringify({ rfc, password, id })
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            console.error('[SAT /verify] Respuesta no-JSON:', res.status, text.slice(0, 200));
            if (!options.silent) {
                alert('El servidor devolvió una respuesta inesperada al verificar la solicitud. Verifica que el backend Node.js esté corriendo y que la ruta /api apunte al servidor correcto.');
            }
            throw new Error(`Respuesta no-JSON (${res.status}) al verificar solicitud`);
        }

        const data = await res.json();

        if (res.ok) {
            // Reload list to show updates only if not silent
            if (!options.silent) loadDownloadHistory();
            return true;
        } else {
            if (!options.silent) alert('Error: ' + (data.error || 'No se pudo verificar'));
            throw new Error(data.error);
        }
    } catch (e) {
        console.error(e);
        if (!options.silent) alert('Error al conectar con el servidor');
        throw e;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

async function downloadRequest(id, options = {}) {
    const rfc = sessionStorage.getItem('sat_rfc');
    const password = sessionStorage.getItem('sat_password');
    
    if (!rfc || !password) {
        if (!options.silent) alert('Credenciales no encontradas. Por favor re-autentícate.');
        return;
    }

    let btn = null;
    let originalContent = '';

    if (!options.silent) {
        btn = document.querySelector(`button[onclick="downloadRequest('${id}')"]`);
        originalContent = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }
    }

    try {
        const res = await apiFetch('/sat/download', {
            method: 'POST',
            body: JSON.stringify({ rfc, password, id, force: false })
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            console.error('[SAT /download] Respuesta no-JSON:', res.status, text.slice(0, 200));
            if (!options.silent) {
                alert('El servidor devolvió una respuesta inesperada al descargar. Verifica que el backend Node.js esté corriendo y que la ruta /api apunte al servidor correcto.');
            }
            throw new Error(`Respuesta no-JSON (${res.status}) al descargar solicitud`);
        }

        const data = await res.json();

        if (res.ok) {
            if (!options.silent) {
                loadDownloadHistory();
                // Navegar al Paso 3 y refrescar la lista de paquetes automáticamente
                showStep(3);
                showToast('success', 'Descarga completada', 'Los paquetes están listos para procesar en el Paso 3.');
            }
            return true;
        } else {
            if (!options.silent) alert('Error: ' + (data.error || 'Error en la descarga'));
            throw new Error(data.error);
        }
    } catch (e) {
        console.error(e);
        if (!options.silent) alert('Error al conectar con el servidor');
        throw e;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

function parsePackets(paquetes) {
    if (!paquetes) return [];
    if (Array.isArray(paquetes)) return paquetes;
    try {
        return JSON.parse(paquetes);
    } catch {
        return [];
    }
}

// consolidateSelected moved to RequestsEnhancer class in requests_enhancer.js
// Function removed to avoid redundancy

// =====================================================
// STEP 3: FLATTENING WORKSPACE
// =====================================================

let selectedPackages = new Set();
let availablePackages = [];
let activeTypeFilter = null; // null | 'Metadata' | 'CFDI'

// ─── Descarga un reporte XLSX con autenticación ───────────────────────────────
async function downloadFlattenReport(filename) {
    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/flatten/download/${encodeURIComponent(filename)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`Error ${res.status}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        alert('Error al descargar: ' + e.message);
    }
}

// ─── Cargar reportes Reporte_Consolidado_*.xlsx históricos ───────────────────
async function loadGeneratedReports() {
    const reportsList = document.getElementById('reports-list');
    if (!reportsList) return;

    reportsList.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Cargando reportes...</p></div>';

    // Reset checkboxes
    const selAll = document.getElementById('select-all-reports');
    if (selAll) selAll.checked = false;
    updateDeleteReportsBtn();

    try {
        const res = await apiFetch('/flatten/reports');
        if (!res.ok) throw new Error('Error al listar reportes');
        const reports = await res.json();

        if (reports.length === 0) {
            reportsList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-clipboard-list"></i>
                    <p>Aún no hay reportes generados</p>
                </div>`;
            return;
        }

        reportsList.innerHTML = '';
        reports.forEach(r => {
            const safeId = r.filename.replace(/[^a-zA-Z0-9_\-]/g, '_');
            const card = document.createElement('div');
            card.className = 'report-card report-card-selectable';
            card.dataset.filename = r.filename;
            card.style.borderLeft = '4px solid var(--accent-green)';
            card.innerHTML = `
                <div style="display:flex; align-items:flex-start; gap:0.6rem; flex:1; min-width:0;">
                    <input type="checkbox" class="report-chk" id="rchk-${safeId}"
                           data-filename="${r.filename}"
                           onchange="updateDeleteReportsBtn()"
                           style="margin-top:0.25rem; cursor:pointer; flex-shrink:0;">
                    <div style="min-width:0;">
                        <div style="font-weight:600; margin-bottom:0.2rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                             title="${r.filename}">
                            <i class="fas fa-file-excel" style="color:#22c55e;margin-right:0.4rem;"></i>${r.filename}
                        </div>
                        <div style="font-size:0.78rem; color:var(--text-secondary);">
                            ${r.sizeFmt} &nbsp;·&nbsp; ${new Date(r.date).toLocaleString('es-MX')}
                        </div>
                    </div>
                </div>
                <div style="display:flex; gap:0.4rem; flex-shrink:0;">
                    <button class="btn btn-sm btn-outline" title="Descargar"
                            onclick="downloadFlattenReport('${r.filename}')">
                        <i class="fas fa-download"></i>
                    </button>
                    <button class="btn btn-sm" title="Eliminar este reporte"
                            onclick="deleteOneReport('${r.filename}')"
                            style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35);
                                   color:#f87171; border-radius:6px; padding:0.25rem 0.55rem; cursor:pointer;">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `;
            reportsList.appendChild(card);
        });
    } catch (e) {
        console.error('[Flatten] Error cargando reportes:', e);
        reportsList.innerHTML = '<div class="empty-state text-danger"><i class="fas fa-exclamation-triangle"></i><p>Error de conexión</p></div>';
    }
}

// ─── Actualiza visibilidad del botón "Eliminar seleccionados" ─────────────────
function updateDeleteReportsBtn() {
    const checked = document.querySelectorAll('.report-chk:checked').length;
    const btn = document.getElementById('btn-delete-reports');
    if (btn) {
        btn.style.display = checked > 0 ? 'inline-flex' : 'none';
        btn.innerHTML = `<i class="fas fa-trash"></i> Eliminar (${checked})`;
    }
}

// ─── Checkbox "Seleccionar todos" ─────────────────────────────────────────────
function toggleSelectAllReports(checked) {
    document.querySelectorAll('.report-chk').forEach(chk => chk.checked = checked);
    updateDeleteReportsBtn();
}

// ─── Eliminar un solo reporte ─────────────────────────────────────────────────
async function deleteOneReport(filename) {
    if (!confirm(`¿Eliminar el reporte "${filename}" y su versión CSV?\nEsta acción no se puede deshacer.`)) return;
    await _doDeleteReport(filename);
    loadGeneratedReports();
}

// ─── Eliminar todos los seleccionados ────────────────────────────────────────
async function deleteSelectedReports() {
    const checked = [...document.querySelectorAll('.report-chk:checked')];
    if (checked.length === 0) return;

    if (!confirm(`¿Eliminar ${checked.length} reporte(s) seleccionado(s) (xlsx + csv)?\nEsta acción no se puede deshacer.`)) return;

    let ok = 0, fail = 0;
    for (const chk of checked) {
        const result = await _doDeleteReport(chk.dataset.filename, false);
        if (result) ok++; else fail++;
    }

    showToast(
        fail === 0 ? 'success' : 'warning',
        'Reportes',
        fail === 0
            ? `${ok} reporte(s) eliminado(s) correctamente`
            : `${ok} eliminado(s), ${fail} fallaron`
    );
    loadGeneratedReports();
}

// ─── Helper interno de eliminación ───────────────────────────────────────────
async function _doDeleteReport(filename, showAlert = true) {
    try {
        const res = await apiFetch(`/flatten/reports/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            if (showAlert) showToast('success', 'Eliminado', `Reporte eliminado: ${data.deleted.join(', ')}`);
            return true;
        } else {
            if (showAlert) showToast('error', 'Error', data.error);
            return false;
        }
    } catch (e) {
        if (showAlert) showToast('error', 'Error de conexión', 'No se pudo contactar al servidor');
        return false;
    }
}

async function loadFlattenPackages() {
    const listContainer = document.getElementById('packages-list');
    const totalEl = document.getElementById('pkg-total');
    const processedEl = document.getElementById('pkg-processed');

    listContainer.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Cargando paquetes...</p></div>';
    selectedPackages.clear();
    updateSelectionUI();

    // Cargar también los reportes xlsx existentes
    loadGeneratedReports();

    try {
        const res = await apiFetch('/flatten/packages');
        if (!res.ok) throw new Error('Error al listar paquetes');
        
        availablePackages = await res.json();
        
        // Actualizar stats
        totalEl.textContent = availablePackages.length;
        processedEl.textContent = availablePackages.filter(p => p.processed).length;
        const metaCountEl = document.getElementById('pkg-meta-count');
        const cfdiCountEl = document.getElementById('pkg-cfdi-count');
        if (metaCountEl) metaCountEl.textContent = availablePackages.filter(p => p.type === 'Metadata').length;
        if (cfdiCountEl) cfdiCountEl.textContent  = availablePackages.filter(p => p.type === 'CFDI').length;

        if (availablePackages.length === 0) {
            listContainer.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-box-open"></i>
                    <p>No se encontraron paquetes en el servidor</p>
                </div>
            `;
            return;
        }

        // Reset filtro activo al recargar
        activeTypeFilter = null;
        const statMetaEl = document.getElementById('stat-filter-meta');
        const statCfdiEl = document.getElementById('stat-filter-cfdi');
        if (statMetaEl) statMetaEl.classList.remove('stat-active');
        if (statCfdiEl) statCfdiEl.classList.remove('stat-active');

        listContainer.innerHTML = '';
        _renderPackageGroups(availablePackages, listContainer);

    } catch (e) {
        console.error(e);
        listContainer.innerHTML = '<div class="empty-state text-danger"><i class="fas fa-exclamation-triangle"></i><p>Error de conexión</p></div>';
    }
}

// ─── Filtro por tipo clickeable desde las stats del Paso 3 ───────────────────
function applyTypeFilter(type) {
    // Toggle: si ya está activo, desactiva el filtro
    activeTypeFilter = (activeTypeFilter === type) ? null : type;

    // Actualizar visual de las badges
    const statMeta = document.getElementById('stat-filter-meta');
    const statCfdi = document.getElementById('stat-filter-cfdi');
    if (statMeta) statMeta.classList.toggle('stat-active', activeTypeFilter === 'Metadata');
    if (statCfdi) statCfdi.classList.toggle('stat-active', activeTypeFilter === 'CFDI');

    const TYPE_KEYS = {
        'Metadata': ['meta-emit', 'meta-recv'],
        'CFDI':     ['cfdi-emit', 'cfdi-recv'],
    };
    const filterLower = activeTypeFilter ? activeTypeFilter.toLowerCase() : null;

    document.querySelectorAll('.pkg-section').forEach(section => {
        const body = section.querySelector('[id^="pkgsec-"]');
        if (!body) return;
        const key = body.id.replace('pkgsec-', '');

        if (key === 'sin-clas') {
            // sin-clas: filtrar cards individuales por data-type (preserva selecciones)
            let visibles = 0;
            body.querySelectorAll('.package-card').forEach(card => {
                const matches = !filterLower || card.dataset.type === filterLower;
                card.style.display = matches ? '' : 'none';
                if (matches) visibles++;
            });
            section.style.display = visibles > 0 ? '' : 'none';
        } else {
            // Secciones tipadas: show/hide por clave de sección
            if (!activeTypeFilter) {
                section.style.display = '';
            } else {
                const allowed = TYPE_KEYS[activeTypeFilter] || [];
                section.style.display = allowed.includes(key) ? '' : 'none';
            }
        }
    });
}

// ─── Renderiza paquetes agrupados en 4 secciones colapsables ─────────────────
function _renderPackageGroups(packages, container) {
    const GRUPOS = [
        { key: 'meta-emit', type: 'Metadata', dir: 'Emitido',       label: 'Metadata · Emitidos',  icon: 'fa-file-alt',        color: '#60a5fa' },
        { key: 'meta-recv', type: 'Metadata', dir: 'Recibido',      label: 'Metadata · Recibidos', icon: 'fa-file-alt',        color: '#818cf8' },
        { key: 'cfdi-emit', type: 'CFDI',     dir: 'Emitido',       label: 'CFDI · Emitidos',      icon: 'fa-file-invoice',    color: '#34d399' },
        { key: 'cfdi-recv', type: 'CFDI',     dir: 'Recibido',      label: 'CFDI · Recibidos',     icon: 'fa-file-invoice',    color: '#fbbf24' },
        { key: 'sin-clas',  type: null,        dir: 'Sin clasificar', label: 'Sin clasificar',       icon: 'fa-question-circle', color: '#9ca3af' },
    ];

    GRUPOS.forEach(grupo => {
        const pkgs = packages.filter(p =>
            grupo.type === null
                ? p.direccion === 'Sin clasificar'
                : p.type === grupo.type && p.direccion === grupo.dir
        );
        if (pkgs.length === 0) return;

        const section = document.createElement('div');
        section.className = 'pkg-section';
        section.innerHTML = `
            <div class="pkg-section-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <i class="fas ${grupo.icon}" style="color:${grupo.color}"></i>
                <span class="pkg-section-label">${grupo.label}</span>
                <span class="pkg-badge-count">${pkgs.length}</span>
                <label class="pkg-sel-group" onclick="event.stopPropagation()">
                    <input type="checkbox" onchange="toggleSelectGroup('${grupo.key}', this.checked)"> Todos
                </label>
                <i class="fas fa-chevron-down pkg-chevron"></i>
            </div>
            <div class="pkg-section-body" id="pkgsec-${grupo.key}"></div>
        `;
        container.appendChild(section);

        const body = document.getElementById(`pkgsec-${grupo.key}`);
        pkgs.forEach(pkg => {
            const pkgId = pkg.name.replace(/\.(zip|txt)$/i, '');
            const isSelected = selectedPackages.has(pkgId);
            const statusBadge = pkg.processed
                ? '<span class="badge bg-success" style="font-size:0.7em">Procesado</span>'
                : '<span class="badge bg-secondary" style="font-size:0.7em">Nuevo</span>';
            const card = document.createElement('div');
            card.className = `package-card ${isSelected ? 'selected' : ''}`;
            card.dataset.pkgid = pkgId;
            card.dataset.group = grupo.key;
            card.dataset.type = (pkg.type || 'CFDI').toLowerCase(); // 'metadata' | 'cfdi'
            card.onclick = () => toggleSelectPackage(pkgId, card);
            card.innerHTML = `
                <div class="pkg-icon"><i class="fas ${grupo.icon}" style="color:${grupo.color}"></i></div>
                <div class="pkg-info">
                    <div class="pkg-name">${pkg.name}</div>
                    <div class="pkg-meta">${pkg.size} · ${new Date(pkg.date).toLocaleDateString()}</div>
                </div>
                ${statusBadge}
                <div class="pkg-check"><i class="fas ${isSelected ? 'fa-check-square' : 'fa-square'}"></i></div>
            `;
            body.appendChild(card);
        });
    });
}

// ─── Seleccionar/deseleccionar todos los paquetes de un grupo ─────────────────
function toggleSelectGroup(groupKey, checked) {
    document.querySelectorAll(`.package-card[data-group="${groupKey}"]`).forEach(card => {
        const pkgId = card.dataset.pkgid;
        if (checked) selectedPackages.add(pkgId);
        else selectedPackages.delete(pkgId);
        card.classList.toggle('selected', checked);
        card.querySelector('.pkg-check i').className =
            `fas ${checked ? 'fa-check-square' : 'fa-square'}`;
    });
    updateSelectionUI();
}

function toggleSelectPackage(pkgId, cardElement) {
    if (selectedPackages.has(pkgId)) {
        selectedPackages.delete(pkgId);
        cardElement.classList.remove('selected');
        cardElement.querySelector('.pkg-check i').className = 'fas fa-square';
    } else {
        selectedPackages.add(pkgId);
        cardElement.classList.add('selected');
        cardElement.querySelector('.pkg-check i').className = 'fas fa-check-square';
    }
    updateSelectionUI();
}

function toggleSelectAllPkgs() {
    const check = document.getElementById('select-all-pkgs');
    const cards = document.querySelectorAll('.package-card');
    if (check.checked) {
        cards.forEach(c => {
            const id = c.dataset.pkgid || c.dataset.pkgId;
            if (id) selectedPackages.add(id);
            c.classList.add('selected');
            c.querySelector('.pkg-check i').className = 'fas fa-check-square';
        });
    } else {
        selectedPackages.clear();
        cards.forEach(c => {
            c.classList.remove('selected');
            c.querySelector('.pkg-check i').className = 'fas fa-square';
        });
    }
    updateSelectionUI();
}

function updateSelectionUI() {
    const count = selectedPackages.size;
    const countEl = document.getElementById('selected-count');
    const btnEl = document.getElementById('btn-process-selected');
    const btnDel = document.getElementById('btn-delete-selected');
    
    if (countEl) countEl.textContent = count;
    if (btnEl) btnEl.disabled = count === 0;
    if (btnDel) btnDel.disabled = count === 0;
}

async function deleteSelectedPackages() {
    if (selectedPackages.size === 0) return;
    
    if (!confirm(`¿Estás seguro de que deseas eliminar ${selectedPackages.size} paquetes? Esta acción no se puede deshacer.`)) {
        return;
    }
    
    const btn = document.getElementById('btn-delete-selected');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminando...';
    
    try {
        const packageIds = Array.from(selectedPackages);
        
        const res = await apiFetch('/flatten/delete', {
            method: 'POST',
            body: JSON.stringify({ packageIds })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            // Success
            // alert(data.message || 'Paquetes eliminados correctamente');
            
            // Clear selection and reload
            selectedPackages.clear();
            // Also uncheck "select all" if it was checked
            const check = document.getElementById('select-all-pkgs');
            if (check) check.checked = false;
            
            updateSelectionUI();
            loadFlattenPackages(); // Reload the list
        } else {
            throw new Error(data.error || 'Error desconocido');
        }
        
    } catch (e) {
        console.error(e);
        alert('Error al eliminar paquetes: ' + e.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            // btn.disabled = false; // Will be handled by updateSelectionUI based on selection (which is now empty)
            updateSelectionUI();
        }
    }
}

async function processSelectedPackages() {
    if (selectedPackages.size === 0) return;

    // ── Detectar mezcla de tipos (Metadata + CFDI) ──
    const tiposSeleccionados = new Set(
        Array.from(selectedPackages).map(id => {
            const pkg = availablePackages.find(p =>
                p.name.replace(/\.(zip|txt)$/i, '') === id);
            return pkg?.type;
        }).filter(Boolean)
    );
    if (tiposSeleccionados.size > 1) {
        if (!confirm('⚠️ Tienes paquetes Metadata (TXT) y CFDI (ZIP) seleccionados juntos.\n' +
                     'Se generará un reporte combinado con ambos tipos. ¿Continuar de todas formas?')) return;
    }

    const btn = document.getElementById('btn-process-selected');
    const reportsList = document.getElementById('reports-list');
    const originalText = btn.innerHTML;
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';
    
    // Add placeholder item to results
    const tempId = 'temp-' + Date.now();
    const tempItem = document.createElement('div');
    tempItem.className = 'report-card';
    tempItem.id = tempId;
    tempItem.innerHTML = `
        <div style="display:flex; gap:1rem; align-items:center">
            <i class="fas fa-cog fa-spin"></i>
            <div>
                <strong>Procesando ${selectedPackages.size} paquetes...</strong>
                <div style="font-size:0.8em; color:#888">Esto puede tardar unos segundos</div>
            </div>
        </div>
    `;
    
    // Insert at top
    if (reportsList.querySelector('.empty-state')) reportsList.innerHTML = '';
    reportsList.insertBefore(tempItem, reportsList.firstChild);

    try {
        const rfc = sessionStorage.getItem('sat_rfc') || 'GENERIC'; // Fallback
        const packageIds = Array.from(selectedPackages);
        
        const res = await apiFetch('/flatten/process', {
            method: 'POST',
            body: JSON.stringify({ packageIds, rfc })
        });
        
        const data = await res.json();
        
        // Remove temp item
        tempItem.remove();

        if (res.ok) {
            // Soportar respuesta con uno o varios archivos generados (uno por paquete)
            const filesToShow = data.files?.length > 0
                ? data.files
                : data.filename ? [{ filename: data.filename, downloadUrl: data.downloadUrl }] : [];

            filesToShow.forEach(f => {
                const successCard = document.createElement('div');
                successCard.className = 'report-card';
                successCard.style.borderLeft = '4px solid var(--accent-green)';
                successCard.innerHTML = `
                    <div>
                        <div style="font-weight:600; margin-bottom:0.2rem">Reporte Generado</div>
                        <div style="font-size:0.85rem; color:var(--text-secondary)">${f.filename}</div>
                    </div>
                    <button class="btn btn-sm btn-outline" onclick="downloadFlattenReport('${f.filename}')">
                        <i class="fas fa-download"></i> Descargar
                    </button>
                `;
                reportsList.insertBefore(successCard, reportsList.firstChild);
            });

            // Refresh both lists
            loadFlattenPackages();
            loadGeneratedReports();
        } else {
            throw new Error(data.error || 'Error desconocido');
        }
    } catch (e) {
        tempItem.remove();
        alert('Error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// Dropzone Logic
document.addEventListener('DOMContentLoaded', () => {
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-upload');

    if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', handleFileSelect);
        
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                handleFileUpload(e.dataTransfer.files[0]);
            }
        });
    }
});

function handleFileSelect(e) {
    if (e.target.files.length) {
        handleFileUpload(e.target.files[0]);
    }
}

async function handleFileUpload(file) {
    if (!file.name.endsWith('.zip')) {
        alert('Solo se permiten archivos ZIP');
        return;
    }

    const formData = new FormData();
    formData.append('file', file);
    
    // Show uploading state
    const dropzone = document.getElementById('dropzone');
    const originalContent = dropzone.innerHTML;
    dropzone.innerHTML = '<div class="dropzone-content"><i class="fas fa-spinner fa-spin"></i><h3>Subiendo...</h3></div>';
    dropzone.style.pointerEvents = 'none';

    try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/flatten/upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        
        const data = await res.json();
        
        if (res.ok) {
            loadFlattenPackages(); // Refresh list
        } else {
            alert('Error al subir: ' + data.error);
        }
    } catch (e) {
        console.error(e);
        alert('Error de conexión');
    } finally {
        dropzone.innerHTML = originalContent;
        dropzone.style.pointerEvents = 'auto';
    }
}

// =====================================================
// STEP 4: CALCULATION
// =====================================================

async function calculateIVA() {
    const year = document.getElementById('calc-year').value;
    const month = document.getElementById('calc-month').value;
    const rfc = sessionStorage.getItem('sat_rfc') || document.getElementById('rfc-input').value;
    
    if (!rfc) {
        alert('Se requiere RFC para el cálculo');
        return;
    }

    const btn = document.getElementById('btn-calc');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculando...';

    try {
        // Use POST endpoint as per core memory
        const res = await apiFetch('/calculo-iva/generar', {
            method: 'POST',
            body: JSON.stringify({ rfc, year, mes: month })
        });
        
        if (!res.ok) {
            // Try GET if POST fails (fallback)
             const resGet = await apiFetch(`/calculo-iva?rfc=${rfc}&year=${year}&mes=${month}`);
             if (resGet.ok) {
                 const data = await resGet.json();
                 renderCalculation(data[0]); // Assume first result
                 return;
             }
             throw new Error('No se pudo generar el cálculo');
        }

        const data = await res.json();
        renderCalculation(data);

    } catch (e) {
        console.error(e);
        alert('Error en el cálculo: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-percentage"></i> Calcular Impuestos';
    }
}

function renderCalculation(data) {
    if (!data) return;
    
    document.getElementById('calc-results').style.display = 'block';
    
    // Format currency
    const fmt = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0);
    
    // Update summary cards
    document.getElementById('res-trasladado').innerText = fmt(data.iva_trasladado_total || data.total_trasladado);
    document.getElementById('res-acreditable').innerText = fmt(data.iva_acreditable_total || data.total_acreditable);
    document.getElementById('res-saldo').innerText = fmt(data.saldo_final);
    
    // Update table rows (snake_case from core memory)
    // iva_trasladado_pue, iva_trasladado_ppd, etc.
    document.getElementById('row-tras-pue').innerText = fmt(data.iva_trasladado_pue);
    document.getElementById('row-tras-ppd').innerText = fmt(data.iva_trasladado_ppd);
    document.getElementById('row-tras-total').innerText = fmt(data.iva_trasladado_total);
    
    document.getElementById('row-acre-pue').innerText = fmt(data.iva_acreditable_pue);
    document.getElementById('row-acre-ppd').innerText = fmt(data.iva_acreditable_ppd);
    document.getElementById('row-acre-total').innerText = fmt(data.iva_acreditable_total);
    
    document.getElementById('row-ret-iva').innerText = fmt(data.iva_retenido);
    document.getElementById('row-saldo-final').innerText = fmt(data.saldo_final);
}

// =====================================================
// ADMIN: USER MANAGEMENT
// =====================================================
function updateAdminUI() {
    const navAdmin          = document.getElementById('nav-admin');
    const navFiscal         = document.getElementById('nav-fiscal');
    const navEstadosCuenta  = document.getElementById('nav-estados-cuenta');
    const navAuditoria      = document.getElementById('nav-auditoria');
    const navContribuyentes = document.getElementById('nav-contribuyentes');
    const isLoggedIn = currentUser && (currentUser.role === 'admin' || currentUser.role === 'user');
    const isAdmin    = currentUser && currentUser.role === 'admin';

    // Secciones disponibles para todos los usuarios autenticados
    const commonNavs = [navAuditoria, navFiscal, navEstadosCuenta, navContribuyentes];
    commonNavs.forEach(n => { if(n) n.style.display = isLoggedIn ? 'block' : 'none'; });

    // Seccion Clientes/Usuarios: SOLO visible para administradores
    if (navAdmin) navAdmin.style.display = isAdmin ? 'block' : 'none';

    if (currentUser) {
        // Mostrar nombre real si existe, sino username
        const displayName = currentUser.nombre
            ? currentUser.nombre.split(' ').slice(0, 2).join(' ')
            : currentUser.username;
        const initial = displayName.charAt(0).toUpperCase();

        const navUser   = document.getElementById('nav-username');
        const navAvatar = document.getElementById('nav-user-avatar-text');
        const dropUser  = document.getElementById('dropdown-username');
        const dropRole  = document.getElementById('dropdown-role');
        const dropAvatar= document.getElementById('dropdown-avatar-text');
        const container = document.querySelector('.user-menu-container');
        const roleLabel = currentUser.role === 'admin' ? 'Administrador' : 'Cliente';

        if (navUser)  navUser.textContent  = displayName;
        if (navAvatar) navAvatar.textContent = initial;
        if (dropUser)  dropUser.textContent  = displayName;
        if (dropRole)  dropRole.textContent  = roleLabel + (currentUser.rfc ? ` · ${currentUser.rfc}` : '');
        if (dropAvatar) dropAvatar.textContent = initial;
        if (container) container.style.display = 'flex';

        // Auto-fill RFC en Step 1 si el usuario tiene RFC asignado
        if (currentUser.rfc) {
            const rfcInput = document.getElementById('rfc-input');
            if (rfcInput && !rfcInput.value) {
                rfcInput.value = currentUser.rfc;
                // También guardar en sessionStorage para uso del sistema SAT
                sessionStorage.setItem('sat_rfc', currentUser.rfc);
                localStorage.setItem('last_rfc', currentUser.rfc);
            }
        }
    } else {
        const container = document.querySelector('.user-menu-container');
        if (container) container.style.display = 'none';
    }
}

function toggleUserMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropdown = document.getElementById('user-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('show');
    }
}

// Close dropdown when clicking outside
window.addEventListener('click', function(e) {
    const dropdown = document.getElementById('user-dropdown');
    const btn = document.getElementById('user-menu-btn');
    
    if (dropdown && dropdown.classList.contains('show')) {
        if (btn && !btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('show');
        }
    }
});

// Datos en memoria para búsqueda
let _allClients = [];

async function loadUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="clients-loading"><i class="fas fa-spinner fa-spin"></i> Cargando clientes...</td></tr>';

    try {
        const res = await apiFetch('/users');
        if (!res.ok) throw new Error('Error al cargar clientes');

        _allClients = await res.json();
        renderClientsTable(_allClients);
        updateAdminStats(_allClients);
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="8" class="clients-loading" style="color:#ef4444;"><i class="fas fa-exclamation-circle"></i> Error al cargar clientes</td></tr>';
    }
}

function renderClientsTable(clients) {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (clients.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="clients-loading">No hay clientes registrados</td></tr>';
        const cnt = document.getElementById('clients-count');
        if (cnt) cnt.textContent = '0 clientes';
        return;
    }

    const cnt = document.getElementById('clients-count');
    if (cnt) cnt.textContent = `${clients.length} cliente${clients.length !== 1 ? 's' : ''}`;

    clients.forEach(u => {
        const isSelf   = u.id === currentUser?.id;
        const isAdmin  = u.role === 'admin';
        const nombre   = u.nombre || '—';
        const rfc      = u.rfc    || '—';
        const email    = u.email  || '—';
        const cfdis    = Number(u.total_cfdis || 0).toLocaleString();
        const iva      = Number(u.iva_total   || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
        const ultima   = u.ultima_factura
            ? new Date(u.ultima_factura).toLocaleDateString('es-MX')
            : '—';
        const roleBadge = isAdmin
            ? '<span class="client-role-badge role-admin"><i class="fas fa-shield-alt"></i> Admin</span>'
            : '<span class="client-role-badge role-user"><i class="fas fa-user"></i> Cliente</span>';

        const tr = document.createElement('tr');
        tr.className = 'client-row';
        tr.innerHTML = `
            <td>
                <div class="client-name-cell">
                    <div class="client-avatar">${nombre.charAt(0).toUpperCase()}</div>
                    <div>
                        <div class="client-nombre">${nombre}</div>
                        <div class="client-rfc-tag">${rfc}</div>
                    </div>
                </div>
            </td>
            <td class="cell-username"><code>${u.username}</code></td>
            <td class="cell-email">${email}</td>
            <td>${roleBadge}</td>
            <td class="cell-num">${cfdis}</td>
            <td class="cell-num cell-iva">${iva}</td>
            <td class="cell-fecha">${ultima}</td>
            <td>
                <div class="client-actions">
                    <button class="ca-btn ca-edit" onclick='editUser(${JSON.stringify(u)})' title="Editar">
                        <i class="fas fa-edit"></i>
                    </button>
                    ${!isSelf ? `<button class="ca-btn ca-del" onclick="deleteUser(${u.id})" title="Eliminar">
                        <i class="fas fa-trash"></i>
                    </button>` : '<span class="ca-self-tag">Tú</span>'}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function updateAdminStats(clients) {
    const total   = clients.length;
    const cfdis   = clients.reduce((a, c) => a + Number(c.total_cfdis || 0), 0);
    const iva     = clients.reduce((a, c) => a + Number(c.iva_total   || 0), 0);
    const admins  = clients.filter(c => c.role === 'admin').length;

    const el = id => document.getElementById(id);
    if (el('stat-total-clientes')) el('stat-total-clientes').textContent = total;
    if (el('stat-total-cfdis'))    el('stat-total-cfdis').textContent    = cfdis.toLocaleString();
    if (el('stat-iva-total'))      el('stat-iva-total').textContent      = iva.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
    if (el('stat-total-admins'))   el('stat-total-admins').textContent   = admins;
}

function filterClients(query) {
    const q = query.toLowerCase().trim();
    const filtered = q
        ? _allClients.filter(u =>
            (u.nombre   || '').toLowerCase().includes(q) ||
            (u.rfc      || '').toLowerCase().includes(q) ||
            (u.username || '').toLowerCase().includes(q) ||
            (u.email    || '').toLowerCase().includes(q)
          )
        : _allClients;
    renderClientsTable(filtered);
}

function openUserModal(user = null) {
    const isEdit = !!user;
    document.getElementById('user-id').value       = isEdit ? user.id : '';
    document.getElementById('user-nombre').value   = isEdit ? (user.nombre || '') : '';
    document.getElementById('user-rfc').value      = isEdit ? (user.rfc    || '') : '';
    document.getElementById('user-email').value    = isEdit ? (user.email  || '') : '';
    document.getElementById('user-username').value = isEdit ? (user.username || '') : '';
    document.getElementById('user-username').disabled = isEdit;
    document.getElementById('user-password').value = '';
    document.getElementById('user-role').value     = isEdit ? (user.role || 'user') : 'user';

    document.getElementById('user-modal-title').textContent = isEdit ? 'Editar Cliente' : 'Nuevo Cliente';
    document.getElementById('user-modal-sub')?.setAttribute('style', '');

    // Mostrar/ocultar hint de contraseña
    const pwdNote = document.getElementById('user-pwd-note');
    const pwdReq  = document.getElementById('user-pwd-hint');
    if (pwdNote) pwdNote.style.display = isEdit ? 'inline' : 'none';
    if (pwdReq)  pwdReq.style.display  = isEdit ? 'none'   : 'inline';

    const modal = document.getElementById('user-modal');
    modal.style.display = 'flex';
    modal.classList.add('is-open');
}

function closeUserModal() {
    const modal = document.getElementById('user-modal');
    modal.style.display = 'none';
    modal.classList.remove('is-open');
}

function editUser(user) {
    // Puede llamarse con objeto completo o con solo id
    if (typeof user === 'number') {
        user = _allClients.find(u => u.id === user) || { id: user };
    }
    openUserModal(user);
}

async function saveUser(e) {
    e.preventDefault();

    const id       = document.getElementById('user-id').value;
    const nombre   = document.getElementById('user-nombre').value.trim();
    const rfc      = document.getElementById('user-rfc').value.trim().toUpperCase();
    const email    = document.getElementById('user-email').value.trim();
    const username = document.getElementById('user-username').value.trim();
    const password = document.getElementById('user-password').value;
    const role     = document.getElementById('user-role').value;

    const payload = { nombre, rfc, email, role };
    if (!id) {
        if (!username) { showToast('error', 'Validación', 'El usuario es requerido'); return; }
        payload.username = username;
        if (!password) { showToast('error', 'Validación', 'La contraseña es requerida para nuevos clientes'); return; }
    }
    if (password) payload.password = password;

    const endpoint = id ? `/users/${id}` : '/users';
    const method   = id ? 'PUT' : 'POST';

    try {
        const res  = await apiFetch(endpoint, { method, body: JSON.stringify(payload) });
        const data = await res.json();

        if (res.ok) {
            closeUserModal();
            loadUsers();
            showToast('success', 'Listo', id ? 'Cliente actualizado correctamente' : 'Cliente creado exitosamente');
        } else {
            showToast('error', 'Error', data.error);
        }
    } catch (err) {
        console.error(err);
        showToast('error', 'Error de conexión', 'No se pudo contactar al servidor');
    }
}

async function clearRequestHistory() {
    const rfc = sessionStorage.getItem('sat_rfc') || document.getElementById('rfc-input').value;
    if (!rfc) return;

    if (!confirm('¿Estás seguro de que deseas eliminar todo el historial de solicitudes para este RFC? Esta acción no se puede deshacer.')) {
        return;
    }

    try {
        const res = await apiFetch(`/sat/history/${rfc}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            alert('Historial eliminado correctamente');
            loadDownloadHistory(); // Reload table
        } else {
            const data = await res.json();
            throw new Error(data.error || 'Error al eliminar historial');
        }
    } catch (e) {
        console.error(e);
        alert('Error: ' + e.message);
    }
}

async function deleteUser(id) {
    const client = _allClients.find(u => u.id === id);
    const nombre = client ? (client.nombre || client.username) : `ID ${id}`;
    if (!confirm(`¿Eliminar al cliente "${nombre}"?\nSus CFDIs y datos permanecerán en la base de datos pero el acceso al sistema será revocado.`)) return;

    try {
        const res = await apiFetch(`/users/${id}`, { method: 'DELETE' });
        if (res.ok) {
            loadUsers();
            showToast('success', 'Eliminado', 'Cliente eliminado correctamente');
        } else {
            const data = await res.json();
            showToast('error', 'Error', data.error);
        }
    } catch (e) {
        console.error(e);
        showToast('error', 'Error de conexión', 'No se pudo contactar al servidor');
    }
}

// =====================================================
// FAQ
// =====================================================
function toggleFaq(btn) {
    const item = btn.closest('.faq-item');
    if (!item) return;
    const wasOpen = item.classList.contains('open');
    // Close all
    document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
    // Open clicked if it was closed
    if (!wasOpen) item.classList.add('open');
}

// =====================================================
// UTILITY: copy code blocks
// =====================================================
function copyCode(btn) {
    const codeEl = btn.closest('.code-block')?.querySelector('.code-content');
    if (!codeEl) return;
    const text = codeEl.innerText;
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '¡Copiado!';
        btn.style.color = 'var(--accent-green)';
        setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
    }).catch(() => {
        btn.textContent = 'Error';
        setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
    });
}

function filterRequests() {
    const q = (document.getElementById('requests-search')?.value || '').toLowerCase();
    const rfcQ = (document.getElementById('history-rfc-filter')?.value || '').toUpperCase();
    document.querySelectorAll('#requests-table-body tr').forEach(row => {
        const textOk  = q === '' || row.textContent.toLowerCase().includes(q);
        const rfcCell = row.querySelector('.hist-rfc-cell');
        const rfcOk   = rfcQ === '' || (rfcCell && rfcCell.dataset.rfc.includes(rfcQ));
        row.style.display = textOk && rfcOk ? '' : 'none';
    });
}

// ─── Filtrar historial por RFC ────────────────────────────────────────────────
function filterHistoryByRfc(value) {
    const q = value.trim().toUpperCase();
    let visible = 0;
    document.querySelectorAll('#requests-table-body tr').forEach(row => {
        const rfcCell = row.querySelector('.hist-rfc-cell');
        const match   = q === '' || (rfcCell && rfcCell.dataset.rfc.includes(q));
        row.style.display = match ? '' : 'none';
        if (match) visible++;
    });
}

// ─── Cargar historial de TODOS los RFCs ──────────────────────────────────────
async function loadAllHistory() {
    const tbody = document.getElementById('requests-table-body');
    if (!tbody) return;

    // Limpiar filtro RFC al ver todos
    const rfcInput = document.getElementById('history-rfc-filter');
    if (rfcInput) rfcInput.value = '';

    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-secondary);">
        <i class="fas fa-spinner fa-spin" style="font-size:1.5rem;margin-bottom:0.5rem;display:block;"></i>
        Cargando historial de todos los RFCs…
    </td></tr>`;

    try {
        const res = await apiFetch('/sat/history');
        if (!res.ok) throw new Error(`Error ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) throw new Error('Respuesta inesperada del servidor');

        const history = await res.json();
        tbody.innerHTML = '';

        if (history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-secondary);">
                <i class="fas fa-inbox" style="font-size:2rem;margin-bottom:0.5rem;display:block;opacity:0.4"></i>
                No hay solicitudes en el sistema.
            </td></tr>`;
            return;
        }

        // Agrupar igual que loadDownloadHistory
        const groups = {};
        history.forEach(req => {
            const gid = req.group_id || req.id_solicitud;
            if (!groups[gid]) groups[gid] = [];
            groups[gid].push(req);
        });
        const sortedIds = Object.keys(groups).sort((a, b) => {
            const dA = Math.max(...groups[a].map(r => new Date(r.fecha_solicitud).getTime()));
            const dB = Math.max(...groups[b].map(r => new Date(r.fecha_solicitud).getTime()));
            return dB - dA;
        });
        let idx = sortedIds.length;
        for (const gid of sortedIds) {
            const grp = groups[gid];
            if (grp.length === 1 && !grp[0].group_id) renderRow(grp[0], tbody);
            else renderGroupRow(gid, grp, tbody, idx);
            idx--;
        }
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--danger);">
            <i class="fas fa-exclamation-circle" style="font-size:1.5rem;margin-bottom:0.5rem;display:block;"></i>
            Error al cargar: ${e.message}
        </td></tr>`;
    }
}

function closePreview() {
    const m = document.getElementById('preview-modal');
    if (m) m.style.display = 'none';
}

// =====================================================
// STEP 6: ENTREGA — REPORTES
// =====================================================

const REPORT_LABELS = {
    'iva-determinacion':     'Determinación_IVA',
    'iva-determinacion-csv': 'Determinación_IVA',
    'retenciones':           'Retenciones_IVA_ISR',
    'retenciones-csv':       'Retenciones_IVA_ISR',
    'nominas':               'Conciliación_Nóminas',
    'nominas-csv':           'Conciliación_Nóminas',
    'precarga':              'Comparativo_Precarga',
    'precarga-csv':          'Comparativo_Precarga',
    'papeles-trabajo':       'Papeles_de_Trabajo',
    'papeles-trabajo-csv':   'Papeles_de_Trabajo',
};

async function downloadReport(reportType) {
    const year  = document.getElementById('report-global-year')?.value  || new Date().getFullYear();
    const month = document.getElementById('report-global-month')?.value || (new Date().getMonth() + 1);
    const isCSV = reportType.endsWith('-csv');
    const ext   = isCSV ? 'csv' : 'xlsx';
    const label = REPORT_LABELS[reportType] || reportType;
    const filename = `${label}_${year}_${String(month).padStart(2,'0')}.${ext}`;

    if (!backendOnline) {
        showNotification(`Servidor offline. Conecta el backend para generar reportes.`, 'warning');
        return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
        showNotification('Inicia sesión para descargar reportes.', 'error');
        return;
    }

    try {
        const btn = event?.currentTarget;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando...'; }

        const response = await fetch(`${API_URL}/reportes/${reportType.replace(/-csv$/, '')}?year=${year}&month=${month}&format=${ext}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (btn) { btn.disabled = false; btn.innerHTML = isCSV ? '<i class="fas fa-file-csv"></i> CSV' : '<i class="fas fa-file-excel"></i> Excel'; }

        if (!response.ok) {
            showNotification(`Error al generar reporte: ${response.statusText}`, 'error');
            return;
        }

        const blob = await response.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        showNotification(`Reporte "${label}" descargado correctamente.`, 'success');
    } catch (err) {
        showNotification(`Error al descargar reporte: ${err.message}`, 'error');
    }
}

async function downloadAllReports() {
    const reports = ['iva-determinacion', 'retenciones', 'nominas', 'precarga', 'papeles-trabajo'];
    showNotification('Generando todos los reportes...', 'info');
    for (const r of reports) {
        await downloadReport(r);
        await new Promise(res => setTimeout(res, 400));
    }
}

function showNotification(msg, type = 'info') {
    // Reuse existing toast/notification mechanism or create simple one
    const colors = { success: '#00ff9d', error: '#ff4757', warning: '#ffd700', info: '#00b4ff' };
    const icons  = { success: 'check-circle', error: 'times-circle', warning: 'exclamation-triangle', info: 'info-circle' };

    const existing = document.getElementById('global-notification');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'global-notification';
    el.style.cssText = `
        position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
        background: #1a2332; border: 1px solid ${colors[type]};
        color: #e6edf3; padding: 0.85rem 1.25rem; border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4); font-size: 0.9rem;
        display: flex; align-items: center; gap: 0.6rem; max-width: 380px;
        animation: slideInRight 0.3s ease;
    `;
    el.innerHTML = `<i class="fas fa-${icons[type]}" style="color:${colors[type]};"></i> ${msg}`;
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}


// ═══════════════════════════════════════════════════════════════════
// MIS RFCs (CONTRIBUYENTES) — gestión de RFCs del usuario
// ═══════════════════════════════════════════════════════════════════

async function loadContribuyentes() {
    const tbody = document.getElementById('contrib-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;opacity:0.5;"><i class="fas fa-spinner fa-spin"></i> Cargando...</td></tr>';
    try {
        const res = await fetch('/api/contribuyentes', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
        });
        const data = await res.json();
        if (res.status === 401) {
            showToast('warning', 'Sesión expirada', 'Tu sesión expiró. Vuelve a iniciar sesión.');
            setTimeout(function() { if (typeof logout === 'function') logout(); }, 1500);
            return;
        }
        if (!res.ok) throw new Error(data.error || 'Error al cargar');
        renderContribuyentes(Array.isArray(data) ? data : []);
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:#f87171;">' + e.message + '</td></tr>';
    }
}

function renderContribuyentes(rows) {
    const tbody = document.getElementById('contrib-tbody');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;opacity:0.5;">No tienes RFCs registrados. Usa el bot\u00f3n + Agregar RFC.</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(function(r) {
        return '<tr>' +
            '<td style="font-family:monospace;font-weight:600;">' + r.rfc + '</td>' +
            '<td>' + (r.nombre || '\u2014') + '</td>' +
            '<td>' + (r.regimen_fiscal ? r.regimen_fiscal : '\u2014') + '</td>' +
            '<td style="text-align:center;">' +
                '<button onclick="deleteContribuyente(' + r.id + ',\'' + r.rfc + '\')" title="Eliminar" ' +
                'style="background:none;border:none;color:#f87171;cursor:pointer;font-size:1rem;">' +
                '<i class="fas fa-trash"></i></button>' +
            '</td>' +
        '</tr>';
    }).join('');
}

function openContribModal() {
    document.getElementById('contrib-rfc').value = '';
    document.getElementById('contrib-nombre').value = '';
    document.getElementById('contrib-regimen').value = '';
    document.getElementById('contrib-modal').style.display = 'flex';
    setTimeout(function() { document.getElementById('contrib-rfc').focus(); }, 50);
}

function closeContribModal() {
    document.getElementById('contrib-modal').style.display = 'none';
}

async function saveContribuyente() {
    const rfc    = document.getElementById('contrib-rfc').value.trim().toUpperCase();
    const nombre = document.getElementById('contrib-nombre').value.trim();
    const regimen= document.getElementById('contrib-regimen').value;
    if (!rfc || !nombre) {
        showToast('warning', 'Campos requeridos', 'RFC y Nombre son obligatorios.');
        return;
    }
    if (rfc.length < 12 || rfc.length > 13) {
        showToast('warning', 'RFC inv\u00e1lido', 'El RFC debe tener 12 o 13 caracteres.');
        return;
    }
    try {
        const res = await fetch('/api/contribuyentes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('token')
            },
            body: JSON.stringify({ rfc: rfc, nombre: nombre, regimen_fiscal: regimen || null })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al guardar');
        closeContribModal();
        showToast('success', 'RFC agregado', rfc + ' registrado correctamente.');
        loadContribuyentes();
    } catch (e) {
        showToast('error', 'Error', e.message);
    }
}

async function deleteContribuyente(id, rfc) {
    if (!confirm('¿Eliminar el RFC ' + rfc + ' de tu cuenta? Esta acción no se puede deshacer.')) return;
    try {
        const res = await fetch('/api/contribuyentes/' + id, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al eliminar');
        showToast('success', 'RFC eliminado', rfc + ' eliminado de tu cuenta.');
        loadContribuyentes();
    } catch (e) {
        showToast('error', 'Error', e.message);
    }
}
