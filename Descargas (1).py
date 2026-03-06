# Descargas.py - Versión 6.1: Botón de Pausa/Reanudar Monitor
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
import os
from datetime import datetime, timedelta
import json
import base64
import zipfile
import io
import time
from lxml import etree
import threading
import logging
import csv

# --- IMPORTACIONES CFDI ---
from cfdiclient import (Autenticacion, DescargaMasiva, Fiel, SolicitaDescargaEmitidos, SolicitaDescargaRecibidos,
                        VerificaSolicitudDescarga)

# --- CONFIGURACIÓN ---
FIELS_CATALOG_FILE = r"C:\Users\Public\Checado\fiels_catalog.json"
SESSION_FILE = "session_active.json"

logger = logging.getLogger('SAT_DescargaMasiva')
logger.setLevel(logging.DEBUG)
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    logger.addHandler(ch)

class SATExtractor:
    def __init__(self, gui_app):
        self.gui_app = gui_app
        self.fiels_catalog = []
        self.current_fiel = None
        self.rfc_solicitante = ""
        self.current_password = ""
        self.auth_token = ""
        self.output_dir = os.path.abspath(os.path.join(os.getcwd(), "descargas_sat"))
        if not os.path.exists(self.output_dir): os.makedirs(self.output_dir)
        
        # ESTADO
        self.active_solicitud_ids = [] 
        self.request_data = {} 
        
        self.monitoring_active = False
        self.is_paused = False # NUEVA BANDERA DE PAUSA
        self.data_lock = threading.Lock()
        
        self._load_fiels_catalog()
        self._setup_file_logging()

    # --- GESTIÓN DE SESIONES ---
    def get_current_state(self):
        return {
            "rfc": self.rfc_solicitante, 
            "password": self.current_password,
            "output_dir": self.output_dir, 
            "all_ids": self.active_solicitud_ids,
            "request_data": self.request_data,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }

    def restore_state(self, state_dict):
        rfc = state_dict.get("rfc")
        pwd = state_dict.get("password")
        all_ids = state_dict.get("all_ids", [])
        r_data = state_dict.get("request_data", {})
        saved_dir = state_dict.get("output_dir")

        if not rfc: return False

        self.rfc_solicitante = rfc
        self.current_password = pwd
        self.active_solicitud_ids = all_ids
        self.request_data = r_data
        self.is_paused = False # Siempre arrancar despausado al restaurar
        
        if saved_dir and os.path.exists(saved_dir):
            self.output_dir = saved_dir
            self._setup_file_logging()

        self.gui_app.rfc_solicitante_var.set(rfc)
        if pwd: self.gui_app.pass_var.set(pwd)
        self.gui_app.lbl_folder_path.config(text=self.output_dir)
        self.gui_app.refresh_table_counters()
        return True

    def save_auto_session(self):
        with self.data_lock:
            try:
                with open(SESSION_FILE, 'w', encoding='utf-8') as f: 
                    json.dump(self.get_current_state(), f, indent=4)
            except: pass

    def load_auto_session(self):
        if not os.path.exists(SESSION_FILE): return False
        try:
            with open(SESSION_FILE, 'r', encoding='utf-8') as f: 
                data = json.load(f)
            return self.restore_state(data)
        except: return False

    def export_session_manual(self, filepath):
        try:
            with self.data_lock: state = self.get_current_state()
            with open(filepath, 'w', encoding='utf-8') as f: json.dump(state, f, indent=4)
            return True
        except: return False

    def import_session_manual(self, filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f: data = json.load(f)
            return self.restore_state(data)
        except: return False

    # --- LÓGICA ---
    def _setup_file_logging(self):
        for h in logger.handlers[:]: 
            if isinstance(h, logging.FileHandler): logger.removeHandler(h)
        try:
            fh = logging.FileHandler(os.path.join(self.output_dir, 'sat_descarga.log'), encoding='utf-8')
            fh.setLevel(logging.DEBUG)
            logger.addHandler(fh)
        except: pass

    def set_output_directory(self, path):
        if os.path.isdir(path):
            self.output_dir = path
            self._setup_file_logging()
            self.save_auto_session()
            return True
        return False

    def _load_fiels_catalog(self):
        try:
            if os.path.exists(FIELS_CATALOG_FILE):
                with open(FIELS_CATALOG_FILE, 'r') as f: self.fiels_catalog = json.load(f)
        except: self.fiels_catalog = []

    def _save_fiels_catalog(self):
        try:
            os.makedirs(os.path.dirname(FIELS_CATALOG_FILE), exist_ok=True)
            with open(FIELS_CATALOG_FILE, 'w') as f: json.dump(self.fiels_catalog, f, indent=4)
        except: pass

    def add_fiel_entry(self, rfc, cer, key):
        entry = {"rfc": rfc, "cer_path": cer, "key_path": key}
        self.fiels_catalog = [x for x in self.fiels_catalog if x['rfc'] != rfc]
        self.fiels_catalog.append(entry)
        self._save_fiels_catalog()
        return True

    def select_fiel_by_rfc(self, rfc, pwd, silent=False):
        item = next((x for x in self.fiels_catalog if x['rfc'] == rfc), None)
        if not item: 
            if not silent: self.gui_app.log_console(f"Error: RFC {rfc} no encontrado.")
            return False
        try:
            if not os.path.exists(item['cer_path']) or not os.path.exists(item['key_path']):
                 if not silent: self.gui_app.log_console("❌ Error: Archivos .cer o .key no encontrados.")
                 return False
            
            with open(item['cer_path'], 'rb') as f: c = f.read()
            with open(item['key_path'], 'rb') as f: k = f.read()
            
            if not c or not k:
                if not silent: self.gui_app.log_console("❌ Error: Archivos .cer o .key vacíos.")
                return False

            self.current_fiel = Fiel(c, k, pwd)
            self.rfc_solicitante = rfc; self.current_password = pwd
            return True
        except Exception as e:
            self.current_fiel = None # Asegurar que sea None si falló
            if not silent: self.gui_app.log_console(f"❌ Error al cargar FIEL (¿Contraseña incorrecta?): {e}")
            return False

    def authenticate(self, silent=False):
        if not self.current_fiel:
            if not silent: self.gui_app.log_console("⚠️ No hay FIEL cargada correctamente.")
            return False
        try:
            self.auth_service = Autenticacion(self.current_fiel)
            t = self.auth_service.obtener_token()
            if t: 
                self.auth_token = t
                if not silent: self.gui_app.log_console("✅ Autenticación Exitosa.")
                return True
        except Exception as e:
            if not silent: self.gui_app.log_console(f"❌ Error de Autenticación: {e}")
        return False

    def split_dates(self, start, end, days=30):
        res = []; curr = start
        while curr <= end:
            fin = min(curr + timedelta(days=days-1), end)
            res.append((curr, fin)); curr = fin + timedelta(days=1)
        return res

    def start_bulk_process(self, start, end, dtype):
        if self.monitoring_active:
            self.gui_app.log_console("⚠️ Monitor activo. Espera o detenlo.")
            return
        if not self.auth_token: 
            self.gui_app.log_console("⚠️ Error: No autenticado.")
            return
        
        ranges = self.split_dates(start, end)
        self.gui_app.log_console(f"🚀 Generando {len(ranges)} solicitudes...")
        
        new_ids = []
        for s, e in ranges:
            self.gui_app.log_console(f"Solicitando {s.date()} - {e.date()}...")
            rid = self._send_req(s, e, dtype)
            if rid:
                new_ids.append(rid)
                with self.data_lock:
                    if rid not in self.active_solicitud_ids:
                        self.active_solicitud_ids.append(rid)
                    self.request_data[rid] = {
                        'rfc': self.rfc_solicitante,
                        'start': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        'status_code': 1,
                        'last_msg': 'Enviada'
                    }
                time.sleep(1)
            else:
                self.gui_app.log_console(f"   -> Falló solicitud.")
        
        if new_ids:
            self.save_auto_session()
            self.gui_app.refresh_table_counters()
            self._monitor_bulk_requests(new_ids)
        else:
            self.gui_app.log_console("❌ Sin solicitudes válidas.")

    def _send_req(self, s, e, dtype):
        try:
            ctype = self.gui_app.cfdi_type_var.get().upper()
            Srv = SolicitaDescargaEmitidos if ctype == 'ISSUED' else SolicitaDescargaRecibidos
            kwargs = {'rfc_emisor': self.rfc_solicitante} if ctype == 'ISSUED' else {'rfc_receptor': self.rfc_solicitante}
            srv = Srv(self.current_fiel)
            r = srv.solicitar_descarga(self.auth_token, self.rfc_solicitante, s, e, tipo_solicitud=dtype, **kwargs)
            if self._is_bad_token(r): 
                if self.authenticate(True): return self._send_req(s, e, dtype)
            return r.get('id_solicitud')
        except: return None

    def remove_request_local(self, rid):
        with self.data_lock:
            if rid in self.active_solicitud_ids: self.active_solicitud_ids.remove(rid)
            if rid in self.request_data: del self.request_data[rid]
        self.save_auto_session()
        self.gui_app.refresh_table_counters()

    def rescue_request_by_id(self, rid):
        self.rescue_requests_batch([rid])

    def rescue_requests_batch(self, rids):
        if not self.auth_token:
            self.gui_app.log_console("⚠️ Autentícate primero.")
            return
        
        count = 0
        valid_rids = []
        with self.data_lock:
            for rid in rids:
                rid = rid.strip()
                if not rid: continue
                valid_rids.append(rid)
                if rid not in self.active_solicitud_ids:
                    self.active_solicitud_ids.append(rid)
                    self.request_data[rid] = {
                        'rfc': self.rfc_solicitante,
                        'start': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        'status_code': 1,
                        'last_msg': 'Rescatada'
                    }
                    count += 1
        
        if valid_rids:
            self.gui_app.log_console(f"🚑 Rescatando {len(valid_rids)} solicitudes...")
            self.save_auto_session()
            self.gui_app.refresh_table_counters()
            threading.Thread(target=self._check_ids_once, args=(valid_rids,), daemon=True).start()
        else:
            self.gui_app.log_console("⚠️ No se ingresaron IDs válidos.")

    # --- MONITOR ---
    def _check_ids_once(self, ids_to_check):
        verifier = VerificaSolicitudDescarga(self.current_fiel)
        still_pending = []
        for rid in ids_to_check:
            if rid not in self.active_solicitud_ids: continue
            target_rfc = self.request_data.get(rid, {}).get('rfc', '')
            if target_rfc != self.rfc_solicitante:
                with self.data_lock: self.request_data[rid]['last_msg'] = f"⚠️ Requiere RFC {target_rfc}"
                still_pending.append(rid); continue

            try:
                r = verifier.verificar_descarga(self.auth_token, self.rfc_solicitante, rid)
                if self._is_bad_token(r):
                    self.authenticate(True); still_pending.append(rid); continue
                st = int(r.get('estado_solicitud', -1))
                with self.data_lock:
                    self.request_data[rid]['status_code'] = st
                    if st == 3:
                        self.request_data[rid]['last_msg'] = "Descargando..."
                        self.gui_app.refresh_table_counters()
                        pkgs = r.get('paquetes', [])
                        if pkgs: self._download_pkgs(pkgs)
                        self.request_data[rid]['last_msg'] = "Completada"
                    elif st in (1, 2):
                        self.request_data[rid]['last_msg'] = "En Proceso (SAT)"; still_pending.append(rid)
                    elif st == 0 or str(r.get('cod_estatus')) == '404':
                        self.request_data[rid]['last_msg'] = "SAT Busy (Reintento)"; still_pending.append(rid)
                    else:
                        self.request_data[rid]['last_msg'] = f"Error {st}: {r.get('mensaje')}"
                        self.request_data[rid]['status_code'] = 4
            except: still_pending.append(rid)
        self.gui_app.refresh_table_counters()
        return still_pending

    def _monitor_bulk_requests(self, initial_ids):
        self.monitoring_active = True
        current_pending = list(initial_ids)

        try:
            val = int(self.gui_app.interval_val.get())
            if val < 1: val = 1
        except: val = 1
        unit = self.gui_app.interval_unit.get()
        wait_seconds = val * 3600 if unit == "Horas" else val * 60

        while self.monitoring_active and current_pending:
            # --- LÓGICA DE PAUSA ---
            if self.is_paused:
                self.gui_app.update_status_lbl("⏸ Monitor Pausado (Esperando reanudación)...")
                time.sleep(1)
                continue
            # -----------------------

            self.gui_app.log_console(f"🔎 Auto-Check: {len(current_pending)} pendientes...")
            current_pending = self._check_ids_once(current_pending)
            self.save_auto_session()

            if current_pending:
                # Cuenta regresiva con soporte de Pausa
                i = wait_seconds
                while i > 0 and self.monitoring_active:
                    if self.is_paused:
                        self.gui_app.update_status_lbl("⏸ Monitor Pausado (Esperando reanudación)...")
                        time.sleep(1)
                        continue # Bucle infinito hasta que quiten pausa o cierren
                    
                    # Re-sincronizar si hay cambios
                    active_unfinished = [rid for rid in self.active_solicitud_ids 
                                         if self.request_data.get(rid, {}).get('status_code') not in (3, 4)]
                    if len(active_unfinished) > len(current_pending): current_pending = active_unfinished

                    if i % 10 == 0: self.gui_app.update_status_lbl(f"Próxima revisión auto en {i}s")
                    time.sleep(1)
                    i -= 1
            else:
                self.gui_app.log_console("🎉 Pendientes finalizados.")
                self.gui_app.update_status_lbl("Listo.")
                self.save_auto_session()
        
        self.monitoring_active = False

    def toggle_pause(self):
        """Alterna el estado de pausa."""
        self.is_paused = not self.is_paused
        return self.is_paused

    def manual_verify(self):
        pending = [rid for rid in self.active_solicitud_ids 
                   if self.request_data.get(rid, {}).get('status_code') not in (3, 4)]
        if pending:
            self.gui_app.log_console("👆 Verificando manual...")
            threading.Thread(target=self._check_ids_once, args=(pending,), daemon=True).start()

    def manual_download(self): self.gui_app.log_console("ℹ️ Sistema descarga automáticamente.")

    def _download_pkgs(self, pkgs):
        dl = DescargaMasiva(self.current_fiel)
        all_meta = []
        for pid in pkgs:
            try:
                with self.data_lock:
                    path_zip = os.path.join(self.output_dir, f"{pid}.zip")
                    if os.path.exists(path_zip): continue

                r = dl.descargar_paquete(self.auth_token, self.rfc_solicitante, pid)
                if r.get('paquete_b64'):
                    data = base64.b64decode(r['paquete_b64'])
                    with self.data_lock:
                        with open(path_zip, 'wb') as f: f.write(data)
                    with zipfile.ZipFile(io.BytesIO(data)) as z:
                        for x in z.namelist():
                            if x.endswith('.xml'):
                                m = self._parse_xml(z.read(x))
                                if m: all_meta.append(m)
            except: pass
        if all_meta: self._save_csv(all_meta)

    def _save_csv(self, data):
        try:
            path = os.path.join(self.output_dir, f"meta_{datetime.now().strftime('%H%M%S')}.csv")
            with self.data_lock: 
                with open(path, 'w', newline='', encoding='utf-8-sig') as f:
                    w = csv.DictWriter(f, fieldnames=list(data[0].keys()))
                    w.writeheader(); w.writerows(data)
            self.gui_app.log_console(f"💾 CSV guardado: {os.path.basename(path)}")
        except: pass

    def _parse_xml(self, b):
        try:
            r = etree.fromstring(b)
            ns = {'cfdi': 'http://www.sat.gob.mx/cfd/3', 'tfd': 'http://www.sat.gob.mx/TimbreFiscalDigital'}
            tfd = r.find('.//tfd:TimbreFiscalDigital', ns)
            return {"UUID": tfd.get('UUID') if tfd is not None else "", "Total": r.get('Total')}
        except: return None

    def _is_bad_token(self, r): return 'token' in str(r).lower()

# --- GUI ---
class SATExtractorGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("SAT Web Service v6.1 - Pausa y Rescate")
        self.geometry("1050x800")
        self.extractor = SATExtractor(self)
        self.setup_ui()
        self.after(1000, self.auto_load)

    def auto_load(self):
        if self.extractor.load_auto_session():
            self.log_console("♻️ Sesión automática recuperada.")
            rfc = self.rfc_solicitante_var.get(); pwd = self.pass_var.get()
            if rfc and pwd:
                 if self.extractor.select_fiel_by_rfc(rfc, pwd, silent=True):
                     if self.extractor.authenticate(silent=True):
                         pending = [rid for rid in self.extractor.active_solicitud_ids 
                                    if self.extractor.request_data.get(rid, {}).get('status_code') not in (3, 4)]
                         if pending:
                             threading.Thread(target=self.extractor._monitor_bulk_requests, args=(pending,), daemon=True).start()

    def setup_ui(self):
        # 1. Config y Sesión
        fr_cfg = ttk.LabelFrame(self, text="1. Configuración y Sesión", padding=5)
        fr_cfg.pack(fill="x", padx=5, pady=5)
        
        ttk.Label(fr_cfg, text="RFC:").pack(side="left")
        self.rfc_solicitante_var = tk.StringVar()
        self.cmb_rfc = ttk.Combobox(fr_cfg, textvariable=self.rfc_solicitante_var, width=13, state="readonly")
        self.cmb_rfc.pack(side="left", padx=2); self.cmb_rfc.bind("<<ComboboxSelected>>", self.on_rfc)
        
        ttk.Label(fr_cfg, text="Pass:").pack(side="left")
        self.pass_var = tk.StringVar(); ttk.Entry(fr_cfg, textvariable=self.pass_var, show="*", width=10).pack(side="left")
        
        ttk.Button(fr_cfg, text="FIELs", command=self.open_manager).pack(side="left", padx=2)
        ttk.Button(fr_cfg, text="Carpeta", command=self.sel_folder).pack(side="left", padx=2)
        
        ttk.Separator(fr_cfg, orient="vertical").pack(side="left", fill="y", padx=5)
        ttk.Button(fr_cfg, text="💾 Guardar Sesión", command=self.save_session_dialog).pack(side="left", padx=2)
        ttk.Button(fr_cfg, text="📂 Cargar Sesión", command=self.load_session_dialog).pack(side="left", padx=2)

        self.lbl_folder_path = ttk.Label(fr_cfg, text="...", relief="sunken", width=15)
        self.lbl_folder_path.pack(side="left", fill="x", expand=True, padx=5)

        # 2. Parámetros
        fr_param = ttk.LabelFrame(self, text="2. Parámetros de Descarga", padding=5)
        fr_param.pack(fill="x", padx=5)
        
        ttk.Label(fr_param, text="Inicio:").pack(side="left")
        self.start_var = tk.StringVar(value=(datetime.now()-timedelta(days=30)).strftime("%Y-%m-%d"))
        ttk.Entry(fr_param, textvariable=self.start_var, width=10).pack(side="left")
        ttk.Label(fr_param, text="Fin:").pack(side="left")
        self.end_var = tk.StringVar(value=datetime.now().strftime("%Y-%m-%d"))
        ttk.Entry(fr_param, textvariable=self.end_var, width=10).pack(side="left")

        ttk.Separator(fr_param, orient="vertical").pack(side="left", fill="y", padx=5)
        self.cfdi_type_var = tk.StringVar(value="ISSUED")
        ttk.Radiobutton(fr_param, text="Emit", variable=self.cfdi_type_var, value="ISSUED").pack(side="left")
        ttk.Radiobutton(fr_param, text="Recib", variable=self.cfdi_type_var, value="RECEIVED").pack(side="left")

        ttk.Separator(fr_param, orient="vertical").pack(side="left", fill="y", padx=5)
        ttk.Label(fr_param, text="Tipo:").pack(side="left")
        self.download_type_var = tk.StringVar(value="Metadata")
        ttk.Combobox(fr_param, textvariable=self.download_type_var, values=["Metadata", "CFDI"], state="readonly", width=9).pack(side="left")

        ttk.Separator(fr_param, orient="vertical").pack(side="left", fill="y", padx=5)
        ttk.Label(fr_param, text="Check:").pack(side="left")
        self.interval_val = tk.StringVar(value="1")
        ttk.Spinbox(fr_param, from_=1, to=60, textvariable=self.interval_val, width=3).pack(side="left")
        self.interval_unit = tk.StringVar(value="Minutos")
        ttk.Combobox(fr_param, textvariable=self.interval_unit, values=["Minutos", "Horas"], state="readonly", width=7).pack(side="left")

        # 3. Botones
        fr_btns = ttk.Frame(self, padding=5)
        fr_btns.pack(fill="x", padx=5)
        ttk.Button(fr_btns, text="1. Autenticar", command=self.on_auth).pack(fill="x", pady=2)
        ttk.Button(fr_btns, text="2. INICIAR AUTOMÁTICO", command=self.on_start_auto).pack(fill="x", pady=2)
        
        fr_man = ttk.Frame(self, padding=5); fr_man.pack(fill="x", padx=5)
        ttk.Button(fr_man, text="Verificar Manual", command=self.extractor.manual_verify).pack(side="left", fill="x", expand=True)
        ttk.Button(fr_man, text="Descargar Manual", command=self.extractor.manual_download).pack(side="left", fill="x", expand=True)

        # 4. Tablero
        fr_dash = ttk.LabelFrame(self, text="Tablero de Control", padding=5)
        fr_dash.pack(fill="both", expand=True, padx=5)
        
        fr_tools = ttk.Frame(fr_dash); fr_tools.pack(fill="x", pady=2)
        ttk.Button(fr_tools, text="🚑 Rescatar ID", command=self.ask_rescue).pack(side="left")
        ttk.Button(fr_tools, text="🗑️ Eliminar/Olvidar", command=self.delete_selected).pack(side="left", padx=5)
        
        # --- BOTÓN DE PAUSA ---
        self.btn_pause = ttk.Button(fr_tools, text="⏸ Pausar Monitor", command=self.toggle_pause_ui)
        self.btn_pause.pack(side="left", padx=20)
        # ----------------------

        ttk.Button(fr_tools, text="🧹 Limpiar Completadas", command=self.clean_completed).pack(side="right")

        cols = ("ID", "RFC", "Estado", "Inicio", "Proceso", "Hechas")
        self.tree = ttk.Treeview(fr_dash, columns=cols, show="headings", height=8)
        self.tree.heading("ID", text="ID"); self.tree.column("ID", width=220)
        self.tree.heading("RFC", text="RFC"); self.tree.column("RFC", width=90)
        self.tree.heading("Estado", text="Estado"); self.tree.column("Estado", width=180)
        self.tree.heading("Inicio", text="Inicio"); self.tree.column("Inicio", width=110)
        self.tree.heading("Proceso", text="Proc"); self.tree.column("Proceso", width=50, anchor="center")
        self.tree.heading("Hechas", text="Fin"); self.tree.column("Hechas", width=50, anchor="center")
        sb = ttk.Scrollbar(fr_dash, command=self.tree.yview); self.tree.config(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True); sb.pack(side="right", fill="y")
        
        self.ctx_menu = tk.Menu(self.tree, tearoff=0)
        self.ctx_menu.add_command(label="Eliminar / Olvidar", command=self.delete_selected)
        self.tree.bind("<Button-3>", self.show_ctx_menu)

        # 5. Log
        fr_con = ttk.LabelFrame(self, text="Log", padding=5); fr_con.pack(fill="both", expand=True, padx=5, pady=5)
        ttk.Button(fr_con, text="Limpiar Log", command=self.clear_console).pack(side="top", anchor="e")
        self.console = tk.Text(fr_con, height=6, bg="#f0f0f0", font=("Consolas", 9))
        self.console.pack(fill="both", expand=True)
        self.lbl_status = ttk.Label(self, text="Listo.", anchor="w"); self.lbl_status.pack(side="bottom", fill="x", padx=5)
        self.update_rfc_list()

    def toggle_pause_ui(self):
        is_paused = self.extractor.toggle_pause()
        if is_paused:
            self.btn_pause.config(text="▶ Reanudar Monitor")
            self.update_status_lbl("⏸ Monitor Pausado.")
        else:
            self.btn_pause.config(text="⏸ Pausar Monitor")
            self.update_status_lbl("▶ Monitor Reanudado.")

    def update_rfc_list(self):
        vals = [x['rfc'] for x in self.extractor.fiels_catalog]
        self.cmb_rfc['values'] = vals
        if vals: self.cmb_rfc.current(0)

    def log_console(self, msg):
        ts = datetime.now().strftime("%H:%M:%S")
        self.console.config(state='normal')
        self.console.insert("1.0", f"[{ts}] {msg}\n")
        self.console.config(state='disabled')
        self.lbl_status.config(text=msg)

    def clear_console(self):
        self.console.config(state='normal'); self.console.delete('1.0', tk.END); self.console.config(state='disabled')
    
    def update_status_lbl(self, msg): self.lbl_status.config(text=msg)

    def refresh_table_counters(self):
        self.clear_tree()
        in_proc_list = []
        completed_list = []
        others = []
        for rid in self.extractor.active_solicitud_ids:
            d = self.extractor.request_data.get(rid, {})
            code = d.get('status_code', -1)
            if code == 3: completed_list.append(rid)
            elif code in (1, 2, 0) or code == -1: in_proc_list.append(rid)
            else: others.append(rid)
        for idx, rid in enumerate(in_proc_list, start=1):
            d = self.extractor.request_data.get(rid, {})
            self.tree.insert("", "end", iid=rid, values=(rid, d.get('rfc'), d.get('last_msg', 'Pendiente'), d.get('start'), str(idx), "0"))
        for idx, rid in enumerate(completed_list, start=1):
            d = self.extractor.request_data.get(rid, {})
            self.tree.insert("", "end", iid=rid, values=(rid, d.get('rfc'), d.get('last_msg', 'Completada'), d.get('start'), "0", str(idx)))
        for rid in others:
            d = self.extractor.request_data.get(rid, {})
            self.tree.insert("", "end", iid=rid, values=(rid, d.get('rfc'), d.get('last_msg', 'Error'), d.get('start'), "0", "0"))

    def clear_tree(self):
        for i in self.tree.get_children(): self.tree.delete(i)
    def clean_completed(self):
        self.extractor.clean_completed = [] # (Logic in Extractor actually)
        to_keep = []
        for rid in self.extractor.active_solicitud_ids:
            code = self.extractor.request_data.get(rid, {}).get('status_code')
            if code != 3: to_keep.append(rid)
        self.extractor.active_solicitud_ids = to_keep
        self.extractor.save_auto_session()
        self.refresh_table_counters()
        self.log_console("🧹 Limpiado.")

    def delete_selected(self):
        sel = self.tree.selection()
        if not sel: return
        if messagebox.askyesno("Confirmar", "¿Olvidar solicitud localmente?"):
            for rid in sel: self.extractor.remove_request_local(rid)
            self.log_console("🗑️ Eliminado.")
    def show_ctx_menu(self, event):
        item = self.tree.identify_row(event.y)
        if item: self.tree.selection_set(item); self.ctx_menu.post(event.x_root, event.y_root)
    def save_session_dialog(self):
        f = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON Session", "*.json")])
        if f: self.extractor.export_session_manual(f)
    def load_session_dialog(self):
        f = filedialog.askopenfilename(filetypes=[("JSON Session", "*.json")])
        if f: 
            if self.extractor.import_session_manual(f): self.log_console("📂 Cargado.")
    def ask_rescue(self):
        RescueSelectionDialog(self, self.extractor.rescue_requests_batch)
    def on_rfc(self, e): self.clear_console(); self.pass_var.set("")
    def open_manager(self): FielManagerWindow(self, self.extractor)

    def sel_folder(self):
        d = filedialog.askdirectory()
        if d: self.extractor.set_output_directory(d); self.lbl_folder_path.config(text=d)
    def on_auth(self):
        self.extractor.select_fiel_by_rfc(self.rfc_solicitante_var.get(), self.pass_var.get())
        self.extractor.authenticate()
    def on_start_auto(self):
        try:
            s = datetime.strptime(self.start_var.get(), "%Y-%m-%d")
            e = datetime.strptime(self.end_var.get(), "%Y-%m-%d")
            dtype = self.download_type_var.get()
            if self.extractor.select_fiel_by_rfc(self.rfc_solicitante_var.get(), self.pass_var.get()):
                if self.extractor.authenticate():
                    threading.Thread(target=self.extractor.start_bulk_process, args=(s,e,dtype), daemon=True).start()
        except: messagebox.showerror("Error", "Fechas")

class RescueSelectionDialog(tk.Toplevel):
    def __init__(self, parent, callback):
        super().__init__(parent)
        self.title("Rescatar Múltiples Solicitudes")
        self.geometry("400x400")
        self.callback = callback
        
        ttk.Label(self, text="Ingresa los UUIDs de solicitud (uno por línea):").pack(pady=5)
        self.txt_ids = tk.Text(self, height=15, width=40)
        self.txt_ids.pack(padx=10, pady=5, fill="both", expand=True)
        
        btn_frame = ttk.Frame(self)
        btn_frame.pack(fill="x", pady=10)
        ttk.Button(btn_frame, text="Cancelar", command=self.destroy).pack(side="right", padx=10)
        ttk.Button(btn_frame, text="Rescatar IDs", command=self.on_confirm).pack(side="right", padx=5)

    def on_confirm(self):
        content = self.txt_ids.get("1.0", tk.END)
        # Separar por saltos de línea y comas, y limpiar espacios
        raw_ids = content.replace(',', '\n').split('\n')
        clean_ids = [x.strip() for x in raw_ids if x.strip()]
        
        if clean_ids:
            self.callback(clean_ids)
            self.destroy()
        else:
            messagebox.showwarning("Atención", "No has ingresado ningún ID válido.")

class FielManagerWindow(tk.Toplevel):
    def __init__(self, parent, extractor):
        super().__init__(parent)
        self.ext = extractor; self.geometry("400x300")
        self.l = tk.Listbox(self); self.l.pack(fill="both", expand=True)
        ttk.Button(self, text="Add", command=self.add).pack()
        ttk.Button(self, text="Del", command=self.dele).pack()
        self.ref()
    def ref(self):
        self.l.delete(0,tk.END)
        for x in self.ext.fiels_catalog: self.l.insert(tk.END, x['rfc'])
    def add(self):
        r = simpledialog.askstring("RFC","RFC"); c = filedialog.askopenfilename(); k = filedialog.askopenfilename()
        if r and c and k: self.ext.add_fiel_entry(r,c,k); self.ref(); self.master.update_rfc_list()
    def dele(self):
        s = self.l.curselection()
        if s: 
            self.ext.fiels_catalog = [x for x in self.ext.fiels_catalog if x['rfc'] != self.l.get(s[0])]
            self.ext._save_fiels_catalog(); self.ref(); self.master.update_rfc_list()

if __name__ == "__main__":
    SATExtractorGUI().mainloop()