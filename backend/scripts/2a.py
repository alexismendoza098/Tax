import sys
import pandas as pd
import os
import numpy as np

def process_pivot(input_csv, output_csv):
    if not os.path.exists(input_csv):
        print(f"Input file not found: {input_csv}")
        return

    try:
        df = pd.read_csv(input_csv)
        
        # Pivot
        # Index: UUID, Columns: Var, Values: Val
        pivot_df = df.pivot_table(index='UUID', columns='Var', values='Val', aggfunc='first').reset_index()
        
        # --- PREPARE COLUMNS FOR AUDIT & REPORTING ---
        sum_cols = ['SubTotal', 'TotalTraslados', 'TotalRetenciones', 'Descuento', 'Total', 'Monto']
        
        # Ensure all important columns exist in DataFrame (even if empty) to avoid KeyErrors
        for col in sum_cols:
            if col not in pivot_df.columns:
                pivot_df[col] = 0

        # Convert to numeric
        for col in sum_cols:
            pivot_df[col] = pd.to_numeric(pivot_df[col], errors='coerce').fillna(0)

        # --- DATE PROCESSING (YEAR/MONTH) ---
        # Try to parse 'Fecha' (ISO format usually) or 'FechaDDMMYYYY'
        if 'Fecha' in pivot_df.columns:
            # Convert to datetime, coerce errors
            pivot_df['Fecha_dt'] = pd.to_datetime(pivot_df['Fecha'], errors='coerce')
        elif 'FechaDDMMYYYY' in pivot_df.columns:
            pivot_df['Fecha_dt'] = pd.to_datetime(pivot_df['FechaDDMMYYYY'], format='%d/%m/%Y', errors='coerce')
        else:
            pivot_df['Fecha_dt'] = pd.NaT

        # Extract Year and Month
        pivot_df['Año'] = pivot_df['Fecha_dt'].dt.year
        pivot_df['Mes'] = pivot_df['Fecha_dt'].dt.month
        pivot_df['Periodo'] = pivot_df['Fecha_dt'].dt.strftime('%Y-%m')

        # Fill NaNs for rows without date (maybe Metadata without date?)
        pivot_df['Año'] = pivot_df['Año'].fillna(0).astype(int)
        pivot_df['Mes'] = pivot_df['Mes'].fillna(0).astype(int)
        pivot_df['Periodo'] = pivot_df['Periodo'].fillna('Sin Fecha')

        # --- AUDIT LOGIC (IRREGULARITIES) ---
        # Calculate expected total: SubTotal - Descuento + Traslados - Retenciones
        pivot_df['Total_Calculado'] = (
            pivot_df['SubTotal'] 
            - pivot_df['Descuento'] 
            + pivot_df['TotalTraslados'] 
            - pivot_df['TotalRetenciones']
        )
        
        # Round for comparison (2 decimal places)
        pivot_df['Total_Calculado'] = pivot_df['Total_Calculado'].round(2)
        pivot_df['Total'] = pivot_df['Total'].round(2)
        
        # Calculate Difference
        pivot_df['Diferencia_Audit'] = pivot_df['Total'] - pivot_df['Total_Calculado']
        
        # Flag discrepancies > 1.0 (tolerance for rounding errors)
        pivot_df['Estado_Calculo'] = np.where(
            abs(pivot_df['Diferencia_Audit']) > 1.0, 
            'REVISAR', 
            'OK'
        )

        # Handle Metadata rows (which might have Total but no breakdown) -> Mark as 'METADATA'
        # Check if 'Or' column exists (Origin) or infer from missing breakdown
        # If SubTotal is 0 but Total > 0, it's likely Metadata or incomplete data
        if 'Or' in pivot_df.columns: # Assuming 1a.py outputs 'Or' (Origin)
             pivot_df.loc[pivot_df['Or'] == 'Metadata', 'Estado_Calculo'] = 'METADATA'
        else:
             # Heuristic fallback
             mask_metadata = (pivot_df['SubTotal'] == 0) & (pivot_df['Total'] > 0)
             pivot_df.loc[mask_metadata, 'Estado_Calculo'] = 'METADATA (S/D)'


        # --- MONTHLY SUMMARY (RESUMEN) ---
        # Group by Periodo
        summary_cols = ['SubTotal', 'Descuento', 'TotalTraslados', 'TotalRetenciones', 'Total', 'Total_Calculado', 'Diferencia_Audit']
        # Filter only numeric columns that exist
        valid_summary_cols = [c for c in summary_cols if c in pivot_df.columns]
        
        monthly_summary = pivot_df.groupby(['Año', 'Mes', 'Periodo'])[valid_summary_cols].sum().reset_index()
        monthly_summary['Conteo_CFDI'] = pivot_df.groupby(['Año', 'Mes', 'Periodo'])['UUID'].count().values
        
        # Count irregularities
        irregular_counts = pivot_df[pivot_df['Estado_Calculo'] == 'REVISAR'].groupby(['Año', 'Mes', 'Periodo'])['UUID'].count().reset_index(name='Conteo_Irregularidades')
        
        monthly_summary = pd.merge(monthly_summary, irregular_counts, on=['Año', 'Mes', 'Periodo'], how='left')
        monthly_summary['Conteo_Irregularidades'] = monthly_summary['Conteo_Irregularidades'].fillna(0).astype(int)

        # --- FINAL TOTAL ROW FOR DETALLE ---
        totals = pivot_df[sum_cols].sum()
        total_row = pd.DataFrame([totals], columns=sum_cols)
        total_row['UUID'] = 'TOTALES GENERALES'
        total_row['Estado_Calculo'] = '-'
        # Append to Detail
        pivot_df_final = pd.concat([pivot_df, total_row], ignore_index=True)

        # --- EXCEL OUTPUT WITH MULTIPLE SHEETS ---
        excel_path = output_csv.replace('.csv', '.xlsx')
        
        with pd.ExcelWriter(excel_path, engine='openpyxl') as writer:
            # Sheet 1: Resumen Mensual (Summary first for visibility)
            monthly_summary.to_excel(writer, sheet_name='Resumen Mensual', index=False)
            
            # Sheet 2: Detalle Completo
            # Move important columns to front
            cols = list(pivot_df_final.columns)
            priority_cols = ['UUID', 'Fecha', 'Periodo', 'RfcEmisor', 'NombreEmisor', 'RfcReceptor', 'NombreReceptor', 
                             'SubTotal', 'Descuento', 'TotalTraslados', 'TotalRetenciones', 'Total', 
                             'Total_Calculado', 'Diferencia_Audit', 'Estado_Calculo']
            
            # Reorder columns: Priority + remaining
            final_cols = [c for c in priority_cols if c in cols] + [c for c in cols if c not in priority_cols]
            
            pivot_df_final[final_cols].to_excel(writer, sheet_name='Detalle Completo', index=False)

        # Save CSV (Just the detail, for compatibility)
        pivot_df_final.to_csv(output_csv, index=False)
        
        print(f"Generated Audit Report: {excel_path}")
        print(f"Summary: {len(monthly_summary)} periods found.")

    except Exception as e:
        print(f"Error processing pivot: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python 2a.py <input_csv> <output_csv>")
        sys.exit(1)
        
    input_csv = sys.argv[1]
    output_csv = sys.argv[2]
    process_pivot(input_csv, output_csv)
