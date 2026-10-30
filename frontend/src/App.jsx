import { useEffect, useMemo, useState } from "react";

const MOCK_MODE = import.meta.env.MOCK_MODE === true;
const DEFAULT_FIXTURE = "set_05_demo_story";
const FIXTURES = [
  ["set_01_clean", "Clean application"],
  ["set_02_address_mismatch", "Address mismatch"],
  ["set_03_missing_document", "Missing document"],
  ["set_04_formatting_only", "Formatting only"],
  ["set_05_demo_story", "Demo story"],
];
const DOCUMENTS = [
  ["application_form", "Business Permit Application Form"],
  ["dti_certificate", "DTI Certificate"],
  ["barangay_clearance", "Barangay Business Clearance"],
  ["lease_contract", "Contract of Lease"],
  ["community_tax_certificate", "Community Tax Certificate"],
];
const SCREENS = ["Upload", "Requirements", "Extracted Fields", "Findings", "Outcome"];

function outcomeFor(application) {
  const statuses = application?.findings.map((finding) => finding.status) ?? [];
  if (statuses.some((status) => status === "open" || status === "escalated")) return "locked";
  if (statuses.includes("confirmed")) return "return";
  return "approve";
}

function textWithHighlight(text, target) {
  if (!target) return text;
  const start = text.toLowerCase().indexOf(target.toLowerCase());
  if (start < 0) return text;
  return <>
    {text.slice(0, start)}
    <mark>{text.slice(start, start + target.length)}</mark>
    {text.slice(start + target.length)}
  </>;
}

