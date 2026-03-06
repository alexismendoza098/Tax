# Descargas.py - Versión 7.1: Descargas especiales mejoradas (RFC/UUID: 1, varios, archivo)
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
import os
import sys
from datetime import datetime, timedelta

# --- VERSIÓN DEL EJECUTABLE ---
APP_VERSION = "7.1"
APP_BUILD = "20260104_2115"
APP_NAME = f"SAT_WebService_{APP_BUILD}"
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
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")
MAX_BACKUPS = 10

logger = logging.getLogger('SAT_DescargaMasiva')
logger.setLevel(logging.DEBUG)
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    logger.addHandler(ch)

def backup_script():
    """Crea un respaldo del script actual antes de ejecutarse."""
    try:
        script_path = os.path.abspath(__file__)
        os.makedirs(BACKUP_DIR, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"Descargas_v{APP_VERSION}_{timestamp}.py"
        backup_path = os.path.join(BACKUP_DIR, backup_name)

        import shutil
        shutil.copy2(script_path, backup_path)

        # Limpiar respaldos antiguos, conservar solo MAX_BACKUPS
        backups = sorted(
            [f for f in os.listdir(BACKUP_DIR) if f.startswith("Descargas_v") and f.endswith(".py")],
            reverse=True
        )
        for old in backups[MAX_BACKUPS:]:
            os.remove(os.path.join(BACKUP_DIR, old))

        return backup_path
    except Exception as e:
        print(f"Advertencia: No se pudo respaldar el script: {e}")
        return None

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
        self.data_lock = threading.RLock()  # RLock permite re-entrada del mismo thread
        
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
            with open(item['cer_path'], 'rb') as f: c = f.read()
            with open(item['key_path'], 'rb') as f: k = f.read()
            self.current_fiel = Fiel(c, k, pwd)
            self.rfc_solicitante = rfc; self.current_password = pwd
            return True
        except Exception as e:
            if not silent: self.gui_app.log_console(f"Error FIEL: {e}")
            return False

    def authenticate(self, silent=False):
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

    def start_bulk_process(self, start, end, dtype, rfc_list=None, uuids_list=None):
        """Inicia proceso masivo de descarga
        rfc_list: lista de RFCs de contraparte (puede ser None o lista vacía para modo normal)
        uuids_list: lista de UUIDs específicos (prioridad sobre rfc_list)
        """
        if self.monitoring_active:
            self.gui_app.log_console("⚠️ Monitor activo. Espera o detenlo.")
            return
        if not self.auth_token:
            self.gui_app.log_console("⚠️ Error: No autenticado.")
            return

        new_ids = []

        # Modo UUID: solicitud por cada UUID
        if uuids_list:
            self.gui_app.log_console(f"🚀 Modo UUID: Generando {len(uuids_list)} solicitudes por UUID...")
            for i, uuid in enumerate(uuids_list, 1):
                self.gui_app.log_console(f"[{i}/{len(uuids_list)}] Solicitando UUID: {uuid[:20]}...")
                rid = self._send_req(start, end, dtype, rfc_contraparte=None, uuid=uuid)
                if rid:
                    new_ids.append(rid)
                    with self.data_lock:
                        if rid not in self.active_solicitud_ids:
                            self.active_solicitud_ids.append(rid)
                        self.request_data[rid] = {
                            'rfc': self.rfc_solicitante,
                            'start': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            'status_code': 1,
                            'last_msg': f'UUID: {uuid[:12]}...'
                        }
                    time.sleep(0.5)
                else:
                    self.gui_app.log_console(f"   -> Falló solicitud UUID.")

        # Modo RFC Contraparte: solicitud por cada RFC * cada rango de fechas
        elif rfc_list:
            ranges = self.split_dates(start, end)
            total = len(rfc_list) * len(ranges)
            self.gui_app.log_console(f"🚀 Modo RFC Contraparte: {len(rfc_list)} RFCs × {len(ranges)} rangos = {total} solicitudes...")

            count = 0
            for rfc_cp in rfc_list:
                self.gui_app.log_console(f"📌 RFC Contraparte: {rfc_cp}")
                for s, e in ranges:
                    count += 1
                    self.gui_app.log_console(f"[{count}/{total}] {rfc_cp} | {s.date()} - {e.date()}")
                    rid = self._send_req(s, e, dtype, rfc_contraparte=rfc_cp)
                    if rid:
                        new_ids.append(rid)
                        with self.data_lock:
                            if rid not in self.active_solicitud_ids:
                                self.active_solicitud_ids.append(rid)
                            self.request_data[rid] = {
                                'rfc': self.rfc_solicitante,
                                'start': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                'status_code': 1,
                                'last_msg': f'RFC: {rfc_cp}'
                            }
                        time.sleep(1)
                    else:
                        self.gui_app.log_console(f"   -> Falló solicitud.")

        # Modo Normal: solo por rangos de fechas
        else:
            ranges = self.split_dates(start, end)
            self.gui_app.log_console(f"🚀 Modo Normal: Generando {len(ranges)} solicitudes...")

            for i, (s, e) in enumerate(ranges, 1):
                self.gui_app.log_console(f"[{i}/{len(ranges)}] {s.date()} - {e.date()}")
                rid = self._send_req(s, e, dtype, rfc_contraparte=None)
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

    def _send_req(self, s, e, dtype, rfc_contraparte=None, uuid=None):
        try:
            ctype = self.gui_app.cfdi_type_var.get().upper()
            rfc_upper = self.rfc_solicitante.upper()  # Asegurar mayúsculas

            if ctype == 'ISSUED':
                Srv = SolicitaDescargaEmitidos
                kwargs = {'rfc_emisor': rfc_upper, 'estado_comprobante': 'Vigente'}
                # RFC contraparte para Emitidos = receptor
                if rfc_contraparte:
                    kwargs['rfc_receptor'] = rfc_contraparte.upper()
            else:
                Srv = SolicitaDescargaRecibidos
                kwargs = {'rfc_receptor': rfc_upper, 'estado_comprobante': 'Vigente'}
                # RFC contraparte para Recibidos = emisor
                if rfc_contraparte:
                    kwargs['rfc_emisor'] = rfc_contraparte.upper()

            # Agregar UUID si se especifica (para descarga de CFDI específico)
            if uuid:
                kwargs['uuid'] = uuid

            srv = Srv(self.current_fiel)
            self.gui_app.log_console(f"   → Enviando solicitud {ctype}: {s.date()} a {e.date()}")
            self.gui_app.log_console(f"   → Params: RFC={rfc_upper}, tipo={dtype}, kwargs={kwargs}")
            r = srv.solicitar_descarga(self.auth_token, rfc_upper, s, e, tipo_solicitud=dtype, **kwargs)

            # Log de respuesta del SAT
            cod = r.get('cod_estatus', 'N/A')
            msg = r.get('mensaje', 'Sin mensaje')
            id_sol = r.get('id_solicitud')
            self.gui_app.log_console(f"   ← SAT responde: cod={cod}, id={id_sol}, msg={msg}")

            if self._is_bad_token(r):
                self.gui_app.log_console("   ⚠️ Token inválido, reautenticando...")
                if self.authenticate(True):
                    return self._send_req(s, e, dtype, rfc_contraparte, uuid)
            return id_sol
        except Exception as ex:
            self.gui_app.log_console(f"   ❌ Error en solicitud: {type(ex).__name__}: {ex}")
            logger.exception("Error en _send_req")
            return None

    def remove_request_local(self, rid):
        with self.data_lock:
            if rid in self.active_solicitud_ids: self.active_solicitud_ids.remove(rid)
            if rid in self.request_data: del self.request_data[rid]
        self.save_auto_session()
        self.gui_app.refresh_table_counters()

    def rescue_request_by_id(self, rid):
        if not self.auth_token:
            self.gui_app.log_console("⚠️ Autentícate primero.")
            return
        self.gui_app.log_console(f"🚑 Rescatando ID: {rid}...")
        with self.data_lock:
            if rid not in self.active_solicitud_ids: self.active_solicitud_ids.append(rid)
            self.request_data[rid] = {
                'rfc': self.rfc_solicitante,
                'start': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                'status_code': 1,
                'last_msg': 'Rescatada'
            }
        self.save_auto_session()
        self.gui_app.refresh_table_counters()
        threading.Thread(target=self._check_ids_once, args=([rid],), daemon=True).start()

    # --- MONITOR ---
    def _check_ids_once(self, ids_to_check):
        """
        Verifica 1 vez el estado de cada ID con el SAT y, si ya está listo (st==3),
        intenta descargar los paquetes. Esta versión agrega LOG detallado y evita
        "fallos silenciosos" para que entiendas por qué se queda en 'Descargando...'.
        """
        verifier = VerificaSolicitudDescarga(self.current_fiel)
        still_pending = []
    
        for rid in ids_to_check:
            # Si ya lo borraste localmente, no lo proceses
            if rid not in self.active_solicitud_ids:
                continue
    
            # Protección: el ID está asociado a otro RFC (sesión restaurada / mezclada)
            target_rfc = self.request_data.get(rid, {}).get('rfc', '')
            if target_rfc != self.rfc_solicitante:
                with self.data_lock:
                    self.request_data[rid]['last_msg'] = f"⚠️ Requiere RFC {target_rfc}"
                still_pending.append(rid)
                continue
    
            # LOG: qué vamos a revisar
            self.gui_app.log_console(f"🔎 Verificando ID: {rid}")
    
            try:
                # 1) Preguntar al SAT el estado de la solicitud
                r = verifier.verificar_descarga(self.auth_token, self.rfc_solicitante, rid)
    
                # LOG: respuesta cruda (resumida) para depurar
                cod = r.get('cod_estatus')
                msg = r.get('mensaje')
                est = r.get('estado_solicitud')
                self.gui_app.log_console(f"   ↪ SAT cod_estatus={cod} estado_solicitud={est} mensaje={msg}")
    
                # 2) Si el token está mal, reautenticar y reintentar más tarde
                if self._is_bad_token(r):
                    self.gui_app.log_console("🔑 Token inválido/bloqueado. Reautenticando...")
                    self.authenticate(True)
                    still_pending.append(rid)
                    continue
    
                # 3) Interpretar estado
                st = int(r.get('estado_solicitud', -1))
    
                with self.data_lock:
                    self.request_data[rid]['status_code'] = st
    
                    # ====== ESTADO LISTO PARA DESCARGA ======
                    if st == 3:
                        pkgs = r.get('paquetes') or []
                        self.gui_app.log_console(f"📦 SAT reporta {len(pkgs)} paquete(s) para {rid}")

                        if not pkgs:
                            # Caso común: st==3 pero SAT no trae paquetes (o viene vacío)
                            self.request_data[rid]['last_msg'] = "Esperando paquetes del SAT..."
                            still_pending.append(rid)  # lo dejamos pendiente para reintentar
                            continue

                        # Hay paquetes, intentar descargar
                        self.request_data[rid]['last_msg'] = f"Listo ({len(pkgs)} paq.) - Iniciando..."
                        self.request_data[rid]['download_start'] = datetime.now()
                        self.gui_app.refresh_table_counters()
                        self.gui_app.log_console(f"📁 Carpeta destino: {self.output_dir}")

                        # Intento de descarga de paquetes (si falla, ahora lo veremos)
                        try:
                            self._download_pkgs(pkgs, rid)
                            elapsed = (datetime.now() - self.request_data[rid]['download_start']).seconds
                            self.request_data[rid]['last_msg'] = f"Completada ({elapsed}s)"
                            self.gui_app.log_console(f"✅ Descarga completada para {rid} en {elapsed}s")
                        except Exception as e:
                            # ANTES: fallaba silencioso. AHORA: lo ves.
                            self.request_data[rid]['last_msg'] = f"❌ Error descargando: {type(e).__name__}"
                            self.request_data[rid]['status_code'] = 4
                            self.gui_app.log_console(f"❌ Error descargando paquetes de {rid}: {e}")
                            logger.exception("Error descargando paquetes para rid=%s", rid)
    
                    # ====== EN PROCESO EN SAT ======
                    elif st in (1, 2):
                        self.request_data[rid]['last_msg'] = "En Proceso (SAT)"
                        still_pending.append(rid)
    
                    # ====== SAT SATURADO / REINTENTO ======
                    elif st == 0 or str(r.get('cod_estatus')) == '404':
                        self.request_data[rid]['last_msg'] = "SAT Busy (Reintento)"
                        still_pending.append(rid)
    
                    # ====== CUALQUIER OTRO ESTADO -> ERROR ======
                    else:
                        self.request_data[rid]['last_msg'] = f"Error {st}: {r.get('mensaje')}"
                        self.request_data[rid]['status_code'] = 4
    
            except Exception as e:
                # ANTES: solo still_pending.append(rid) y silencio.
                # AHORA: ves el porqué.
                self.gui_app.log_console(f"❌ Excepción verificando {rid}: {type(e).__name__}: {e}")
                logger.exception("Excepción en _check_ids_once para rid=%s", rid)
                still_pending.append(rid)
    
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
            self.gui_app.log_console(f"🔄 Verificando {len(pending)} solicitud(es) con el SAT...")
            self.gui_app.update_status_lbl(f"Verificando {len(pending)} solicitudes...")
            threading.Thread(target=self._manual_verify_thread, args=(pending,), daemon=True).start()
        else:
            self.gui_app.log_console("✅ No hay solicitudes pendientes de verificar")
            self.gui_app.update_status_lbl("Sin solicitudes pendientes")

    def _manual_verify_thread(self, pending):
        still_pending = self._check_ids_once(pending)
        completed = len(pending) - len(still_pending)
        self.gui_app.log_console(f"✅ Verificación completada: {completed} listas, {len(still_pending)} pendientes")
        self.gui_app.update_status_lbl(f"Verificación completada")

    def manual_download(self):
        self.gui_app.log_console("ℹ️ El sistema descarga automáticamente cuando el SAT tiene los paquetes listos.")
        self.gui_app.log_console(f"📁 Los archivos se guardan en: {self.output_dir}")

    def _download_pkgs(self, pkgs, rid=None):
        dl = DescargaMasiva(self.current_fiel)
        all_meta = []
        total_pkgs = len(pkgs)
        start_time = datetime.now()

        for idx, pid in enumerate(pkgs, 1):
            try:
                # Actualizar progreso
                elapsed = (datetime.now() - start_time).seconds
                if rid:
                    with self.data_lock:
                        self.request_data[rid]['last_msg'] = f"Descargando paquete {idx}/{total_pkgs} ({elapsed}s)"
                    self.gui_app.refresh_table_counters()

                self.gui_app.log_console(f"⬇️ Descargando paquete {idx}/{total_pkgs}: {pid[:20]}...")

                with self.data_lock:
                    path_zip = os.path.join(self.output_dir, f"{pid}.zip")
                    if os.path.exists(path_zip):
                        self.gui_app.log_console(f"   (ya existe, omitiendo)")
                        continue

                self.gui_app.log_console(f"   ⏳ Conectando al SAT para descargar...")
                r = dl.descargar_paquete(self.auth_token, self.rfc_solicitante, pid)
                self.gui_app.log_console(f"   📥 Respuesta recibida del SAT")
                if r.get('paquete_b64'):
                    data = base64.b64decode(r['paquete_b64'])
                    size_kb = len(data) / 1024
                    with self.data_lock:
                        with open(path_zip, 'wb') as f: f.write(data)
                    self.gui_app.log_console(f"   ✓ Guardado: {pid}.zip ({size_kb:.1f} KB)")

                    with zipfile.ZipFile(io.BytesIO(data)) as z:
                        xml_count = 0
                        for x in z.namelist():
                            if x.endswith('.xml'):
                                m = self._parse_xml(z.read(x))
                                if m: all_meta.append(m)
                                xml_count += 1
                        self.gui_app.log_console(f"   📄 {xml_count} XMLs extraídos")
                else:
                    self.gui_app.log_console(f"   ⚠️ Paquete vacío o sin datos")

            except Exception as e:
                self.gui_app.log_console(f"❌ Error descargando paquete {pid}: {e}")
                logger.exception("Error descargando paquete %s", pid)

        if all_meta:
            self._save_csv(all_meta)
            self.gui_app.log_console(f"📊 Total: {len(all_meta)} registros procesados")

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
        self.title(f"SAT Web Service v{APP_VERSION} - Code Business")
        self.geometry("1050x800")
        self.extractor = SATExtractor(self)
        self.setup_menubar()
        self.setup_ui()
        # Respaldo automático del script
        backup_result = backup_script()
        if backup_result:
            self.log_console(f"Respaldo creado: {os.path.basename(backup_result)}")
        # Mostrar nombre del exe al iniciar
        self.log_console(f"🚀 Iniciando {APP_NAME}.exe (v{APP_VERSION})")
        self.after(1000, self.auto_load)

    def setup_menubar(self):
        menubar = tk.Menu(self)
        self.config(menu=menubar)

        # Menú Configuración
        config_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="Configuración", menu=config_menu)
        config_menu.add_command(label="Opciones de Descarga...", command=self.show_config_dialog)

        # Menú Ayuda
        help_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="Ayuda", menu=help_menu)
        help_menu.add_command(label="Acerca de...", command=self.show_about)
        help_menu.add_command(label="Visitar Web", command=self.open_website)

    def show_config_dialog(self):
        ConfigDialog(self, self.extractor)

    def show_about(self):
        about_text = f"""SAT Web Service v{APP_VERSION}
Build: {APP_BUILD}
Ejecutable: {APP_NAME}.exe

Descarga Masiva de CFDIs del SAT

Desarrollado por:
Code Business
https://www.code-business.com/

Este software permite la descarga automatizada
de comprobantes fiscales digitales (CFDI) desde
el portal del SAT usando la e.firma (FIEL).

© 2025 Code Business - Todos los derechos reservados"""
        messagebox.showinfo("Acerca de SAT Web Service", about_text)

    def open_website(self):
        import webbrowser
        webbrowser.open("https://www.code-business.com/")

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

        ttk.Separator(fr_cfg, orient="vertical").pack(side="left", fill="y", padx=5)
        ttk.Button(fr_cfg, text="💾 Guardar Sesión", command=self.save_session_dialog).pack(side="left", padx=2)
        ttk.Button(fr_cfg, text="📂 Cargar Sesión", command=self.load_session_dialog).pack(side="left", padx=2)

        # Carpeta de descarga (más visible)
        fr_folder = ttk.LabelFrame(self, text="📁 Carpeta de Descarga", padding=5)
        fr_folder.pack(fill="x", padx=5, pady=2)

        self.lbl_folder_path = ttk.Label(fr_folder, text=self.extractor.output_dir,
                                          font=("Consolas", 9), foreground="blue", cursor="hand2")
        self.lbl_folder_path.pack(side="left", fill="x", expand=True)
        self.lbl_folder_path.bind("<Button-1>", lambda e: self.open_download_folder())

        ttk.Button(fr_folder, text="Cambiar", command=self.sel_folder).pack(side="left", padx=2)
        ttk.Button(fr_folder, text="Abrir Carpeta", command=self.open_download_folder).pack(side="left", padx=2)

        # 2. Parámetros
        fr_param = ttk.LabelFrame(self, text="2. Parámetros de Descarga", padding=5)
        fr_param.pack(fill="x", padx=5)
        
        ttk.Label(fr_param, text="Inicio:").pack(side="left")
        # Fecha por defecto: primer día del mes anterior
        today = datetime.now()
        first_day_prev_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
        self.start_var = tk.StringVar(value=first_day_prev_month.strftime("%Y-%m-%d"))
        ttk.Entry(fr_param, textvariable=self.start_var, width=10).pack(side="left")
        ttk.Label(fr_param, text="Fin:").pack(side="left")
        # Fecha fin: ayer (para evitar error de fecha igual)
        self.end_var = tk.StringVar(value=(today - timedelta(days=1)).strftime("%Y-%m-%d"))
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

        # 2.5 Modo de Descarga Especial
        fr_mode = ttk.LabelFrame(self, text="2.5 Modo de Descarga", padding=5)
        fr_mode.pack(fill="x", padx=5, pady=2)

        # Selector de modo principal
        self.download_mode_var = tk.StringVar(value="normal")
        fr_mode_sel = ttk.Frame(fr_mode)
        fr_mode_sel.pack(fill="x")
        ttk.Radiobutton(fr_mode_sel, text="Normal (por fechas)", variable=self.download_mode_var,
                        value="normal", command=self._on_mode_change).pack(side="left")
        ttk.Radiobutton(fr_mode_sel, text="Por RFC Contraparte", variable=self.download_mode_var,
                        value="rfc", command=self._on_mode_change).pack(side="left", padx=10)
        ttk.Radiobutton(fr_mode_sel, text="Por UUIDs específicos", variable=self.download_mode_var,
                        value="uuid", command=self._on_mode_change).pack(side="left")

        # Frame contenedor para opciones específicas
        self.fr_mode_options = ttk.Frame(fr_mode)
        self.fr_mode_options.pack(fill="x", pady=5)

        # === OPCIONES MODO RFC ===
        self.fr_rfc_mode = ttk.Frame(self.fr_mode_options)
        ttk.Label(self.fr_rfc_mode, text="RFC Contraparte (emisor si Recib, receptor si Emit):",
                  font=("", 8, "bold")).pack(anchor="w")
        fr_rfc_opts = ttk.Frame(self.fr_rfc_mode)
        fr_rfc_opts.pack(fill="x", pady=2)

        self.rfc_input_mode = tk.StringVar(value="uno")
        ttk.Radiobutton(fr_rfc_opts, text="Uno:", variable=self.rfc_input_mode,
                        value="uno", command=self._on_rfc_input_change).pack(side="left")
        self.rfc_single_var = tk.StringVar()
        self.ent_rfc_single = ttk.Entry(fr_rfc_opts, textvariable=self.rfc_single_var, width=14)
        self.ent_rfc_single.pack(side="left", padx=2)

        ttk.Radiobutton(fr_rfc_opts, text="Varios:", variable=self.rfc_input_mode,
                        value="varios", command=self._on_rfc_input_change).pack(side="left", padx=(15,0))
        self.rfc_multi_var = tk.StringVar()
        self.ent_rfc_multi = ttk.Entry(fr_rfc_opts, textvariable=self.rfc_multi_var, width=30)
        self.ent_rfc_multi.pack(side="left", padx=2)
        ttk.Label(fr_rfc_opts, text="(separados por coma)", font=("", 7), foreground="gray").pack(side="left")

        fr_rfc_file = ttk.Frame(self.fr_rfc_mode)
        fr_rfc_file.pack(fill="x", pady=2)
        ttk.Radiobutton(fr_rfc_file, text="Desde archivo:", variable=self.rfc_input_mode,
                        value="archivo", command=self._on_rfc_input_change).pack(side="left")
        ttk.Button(fr_rfc_file, text="📂 Cargar CSV/XLSX",
                   command=lambda: self._load_file_column("rfc")).pack(side="left", padx=5)
        self.lbl_rfc_file_status = ttk.Label(fr_rfc_file, text="Sin archivo", foreground="gray")
        self.lbl_rfc_file_status.pack(side="left", padx=5)
        self.rfc_list_from_file = []  # Lista de RFCs desde archivo

        # === OPCIONES MODO UUID ===
        self.fr_uuid_mode = ttk.Frame(self.fr_mode_options)
        ttk.Label(self.fr_uuid_mode, text="UUIDs de CFDIs específicos a descargar:",
                  font=("", 8, "bold")).pack(anchor="w")
        fr_uuid_opts = ttk.Frame(self.fr_uuid_mode)
        fr_uuid_opts.pack(fill="x", pady=2)

        self.uuid_input_mode = tk.StringVar(value="uno")
        ttk.Radiobutton(fr_uuid_opts, text="Uno:", variable=self.uuid_input_mode,
                        value="uno", command=self._on_uuid_input_change).pack(side="left")
        self.uuid_single_var = tk.StringVar()
        self.ent_uuid_single = ttk.Entry(fr_uuid_opts, textvariable=self.uuid_single_var, width=38)
        self.ent_uuid_single.pack(side="left", padx=2)

        fr_uuid_multi = ttk.Frame(self.fr_uuid_mode)
        fr_uuid_multi.pack(fill="x", pady=2)
        ttk.Radiobutton(fr_uuid_multi, text="Varios:", variable=self.uuid_input_mode,
                        value="varios", command=self._on_uuid_input_change).pack(side="left")
        self.uuid_multi_var = tk.StringVar()
        self.ent_uuid_multi = ttk.Entry(fr_uuid_multi, textvariable=self.uuid_multi_var, width=60)
        self.ent_uuid_multi.pack(side="left", padx=2)
        ttk.Label(fr_uuid_multi, text="(separados por coma o línea)", font=("", 7), foreground="gray").pack(side="left")

        fr_uuid_file = ttk.Frame(self.fr_uuid_mode)
        fr_uuid_file.pack(fill="x", pady=2)
        ttk.Radiobutton(fr_uuid_file, text="Desde archivo:", variable=self.uuid_input_mode,
                        value="archivo", command=self._on_uuid_input_change).pack(side="left")
        ttk.Button(fr_uuid_file, text="📂 Cargar CSV/XLSX",
                   command=lambda: self._load_file_column("uuid")).pack(side="left", padx=5)
        self.lbl_uuid_file_status = ttk.Label(fr_uuid_file, text="Sin archivo", foreground="gray")
        self.lbl_uuid_file_status.pack(side="left", padx=5)
        self.uuid_list_from_file = []  # Lista de UUIDs desde archivo

        # Inicialmente ocultar opciones especiales
        self._on_mode_change()

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
        self.ctx_menu.add_command(label="Ver Estado / Ayuda", command=self.show_status_help)
        self.ctx_menu.add_separator()
        self.ctx_menu.add_command(label="Copiar ID", command=self.copy_selected_id)
        self.ctx_menu.add_command(label="Copiar Fila Completa", command=self.copy_selected_row)
        self.ctx_menu.add_separator()
        self.ctx_menu.add_command(label="Eliminar / Olvidar", command=self.delete_selected)
        self.tree.bind("<Button-3>", self.show_ctx_menu)

        # 5. Log (con menú contextual para copiar)
        fr_con = ttk.LabelFrame(self, text="Log", padding=5); fr_con.pack(fill="both", expand=True, padx=5, pady=5)
        ttk.Button(fr_con, text="Limpiar Log", command=self.clear_console).pack(side="top", anchor="e")
        self.console = tk.Text(fr_con, height=6, bg="#f0f0f0", font=("Consolas", 9))
        self.console.pack(fill="both", expand=True)

        # Menú contextual para el log
        self.log_ctx_menu = tk.Menu(self.console, tearoff=0)
        self.log_ctx_menu.add_command(label="Copiar", command=self.copy_log_selection)
        self.log_ctx_menu.add_command(label="Seleccionar Todo", command=self.select_all_log)
        self.log_ctx_menu.add_separator()
        self.log_ctx_menu.add_command(label="Copiar Todo el Log", command=self.copy_all_log)
        self.console.bind("<Button-3>", self.show_log_ctx_menu)

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
        self.console.config(state='normal')  # Mantener habilitado para selección
        self.lbl_status.config(text=msg)
        logger.info(msg)  # Added for terminal/file monitoring

    def clear_console(self):
        self.console.delete('1.0', tk.END)

    def update_status_lbl(self, msg): self.lbl_status.config(text=msg)

    # --- Métodos del menú contextual del Log ---
    def show_log_ctx_menu(self, event):
        self.log_ctx_menu.post(event.x_root, event.y_root)

    def copy_log_selection(self):
        try:
            text = self.console.get(tk.SEL_FIRST, tk.SEL_LAST)
            self.clipboard_clear()
            self.clipboard_append(text)
            self.lbl_status.config(text="Texto copiado al portapapeles")
        except tk.TclError:
            self.lbl_status.config(text="No hay texto seleccionado")

    def select_all_log(self):
        self.console.tag_add(tk.SEL, "1.0", tk.END)
        self.console.mark_set(tk.INSERT, "1.0")
        self.console.see(tk.INSERT)

    def copy_all_log(self):
        text = self.console.get("1.0", tk.END)
        self.clipboard_clear()
        self.clipboard_append(text)
        self.lbl_status.config(text="Log completo copiado al portapapeles")

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

    def show_status_help(self):
        sel = self.tree.selection()
        if not sel: return
        rid = sel[0]
        data = self.extractor.request_data.get(rid, {})
        status_code = data.get('status_code', -1)
        last_msg = data.get('last_msg', 'Desconocido')

        # Explicaciones por estado
        status_info = {
            -1: ("Pendiente",
                 "La solicitud fue registrada pero aún no se ha verificado con el SAT.",
                 "Espera a que el monitor automático verifique, o usa 'Verificar Manual'."),
            0: ("SAT Ocupado",
                "El SAT está saturado y no puede procesar la solicitud ahora.",
                "El sistema reintentará automáticamente. No hagas nada, solo espera."),
            1: ("Aceptada",
                "El SAT aceptó la solicitud y la está procesando.",
                "Espera. El SAT está generando los paquetes de descarga."),
            2: ("En Proceso",
                "El SAT está preparando los archivos para descarga.",
                "Espera. Puede tomar desde minutos hasta horas dependiendo del volumen."),
            3: ("Lista para Descargar",
                "Los paquetes están listos. El sistema descargará automáticamente.",
                "Si no se descarga, usa 'Verificar Manual' para forzar la descarga."),
            4: ("Error / Rechazada",
                "Hubo un error en la solicitud o fue rechazada por el SAT.",
                "Revisa el log para más detalles. Puede ser:\n"
                "- Token expirado (reautentícate)\n"
                "- Rango de fechas inválido\n"
                "- RFC incorrecto\n"
                "- Límite de solicitudes alcanzado"),
        }

        title, desc, action = status_info.get(status_code,
            ("Desconocido", "Estado no reconocido.", "Contacta soporte técnico."))

        msg = f"""SOLICITUD: {rid}

ESTADO: {title} (código {status_code})
MENSAJE: {last_msg}

¿QUÉ SIGNIFICA?
{desc}

¿QUÉ HACER?
{action}
"""
        messagebox.showinfo(f"Estado: {title}", msg)

    def copy_selected_id(self):
        sel = self.tree.selection()
        if not sel: return
        rid = sel[0]
        self.clipboard_clear()
        self.clipboard_append(rid)
        self.log_console(f"ID copiado: {rid}")

    def copy_selected_row(self):
        sel = self.tree.selection()
        if not sel: return
        rid = sel[0]
        values = self.tree.item(rid, 'values')
        row_text = "\t".join(str(v) for v in values)
        self.clipboard_clear()
        self.clipboard_append(row_text)
        self.log_console(f"Fila copiada al portapapeles")

    def save_session_dialog(self):
        f = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON Session", "*.json")])
        if f: self.extractor.export_session_manual(f)
    def load_session_dialog(self):
        f = filedialog.askopenfilename(filetypes=[("JSON Session", "*.json")])
        if f: 
            if self.extractor.import_session_manual(f): self.log_console("📂 Cargado.")
    def ask_rescue(self):
        rid = simpledialog.askstring("Rescatar", "UUID de solicitud:")
        if rid: self.extractor.rescue_request_by_id(rid.strip())
    def on_rfc(self, e): self.clear_console(); self.pass_var.set("")
    def open_manager(self): FielManagerWindow(self, self.extractor)
    def sel_folder(self):
        d = filedialog.askdirectory()
        if d:
            self.extractor.set_output_directory(d)
            self.lbl_folder_path.config(text=d)
            self.log_console(f"📁 Carpeta cambiada a: {d}")

    def open_download_folder(self):
        import subprocess
        folder = self.extractor.output_dir
        if os.path.exists(folder):
            subprocess.Popen(f'explorer "{folder}"')
        else:
            messagebox.showwarning("Carpeta no existe",
                f"La carpeta no existe:\n{folder}\n\nSe creará cuando inicie una descarga.")

    def _on_mode_change(self):
        """Muestra/oculta opciones según el modo de descarga seleccionado"""
        mode = self.download_mode_var.get()
        # Ocultar todos
        self.fr_rfc_mode.pack_forget()
        self.fr_uuid_mode.pack_forget()
        # Mostrar el correspondiente
        if mode == "rfc":
            self.fr_rfc_mode.pack(fill="x")
            self._on_rfc_input_change()
        elif mode == "uuid":
            self.fr_uuid_mode.pack(fill="x")
            self._on_uuid_input_change()

    def _on_rfc_input_change(self):
        """Habilita/deshabilita campos según el tipo de entrada RFC"""
        mode = self.rfc_input_mode.get()
        self.ent_rfc_single.config(state="normal" if mode == "uno" else "disabled")
        self.ent_rfc_multi.config(state="normal" if mode == "varios" else "disabled")

    def _on_uuid_input_change(self):
        """Habilita/deshabilita campos según el tipo de entrada UUID"""
        mode = self.uuid_input_mode.get()
        self.ent_uuid_single.config(state="normal" if mode == "uno" else "disabled")
        self.ent_uuid_multi.config(state="normal" if mode == "varios" else "disabled")

    def _load_file_column(self, data_type):
        """Carga datos desde archivo CSV o XLSX con selección de columna
        data_type: 'rfc' o 'uuid'
        """
        filepath = filedialog.askopenfilename(
            title=f"Seleccionar archivo con {'RFCs' if data_type == 'rfc' else 'UUIDs'}",
            filetypes=[("Excel/CSV", "*.xlsx *.xls *.csv"), ("Excel", "*.xlsx *.xls"),
                       ("CSV", "*.csv"), ("Text files", "*.txt"), ("All files", "*.*")]
        )
        if not filepath:
            return

        try:
            headers = []
            rows = []
            is_excel = filepath.lower().endswith(('.xlsx', '.xls'))

            if is_excel:
                # Cargar Excel con openpyxl
                try:
                    import openpyxl
                except ImportError:
                    messagebox.showerror("Error", "Se requiere openpyxl para leer archivos Excel.\n\nInstala con: pip install openpyxl")
                    return

                wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
                ws = wb.active
                all_rows = list(ws.iter_rows(values_only=True))
                if not all_rows:
                    messagebox.showerror("Error", "El archivo Excel está vacío")
                    return
                headers = [str(c) if c else f"Col{i+1}" for i, c in enumerate(all_rows[0])]
                rows = [[str(c) if c else "" for c in row] for row in all_rows[1:]]
                wb.close()
            else:
                # Cargar CSV
                with open(filepath, 'r', encoding='utf-8-sig') as f:
                    sample = f.read(4096)
                    f.seek(0)
                    try:
                        dialect = csv.Sniffer().sniff(sample, delimiters=',;\t|')
                    except:
                        dialect = csv.excel
                    reader = csv.reader(f, dialect)
                    headers = next(reader, None)
                    if not headers:
                        messagebox.showerror("Error", "El archivo CSV está vacío")
                        return
                    rows = list(reader)

            # Mostrar diálogo para seleccionar columna
            col_dialog = tk.Toplevel(self)
            tipo_texto = "RFCs" if data_type == "rfc" else "UUIDs"
            col_dialog.title(f"Seleccionar columna de {tipo_texto}")
            col_dialog.geometry("450x350")
            col_dialog.transient(self)
            col_dialog.grab_set()

            ttk.Label(col_dialog, text=f"Selecciona la columna que contiene los {tipo_texto}:",
                      font=("", 10, "bold")).pack(pady=10)

            fr_list = ttk.Frame(col_dialog)
            fr_list.pack(fill="both", expand=True, padx=10)

            listbox = tk.Listbox(fr_list, font=("Consolas", 9))
            listbox.pack(side="left", fill="both", expand=True)
            sb = ttk.Scrollbar(fr_list, command=listbox.yview)
            sb.pack(side="right", fill="y")
            listbox.config(yscrollcommand=sb.set)

            # Mostrar columnas con ejemplo de primer valor
            for i, header in enumerate(headers):
                sample_val = rows[0][i] if rows and i < len(rows[0]) else ""
                display = f"{i+1}. {header}: \"{sample_val[:35]}\"" + ("..." if len(sample_val) > 35 else "")
                listbox.insert(tk.END, display)

            def on_select():
                sel = listbox.curselection()
                if not sel:
                    messagebox.showwarning("Selección", "Selecciona una columna")
                    return

                col_idx = sel[0]
                result_list = []

                for row in rows:
                    if col_idx < len(row):
                        val_raw = str(row[col_idx]).strip()
                        if not val_raw:
                            continue

                        if data_type == "rfc":
                            # Limpiar RFC: quitar espacios, normalizar
                            rfc_clean = val_raw.replace(" ", "").replace("-", "").upper()
                            # Validar longitud RFC (12-13 caracteres)
                            if 12 <= len(rfc_clean) <= 13:
                                result_list.append(rfc_clean)
                        else:  # uuid
                            # Limpiar UUID: quitar espacios, normalizar
                            uuid_clean = val_raw.replace(" ", "").upper()
                            # Validar formato UUID (32-36 chars)
                            if len(uuid_clean) >= 32:
                                result_list.append(uuid_clean)

                if not result_list:
                    messagebox.showwarning(f"Sin {tipo_texto}", f"No se encontraron {tipo_texto} válidos en esa columna")
                    return

                # Guardar en la lista correspondiente
                if data_type == "rfc":
                    self.rfc_list_from_file = result_list
                    self.lbl_rfc_file_status.config(text=f"✅ {len(result_list)} RFCs", foreground="green")
                else:
                    self.uuid_list_from_file = result_list
                    self.lbl_uuid_file_status.config(text=f"✅ {len(result_list)} UUIDs", foreground="green")

                self.log_console(f"📂 Archivo cargado: {len(result_list)} {tipo_texto} de '{os.path.basename(filepath)}'")
                col_dialog.destroy()

            ttk.Button(col_dialog, text="Seleccionar", command=on_select).pack(pady=10)
            ttk.Label(col_dialog, text=f"Total filas: {len(rows)}", foreground="gray").pack()

        except Exception as ex:
            messagebox.showerror("Error al leer archivo", f"No se pudo leer el archivo:\n{ex}")
            self.log_console(f"❌ Error cargando archivo: {ex}")

    def on_auth(self):
        self.extractor.select_fiel_by_rfc(self.rfc_solicitante_var.get(), self.pass_var.get())
        self.extractor.authenticate()

    def _get_rfc_list(self):
        """Obtiene la lista de RFCs según el modo de entrada seleccionado"""
        input_mode = self.rfc_input_mode.get()
        rfcs = []

        if input_mode == "uno":
            rfc = self.rfc_single_var.get().strip().upper()
            if rfc:
                rfcs = [rfc]
        elif input_mode == "varios":
            raw = self.rfc_multi_var.get()
            # Separar por coma, punto y coma, o espacio
            import re
            parts = re.split(r'[,;\s]+', raw)
            rfcs = [p.strip().upper() for p in parts if p.strip()]
        elif input_mode == "archivo":
            rfcs = self.rfc_list_from_file

        # Validar formato de cada RFC
        valid_rfcs = [r for r in rfcs if 12 <= len(r) <= 13]
        return valid_rfcs

    def _get_uuid_list(self):
        """Obtiene la lista de UUIDs según el modo de entrada seleccionado"""
        input_mode = self.uuid_input_mode.get()
        uuids = []

        if input_mode == "uno":
            uuid = self.uuid_single_var.get().strip().upper().replace(" ", "")
            if uuid and len(uuid) >= 32:
                uuids = [uuid]
        elif input_mode == "varios":
            raw = self.uuid_multi_var.get()
            # Separar por coma, punto y coma, salto de línea o espacio
            import re
            parts = re.split(r'[,;\n\r]+', raw)
            uuids = [p.strip().upper().replace(" ", "") for p in parts if p.strip()]
            # Validar longitud
            uuids = [u for u in uuids if len(u) >= 32]
        elif input_mode == "archivo":
            uuids = self.uuid_list_from_file

        return uuids

    def on_start_auto(self):
        # 0. Obtener modo de descarga
        mode = self.download_mode_var.get()
        rfc_list = []
        uuids_list = []

        # Validar según el modo
        if mode == "rfc":
            rfc_list = self._get_rfc_list()
            if not rfc_list:
                input_mode = self.rfc_input_mode.get()
                if input_mode == "uno":
                    msg = "Ingresa un RFC de contraparte válido (12-13 caracteres)."
                elif input_mode == "varios":
                    msg = "Ingresa uno o más RFCs separados por coma.\n\nEjemplo: RFC123456789,RFC987654321"
                else:
                    msg = "Carga un archivo CSV/XLSX con RFCs.\n\nHaz clic en '📂 Cargar CSV/XLSX'."
                messagebox.showerror("Error", f"Modo RFC Contraparte requiere al menos un RFC válido.\n\n{msg}")
                return

        elif mode == "uuid":
            uuids_list = self._get_uuid_list()
            if not uuids_list:
                input_mode = self.uuid_input_mode.get()
                if input_mode == "uno":
                    msg = "Ingresa un UUID válido (32+ caracteres)."
                elif input_mode == "varios":
                    msg = "Ingresa uno o más UUIDs separados por coma.\n\nEjemplo: ABC123...,DEF456..."
                else:
                    msg = "Carga un archivo CSV/XLSX con UUIDs.\n\nHaz clic en '📂 Cargar CSV/XLSX'."
                messagebox.showerror("Error", f"Modo UUID requiere al menos un UUID válido.\n\n{msg}")
                return

        # 1. Validar fechas
        try:
            s = datetime.strptime(self.start_var.get(), "%Y-%m-%d")
            e = datetime.strptime(self.end_var.get(), "%Y-%m-%d")
        except ValueError:
            messagebox.showerror("Error de Fechas",
                "Formato de fecha inválido.\n\nUsa el formato: AAAA-MM-DD\nEjemplo: 2025-12-01")
            return

        # 2. Validar rango de fechas
        errores = []
        advertencias = []

        if s > e:
            errores.append("❌ La fecha inicial es MAYOR que la fecha final")

        if s == e:
            errores.append("❌ La fecha inicial es IGUAL a la fecha final\n   (el SAT requiere al menos 1 día de diferencia)")

        if e >= datetime.now().replace(hour=0, minute=0, second=0, microsecond=0):
            advertencias.append("⚠️ La fecha final incluye HOY\n   (puede causar error si no hay CFDIs procesados)")

        dias = (e - s).days
        if dias > 365:
            advertencias.append(f"⚠️ Rango muy amplio: {dias} días\n   (se dividirá en múltiples solicitudes)")

        # 3. Validar RFC y contraseña
        rfc = self.rfc_solicitante_var.get()
        pwd = self.pass_var.get()
        if not rfc:
            errores.append("❌ No hay RFC seleccionado")
        if not pwd:
            errores.append("❌ No hay contraseña de FIEL")

        # 4. Mostrar errores si hay
        if errores:
            msg = "ERRORES ENCONTRADOS:\n\n" + "\n\n".join(errores)
            if advertencias:
                msg += "\n\n" + "ADVERTENCIAS:\n\n" + "\n\n".join(advertencias)
            messagebox.showerror("No se puede continuar", msg)
            return

        # 5. Preparar resumen de confirmación
        dtype = self.download_type_var.get()
        ctype = "EMITIDOS" if self.cfdi_type_var.get() == "ISSUED" else "RECIBIDOS"

        # Calcular número de solicitudes según modo
        ranges_count = len(self.extractor.split_dates(s, e))
        if mode == "uuid":
            num_solicitudes = len(uuids_list)
            modo_desc = f"Por UUIDs ({num_solicitudes} CFDIs específicos)"
        elif mode == "rfc":
            num_solicitudes = len(rfc_list) * ranges_count
            if len(rfc_list) == 1:
                modo_desc = f"Por RFC Contraparte: {rfc_list[0]}"
            else:
                modo_desc = f"Por {len(rfc_list)} RFCs Contraparte"
        else:
            num_solicitudes = ranges_count
            modo_desc = "Normal (por fechas)"

        resumen = f"""¿Iniciar descarga con estos parámetros?

📋 RESUMEN DE SOLICITUD:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RFC Solicitante: {rfc}
Tipo de CFDI: {ctype}
Tipo de Descarga: {dtype}
Modo: {modo_desc}
Fecha Inicio: {s.strftime('%Y-%m-%d')}
Fecha Fin: {e.strftime('%Y-%m-%d')}
Días totales: {dias}
Solicitudes a generar: {num_solicitudes}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        if advertencias:
            resumen += "\n\n⚠️ ADVERTENCIAS:\n" + "\n".join(advertencias)

        # 6. Confirmar con el usuario
        if not messagebox.askyesno("Confirmar Descarga", resumen):
            self.log_console("❌ Descarga cancelada por el usuario")
            return

        # 7. Proceder con la descarga
        self.log_console(f"📋 Iniciando: {ctype} | {dtype} | {modo_desc} | {s.date()} → {e.date()}")

        if self.extractor.select_fiel_by_rfc(rfc, pwd):
            if self.extractor.authenticate():
                threading.Thread(
                    target=self.extractor.start_bulk_process,
                    args=(s, e, dtype),
                    kwargs={'rfc_list': rfc_list if rfc_list else None, 'uuids_list': uuids_list if uuids_list else None},
                    daemon=True
                ).start()
            else:
                messagebox.showerror("Error", "No se pudo autenticar con el SAT.\nVerifica tu FIEL y contraseña.")
        else:
            messagebox.showerror("Error", "No se pudo cargar la FIEL.\nVerifica los archivos .cer y .key")

class FielManagerWindow(tk.Toplevel):
    def __init__(self, parent, extractor):
        super().__init__(parent)
        self.ext = extractor
        self.title("Administrador de e.firma (FIEL)")
        self.geometry("500x400")
        self.transient(parent)

        # Instrucciones
        fr_info = ttk.LabelFrame(self, text="Instrucciones", padding=10)
        fr_info.pack(fill="x", padx=10, pady=5)
        ttk.Label(fr_info, text="Para agregar una FIEL necesitas:\n"
                  "• Archivo .CER (certificado)\n"
                  "• Archivo .KEY (llave privada)\n"
                  "• Contraseña de la FIEL", justify="left").pack(anchor="w")

        # Lista de FIELs
        fr_list = ttk.LabelFrame(self, text="FIELs Registradas", padding=10)
        fr_list.pack(fill="both", expand=True, padx=10, pady=5)

        self.l = tk.Listbox(fr_list, font=("Consolas", 10))
        self.l.pack(fill="both", expand=True)

        # Botones
        fr_btns = ttk.Frame(self, padding=10)
        fr_btns.pack(fill="x")
        ttk.Button(fr_btns, text="Agregar FIEL...", command=self.add).pack(side="left", padx=5)
        ttk.Button(fr_btns, text="Eliminar Seleccionada", command=self.dele).pack(side="left", padx=5)
        ttk.Button(fr_btns, text="Cerrar", command=self.destroy).pack(side="right", padx=5)

        self.ref()

    def ref(self):
        self.l.delete(0, tk.END)
        for x in self.ext.fiels_catalog:
            self.l.insert(tk.END, f"RFC: {x['rfc']}")

    def add(self):
        # Paso 1: RFC
        rfc = simpledialog.askstring("Paso 1/3 - RFC",
            "Ingresa el RFC de la FIEL:\n\n(Ejemplo: XAXX010101000)",
            parent=self)
        if not rfc:
            return

        # Paso 2: Archivo CER
        messagebox.showinfo("Paso 2/3 - Certificado",
            "Selecciona el archivo .CER (certificado)\n\n"
            "Este archivo tiene extensión .cer y contiene\n"
            "el certificado de la e.firma.", parent=self)
        cer = filedialog.askopenfilename(
            title="Seleccionar archivo .CER (Certificado)",
            filetypes=[("Certificado", "*.cer"), ("Todos", "*.*")],
            parent=self)
        if not cer:
            return

        # Paso 3: Archivo KEY
        messagebox.showinfo("Paso 3/3 - Llave Privada",
            "Selecciona el archivo .KEY (llave privada)\n\n"
            "Este archivo tiene extensión .key y contiene\n"
            "la llave privada de la e.firma.", parent=self)
        key = filedialog.askopenfilename(
            title="Seleccionar archivo .KEY (Llave Privada)",
            filetypes=[("Llave Privada", "*.key"), ("Todos", "*.*")],
            parent=self)
        if not key:
            return

        # Registrar
        self.ext.add_fiel_entry(rfc.upper().strip(), cer, key)
        self.ref()
        self.master.update_rfc_list()
        messagebox.showinfo("FIEL Agregada",
            f"La FIEL del RFC {rfc.upper()} fue agregada correctamente.\n\n"
            "Recuerda ingresar la contraseña en la pantalla principal\n"
            "antes de autenticarte.", parent=self)

    def dele(self):
        s = self.l.curselection()
        if not s:
            messagebox.showwarning("Selecciona", "Selecciona una FIEL de la lista.", parent=self)
            return
        rfc_text = self.l.get(s[0])
        rfc = rfc_text.replace("RFC: ", "")
        if messagebox.askyesno("Confirmar", f"¿Eliminar la FIEL del RFC {rfc}?", parent=self):
            self.ext.fiels_catalog = [x for x in self.ext.fiels_catalog if x['rfc'] != rfc]
            self.ext._save_fiels_catalog()
            self.ref()
            self.master.update_rfc_list()

class ConfigDialog(tk.Toplevel):
    """Ventana de configuración de descargas"""
    def __init__(self, parent, extractor):
        super().__init__(parent)
        self.parent = parent
        self.ext = extractor
        self.title("Configuración de Descargas")
        self.geometry("500x400")
        self.transient(parent)
        self.grab_set()

        # Frame principal
        main_frame = ttk.Frame(self, padding=10)
        main_frame.pack(fill="both", expand=True)

        # --- Sección: Carpeta de Descarga ---
        ttk.Label(main_frame, text="Carpeta de Descarga:", font=("", 10, "bold")).pack(anchor="w", pady=(0,5))
        fr_folder = ttk.Frame(main_frame)
        fr_folder.pack(fill="x", pady=(0,15))

        self.folder_var = tk.StringVar(value=self.ext.output_dir)
        ttk.Entry(fr_folder, textvariable=self.folder_var, width=50).pack(side="left", fill="x", expand=True)
        ttk.Button(fr_folder, text="Examinar...", command=self.browse_folder).pack(side="left", padx=5)

        # --- Sección: Intervalo de Verificación ---
        ttk.Label(main_frame, text="Intervalo de Verificación:", font=("", 10, "bold")).pack(anchor="w", pady=(0,5))
        fr_interval = ttk.Frame(main_frame)
        fr_interval.pack(fill="x", pady=(0,15))

        self.interval_var = tk.StringVar(value=parent.interval_val.get())
        ttk.Spinbox(fr_interval, from_=1, to=60, textvariable=self.interval_var, width=5).pack(side="left")
        self.unit_var = tk.StringVar(value=parent.interval_unit.get())
        ttk.Combobox(fr_interval, textvariable=self.unit_var, values=["Minutos", "Horas"], state="readonly", width=10).pack(side="left", padx=5)

        # --- Sección: Tipo de Descarga por Defecto ---
        ttk.Label(main_frame, text="Tipo de Descarga por Defecto:", font=("", 10, "bold")).pack(anchor="w", pady=(0,5))
        fr_dtype = ttk.Frame(main_frame)
        fr_dtype.pack(fill="x", pady=(0,15))

        self.dtype_var = tk.StringVar(value=parent.download_type_var.get())
        ttk.Radiobutton(fr_dtype, text="Metadata (más rápido)", variable=self.dtype_var, value="Metadata").pack(side="left")
        ttk.Radiobutton(fr_dtype, text="CFDI (archivos XML)", variable=self.dtype_var, value="CFDI").pack(side="left", padx=10)

        # --- Sección: Tipo de Comprobante ---
        ttk.Label(main_frame, text="Tipo de Comprobante por Defecto:", font=("", 10, "bold")).pack(anchor="w", pady=(0,5))
        fr_cfdi = ttk.Frame(main_frame)
        fr_cfdi.pack(fill="x", pady=(0,15))

        self.cfdi_type_var = tk.StringVar(value=parent.cfdi_type_var.get())
        ttk.Radiobutton(fr_cfdi, text="Emitidos", variable=self.cfdi_type_var, value="ISSUED").pack(side="left")
        ttk.Radiobutton(fr_cfdi, text="Recibidos", variable=self.cfdi_type_var, value="RECEIVED").pack(side="left", padx=10)

        # --- Sección: División de Rangos ---
        ttk.Label(main_frame, text="Días por Solicitud (división de rangos):", font=("", 10, "bold")).pack(anchor="w", pady=(0,5))
        fr_days = ttk.Frame(main_frame)
        fr_days.pack(fill="x", pady=(0,15))

        self.days_var = tk.StringVar(value="30")
        ttk.Spinbox(fr_days, from_=1, to=90, textvariable=self.days_var, width=5).pack(side="left")
        ttk.Label(fr_days, text="días (máx. recomendado: 30)").pack(side="left", padx=5)

        # --- Botones ---
        fr_buttons = ttk.Frame(main_frame)
        fr_buttons.pack(fill="x", pady=(20,0))

        ttk.Button(fr_buttons, text="Guardar", command=self.save_config).pack(side="right", padx=5)
        ttk.Button(fr_buttons, text="Cancelar", command=self.destroy).pack(side="right")

    def browse_folder(self):
        d = filedialog.askdirectory()
        if d:
            self.folder_var.set(d)

    def save_config(self):
        # Aplicar cambios
        folder = self.folder_var.get()
        if folder and os.path.isdir(folder):
            self.ext.set_output_directory(folder)
            self.parent.lbl_folder_path.config(text=folder)

        self.parent.interval_val.set(self.interval_var.get())
        self.parent.interval_unit.set(self.unit_var.get())
        self.parent.download_type_var.set(self.dtype_var.get())
        self.parent.cfdi_type_var.set(self.cfdi_type_var.get())

        self.parent.log_console("Configuración guardada")
        self.destroy()

if __name__ == "__main__":
    SATExtractorGUI().mainloop()