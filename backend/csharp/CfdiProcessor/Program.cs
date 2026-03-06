/**
 * CfdiProcessor — Procesador C# de alto rendimiento para CFDIs del SAT
 * .NET 9 — Llamado desde Node.js via child_process.spawn
 */

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Linq;

// ─── Entry point ─────────────────────────────────────────────────────────────
var argsDict = CfdiApp.ParseArgs(Environment.GetCommandLineArgs().Skip(1).ToArray());
string action = CfdiApp.GetArg(argsDict, "action",  "process-zip");
string input  = CfdiApp.GetArg(argsDict, "input",   "");
string output = CfdiApp.GetArg(argsDict, "output",  "");
string rfc    = CfdiApp.GetArg(argsDict, "rfc",     "").ToUpperInvariant();
string year   = CfdiApp.GetArg(argsDict, "year",    "");
string month  = CfdiApp.GetArg(argsDict, "month",   "");

var opts = new JsonSerializerOptions
{
    WriteIndented = false,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
};

try
{
    object result = action switch
    {
        "process-zip"   => CfdiApp.ProcessZip(input, output, rfc),
        "calc-iva"      => CfdiApp.CalcIva(input, rfc, year, month),
        "validate"      => CfdiApp.Validate(input),
        "export-csv"    => CfdiApp.ExportCsv(input, output, rfc, year, month),
        "full-pipeline" => CfdiApp.FullPipeline(input, output, rfc, year, month),
        _ => new { status = "error", message = $"Acción desconocida: {action}" }
    };
    Console.WriteLine(JsonSerializer.Serialize(result, opts));
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex);
    Console.WriteLine(JsonSerializer.Serialize(
        new { status = "error", message = ex.Message }, opts));
    Environment.Exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// MODELS
// ═════════════════════════════════════════════════════════════════════════════

public record Traslado(
    string Impuesto, string TipoFactor,
    decimal TasaOCuota, decimal Base, decimal Importe);

public record Retencion(string Impuesto, decimal Importe);

public record Cfdi(
    string   Uuid,
    string   Version,
    string   TipoComprobante,
    string   RfcEmisor,
    string   NombreEmisor,
    string   RfcReceptor,
    string   NombreReceptor,
    DateTime Fecha,
    string   MetodoPago,
    string   FormaPago,
    string   Moneda,
    decimal  TipoCambio,
    decimal  SubTotal,
    decimal  Descuento,
    decimal  Total,
    decimal  TotalTraslados,
    decimal  TotalRetenciones,
    bool     EsNomina,
    List<Traslado>  Traslados,
    List<Retencion> Retenciones);

// ═════════════════════════════════════════════════════════════════════════════
// APPLICATION LOGIC
// ═════════════════════════════════════════════════════════════════════════════

public static class CfdiApp
{
    static readonly JsonSerializerOptions ReadOpts = new()
        { PropertyNameCaseInsensitive = true };

    // ── PROCESS-ZIP ─────────────────────────────────────────────────────────
    public static object ProcessZip(string inputPath, string outputPath, string rfc)
    {
        if (string.IsNullOrEmpty(inputPath))
            return Err("--input es requerido");

        var xmlItems = new List<(string name, string xml)>();
        var errors   = new List<string>();

        if (File.Exists(inputPath) && inputPath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            using var zip = ZipFile.OpenRead(inputPath);
            foreach (var e in zip.Entries.Where(e => e.Name.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)))
            {
                try
                {
                    using var r = new StreamReader(e.Open(), Encoding.UTF8);
                    xmlItems.Add((e.Name, r.ReadToEnd()));
                }
                catch (Exception ex) { errors.Add($"{e.Name}: {ex.Message}"); }
            }
        }
        else if (Directory.Exists(inputPath))
        {
            foreach (var f in Directory.GetFiles(inputPath, "*.xml", SearchOption.AllDirectories))
            {
                try { xmlItems.Add((Path.GetFileName(f), File.ReadAllText(f, Encoding.UTF8))); }
                catch (Exception ex) { errors.Add($"{Path.GetFileName(f)}: {ex.Message}"); }
            }
        }
        else return Err($"Ruta no encontrada: {inputPath}");

