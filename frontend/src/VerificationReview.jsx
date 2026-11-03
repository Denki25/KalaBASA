import { useState } from "react";

function VerificationForm({ document, kind, saved, disabled, onSave }) {
  const [status, setStatus] = useState(saved?.status ?? "unverified");
  const [note, setNote] = useState(saved?.evidence_note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try { await onSave({ document, kind, status, evidence_note: note }); }
    catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }
  return <form className="verification-form" onSubmit={submit}>
    <label>{kind === "validity" ? "Validity review" : "Authenticity review"}
      <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={disabled || saving}>
        <option value="unverified">Pending / unable to verify</option>
        <option value="verified">Verified by reviewer</option>
        <option value="rejected">Failed verification</option>
      </select>
    </label>
    <label>Evidence and review notes
      <textarea required minLength={10} maxLength={4000} rows={3} value={note} disabled={disabled || saving} onChange={(e) => setNote(e.target.value)}
        placeholder={kind === "authenticity" ? "Record issuer confirmation, trusted verification reference, or why authenticity remains unverified." : "Record the applicable requirement, dates, business ownership, and source checks performed."} />
    </label>
    {saved && <small>Saved: {saved.status.replaceAll("_", " ")} · {saved.reviewed_by} · {new Date(saved.reviewed_at).toLocaleString()}<br />{saved.evidence_note}</small>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {!disabled && <button type="submit" className="outline-button" disabled={saving || note.trim().length < 10}>{saving ? "Saving…" : "Save review"}</button>}
  </form>;
}

export function ReviewSummary({ application, requirements }) {
  const documents = application.documents;
  const findings = application.findings;
  const unresolved = (f) => f.status !== "dismissed";
  const complete = (requirements?.required_documents ?? []).filter((r) => r.required).every((r) => documents.some((d) => d.document === r.document));
  const status = (kind) => {
    const records = documents.map((d) => application.verifications?.find((v) => v.document === d.document && v.kind === kind));
    if (records.some((v) => v?.status === "rejected")) return "Failed verification";
    if (kind === "validity" && findings.some((f) => f.type === "validity_issue" && unresolved(f))) return "Issues require review";
    return records.length && records.every((v) => v?.status === "verified") ? "Reviewer verified" : "Pending verification";
  };
  return <section className="review-assessment" aria-label="Document assessment">
    <dl>
      <div><dt>Completeness</dt><dd>{!requirements ? "Requirements loading" : complete ? "Required documents uploaded" : "Required documents missing"}{findings.some((f) => f.type === "missing_field" && unresolved(f)) ? " · Field issues" : ""}</dd></div>
      <div><dt>Consistency</dt><dd>{findings.some((f) => f.type === "cross_document_mismatch" && unresolved(f)) ? "Discrepancies require review" : "No configured mismatches flagged"}</dd></div>
      <div><dt>Validity</dt><dd>{status("validity")}</dd></div>
      <div><dt>Authenticity</dt><dd>{status("authenticity")}</dd></div>
    </dl>
    <p>Uploads and matching text do not establish authenticity or legal compliance. Review the applicable LGU requirements and record verification evidence before approval.</p>
  </section>;
}

export default function VerificationReview({ application, disabled, onSave }) {
  return <section className="card verification-review">
    <div className="card-heading"><div><h2>Document verification</h2><p>Review each uploaded document. Record trusted evidence for authenticity and the applicable requirements for validity. If verification is unavailable, leave it pending.</p></div></div>
    {application.documents.map(({ document, filename }) => <article className="verification-document" key={document}>
      <h3>{document.replaceAll("_", " ")}</h3><p>{filename}</p>
      <div className="verification-forms">{["validity", "authenticity"].map((kind) => {
        const saved = application.verifications?.find((v) => v.document === document && v.kind === kind);
        return <VerificationForm key={`${application.id}-${document}-${kind}-${saved?.reviewed_at ?? "new"}`} {...{ document, kind, saved, disabled, onSave }} />;
      })}</div>
    </article>)}
  </section>;
}