function App() {
  const [application, setApplication] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [screen, setScreen] = useState("Upload");
  const [selectedFindingId, setSelectedFindingId] = useState(null);
  const [fixture, setFixture] = useState(DEFAULT_FIXTURE);
  const [files, setFiles] = useState({});
  const [reviewerNote, setReviewerNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedFinding = useMemo(
    () => application?.findings.find((finding) => finding.finding_id === selectedFindingId) ?? application?.findings[0] ?? null,
    [application, selectedFindingId],
  );
  const decision = outcomeFor(application);

  useEffect(() => {
    let active = true;
    fetch("/api/lgus/bagong-dalisay-demo/requirements")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? "Could not load requirements.");
        return response.json();
      })
      .then((data) => {
        if (active) setRequirements(data);
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });

    if (MOCK_MODE) {
      fetch(`/api/applications/app-${DEFAULT_FIXTURE}`)
        .then(async (response) => {
          if (!response.ok) throw new Error((await response.json()).error ?? "Could not load demo application.");
          return response.json();
        })
        .then((data) => {
          if (active) {
            setApplication(data);
            setSelectedFindingId(data.findings[0]?.finding_id ?? null);
          }
        })
        .catch((cause) => {
          if (active) setError(cause.message);
        });
    }

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setReviewerNote(selectedFinding?.reviewer_note ?? "");
  }, [selectedFinding?.finding_id]);

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "The request could not be completed.");
    return data;
  }

  async function processApplication(id) {
    const processed = await request(`/api/applications/${id}/process`, { method: "POST" });
    setApplication(processed);
    setSelectedFindingId(processed.findings[0]?.finding_id ?? null);
    setScreen("Requirements");
  }

  async function submitApplication(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let created;
      if (MOCK_MODE) {
        created = await request("/api/applications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fixture }),
        });
      } else {
        const formData = new FormData();
        formData.set("lgu_id", "bagong-dalisay-demo");
        formData.set("label", "Business Permit Application");
        for (const [document, file] of Object.entries(files)) {
          if (!file) continue;
          formData.append("document_types[]", document);
          formData.append("files", file);
        }
        created = await request("/api/applications", { method: "POST", body: formData });
      }
      await processApplication(created.id);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateFinding(status) {
    if (!application || !selectedFinding) return;
    setBusy(true);
    setError("");
    try {
      const updated = await request(`/api/applications/${application.id}/findings/${selectedFinding.finding_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, reviewer_note: reviewerNote }),
      });
      setApplication((current) => ({
        ...current,
        findings: current.findings.map((finding) => finding.finding_id === updated.finding_id ? updated : finding),
      }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function decide(outcome) {
    if (!application) return;
    setBusy(true);
    setError("");
    try {
      const updated = await request(`/api/applications/${application.id}/${outcome}`, { method: "POST" });
      setApplication(updated);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  const uploaded = new Set(application?.documents.map((document) => document.document) ?? []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={() => setScreen("Upload")} aria-label="KalaBASA home">
          <span className="brand-mark">K</span>
          <span><strong>KalaBASA</strong><small>Permit review workspace</small></span>
        </a>
        <div className="topbar-right">
          {MOCK_MODE && <span className="demo-badge"><span />Demo mode / mocked data</span>}
          <span className="reviewer-label">Reviewer workspace</span>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-label">APPLICATION REVIEW</div>
          <nav aria-label="Review sections">
            {SCREENS.map((item, index) => (
              <button
                className={`nav-item ${screen === item ? "active" : ""}`}
                key={item}
                onClick={() => setScreen(item)}
              >
                <span className="nav-number">{String(index + 1).padStart(2, "0")}</span>
                <span>{item}</span>
                {item === "Findings" && application?.findings.length > 0 && (
                  <span className="nav-count">{application.findings.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className={`status-dot ${application ? "ready" : ""}`} />
            {application ? application.status.replaceAll("_", " ") : "No application loaded"}
          </div>
        </aside>

        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">{requirements?.lgu.name ?? "City Business Permits Office"}</div>
              <h1>{screen}</h1>
              <p>{application?.label ?? "Review supporting documents and extracted information."}</p>
            </div>
            {application && <div className="application-id">APPLICATION <strong>{application.id}</strong></div>}
          </div>

          {error && <div className="error-banner" role="alert">{error}</div>}

          {screen === "Upload" && (
            <section className="card upload-card">
              <div className="card-heading">
                <div><h2>{MOCK_MODE ? "Choose a demo application" : "Upload application documents"}</h2>
                  <p>{MOCK_MODE ? "Select one sample set to load its review data." : "Select each PDF and the document type it contains."}</p></div>
                <span className="step-pill">STEP 01</span>
              </div>
              <form onSubmit={submitApplication}>
                {MOCK_MODE ? (
                  <label className="field-label">Sample scenario
                    <select value={fixture} onChange={(event) => setFixture(event.target.value)}>
                      {FIXTURES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                    </select>
                  </label>
                ) : (
                  <div className="file-grid">
                    {DOCUMENTS.map(([document, label]) => (
                      <label className="file-row" key={document}>
                        <span className="file-symbol">PDF</span>
                        <span className="file-description"><strong>{label}</strong><small>{files[document]?.name ?? "Choose a PDF file"}</small></span>
                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(event) => setFiles((current) => ({ ...current, [document]: event.target.files?.[0] ?? null }))}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <div className="form-actions">
                  <p>{MOCK_MODE ? "Mock mode loads fixture fields and findings; no files or LLM calls are used." : "Uploaded PDFs are processed for text and required fields."}</p>
                  <button className="primary-button" type="submit" disabled={busy || (!MOCK_MODE && Object.values(files).every((file) => !file))}>
                    {busy ? "Processing…" : MOCK_MODE ? "Load application" : "Upload and process"}
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              </form>
            </section>
          )}

          {screen === "Requirements" && (
            <section className="card">
              <div className="card-heading"><div><h2>Required documents</h2><p>Checklist status based on documents uploaded with this application.</p></div></div>
              {requirements ? <div className="requirements-list">
                {requirements.required_documents.map((rule) => {
                  const isUploaded = uploaded.has(rule.document);
                  return <div className="requirement-row" key={rule.rule_id}>
                    <span className={`check-icon ${isUploaded ? "complete" : ""}`}>{isUploaded ? "✓" : "—"}</span>
                    <span className="requirement-copy"><strong>{rule.label}</strong><small>{rule.document.replaceAll("_", " ")}</small></span>
                    <span className={`state-pill ${isUploaded ? "complete" : "missing"}`}>{isUploaded ? "Uploaded" : "Missing"}</span>
                  </div>;
                })}
              </div> : <p className="empty-state">Loading requirements…</p>}
            </section>
          )}

          {screen === "Extracted Fields" && (
            <section className="card">
              <div className="card-heading"><div><h2>Extracted information</h2><p>Values are copied from source documents. Unverified values need reviewer attention.</p></div></div>
              {application?.fields.length ? <div className="table-scroll"><table>
                <thead><tr><th>Field</th><th>Value</th><th>Document</th><th>Page</th><th>Verification</th></tr></thead>
                <tbody>{application.fields.map((field, index) => <tr key={`${field.document}-${field.field}-${index}`}>
                  <td className="field-name">{field.field.replaceAll("_", " ")}</td>
                  <td>{field.value ?? <span className="null-value">{field.presence === "blank_printed" ? "Blank on document" : "Not found"}</span>}</td>
                  <td>{field.document.replaceAll("_", " ")}</td>
                  <td>{field.page}</td>
                  <td>{field.verified
                    ? <span className="verified">Verified</span>
                    : <span className="unverified">⚠ Unverified — review source</span>}</td>
                </tr>)}</tbody>
              </table></div> : <p className="empty-state">Load or process an application to view extracted fields.</p>}
            </section>
          )}

          {screen === "Findings" && (
            <div className="findings-layout">
              <section className="card finding-list">
                <div className="card-heading"><div><h2>Review findings</h2><p>Each finding includes supporting document evidence.</p></div></div>
                {application?.findings.length ? application.findings.map((finding) => (
                  <button
                    className={`finding-item ${selectedFinding?.finding_id === finding.finding_id ? "selected" : ""}`}
                    key={finding.finding_id}
                    onClick={() => setSelectedFindingId(finding.finding_id)}
                  >
                    <span className={`finding-indicator ${finding.status}`} />
                    <span className="finding-summary">
                      <span className="finding-summary-top"><strong>{finding.field.replaceAll("_", " ")}</strong><span className={`severity ${finding.severity}`}>{finding.severity}</span></span>
                      <small>{finding.message}</small>
                      <span className="finding-status">{finding.status.replaceAll("_", " ")}</span>
                    </span>
                  </button>
                )) : <p className="empty-state">No findings. No discrepancies were detected by the configured rules.</p>}
              </section>

              {selectedFinding && <section className="card finding-detail">
                <div className="detail-eyebrow">{selectedFinding.rule_id} <span>·</span> {selectedFinding.type.replaceAll("_", " ")}</div>
                <h2>{selectedFinding.field.replaceAll("_", " ")}</h2>
                <p className="detail-message">{selectedFinding.message}</p>
                <h3>Evidence</h3>
                <div className="evidence-list">
                  {selectedFinding.evidence.map((evidence, index) => {
                    const matchedField = application.fields.find((field) =>
                      field.document === evidence.document && field.field === selectedFinding.field);
                    return <article className="evidence-card" key={`${evidence.document}-${evidence.page}-${index}`}>
                      <div className="evidence-meta"><strong>{evidence.document.replaceAll("_", " ")}</strong><span>Page {evidence.page}</span></div>
                      {evidence.source_text
                        ? <blockquote>{textWithHighlight(evidence.source_text, matchedField?.value)}</blockquote>
                        : <div className="evidence-absence">{evidence.note ?? "No source text was available for this absence."}</div>}
                      {evidence.source_text && evidence.note && <div className="evidence-note">{evidence.note}</div>}
                    </article>;
                  })}
                </div>
                <label className="field-label note-label">Reviewer note
                  <textarea value={reviewerNote} onChange={(event) => setReviewerNote(event.target.value)} placeholder="Add a note for the review record…" rows="3" />
                </label>
                <div className="review-actions">
                  <button className="outline-button" disabled={busy} onClick={() => updateFinding("confirmed")}>Confirm</button>
                  <button className="outline-button" disabled={busy} onClick={() => updateFinding("dismissed")}>Dismiss</button>
                  <button className="outline-button" disabled={busy} onClick={() => updateFinding("escalated")}>Escalate</button>
                </div>
              </section>}
            </div>
          )}

          {screen === "Outcome" && (
            <section className="card outcome-card">
              <div className={`outcome-icon ${application?.status === "approved" ? "approved" : application?.status === "returned" ? "returned" : ""}`}>
                {application?.status === "approved" ? "✓" : application?.status === "returned" ? "↩" : "…"}
              </div>
              <div className="outcome-copy">
                <span className="eyebrow">REVIEWER DECISION</span>
                <h2>{application?.status === "approved" ? "Application approved" : application?.status === "returned" ? "Application returned" : "Decision pending"}</h2>
                <p>{decision === "approve"
                  ? "All findings have been dismissed or no findings were raised. You may approve this application."
                  : decision === "return"
                    ? "At least one finding is confirmed. Return the application for correction."
                    : "Open or escalated findings must be resolved before a final decision."}</p>
                <div className="outcome-actions">
                  <button className="primary-button" disabled={busy || decision !== "approve" || application?.status === "approved"} onClick={() => decide("approve")}>Approve application</button>
                  <button className="outline-button" disabled={busy || decision !== "return" || application?.status === "returned"} onClick={() => decide("return")}>Return for correction</button>
                </div>
              </div>
            </section>
          )}

          {!application && screen !== "Upload" && <div className="card empty-card"><p className="empty-state">Load an application first to view this section.</p></div>}

          {application && <footer className="review-disclaimer">
            <span className="disclaimer-icon">i</span>
            <span>Automated checks support the review only. The reviewer makes the final decision.</span>
            <button onClick={() => setScreen("Outcome")}>Go to outcome <span aria-hidden="true">→</span></button>
          </footer>}
        </main>
      </div>
    </div>
  );
}

export default App;
