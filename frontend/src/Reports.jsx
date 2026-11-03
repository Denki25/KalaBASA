import { useEffect, useMemo, useState } from "react";

function localDate(date) {
  const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, "0"); const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function periodFor(range, from, to) {
  const now = new Date(); const end = new Date(now); end.setHours(23, 59, 59, 999);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (range === "7") start.setDate(start.getDate() - 6);
  if (range === "30") start.setDate(start.getDate() - 29);
  if (range === "month") start.setDate(1);
  if (range === "year") { start.setMonth(0, 1); }
  if (range === "custom") return { from, to };
  return { from: localDate(start), to: localDate(end) };
}

function csvFor(report, lguName) {
  const comparison = report.comparison ?? {};
  const rows = [["KalaBASA Reports & Analytics"], ["LGU", lguName], ["Reporting period", `${report.period.from ?? "All time"} to ${report.period.to ?? "Today"}`],
    ["Generated", report.generated_at], [], ["Summary metric", "Count", "Change vs previous period"],
    ["Applications received", report.application_total, comparison.application_total], ["Ready for review", report.applications_by_status.ready_for_review, comparison.ready_for_review], ["Documents uploaded", report.documents_total, comparison.documents_total],
    ["Findings generated", report.findings_total, comparison.findings_total], ["Open findings", report.findings_by_status.open + report.findings_by_status.escalated, comparison.open_findings], ["Extraction completed", report.extraction_completed], ["Extraction failed", report.extraction_failed], [],
    ["Application status", "Count"], ...Object.entries(report.applications_by_status), [],
    ["Finding status", "Count"], ...Object.entries(report.findings_by_status), [],
    ["Finding type", "Count"], ...Object.entries(report.findings_by_type), [],
    ["Document extraction method", "Count"], ...Object.entries(report.documents_by_method), [],
    ["Application ID", "Status", "Created"], ...report.applications.map((item) => [item.id, item.status, item.created_at])];
  return rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

function comparisonText(delta) {
  if (delta == null) return "";
  if (delta === 0) return "No change vs previous period";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} vs previous period`;
}

function Metric({ label, value, note, delta, primary = false }) {
  const isZero = Number(value) === 0;
  return <article className={`report-metric${primary ? " is-primary" : ""}${isZero ? " is-zero" : ""}`}>
    <span>{label}</span><strong>{value}</strong><small>{note}</small>
    {delta != null && <small className="report-comparison">{comparisonText(delta)}</small>}
  </article>;
}

function Breakdown({ title, values, labels = {} }) {
  const entries = Object.entries(values ?? {}); const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return <section className="report-panel"><h2>{title}</h2>{entries.length === 0 ? <p className="report-empty">No records for this period.</p> : entries.map(([key, value]) => <div className="report-breakdown" key={key}><div><span>{labels[key] ?? key.replaceAll("_", " ")}</span><strong>{value}</strong></div><i><b style={{ width: `${total ? value / total * 100 : 0}%` }} /></i></div>)}</section>;
}

export default function Reports({ apiFetch, lguName }) {
  const [range, setRange] = useState("30"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [report, setReport] = useState(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const period = useMemo(() => periodFor(range, from, to), [range, from, to]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const query = new URLSearchParams(); if (period.from) query.set("from", new Date(`${period.from}T00:00:00`).toISOString()); if (period.to) query.set("to", new Date(`${period.to}T23:59:59.999`).toISOString());
    apiFetch(`/api/reports?${query}`).then(async (response) => { if (!response.ok) throw new Error((await response.json()).error ?? "Could not load reports."); return response.json(); })
      .then((data) => { if (active) setReport(data); }).catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [apiFetch, period.from, period.to]);
  const exportCsv = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob(["\ufeff", csvFor(report, lguName)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "kalabasa-report.csv"; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="reports-page">
    <div className="reports-heading"><div className="reports-heading-copy"><div className="eyebrow">{lguName}</div><h2>Reports &amp; Analytics</h2><p>Application processing and document verification activity from recorded cases.</p></div>
      <button className="outline-button reports-export" type="button" onClick={exportCsv} disabled={!report}>Export CSV</button></div>
    <div className="report-controls"><label>Reporting period<select value={range} onChange={(event) => setRange(event.target.value)}><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="month">This month</option><option value="year">This year</option><option value="custom">Custom range</option></select></label>
      {range === "custom" && <><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></>}
      <span>Dates use your local timezone.</span></div>
    {loading && <p className="report-notice">Loading authorized report data…</p>}{error && <p className="report-error" role="alert">{error}</p>}
    {report && <>
      <div className="report-metrics"><Metric label="Applications received" value={report.application_total} note="Created in selected period" delta={report.comparison?.application_total} primary/><Metric label="Under review" value={report.applications_by_status.extracting + report.applications_by_status.ready_for_review} note="Extraction or reviewer queue"/><Metric label="Ready for review" value={report.applications_by_status.ready_for_review} note="Processed applications" delta={report.comparison?.ready_for_review} primary/><Metric label="Approved" value={report.applications_by_status.approved} note="Recorded decisions"/><Metric label="Returned" value={report.applications_by_status.returned} note="Recorded decisions" delta={report.comparison?.returned}/><Metric label="Documents uploaded" value={report.documents_total} note="Across selected applications" delta={report.comparison?.documents_total}/><Metric label="Findings" value={report.findings_total} note="Generated for selected cases" delta={report.comparison?.findings_total}/><Metric label="Open findings" value={report.findings_by_status.open + report.findings_by_status.escalated} note="Open or escalated" delta={report.comparison?.open_findings}/></div>
      <div className="report-grid"><Breakdown title="Application status" values={report.applications_by_status} labels={{ ready_for_review: "Ready for review" }}/><Breakdown title="Findings by status" values={report.findings_by_status} labels={{ confirmed: "Confirmed by reviewer" }}/><Breakdown title="Finding type" values={report.findings_by_type}/><Breakdown title="Finding severity" values={report.findings_by_severity}/><Breakdown title="Extraction method (processed cases)" values={report.documents_by_method} labels={{ text_layer: "Text extraction", ocr: "OCR"}}/><Breakdown title="Extraction outcomes" values={{ completed: report.extraction_completed, failed: report.extraction_failed }}/></div>
      <section className="report-panel report-trend"><h2>Applications received over time</h2>{report.trend.length ? <div className="trend-bars">{report.trend.map((item) => <div key={item.date} title={`${item.date}: ${item.count}`}><i style={{ height: `${Math.max(5, item.count / Math.max(...report.trend.map((day) => day.count)) * 100)}%` }}/><small>{item.date.slice(5)}</small></div>)}</div> : <p className="report-empty">No applications were created during this period.</p>}</section>
      <section className="report-panel"><h2>Application activity</h2><div className="table-scroll"><table><thead><tr><th>Application ID</th><th>Status</th><th>Received</th></tr></thead><tbody>{report.applications.map((item) => <tr key={item.id}><td>{item.id}</td><td>{item.status.replaceAll("_", " ")}</td><td>{new Date(item.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>{!report.applications.length && <p className="report-empty">No applications for this period.</p>}</section>
      <p className="report-definition">Finding status reflects the latest recorded reviewer decision. Extraction method is counted only for processed applications. Upload type and upload time are not recorded by the current database.</p>
    </>}
  </section>;
}
