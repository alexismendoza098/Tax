
import sys
import json
import base64
import os
import io
import zipfile
import csv
import time
from datetime import datetime, timedelta
# Force UTF-8 encoding for stdout/stderr
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

from cfdiclient import Autenticacion, Fiel, SolicitaDescargaEmitidos, SolicitaDescargaRecibidos, VerificaSolicitudDescarga, DescargaMasiva

# Configuración básica
# OUTPUT_DIR removed, now per-RFC

class SatIntegration:
    def __init__(self, rfc, cer_path, key_path, password):
        self.rfc = rfc.strip().upper()
        self.password = password
        self.cer_path = cer_path
        self.key_path = key_path
        self.fiel = None
        self.token = None
        
        # Configurar directorio de salida por RFC
        base_dir = os.path.join(os.getcwd(), 'downloads')
        self.output_dir = os.path.join(base_dir, self.rfc)
        if not os.path.exists(self.output_dir):
            os.makedirs(self.output_dir)
            
        self.load_fiel()

    def load_fiel(self):
        try:
            with open(self.cer_path, 'rb') as f: cer_content = f.read()
            with open(self.key_path, 'rb') as f: key_content = f.read()
            self.fiel = Fiel(cer_content, key_content, self.password)
        except Exception as e:
            print(json.dumps({"status": "error", "message": f"Error loading FIEL: {str(e)}"}))
            sys.exit(1)

    def authenticate(self, force=False):
        if self.token and not force:
            return self.token
            
        try:
            auth = Autenticacion(self.fiel)
            self.token = auth.obtener_token()
            if not self.token:
                raise Exception("Token nulo recibido del SAT")
            return self.token
        except Exception as e:
            print(json.dumps({"status": "error", "message": f"Authentication failed: {str(e)}"}))
            sys.exit(1)

    def _is_bad_token(self, response):
        # Logic from Descargas (1).py
        s = str(response).lower()
        return 'token' in s or '301' in s

    def split_dates(self, start, end, days=30):
        # Logic from Descargas (1).py
        res = []
        curr = start
        while curr <= end:
            fin = min(curr + timedelta(days=days-1), end)
            res.append((curr, fin))
            curr = fin + timedelta(days=1)
        return res

    def request_download(self, start_date, end_date, download_type='Metadata', cfdi_type='Issued', status='Todos'):
        self.authenticate()
        
        start = datetime.strptime(start_date, '%Y-%m-%d')
        end = datetime.strptime(end_date, '%Y-%m-%d')
        
        # Mapeo de tipos
        tipo_solicitud = download_type  # 'Metadata' o 'CFDI'
        
        # Logic from Descargas (1).py
        ctype = cfdi_type.upper()
        if ctype == 'ISSUED':
            ServiceClass = SolicitaDescargaEmitidos
            kwargs = {'rfc_emisor': self.rfc}
        else:
            ServiceClass = SolicitaDescargaRecibidos
            kwargs = {'rfc_receptor': self.rfc}
            # FIX: Reverted to include rfc_receptor, but ensured self.rfc is UPPERCASE in __init__
            # SAT requires RfcReceptor for Recibidos, and it must be valid (UPPERCASE).
            
        # Status Filtering
        if status == 'Vigente':
            kwargs['estado_comprobante'] = '1'
            print(f"DEBUG: [FILTER] Filtering 'Vigente'.", flush=True)
        elif status == 'Cancelado':
            if download_type == 'CFDI':
                raise ValueError("SAT Error 5012: No se permite la descarga de XMLs cancelados. Seleccione 'Metadata' para ver cancelados.")
            kwargs['estado_comprobante'] = '0'
            print(f"DEBUG: [FILTER] Filtering 'Cancelado'.", flush=True)
        else:
            # Todos
            if download_type == 'CFDI':
                print("WARNING: SAT forbids downloading Cancelled XMLs. Automatically filtering to 'Vigente' to avoid Error 5012.", flush=True)
                kwargs['estado_comprobante'] = '1'
            else:
                print(f"DEBUG: [FILTER] No filter (Todos).", flush=True)

        print(f"DEBUG: Requesting {tipo_solicitud} ({ctype}) with kwargs: {kwargs}", flush=True)

        # Split dates if range > 30 days (Robustness from Descargas (1).py)
        ranges = self.split_dates(start, end)
        results = []

        for s, e in ranges:
            # Set end time to 23:59:59 to ensure valid range (start < end) and full day coverage
            e = e.replace(hour=23, minute=59, second=59, microsecond=999999)
            s_adj = s  # se ajusta a s + 1s si el SAT devuelve código 5002

            # Retry loop for each range
            max_retries = 3
            success = False

            for attempt in range(max_retries):
                try:
                    # Re-instantiate service to be safe
                    service = ServiceClass(self.fiel)

                    r = service.solicitar_descarga(
                        self.token,
                        self.rfc,
                        s_adj,
                        e,
                        tipo_solicitud=tipo_solicitud,
                        **kwargs
                    )

                    # Token check from Descargas (1).py
                    if self._is_bad_token(r):
                        if attempt < max_retries - 1:
                            self.authenticate(force=True)
                            continue

                    cod = str(r.get('cod_estatus') or r.get('codigo_estado_solicitud') or '')

                    # Check for valid ID
                    if r.get('id_solicitud'):
                        results.append({
                            "id_solicitud": r.get('id_solicitud'),
                            "fecha_inicio": s_adj.strftime('%Y-%m-%d'),
                            "fecha_fin": e.strftime('%Y-%m-%d'),
                            "mensaje": r.get('mensaje'),
                            "estado_solicitud": r.get('estado_solicitud'),
                            "codigo_estado_solicitud": r.get('codigo_estado_solicitud')
                        })
                        success = True
                        break # Success for this range
                    elif cod == '5002' and s_adj == s and attempt < max_retries - 1:
                        # SAT: límite de por vida — reintento con inicio +1 segundo
                        s_adj = s + timedelta(seconds=1)
                        time.sleep(1)
                        continue
                    else:
                        # SAT Error or specific message
                        if attempt == max_retries - 1:
                            results.append({"error": r.get('mensaje'), "data": r})

                except Exception as exc:
                    if attempt == max_retries - 1:
                        results.append({"error": str(exc)})
                    time.sleep(2)
            
            # Avoid SAT flooding
            time.sleep(1)

        # If only 1 result, return it directly to maintain backward compatibility if possible,
        # BUT for robustness, returning a list is better. 
        # However, to avoid breaking sat.js immediately, let's see:
        # If I return a list, I must update sat.js.
        return results

    def verify_request(self, request_id):
        self.authenticate()
        try:
            verifier = VerificaSolicitudDescarga(self.fiel)
            result = verifier.verificar_descarga(self.token, self.rfc, request_id)
            
            if self._is_bad_token(result):
                self.authenticate(force=True)
                result = verifier.verificar_descarga(self.token, self.rfc, request_id)
                
            return result
        except Exception as e:
            return {"error": str(e)}

    def download_package(self, package_id, force=False):
        self.authenticate()
        try:
            downloader = DescargaMasiva(self.fiel)
            file_path = os.path.join(self.output_dir, f"{package_id}.zip")
            
            # Check local file first
            if not force and os.path.exists(file_path) and os.path.getsize(file_path) > 0:
                 # Validation: Ensure it is a valid zip
                 if zipfile.is_zipfile(file_path):
                     return {"status": "success", "file": file_path, "message": "File already exists and is valid"}
                 else:
                     print(f"File {file_path} exists but is invalid/corrupt. Re-downloading.")

            result = downloader.descargar_paquete(self.token, self.rfc, package_id)
            
            if self._is_bad_token(result):
                self.authenticate(force=True)
                result = downloader.descargar_paquete(self.token, self.rfc, package_id)

            if result.get('paquete_b64'):
                data = base64.b64decode(result['paquete_b64'])
                with open(file_path, 'wb') as f:
                    f.write(data)
                
                # Verify integrity
                if zipfile.is_zipfile(file_path):
                    return {"status": "success", "file": file_path, "size": len(data)}
                else:
                    return {"status": "error", "message": "Downloaded file is not a valid ZIP", "file": file_path}
            else:
                return {"status": "error", "message": "No content", "data": result}
        except Exception as e:
            return {"error": str(e)}

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description='SAT Integration CLI')
    parser.add_argument('--action', required=True, choices=['authenticate', 'request', 'verify', 'download'])
    parser.add_argument('--rfc', required=True)
    parser.add_argument('--cer', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--pwd', required=True)
    
    # Request args
    parser.add_argument('--start', help='Start date YYYY-MM-DD')
    parser.add_argument('--end', help='End date YYYY-MM-DD')
    parser.add_argument('--type', default='Metadata', choices=['Metadata', 'CFDI'])
    parser.add_argument('--cfdi_type', default='Issued', choices=['Issued', 'Received', 'ISSUED', 'RECEIVED'])
    parser.add_argument('--status', default='Todos', choices=['Todos', 'Vigente', 'Cancelado'])
    
    # Verify/Download args
    parser.add_argument('--id', help='Request ID or Package ID')
    parser.add_argument('--force', action='store_true', help='Force download even if exists')

    args = parser.parse_args()

    try:
        sat = SatIntegration(args.rfc, args.cer, args.key, args.pwd)

        if args.action == 'authenticate':
            token = sat.authenticate()
            print(json.dumps({"status": "success", "token": token}))
            
        elif args.action == 'request':
            if not args.start or not args.end:
                print(json.dumps({"status": "error", "message": "Start and end dates required"}))
                sys.exit(1)
            results = sat.request_download(args.start, args.end, args.type, args.cfdi_type, args.status)
            
            # If results is a list, we wrap it in a standard response
            # Check if any success
            successes = [r for r in results if 'id_solicitud' in r]
            if successes:
                # If single result, return like before for minimal breakage, OR standard list
                # Let's return a list in 'data' and handle it in sat.js
                 print(json.dumps({"status": "success", "data": results})) # data is list
            else:
                 print(json.dumps({"status": "error", "data": results}))

        elif args.action == 'verify':
            if not args.id:
                print(json.dumps({"status": "error", "message": "ID required"}))
                sys.exit(1)
            result = sat.verify_request(args.id)
            print(json.dumps({"status": "success", "data": result}))

        elif args.action == 'download':
            if not args.id:
                print(json.dumps({"status": "error", "message": "ID required"}))
                sys.exit(1)
            result = sat.download_package(args.id, force=args.force)
            print(json.dumps(result)) 

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)
