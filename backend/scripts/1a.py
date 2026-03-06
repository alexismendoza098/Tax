import sys
import os
import zipfile
import pandas as pd
import xml.etree.ElementTree as ET
from glob import glob
from datetime import datetime

def process_zip(zip_path, output_csv):
    temp_dir = os.path.join(os.path.dirname(zip_path), "temp_extract")
    os.makedirs(temp_dir, exist_ok=True)
    
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)
    except Exception as e:
        print(f"Error unzipping: {e}")
        return

    data = []
    
    # Process XMLs
    xml_files = glob(os.path.join(temp_dir, "**/*.xml"), recursive=True)
    
    # Process Metadata TXTs
    txt_files = glob(os.path.join(temp_dir, "**/*.txt"), recursive=True)
    
    ns = {'cfdi': 'http://www.sat.gob.mx/cfd/4', 'tfd': 'http://www.sat.gob.mx/TimbreFiscalDigital'}
    # Fallback for v3.3
    ns33 = {'cfdi': 'http://www.sat.gob.mx/cfd/3', 'tfd': 'http://www.sat.gob.mx/TimbreFiscalDigital'}

    # --- Helper to add records ---
    def add_record_global(var, val, uuid, origin='XML'):
        if val is not None:
            data.append({
                'Or': origin,
                'Var': var,
                'Val': str(val),
                'UUID': uuid
            })

    # 1. XML Processing
    for xml_file in xml_files:
        try:
            tree = ET.parse(xml_file)
            root = tree.getroot()
            
            # Detect version
            version = root.get('Version')
            curr_ns = ns if version == '4.0' else ns33
            
            # Basic attributes
            uuid = None
            complemento = root.find('cfdi:Complemento', curr_ns)
            if complemento is not None:
                tfd = complemento.find('tfd:TimbreFiscalDigital', curr_ns)
                if tfd is not None:
                    uuid = tfd.get('UUID')
            
            if not uuid:
                uuid = os.path.basename(xml_file) # Fallback

            # Core fields
            fecha_raw = root.get('Fecha')
            add_record_global('Version', version, uuid, 'XML')
            add_record_global('Fecha', fecha_raw, uuid, 'XML')
            
            # Fecha Formatted DD/MM/YYYY
            if fecha_raw:
                try:
                    # Usually YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD
                    dt_str = fecha_raw.split('T')[0]
                    dt_obj = datetime.strptime(dt_str, '%Y-%m-%d')
                    add_record_global('FechaDDMMYYYY', dt_obj.strftime('%d/%m/%Y'), uuid, 'XML')
                except:
                    pass

            add_record_global('Total', root.get('Total'), uuid, 'XML')
            add_record_global('SubTotal', root.get('SubTotal'), uuid, 'XML')
            add_record_global('Descuento', root.get('Descuento'), uuid, 'XML')
            add_record_global('Moneda', root.get('Moneda'), uuid, 'XML')
            add_record_global('TipoDeComprobante', root.get('TipoDeComprobante'), uuid, 'XML')
            add_record_global('FormaPago', root.get('FormaPago'), uuid, 'XML')
            add_record_global('MetodoPago', root.get('MetodoPago'), uuid, 'XML')
            add_record_global('LugarExpedicion', root.get('LugarExpedicion'), uuid, 'XML')
            
            # Impuestos Globales
            impuestos = root.find('cfdi:Impuestos', curr_ns)
            if impuestos is not None:
                add_record_global('TotalTraslados', impuestos.get('TotalImpuestosTrasladados'), uuid, 'XML')
                add_record_global('TotalRetenciones', impuestos.get('TotalImpuestosRetenidos'), uuid, 'XML')

            emisor = root.find('cfdi:Emisor', curr_ns)
            if emisor is not None:
                add_record_global('RfcEmisor', emisor.get('Rfc'), uuid, 'XML')
                add_record_global('NombreEmisor', emisor.get('Nombre'), uuid, 'XML')
            
            receptor = root.find('cfdi:Receptor', curr_ns)
            if receptor is not None:
                add_record_global('RfcReceptor', receptor.get('Rfc'), uuid, 'XML')
                add_record_global('NombreReceptor', receptor.get('Nombre'), uuid, 'XML')

        except Exception as e:
            print(f"Error parsing XML {xml_file}: {e}")

    # 2. Metadata TXT Processing
    for txt_file in txt_files:
        try:
            with open(txt_file, 'r', encoding='utf-8', errors='replace') as f:
                lines = f.readlines()
            
            if len(lines) < 2:
                continue

            headers = lines[0].strip().split('~')
            
            # Map headers to indices
            h_map = {h: i for i, h in enumerate(headers)}
            
            # Helper to get value safely
            def get_val(parts, key):
                if key in h_map and h_map[key] < len(parts):
                    return parts[h_map[key]]
                return None

            for line in lines[1:]:
                parts = line.strip().split('~')
                if len(parts) < 2: continue
                
                uuid = get_val(parts, 'Uuid')
                if not uuid: continue
                
                # Extract available fields
                fecha_emision = get_val(parts, 'FechaEmision')
                
                add_record_global('Version', '', uuid, 'Metadata') # Not in Metadata
                add_record_global('Fecha', fecha_emision, uuid, 'Metadata')
                
                if fecha_emision:
                    try:
                        # Metadata date format is usually YYYY-MM-DD HH:MM:SS
                        dt_str = fecha_emision.split(' ')[0]
                        dt_obj = datetime.strptime(dt_str, '%Y-%m-%d')
                        add_record_global('FechaDDMMYYYY', dt_obj.strftime('%d/%m/%Y'), uuid, 'Metadata')
                    except:
                        pass
                
                add_record_global('Total', get_val(parts, 'Monto'), uuid, 'Metadata')
                add_record_global('SubTotal', '0', uuid, 'Metadata') # Not available
                add_record_global('Descuento', '0', uuid, 'Metadata') # Not available
                add_record_global('Moneda', 'MXN', uuid, 'Metadata') # Assume MXN
                add_record_global('TipoDeComprobante', get_val(parts, 'EfectoComprobante'), uuid, 'Metadata')
                add_record_global('FormaPago', '', uuid, 'Metadata') # Not available
                add_record_global('MetodoPago', '', uuid, 'Metadata') # Not available
                add_record_global('LugarExpedicion', '', uuid, 'Metadata') # Not available
                add_record_global('TotalTraslados', '0', uuid, 'Metadata') # Not available
                add_record_global('TotalRetenciones', '0', uuid, 'Metadata') # Not available
                
                add_record_global('RfcEmisor', get_val(parts, 'RfcEmisor'), uuid, 'Metadata')
                add_record_global('NombreEmisor', get_val(parts, 'NombreEmisor'), uuid, 'Metadata')
                
                add_record_global('RfcReceptor', get_val(parts, 'RfcReceptor'), uuid, 'Metadata')
                add_record_global('NombreReceptor', get_val(parts, 'NombreReceptor'), uuid, 'Metadata')

        except Exception as e:
            print(f"Error parsing Metadata {txt_file}: {e}")


            # Concepts (Example: just count or first one)
            # For brevity, we just do header fields.
            
        except Exception as e:
            print(f"Error parsing {xml_file}: {e}")

    # Process TXT (Metadata)
    txt_files = glob(os.path.join(temp_dir, "**/*.txt"), recursive=True)
    for txt_file in txt_files:
        try:
            with open(txt_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                if len(lines) < 2: continue
                
                # Header usually line 0
                headers = [h.strip() for h in lines[0].strip().split('~')]
                
                for line in lines[1:]:
                    vals = [v.strip() for v in line.strip().split('~')]
                    if len(vals) < 2: continue # Skip empty lines
                    
                    # Handle potential length mismatch safely
                    row_map = {}
                    for i, h in enumerate(headers):
                        if i < len(vals):
                            row_map[h] = vals[i]
                    
                    uuid = row_map.get('Uuid', row_map.get('UUID', ''))
                    
                    if not uuid: continue
                    
                    def add_record_meta(var, val_key):
                        val = row_map.get(val_key)
                        if val:
                             data.append({
                                'Or': 'Meta',
                                'Var': var,
                                'Val': val,
                                'UUID': uuid
                            })
                            
                    add_record_meta('Fecha', 'FechaEmision')
                    add_record_meta('Total', 'Monto')
                    add_record_meta('RfcEmisor', 'RfcEmisor')
                    add_record_meta('NombreEmisor', 'NombreEmisor')
                    add_record_meta('RfcReceptor', 'RfcReceptor')
                    add_record_meta('NombreReceptor', 'NombreReceptor')
                    add_record_meta('TipoDeComprobante', 'EfectoComprobante')
                    add_record_meta('Estado', 'Estatus')
                    add_record_meta('FechaCancelacion', 'FechaCancelacion')

        except Exception as e:
            print(f"Error parsing TXT {txt_file}: {e}")

    # Create DataFrame
    df = pd.DataFrame(data)
    df.to_csv(output_csv, index=False)
    print(f"Generated {output_csv} with {len(df)} rows.")
    
    # Cleanup (optional)
    # import shutil
    # shutil.rmtree(temp_dir)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 1a.py <zip_path> <output_csv>")
        sys.exit(1)
    
    zip_path = sys.argv[1]
    output_csv = sys.argv[2]
    process_zip(zip_path, output_csv)