        var cfdis = new List<Cfdi>();
        foreach (var (name, xml) in xmlItems)
        {
            try
            {
                var c = ParseCfdi(xml);
                if (!string.IsNullOrEmpty(rfc))
                {
                    if (!c.RfcEmisor.Equals(rfc, StringComparison.OrdinalIgnoreCase) &&
                        !c.RfcReceptor.Equals(rfc, StringComparison.OrdinalIgnoreCase))
                        continue;
                }
                cfdis.Add(c);
            }
            catch (Exception ex) { errors.Add($"{name}: {ex.Message}"); }
        }

        string? outFile = null;
        if (!string.IsNullOrEmpty(outputPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? ".");
            File.WriteAllText(outputPath,
                JsonSerializer.Serialize(cfdis, new JsonSerializerOptions
                { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower }), Encoding.UTF8);
            outFile = outputPath;
        }

        return new
        {
            status    = "success",
            processed = cfdis.Count,
            xml_total = xmlItems.Count,
            errors    = errors.Count,
            error_list = errors.Take(10).ToList(),
            json_file = outFile,
            summary = new
            {
                emitidos  = cfdis.Count(c => c.RfcEmisor.Equals(rfc, StringComparison.OrdinalIgnoreCase)),
                recibidos = cfdis.Count(c => c.RfcReceptor.Equals(rfc, StringComparison.OrdinalIgnoreCase)),
                nominas   = cfdis.Count(c => c.EsNomina),
                ingresos  = cfdis.Count(c => c.TipoComprobante == "I"),
                egresos   = cfdis.Count(c => c.TipoComprobante == "E"),
                pagos     = cfdis.Count(c => c.TipoComprobante == "P"),
            }
        };
    }

    // ── CALC-IVA ─────────────────────────────────────────────────────────────
    public static object CalcIva(string jsonPath, string rfc, string year, string month)
    {
        var cfdis = LoadJson(jsonPath);
        if (cfdis is null) return Err($"JSON no encontrado: {jsonPath}");

        int? y = int.TryParse(year,  out int yy) ? yy : null;
        int? m = int.TryParse(month, out int mm) ? mm : null;

        var filtered = cfdis.Where(c =>
            c.TipoComprobante != "P" &&
            (y == null || c.Fecha.Year  == y) &&
            (m == null || c.Fecha.Month == m)).ToList();

        var emitidos  = filtered.Where(c =>
            c.RfcEmisor.Equals(rfc, StringComparison.OrdinalIgnoreCase) &&
            (c.TipoComprobante == "I" || c.TipoComprobante == "E")).ToList();

        var recibidos = filtered.Where(c =>
            c.RfcReceptor.Equals(rfc, StringComparison.OrdinalIgnoreCase) &&
            (c.TipoComprobante == "I" || c.TipoComprobante == "E")).ToList();

        decimal IvaT(IEnumerable<Cfdi> src, string? mp = null) =>
            src.Where(c => mp == null || c.MetodoPago == mp)
               .SelectMany(c => c.Traslados)
               .Where(t => t.Impuesto == "002" && t.TipoFactor == "Tasa")
               .Sum(t => t.Importe);

        decimal Ret(IEnumerable<Cfdi> src, string imp) =>
            src.SelectMany(c => c.Retenciones).Where(r => r.Impuesto == imp).Sum(r => r.Importe);

        decimal tPue = IvaT(emitidos, "PUE"), tPpd = IvaT(emitidos, "PPD");
        decimal aPue = IvaT(recibidos,"PUE"), aPpd = IvaT(recibidos,"PPD");
        decimal retIva = Ret(recibidos, "002"), retIsr = Ret(recibidos, "001");
        decimal saldo  = (tPue + tPpd) - (aPue + aPpd) - retIva;

        return new
        {
            status = "success", rfc, year = y, month = m,
            total_cfdis           = filtered.Count,
            iva_trasladado_pue    = Math.Round(tPue,  2),
            iva_trasladado_ppd    = Math.Round(tPpd,  2),
            iva_trasladado_total  = Math.Round(tPue + tPpd, 2),
            iva_acreditable_pue   = Math.Round(aPue,  2),
            iva_acreditable_ppd   = Math.Round(aPpd,  2),
            iva_acreditable_total = Math.Round(aPue + aPpd, 2),
            retencion_iva         = Math.Round(retIva, 2),
            retencion_isr         = Math.Round(retIsr, 2),
            saldo_iva             = Math.Round(saldo,  2),
            saldo_label           = saldo >= 0 ? "A PAGAR" : "A FAVOR",
            emitidos_count        = emitidos.Count,
            recibidos_count       = recibidos.Count,
        };
    }

    // ── VALIDATE ─────────────────────────────────────────────────────────────
    public static object Validate(string jsonPath)
    {
        var cfdis = LoadJson(jsonPath);
        if (cfdis is null) return Err($"JSON no encontrado: {jsonPath}");

        var issues   = new List<object>();
        var warnings = new List<object>();
        var ok       = new List<string>();

        decimal[] validRates = [0m, 0.08m, 0.16m];
        var badRates = cfdis.SelectMany(c =>
            c.Traslados.Where(t => t.Impuesto == "002" && t.TipoFactor == "Tasa" &&
                !validRates.Any(r => Math.Abs(r - t.TasaOCuota) < 0.001m))
            .Select(t => new { c.Uuid, t.TasaOCuota })).ToList();
        if (badRates.Count > 0)
            issues.Add(new { check = "Tasas IVA", severity = "error", count = badRates.Count,
                message = "CFDIs con tasa IVA inválida (debe ser 0%, 8% o 16%)" });
        else ok.Add("Tasas IVA correctas (0%, 8%, 16%)");

        var dups = cfdis.GroupBy(c => c.Uuid).Where(g => g.Count() > 1)
            .Select(g => new { uuid = g.Key, count = g.Count() }).ToList();
        if (dups.Count > 0)
            issues.Add(new { check = "Duplicados", severity = "error", count = dups.Count, message = "UUIDs duplicados" });
        else ok.Add("Sin UUIDs duplicados");

        int future = cfdis.Count(c => c.Fecha > DateTime.UtcNow.AddDays(1));
        if (future > 0)
            issues.Add(new { check = "Fechas futuras", severity = "error", count = future,
                message = "CFDIs con fecha futura" });
        else ok.Add("Fechas de emisión válidas");

        int noRfc = cfdis.Count(c => string.IsNullOrEmpty(c.RfcEmisor) || string.IsNullOrEmpty(c.RfcReceptor));
        if (noRfc > 0)
            issues.Add(new { check = "RFC vacío", severity = "error", count = noRfc,
                message = "CFDIs con RFC vacío" });
        else ok.Add("RFC completos");

        int old = cfdis.Count(c => c.Fecha < DateTime.UtcNow.AddYears(-5));
        if (old > 0)
            warnings.Add(new { check = "CFDIs Antiguos", severity = "warning", count = old,
                message = "CFDIs con más de 5 años (verificar deducibilidad)" });
        else ok.Add("Antigüedad dentro del límite");

        int zeroSub = cfdis.Count(c => c.SubTotal <= 0 && c.TipoComprobante == "I");
        if (zeroSub > 0)
            warnings.Add(new { check = "SubTotal cero", severity = "warning", count = zeroSub,
                message = "CFDIs de ingreso con SubTotal = 0" });
        else ok.Add("SubTotales positivos");

        bool isValid = !issues.Any();
        return new
        {
            status         = "success",
            is_valid       = isValid,
            total_cfdis    = cfdis.Count,
            errors_count   = issues.Count,
            warnings_count = warnings.Count,
            checks         = new { errors = issues, warnings, ok },
            recommendation = isValid
                ? "✅ CFDIs listos para análisis."
                : $"⚠️ {issues.Count} problemas críticos. Revisa antes de continuar.",
        };
    }

    // ── EXPORT-CSV ───────────────────────────────────────────────────────────
    public static object ExportCsv(string jsonPath, string outputPath, string rfc, string year, string month)
    {
        var cfdis = LoadJson(jsonPath);
        if (cfdis is null) return Err($"JSON no encontrado: {jsonPath}");

        int? y = int.TryParse(year,  out int yy) ? yy : null;
        int? m = int.TryParse(month, out int mm) ? mm : null;

        var rows = cfdis.Where(c =>
            (y == null || c.Fecha.Year  == y) &&
            (m == null || c.Fecha.Month == m)).ToList();

        if (string.IsNullOrEmpty(outputPath))
            outputPath = Path.Combine(Path.GetTempPath(),
                $"CFDI_{rfc}_{year ?? "all"}_{month ?? "all"}.csv");

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? ".");

        var sb = new StringBuilder();
        sb.AppendLine("UUID,TipoComp,RFC_Emisor,Nombre_Emisor,RFC_Receptor,Nombre_Receptor," +
                      "Fecha,MetodoPago,FormaPago,Moneda,SubTotal,Descuento,Total," +
                      "IVA_Trasladado,Ret_IVA,Ret_ISR,EsNomina");

        foreach (var c in rows)
        {
            decimal ivaT   = c.Traslados.Where(t => t.Impuesto == "002").Sum(t => t.Importe);
            decimal retIva = c.Retenciones.Where(r => r.Impuesto == "002").Sum(r => r.Importe);
            decimal retIsr = c.Retenciones.Where(r => r.Impuesto == "001").Sum(r => r.Importe);
            sb.AppendLine(string.Join(",",
                Esc(c.Uuid), Esc(c.TipoComprobante), Esc(c.RfcEmisor), Esc(c.NombreEmisor),
                Esc(c.RfcReceptor), Esc(c.NombreReceptor),
                c.Fecha.ToString("yyyy-MM-dd HH:mm:ss"),
                Esc(c.MetodoPago), Esc(c.FormaPago), Esc(c.Moneda),
                c.SubTotal.ToString("F2"), c.Descuento.ToString("F2"), c.Total.ToString("F2"),
                ivaT.ToString("F2"), retIva.ToString("F2"), retIsr.ToString("F2"),
                c.EsNomina ? "1" : "0"));
        }

        File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(true));
        return new { status = "success", file = outputPath, rows = rows.Count };
    }

    // ── FULL-PIPELINE ────────────────────────────────────────────────────────
    public static object FullPipeline(string inputPath, string outputDir, string rfc, string year, string month)
    {
        if (string.IsNullOrEmpty(outputDir))
            outputDir = Path.GetDirectoryName(Path.GetFullPath(inputPath)) ?? ".";
        Directory.CreateDirectory(outputDir);

        var tag      = string.IsNullOrEmpty(rfc) ? "cfdis" : rfc;
        var jsonFile = Path.Combine(outputDir, $"{tag}_parsed.json");
        var csvFile  = Path.Combine(outputDir, $"{tag}_{year}_{month}.csv");

        var s1 = ProcessZip(inputPath, jsonFile, rfc);
        if (((dynamic)s1).status != "success") return s1;

        var s2 = CalcIva(jsonFile, rfc, year, month);
        var s3 = Validate(jsonFile);
        var s4 = ExportCsv(jsonFile, csvFile, rfc, year, month);

        return new
        {
            status   = "success",
            pipeline = "completed",
            steps    = new { processing = s1, calculation = s2, validation = s3, export = s4 },
            output_files = new { json_file = jsonFile, csv_file = csvFile },
        };
    }

    // ── XML PARSER ───────────────────────────────────────────────────────────
    public static Cfdi ParseCfdi(string xml)
    {
        var doc  = XDocument.Parse(xml.TrimStart('\uFEFF'));
        var root = doc.Root!;

        XNamespace ns33  = "http://www.sat.gob.mx/cfd/3";
        XNamespace ns40  = "http://www.sat.gob.mx/cfd/4";
        XNamespace nsTfd = "http://www.sat.gob.mx/TimbreFiscalDigital";
        XNamespace nsNom = "http://www.sat.gob.mx/nomina12";

        XNamespace ns = root.Name.Namespace == ns40 ? ns40 : ns33;

        var tfd      = root.Descendants(nsTfd + "TimbreFiscalDigital").FirstOrDefault();
        var emisor   = root.Element(ns + "Emisor");
        var receptor = root.Element(ns + "Receptor");
        var imptos   = root.Element(ns + "Impuestos");

        var traslados = (imptos?.Element(ns + "Traslados")?.Elements(ns + "Traslado") ?? [])
            .Select(t => new Traslado(
                t.Attribute("Impuesto")?.Value   ?? "",
                t.Attribute("TipoFactor")?.Value ?? "",
                D(t.Attribute("TasaOCuota")?.Value),
                D(t.Attribute("Base")?.Value),
                D(t.Attribute("Importe")?.Value))).ToList();

        var retenciones = (imptos?.Element(ns + "Retenciones")?.Elements(ns + "Retencion") ?? [])
            .Select(r => new Retencion(
                r.Attribute("Impuesto")?.Value ?? "",
                D(r.Attribute("Importe")?.Value))).ToList();

        return new Cfdi(
            Uuid:             tfd?.Attribute("UUID")?.Value ?? "",
            Version:          root.Attribute("Version")?.Value ?? "",
            TipoComprobante:  root.Attribute("TipoDeComprobante")?.Value ?? "",
            RfcEmisor:        emisor?.Attribute("Rfc")?.Value    ?? "",
            NombreEmisor:     emisor?.Attribute("Nombre")?.Value ?? "",
            RfcReceptor:      receptor?.Attribute("Rfc")?.Value    ?? "",
            NombreReceptor:   receptor?.Attribute("Nombre")?.Value ?? "",
            Fecha:            DateTime.TryParse(root.Attribute("Fecha")?.Value, out var fd) ? fd : DateTime.MinValue,
            MetodoPago:       root.Attribute("MetodoPago")?.Value ?? "",
            FormaPago:        root.Attribute("FormaPago")?.Value  ?? "",
            Moneda:           root.Attribute("Moneda")?.Value ?? "MXN",
            TipoCambio:       D(root.Attribute("TipoCambio")?.Value, 1m),
            SubTotal:         D(root.Attribute("SubTotal")?.Value),
            Descuento:        D(root.Attribute("Descuento")?.Value),
            Total:            D(root.Attribute("Total")?.Value),
            TotalTraslados:   D(imptos?.Attribute("TotalImpuestosTrasladados")?.Value),
            TotalRetenciones: D(imptos?.Attribute("TotalImpuestosRetenidos")?.Value),
            EsNomina:         root.Descendants(nsNom + "Nomina").Any(),
            Traslados:        traslados,
            Retenciones:      retenciones);
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────
    public static List<Cfdi>? LoadJson(string path)
    {
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<List<Cfdi>>(File.ReadAllText(path, Encoding.UTF8), ReadOpts); }
        catch { return null; }
    }

    public static decimal D(string? v, decimal def = 0m) =>
        decimal.TryParse(v, NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : def;

    public static string Esc(string? v)
    {
        if (v is null) return "";
        return (v.Contains(',') || v.Contains('"') || v.Contains('\n'))
            ? $"\"{v.Replace("\"", "\"\"")}\"" : v;
    }

    public static object Err(string msg) => new { status = "error", message = msg };

    public static Dictionary<string, string> ParseArgs(string[] argv)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i + 1 < argv.Length; i += 2)
            d[argv[i].TrimStart('-')] = argv[i + 1];
        return d;
    }

    public static string GetArg(Dictionary<string, string> d, string key, string def = "") =>
        d.TryGetValue(key, out var v) ? v : def;
}
