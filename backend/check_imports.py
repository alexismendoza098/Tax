
try:
    from cfdiclient import Autenticacion, Fiel, SolicitaDescargaEmitidos, SolicitaDescargaRecibidos, VerificaSolicitudDescarga, DescargaMasiva
    print("Imports successful")
except ImportError as e:
    print(f"ImportError: {e}")
except Exception as e:
    print(f"Error: {e}")
