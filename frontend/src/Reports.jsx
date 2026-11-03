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

function csvForRecords(records) {
  const rows = [["Reference", "Applicant / business", "Decision", "Reviewer", "Decided at", "Application ID"],
    ...records.map((item) => [recordReference(item), recordName(item), item.status === "approved" ? "Approved" : "Returned", item.decision.reviewer, item.decision.decided_at, item.id])];
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

function dateTime(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Not recorded";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function recordName(record) {
  const name = record.applicant_name?.trim();
  if (name) {
    if (name !== name.toLocaleUpperCase()) return name;
    return name.split(/(\s+)/).map((word) => /^\s+$/.test(word) ? word : /^[A-Z]{1,2}$/.test(word) ? word : `${word[0]}${word.slice(1).toLocaleLowerCase()}`).join("");
  }
  if (record.label && record.label.toLowerCase() !== "business permit application") return record.label;
  return `Application ${record.id.slice(-8)}`;
}

function recordReference(record) {
  return record.label?.trim() || `Application ${record.id.slice(-8)}`;
}

function reviewerLabel(reviewer) {
  if (!reviewer) return "Reviewer not recorded";
  if (!reviewer.includes("@")) return reviewer;
  const username = reviewer.split("@")[0].replace(/[._-]+/g, " ").trim();
  const match = username.match(/^reviewer\s+([a-z0-9]+)$/i);
  return match ? `Reviewer ${match[1].toUpperCase()}` : username.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readable(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function RecordDetail({ record, onBack }) {
  const returned = record.status === "returned";
  const timeline = [
    ["Submitted", record.history.submitted],
    ["AI checked", record.history.ai_checked],
    ["Reviewed", record.history.reviewed],
    ["Decided", record.history.decided],
  ];
  return <div className="record-detail-view">
    <button className="record-back-link" type="button" onClick={onBack}>← All application records</button>
    <header className="record-detail-heading">
      <div><h3>{recordName(record)}</h3><p>{recordReference(record)}</p><small>{record.id}</small></div>
      <span className={`record-decision-pill ${returned ? "returned" : "approved"}`}>{returned ? "Returned" : "Approved"}</span>
    </header>
    <span className="record-locked"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></svg>Decision locked</span>

    <section className="record-detail-card">
      <h4>Decision summary</h4>
      <dl><div><dt>Decision</dt><dd>{returned ? "Returned for correction" : "Approved"}</dd></div>
        <div><dt>Reviewer</dt><dd>{record.decision.reviewer || "Reviewer not recorded"}</dd></div>
        <div><dt>Decided</dt><dd>{dateTime(record.decision.decided_at)}</dd></div>
      </dl>
      <p className="record-decision-reason">{record.decision.reason || "No decision reason was recorded. Reviewer notes are shown with each finding below."}</p>
    </section>

    <section className="record-detail-card">
      <h4>Finding review record <span>{record.findings.length}</span></h4>
      {record.findings.length ? <ul className="record-finding-list">{record.findings.map((finding) => (
        <li key={finding.finding_id}>
          <div className="record-finding-heading"><strong>{readable(finding.field)}</strong><span className={`record-finding-status status-${finding.status}`}>{readable(finding.status)}</span></div>
          <p>{finding.message}</p>
          <small>Source: {[...new Set((finding.evidence ?? []).map((item) => readable(item.document)))].join(", ") || "Not recorded"}</small>
          <blockquote>{finding.reviewer_note?.trim() || "No reviewer note recorded."}</blockquote>
        </li>
      ))}</ul> : <p className="record-no-data">No findings were recorded.</p>}
    </section>

    <section className="record-detail-card">
      <h4>Document verification</h4>
      {record.verifications?.length ? <ul className="record-finding-list">{record.verifications.map((v) => <li key={`${v.document}-${v.kind}`}>
        <strong>{readable(v.document)} · {readable(v.kind)} · {readable(v.status)}</strong>
        <p>{v.evidence_note}</p><small>{v.reviewed_by} · {dateTime(v.reviewed_at)}</small>
      </li>)}</ul> : <p>No verification evidence was recorded. Document authenticity is unverified.</p>}
      <h4>Documents <span>{record.documents.length}</span></h4>
      {record.documents.length ? <ul className="record-document-list">{record.documents.map((document) => <li key={document.document}>
        <span><strong>{readable(document.document)}</strong><small>{document.filename}</small></span><span className="record-file-type">{readable(document.method)}</span>
      </li>)}</ul> : <p className="record-no-data">No uploaded documents were recorded.</p>}
    </section>

    <section className="record-detail-card">
      <h4>History</h4>
      <ol className="record-timeline">{timeline.map(([label, timestamp]) => <li className={timestamp ? "complete" : ""} key={label}>
        <span className="record-timeline-marker" /><span><strong>{label}</strong><small>{dateTime(timestamp)}</small></span>
      </li>)}</ol>
    </section>
  </div>;
}

export default function Reports({ apiFetch, lguName, selectedRecordId = null, onSelectRecord = () => {} }) {
  const [range, setRange] = useState("30"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [report, setReport] = useState(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState([]); const [stats, setStats] = useState(null); const [recordsError, setRecordsError] = useState("");
  const [recordsLoading, setRecordsLoading] = useState(true); const [recordLoading, setRecordLoading] = useState(false); const [recordDetail, setRecordDetail] = useState(null);
  const [recordFilter, setRecordFilter] = useState("all"); const [recordQuery, setRecordQuery] = useState("");
  const period = useMemo(() => periodFor(range, from, to), [range, from, to]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const query = new URLSearchParams(); if (period.from) query.set("from", new Date(`${period.from}T00:00:00`).toISOString()); if (period.to) query.set("to", new Date(`${period.to}T23:59:59.999`).toISOString());
    apiFetch(`/api/reports?${query}`).then(async (response) => { if (!response.ok) throw new Error((await response.json()).error ?? "Could not load reports."); return response.json(); })
      .then((data) => { if (active) setReport(data); }).catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [apiFetch, period.from, period.to]);
  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch("/api/records").then(async (response) => { if (!response.ok) throw new Error((await response.json()).error ?? "Could not load application records."); return response.json(); }),
      apiFetch("/api/stats").then(async (response) => { if (!response.ok) throw new Error("Could not load dashboard statistics."); return response.json(); }),
    ]).then(([recordData, statsData]) => {
      if (!active) return;
      setRecords(recordData); setStats(statsData); setRecordsError("");
    }).catch((cause) => { if (active) setRecordsError(cause.message); })
      .finally(() => { if (active) setRecordsLoading(false); });
    return () => { active = false; };
  }, [apiFetch]);
  useEffect(() => {
    if (!selectedRecordId) { setRecordDetail(null); return undefined; }
    let active = true; setRecordLoading(true);
    apiFetch(`/api/records/${encodeURIComponent(selectedRecordId)}`)
      .then(async (response) => { if (!response.ok) throw new Error((await response.json()).error ?? "Could not load this application record."); return response.json(); })
      .then((record) => { if (active) setRecordDetail(record); })
      .catch((cause) => { if (active) { setRecordDetail(null); setRecordsError(cause.message); } })
      .finally(() => { if (active) setRecordLoading(false); });
    return () => { active = false; };
  }, [apiFetch, selectedRecordId]);
  const exportCsv = () => {
    if (!visibleRecords.length) return;
    const url = URL.createObjectURL(new Blob(["\ufeff", csvForRecords(visibleRecords)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "kalabasa-filtered-application-records.csv"; link.click(); URL.revokeObjectURL(url);
  };
  const recordCounts = { all: records.length, approved: records.filter((item) => item.status === "approved").length, returned: records.filter((item) => item.status === "returned").length };
  const visibleRecords = records.filter((record) => (recordFilter === "all" || record.status === recordFilter)
    && `${record.label} ${record.applicant_name ?? ""} ${record.business_name ?? ""} ${record.owner_name ?? ""} ${record.id}`.toLowerCase().includes(recordQuery.trim().toLowerCase()));
  return <section className="reports-page">
    <section className="decision-records-section" aria-labelledby="decision-records-title">
      <div className="decision-records-title-row"><div><h3 id="decision-records-title">Application Records</h3><p>Find completed decisions and their review history.</p></div>
        {!selectedRecordId && <button className="outline-button reports-export" type="button" onClick={exportCsv} disabled={!visibleRecords.length}>Export filtered CSV</button>}
      </div>
      {!selectedRecordId && <div className="record-stats-row" aria-label="Decision summary statistics">
        <article><span>Total decided</span><strong>{records.length}</strong></article>
        <article><span>Approved</span><strong>{recordCounts.approved}</strong></article>
        <article><span>Returned</span><strong>{recordCounts.returned}</strong></article>
        <article><span title="Processed today">Today</span><strong>{stats?.processed_today ?? 0}</strong></article>
      </div>}
      {!selectedRecordId && <p className="record-export-note">Exports records matching the current filter and search.</p>}
      {recordsError && <p className="report-error" role="alert">{recordsError}</p>}
      {selectedRecordId ? recordLoading ? <p className="report-notice" role="status">Loading application record…</p> : recordDetail ? <RecordDetail record={recordDetail} onBack={() => onSelectRecord(null)} /> : null : <>
        <div className="record-list-controls">
          <div className="record-filter-chips" role="group" aria-label="Filter application records">{[["all", "All"], ["approved", "Approved"], ["returned", "Returned"]].map(([value, label]) => <button type="button" key={value} className={recordFilter === value ? "active" : ""} aria-pressed={recordFilter === value} onClick={() => setRecordFilter(value)}>{label}<span>{recordCounts[value]}</span></button>)}</div>
          <label className="record-search"><span className="visually-hidden">Search by business name, reference, or application ID</span><input value={recordQuery} onChange={(event) => setRecordQuery(event.target.value)} placeholder="Search by business name or ID" /></label>
        </div>
        {recordsLoading ? <p className="report-notice" role="status">Loading application records…</p> : visibleRecords.length ? <ul className="application-record-list">{visibleRecords.map((record) => <li key={record.id}><button type="button" onClick={() => onSelectRecord(record.id)}>
          <span className="application-record-copy"><span className="application-record-topline"><strong>{recordName(record)}</strong><span className={`record-decision-pill ${record.status === "returned" ? "returned" : "approved"}`}>{record.status === "returned" ? "Returned" : "Approved"}</span></span>
            <span className="application-record-bottomline"><small>{recordReference(record)}</small><span title={record.decision.reviewer || "Reviewer not recorded"}>{reviewerLabel(record.decision.reviewer)}</span><time>{dateTime(record.decision.decided_at)}</time></span></span>
        </button></li>)}</ul> : <p className="record-empty-state">{records.length ? "No applications match your filter or search." : "No decided applications yet. Decisions you make will appear here."}</p>}
      </>}
    </section>
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
