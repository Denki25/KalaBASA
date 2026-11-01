import { useEffect, useMemo, useRef, useState } from "react";
import { nextOutcome } from "kalabasa-contract/schemas.js";
import logo from "./assets/logo.png";

const MOCK_MODE = import.meta.env.MOCK_MODE === true;

// ---- Login session (kept only for this browser tab) ----
const SESSION_KEY = "kalabasa-session";

function readSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    return saved?.token && saved?.user ? saved : null;
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// Like fetch(), but sends the login token. If the server says the token is no good, sign out.
async function apiFetch(url, options = {}) {
  const session = readSession();
  const headers = new Headers(options.headers ?? {});
  if (session) headers.set("Authorization", `Bearer ${session.token}`);
  const response = await window.fetch(url, { ...options, headers });
  if (response.status === 401 && session) {
    clearSession();
    window.location.reload();
  }
  return response;
}
const DEFAULT_FIXTURE = "set_05_demo_story";
const DEFAULT_LGU_ID = "bagong-dalisay-demo";
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
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const SCREENS = ["Upload", "Requirements", "Extracted Fields", "Findings", "Outcome"];

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

function highlightWordDifferences(text, peerTexts) {
  if (!text || peerTexts.length === 0) return text;
  const tokenize = (value) => new Set((value.match(/[\p{L}\p{N}'-]+/gu) ?? []).map((word) => word.toLocaleLowerCase()));
  const peerWords = peerTexts.map(tokenize);
  const pieces = text.split(/([\p{L}\p{N}'-]+)/gu);
  return pieces.map((piece, index) => {
    if (!/[\p{L}\p{N}]/u.test(piece)) return piece;
    const normalized = piece.toLocaleLowerCase();
    return peerWords.some((words) => !words.has(normalized))
      ? <mark className="word-difference" key={`${index}-${piece}`}>{piece}</mark>
      : piece;
  });
}

function formattedDecisionTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function greetingForNow(name) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${greeting}, ${name || "Reviewer"}!`;
}

function timeAgo(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function BottomNavigation({ active, onHome, onApplications, onScan }) {
  return (
    <nav className="bottom-navigation" aria-label="Main navigation">
      <button className={active === "Home" ? "active" : ""} type="button" onClick={onHome} aria-current={active === "Home" ? "page" : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3.5 10 8.5-7 8.5 7v10a.8.8 0 0 1-.8.8h-5.4v-6.3h-4.6v6.3H4.3a.8.8 0 0 1-.8-.8z" /></svg>Home
      </button>
      <button className={active === "Applications" ? "active" : ""} type="button" onClick={onApplications} aria-current={active === "Applications" ? "page" : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /></svg>Applications
      </button>
      <button className="scan-nav-action" type="button" aria-label="Start AI-Assisted Review" onClick={onScan}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 12h8" /></svg>
      </button>
      <button type="button" disabled aria-label="Reports (not available)">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M7 16V9m5 7V4m5 12v-5" /></svg>Reports
      </button>
      <button type="button" disabled aria-label="Profile (not available)">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>Profile
      </button>
    </nav>
  );
}

function HomeScreen({ onUpload, onOpenApplication, user, onSignOut }) {
  const [applications, setApplications] = useState([]);
  const [activity, setActivity] = useState([]);
  const [stats, setStats] = useState({ pending: 0, processed_today: 0, flagged: 0 });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch("/api/applications").then((response) => {
        if (!response.ok) throw new Error("Could not load applications.");
        return response.json();
      }),
      apiFetch("/api/activity?limit=10").then((response) => {
        if (!response.ok) throw new Error("Could not load recent activity.");
        return response.json();
      }),
      apiFetch("/api/stats").then((response) => {
        if (!response.ok) throw new Error("Could not load dashboard stats.");
        return response.json();
      }),
    ]).then(([applicationData, activityData, statsData]) => {
      if (!active) return;
      setApplications(applicationData);
      setActivity(activityData);
      setStats(statsData);
      setLoadError("");
    }).catch(() => {
      if (active) setLoadError("Could not load Home data. Please refresh to try again.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const filteredApplications = applications.filter((application) =>
    `${application.id} ${application.label}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <main className="home-screen">
      <header className="home-header">
        <img className="home-logo" src={logo} alt="KalaBASA" />
        {MOCK_MODE && <span className="home-demo-badge"><i />Demo mode / mocked data</span>}
        {user && (
          <span className="home-user">
            <span>{user.full_name} · {user.role}</span>
            <button className="signout-link" type="button" onClick={onSignOut}>Sign out</button>
          </span>
        )}
      </header>

      <section className="home-welcome">
        <span className="home-eyebrow">PERMIT REVIEW WORKSPACE</span>
        <h1>{greetingForNow(user?.full_name?.split(" ")[0])}</h1>
        <p>Let’s make the permit process faster and more accurate.</p>
      </section>

      <label className="home-search">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <span className="visually-hidden">Search applications by ID or label</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search applications..." />
        <span className="search-hint" aria-hidden="true">⌕</span>
      </label>

      <section className="home-stats" aria-label="Application statistics">
        <article className="home-stat pending-stat"><span className="stat-icon">▤</span><strong>{stats.pending}</strong><span>Pending</span></article>
        <article className="home-stat processed-stat"><span className="stat-icon">✓</span><strong>{stats.processed_today}</strong><span>Processed<br />Today</span></article>
        <article className="home-stat flagged-stat"><span className="stat-icon">!</span><strong>{stats.flagged}</strong><span>Flagged</span></article>
      </section>

      <button className="home-upload-card" type="button" onClick={onUpload}>
        <span className="upload-art" aria-hidden="true"><span>↑</span><i>AI</i></span>
        <span className="upload-copy"><strong>Let KalaBASA do the check</strong><small>Upload an application to get started.</small><small>AI-assisted review.</small></span>
        <span className="upload-arrow" aria-hidden="true">→</span>
      </button>

      {loadError && <p className="home-load-error" role="alert">{loadError}</p>}

      <section className="home-activity" aria-labelledby="recent-activity-heading">
        <div className="home-section-heading"><h2 id="recent-activity-heading">Recent Activity</h2></div>
        {loading ? <p className="home-empty">Loading activity...</p> : activity.length === 0 ? (
          <p className="home-empty">No activity yet</p>
        ) : (
          <ol className="activity-list">
            {activity.map((item, index) => (
              <li className="activity-item" key={`${item.application_id}-${item.action}-${item.timestamp}-${index}`}>
                <span className={`activity-dot activity-${item.action}`} aria-hidden="true">{item.action === "application_approved" ? "✓" : item.action === "application_returned" ? "↩" : item.action === "finding_updated" || item.text === "Inconsistency flagged" ? "!" : "↑"}</span>
                <span className="activity-copy"><strong>{item.text}</strong><small>{applications.find((application) => application.id === item.application_id)?.label ?? item.application_id}</small></span>
                <time dateTime={item.timestamp}>{timeAgo(item.timestamp)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="home-applications" aria-labelledby="applications-heading">
        <div className="home-section-heading"><h2 id="applications-heading">Applications</h2><span>{filteredApplications.length}</span></div>
        {loading ? <p className="home-empty">Loading applications...</p> : filteredApplications.length === 0 ? (
          <p className="home-empty">No applications match your search.</p>
        ) : (
          <ul className="application-list">
            {filteredApplications.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => onOpenApplication(item.id)}>
                  <span className="application-file-icon" aria-hidden="true">▤</span>
                  <span className="application-row-copy"><strong>{item.label}</strong><small>{item.id}</small></span>
                  <span className={`application-status status-${item.status}`}>{item.status.replaceAll("_", " ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BottomNavigation active="Home" onHome={() => {}} onApplications={onUpload} onScan={onUpload} />
    </main>
  );
}

function DecisionCompleteScreen({ application, requirements, user, decisionTimestamp, error, screen, onNavigate, onDashboard, onUpload, onReviewNext }) {
  const [nextApplication, setNextApplication] = useState(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueUnavailable, setQueueUnavailable] = useState(false);
  const approved = application.status === "approved";
  const actor = user?.full_name || user?.email || "Reviewer";
  const relevantFindings = application.findings.filter((finding) =>
    approved ? finding.status === "dismissed" : finding.status === "confirmed");

  useEffect(() => {
    let active = true;
    apiFetch("/api/applications")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the review queue.");
        return response.json();
      })
      .then((applications) => {
        if (!active) return;
        setNextApplication(applications.find((item) =>
          item.id !== application.id && item.status === "ready_for_review") ?? null);
      })
      .catch(() => {
        if (active) {
          setNextApplication(null);
          setQueueUnavailable(true);
        }
      })
      .finally(() => {
        if (active) setQueueLoading(false);
      });
    return () => { active = false; };
  }, [application.id]);

  const decisionTime = decisionTimestamp ? timeAgo(decisionTimestamp) : "Just now";

  return (
    <div className="app-shell review-screen-shell decision-result-shell">
      <header className="review-header">
        <button className="review-back" type="button" onClick={onDashboard} aria-label="Back to dashboard">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="review-header-copy">
          <strong>{application.label || "Application review"}</strong>
          <small>{application.id}</small>
        </div>
        <span className={`review-header-status final ${approved ? "" : "returned"}`}>{application.status.replaceAll("_", " ")}</span>
        {MOCK_MODE && <span className="demo-badge"><span />Demo mode / mocked data</span>}
      </header>
      <nav className="review-tabs" aria-label="Application review sections">
        {[ ["Findings", "Findings"], ["Extracted Fields", "Extracted Fields"], ["Requirements", "Requirements"], ["Outcome", "Decision"] ].map(([value, label]) => (
          <button type="button" key={value} className={screen === value ? "active" : ""} aria-current={screen === value ? "page" : undefined} onClick={() => onNavigate(value)}>{label}</button>
        ))}
      </nav>
      <div className="review-workspace">
        <main className="main-content review-main decision-result-main">
          <section className="card outcome-card decision-result-card">
            <div className={`outcome-icon ${approved ? "approved" : "returned"}`} aria-hidden="true">{approved ? "✓" : "↩"}</div>
            <div className="outcome-copy">
              <span className="eyebrow">REVIEW COMPLETE</span>
              <h2>{approved ? "Application approved" : "Returned for correction"}</h2>
              <p>{approved
                ? "The decision has been recorded and the application is marked as approved."
                : "The application was returned with the confirmed findings attached for correction."}</p>
            </div>
          </section>

          <section className="card decision-summary-card" aria-label="Decision summary">
            <div className="card-heading"><div><h2>Decision summary</h2><p>Recorded for this application.</p></div></div>
            <div className="decision-receipt">
              <div><span>Reference No.</span><strong title={application.id}>{application.id}</strong></div>
              {approved && <div><span>Permit Type</span><strong>{requirements?.lgu?.application_type || "Business Permit"}</strong></div>}
              {!approved && <div><span>Findings attached</span><strong>{relevantFindings.length} {relevantFindings.length === 1 ? "finding" : "findings"}</strong></div>}
              <div><span>{approved ? "Approved by" : "Returned by"}</span><strong>{actor}</strong></div>
              {approved && <div><span>Findings handled</span><strong>{relevantFindings.length} handled</strong></div>}
              <div><span>Time</span><strong><time dateTime={decisionTimestamp || undefined}>{decisionTime}</time></strong></div>
            </div>
          </section>

          <div className="decision-complete-actions">
            <button
              className="primary-button decision-next-button"
              type="button"
              disabled={queueLoading || queueUnavailable || !nextApplication}
              onClick={() => nextApplication && onReviewNext(nextApplication.id)}
            >{queueLoading ? "Checking review queue…" : queueUnavailable ? "Review Queue Unavailable" : nextApplication ? "Review Next Application" : "No Pending Applications"}</button>
            <button className="outline-button decision-dashboard-button" type="button" onClick={onDashboard}>Back to Dashboard</button>
          </div>
          {error && <p className="decision-queue-note" role="alert">{error}</p>}
          {!queueLoading && queueUnavailable && <p className="decision-queue-note" role="status">Could not check the review queue. Return to the dashboard to refresh it.</p>}
          {!queueLoading && !queueUnavailable && !nextApplication && <p className="decision-queue-note">You’re all caught up. There are no other applications ready for review.</p>}
        </main>
      </div>
      <BottomNavigation active="Applications" onHome={onDashboard} onApplications={onUpload} onScan={onUpload} />
    </div>
  );
}

function App() {
  const [application, setApplication] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [screen, setScreen] = useState("Home");
  const [selectedFindingId, setSelectedFindingId] = useState(null);
  const [fixture, setFixture] = useState(DEFAULT_FIXTURE);
  const [files, setFiles] = useState({});
  const [referenceLabel, setReferenceLabel] = useState("");
  const [fileError, setFileError] = useState("");
  const [pendingApplications, setPendingApplications] = useState([]);
  const [checkApplicationId, setCheckApplicationId] = useState(null);
  const [aiCheckError, setAiCheckError] = useState("");
  const [checkStartedAt, setCheckStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [draggingDocument, setDraggingDocument] = useState(null);
  const [reviewerNote, setReviewerNote] = useState("");
  const [findingUpdating, setFindingUpdating] = useState("");
  const [findingUpdateMessage, setFindingUpdateMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [splashStatus, setSplashStatus] = useState("loading");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [session, setSession] = useState(() => readSession());
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotMessage, setForgotMessage] = useState(false);
  const [showFindingDetailMobile, setShowFindingDetailMobile] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [decisionTimestamp, setDecisionTimestamp] = useState(null);
  const [pendingDecision, setPendingDecision] = useState(null);
  const decisionCancelRef = useRef(null);
  const decisionConfirmRef = useRef(null);
  const decisionTriggerRef = useRef(null);

  const selectedFinding = useMemo(
    () => application?.findings.find((finding) => finding.finding_id === selectedFindingId) ?? application?.findings[0] ?? null,
    [application, selectedFindingId],
  );
  const decision = application ? nextOutcome(application) : "locked";

  useEffect(() => {
    if (!pendingDecision) {
      decisionTriggerRef.current?.focus();
      decisionTriggerRef.current = null;
      return undefined;
    }

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    decisionCancelRef.current?.focus();
    function handleDialogKeyDown(event) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setPendingDecision(null);
      } else if (event.key === "Tab") {
        const first = decisionCancelRef.current;
        const last = decisionConfirmRef.current;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    window.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      window.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [pendingDecision, busy]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const startedAt = Date.now();
    setSplashStatus("loading");
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (active) setSplashStatus("error");
    }, 8000);

    async function checkServer() {
      try {
        const lguId = session?.user?.lgu_id ?? DEFAULT_LGU_ID;
        const response = await apiFetch(`/api/lgus/${encodeURIComponent(lguId)}/requirements`, { signal: controller.signal });
        if (!response.ok) throw new Error("Requirements check failed.");
        const data = await response.json();
        const remaining = Math.max(0, 1500 - (Date.now() - startedAt));
        await new Promise((resolve) => window.setTimeout(resolve, remaining));
        if (active && !timedOut) {
          setRequirements(data);
          setSplashStatus("ready");
        }
      } catch {
        if (active && !timedOut) setSplashStatus("error");
      } finally {
        window.clearTimeout(timeout);
      }
    }

    checkServer();

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [retryAttempt, session?.user?.lgu_id]);

  useEffect(() => {
    if (!MOCK_MODE) return undefined;
    let active = true;
    apiFetch(`/api/applications/app-${DEFAULT_FIXTURE}`)
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
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (screen !== "Upload") return undefined;
    let active = true;
    apiFetch("/api/applications")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load pending applications.");
        return response.json();
      })
      .then((items) => {
        if (active) setPendingApplications(items.filter((item) => item.status === "ready_for_review"));
      })
      .catch(() => {
        if (active) setPendingApplications([]);
      });
    return () => { active = false; };
  }, [screen]);

  useEffect(() => {
    if (screen !== "AI Check" || !checkStartedAt || !busy) return undefined;
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - checkStartedAt) / 1000));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [screen, checkStartedAt, busy]);

  useEffect(() => {
    setReviewerNote(selectedFinding?.reviewer_note ?? "");
    setNoteError("");
  }, [application?.id, selectedFinding?.finding_id]);

  useEffect(() => {
    if (!application || !["approved", "returned"].includes(application.status)) {
      setDecisionTimestamp(null);
      return undefined;
    }
    let active = true;
    const action = application.status === "approved" ? "application_approved" : "application_returned";
    apiFetch("/api/activity?limit=100")
      .then((response) => response.ok ? response.json() : [])
      .then((items) => {
        if (!active) return;
        const entry = items.find((item) => item.application_id === application.id && item.action === action);
        setDecisionTimestamp(entry?.timestamp ?? null);
      })
      .catch(() => { if (active) setDecisionTimestamp(null); });
    return () => { active = false; };
  }, [application?.id, application?.status]);

  async function request(url, options = {}) {
    const response = await apiFetch(url, options);
    const body = await response.text();
    let data = null;
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        if (response.ok) throw new Error("The server returned an invalid response.");
      }
    }
    if (!response.ok) throw new Error(data?.error ?? (body || "The request could not be completed."));
    return data;
  }

  async function processApplication(id) {
    const processed = await request(`/api/applications/${id}/process`, { method: "POST" });
    setApplication(processed);
    setFindingUpdateMessage("");
    setSelectedFindingId(processed.findings[0]?.finding_id ?? null);
    setScreen("Findings");
  }

  function acceptFile(document, file) {
    setFileError("");
    if (!file) return;
    const isPdf = file.name.toLowerCase().endsWith(".pdf") && (!file.type || file.type === "application/pdf");
    if (!isPdf) {
      setFileError("Please choose a PDF file for each document slot.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setFileError("Each PDF must be 20 MB or smaller.");
      return;
    }
    setFiles((current) => ({ ...current, [document]: file }));
  }

  function removeFile(document) {
    setFiles((current) => ({ ...current, [document]: null }));
    setFileError("");
  }

  async function submitApplication(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setAiCheckError("");
    setCheckApplicationId(null);
    setCheckStartedAt(Date.now());
    setElapsedSeconds(0);
    setScreen("AI Check");
    let createdId = null;
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
        formData.set("lgu_id", session?.user?.lgu_id ?? DEFAULT_LGU_ID);
        formData.set("label", referenceLabel.trim() || "Business Permit Application");
        for (const [document] of DOCUMENTS) {
          const file = files[document];
          if (!file) continue;
          formData.append("document_types[]", document);
          formData.append("files", file);
        }
        created = await request("/api/applications", { method: "POST", body: formData });
      }
      createdId = created.id;
      setCheckApplicationId(created.id);
      await processApplication(created.id);
    } catch (cause) {
      if (createdId) setAiCheckError(cause.message);
      else {
        setScreen("Upload");
        setFileError(cause.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryProcessing() {
    if (!checkApplicationId) return;
    setAiCheckError("");
    setBusy(true);
    setCheckStartedAt(Date.now());
    setElapsedSeconds(0);
    try {
      await processApplication(checkApplicationId);
    } catch (cause) {
      setAiCheckError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateFinding(status) {
    if (!application || !selectedFinding) return;
    if (["dismissed", "escalated"].includes(status) && !reviewerNote.trim()) {
      setNoteError("Add a reviewer note before dismissing or escalating this finding.");
      return;
    }
    setNoteError("");
    setFindingUpdateMessage("");
    setFindingUpdating(status);
    setBusy(true);
    setError("");
    try {
      const updated = await request(`/api/applications/${application.id}/findings/${selectedFinding.finding_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, reviewer_note: reviewerNote }),
      });
      const nextFindings = application.findings.map((finding) => finding.finding_id === updated.finding_id ? updated : finding);
      setApplication((current) => ({ ...current, findings: nextFindings }));
      const unresolved = nextFindings.filter((finding) => ["open", "escalated"].includes(finding.status));
      const actionLabel = status.charAt(0).toUpperCase() + status.slice(1);
      if (unresolved.length === 0) {
        setFindingUpdateMessage(`${actionLabel} saved. All findings are reviewed. Opening the decision.`);
        setShowFindingDetailMobile(false);
        setScreen("Outcome");
      } else {
        const nextFinding = unresolved.find((finding) => finding.finding_id !== updated.finding_id);
        if (nextFinding) {
          setSelectedFindingId(nextFinding.finding_id);
          setShowFindingDetailMobile(true);
          setFindingUpdateMessage(`${actionLabel} saved. ${unresolved.length} finding${unresolved.length === 1 ? "" : "s"} still need review.`);
        } else {
          setFindingUpdateMessage("Finding escalated. Resolve it before making a final decision.");
        }
      }
    } catch (cause) {
      setError(cause.message);
    } finally {
      setFindingUpdating("");
      setBusy(false);
    }
  }

  function requestDecision(outcome, event) {
    if (!application || busy) return;
    decisionTriggerRef.current = event.currentTarget;
    setPendingDecision(outcome);
  }

  async function decide() {
    const outcome = pendingDecision;
    if (!application || !outcome || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await request(`/api/applications/${application.id}/${outcome}`, { method: "POST" });
      setApplication(updated);
      setDecisionTimestamp(new Date().toISOString());
      setScreen("Decision Complete");
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
      setPendingDecision(null);
    }
  }

  async function openApplication(id) {
    setBusy(true);
    setError("");
    try {
      const selected = await request(`/api/applications/${id}`);
      setApplication(selected);
      setDecisionTimestamp(null);
      setFindingUpdateMessage("");
      setSelectedFindingId(selected.findings[0]?.finding_id ?? null);
      setShowFindingDetailMobile(false);
      setScreen("Findings");
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  const uploaded = new Set(application?.documents.map((document) => document.document) ?? []);
  const flowScreen = ["Upload", "AI Check"].includes(screen);
  const reviewScreen = ["Findings", "Extracted Fields", "Requirements", "Outcome"].includes(screen);
  const finalDecision = ["approved", "returned"].includes(application?.status);
  const requiredDocuments = requirements?.required_documents ?? [];
  const submittedRequiredCount = requiredDocuments.filter((item) => uploaded.has(item.document)).length;
  const requiredCompletion = requiredDocuments.length ? Math.round((submittedRequiredCount / requiredDocuments.length) * 100) : 0;

  async function signIn(event) {
    event.preventDefault();
    setLoginError("");
    if (!loginEmail.trim() || !loginPassword) {
      setLoginError("Enter your email and password.");
      return;
    }
    setLoginBusy(true);
    try {
      const response = await window.fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not sign in. Please try again.");
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: data.token, user: data.user }));
      setLoginPassword("");
      setSession({ token: data.token, user: data.user });
    } catch (cause) {
      setLoginError(cause.message);
    } finally {
      setLoginBusy(false);
    }
  }

  function signOut() {
    clearSession();
    window.location.reload();
  }

  if (splashStatus !== "ready") {
    return (
      <main className="splash-screen" aria-live="polite">
        <svg className="splash-wave splash-wave-top" viewBox="0 0 430 190" preserveAspectRatio="none" aria-hidden="true">
          <path className="wave-navy" d="M0 0h430v62C333 105 248 87 174 111 97 137 49 174 0 190Z" />
          <path className="wave-orange" d="M0 161C87 105 138 104 206 89c73-16 145-9 224-43v9c-76 33-148 26-222 42C139 113 86 114 0 173Z" />
        </svg>
        <svg className="splash-wave splash-wave-bottom" viewBox="0 0 430 150" preserveAspectRatio="none" aria-hidden="true">
          <path className="wave-orange" d="M0 98c90 28 155 17 220-1 74-20 127-28 210-68v121H0Z" />
          <path className="wave-navy" d="M0 117c90 24 154 13 222-4 76-19 128-29 208-65v102H0Z" />
        </svg>
        <section className="splash-content">
          <img className="splash-logo" src={logo} alt="KalaBASA" />
          <p className="splash-tagline">Smarter Review. Faster Service.</p>
          {splashStatus === "loading" ? (
            <>
              <span className="splash-spinner" role="status" aria-label="Loading" />
              <p className="splash-status">Initializing KalaBASA...</p>
            </>
          ) : (
            <div className="splash-error" role="alert">
              <p>Can't reach the server</p>
              <button type="button" onClick={() => setRetryAttempt((attempt) => attempt + 1)}>Retry</button>
            </div>
          )}
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="login-screen">
        <div className="login-decoration login-decoration-top" aria-hidden="true" />
        <div className="login-decoration login-decoration-bottom" aria-hidden="true" />
        <section className="login-content" aria-labelledby="login-heading">
          <header className="login-brand">
            <img src={logo} alt="KalaBASA" />
            <p>Smarter Review. Faster Service.</p>
          </header>

          <div className="login-intro">
            <h1 id="login-heading">Welcome Back, Reviewer!</h1>
            <p>Sign in to continue reviewing business permit applications.</p>
          </div>

          <form className="login-form" noValidate onSubmit={signIn}>
            <label className="login-field">
              <span>Email</span>
              <input type="email" name="email" autoComplete="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} />
            </label>
            <label className="login-field">
              <span>Password</span>
              <span className="login-password-input">
                <input type={showPassword ? "text" : "password"} name="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} />
                <button className="password-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((visible) => !visible)}>
                  {showPassword ? "Hide" : "Show"}
                </button>
              </span>
            </label>
            <div className="login-options">
              <a href="#forgot-password" onClick={(event) => { event.preventDefault(); setForgotMessage(true); }}>Forgot password?</a>
            </div>
            {forgotMessage && <p className="forgot-message" role="status">Ask your system administrator to reset your password.</p>}
            {loginError && <p className="login-error" role="alert">{loginError}</p>}
            <button className="login-submit" type="submit" disabled={loginBusy}>{loginBusy ? "Signing in..." : "Sign In"}</button>
          </form>

          <p className="login-help">Need help? Contact your system administrator.</p>
        </section>
      </main>
    );
  }

  if (screen === "Home") {
    return <HomeScreen onUpload={() => setScreen("Upload")} onOpenApplication={openApplication} user={session.user} onSignOut={signOut} />;
  }

  if (screen === "Decision Complete" && application) {
    return <DecisionCompleteScreen
      application={application}
      requirements={requirements}
      user={session.user}
      decisionTimestamp={decisionTimestamp}
      error={error}
      screen={screen}
      onNavigate={setScreen}
      onDashboard={() => setScreen("Home")}
      onUpload={() => setScreen("Upload")}
      onReviewNext={openApplication}
    />;
  }

  return (
    <div className={`app-shell ${flowScreen ? "review-flow-shell" : ""} ${reviewScreen ? "review-screen-shell" : ""}`}>
      {flowScreen ? (
        <header className="flow-header">
          <div className="flow-header-art" aria-hidden="true" />
          <button className="flow-back" type="button" aria-label="Back to Home" onClick={() => setScreen("Home")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h11" /></svg>
          </button>
          <div className="flow-header-title">AI-Assisted <span>Review</span></div>
          <button className="flow-notifications" type="button" aria-label="Notifications" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
            <i />
          </button>
        </header>
      ) : reviewScreen ? (
        <header className="review-header">
          <button className="review-back" type="button" onClick={() => setScreen("Home")} aria-label="Back to Home">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <div className="review-header-copy">
            <strong>{application?.label || application?.id || "Application review"}</strong>
            {application?.label && <small>{application.id}</small>}
          </div>
          <span className={`review-header-status ${finalDecision ? "final" : ""}`}>{application?.status?.replaceAll("_", " ") ?? "No application"}</span>
          {MOCK_MODE && <span className="demo-badge"><span />Demo mode / mocked data</span>}
        </header>
      ) : (
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
      )}

      <div className={`workspace ${flowScreen ? "flow-workspace" : ""} ${reviewScreen ? "review-workspace" : ""}`}>
        {!flowScreen && !reviewScreen && <aside className="sidebar">
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
        </aside>}

        <main className={`main-content ${flowScreen ? "flow-main" : ""} ${reviewScreen ? "review-main" : ""}`}>
          {(flowScreen || reviewScreen) && (
            <nav className="review-stepper" aria-label="AI-assisted review steps">
              {["Upload", "AI Check", "Review"].map((step, index) => {
                const activeIndex = screen === "Upload" ? 0 : screen === "AI Check" || screen === "Requirements" || screen === "Extracted Fields" ? 1 : 2;
                return <span className={`review-step ${index === activeIndex ? "active" : index < activeIndex ? "complete" : ""}`} key={step}>
                  <i>{index < activeIndex ? "✓" : index + 1}</i>{step}
                </span>;
              })}
            </nav>
          )}
          {reviewScreen && <nav className="review-tabs" aria-label="Application review sections">
            {[ ["Findings", "Findings"], ["Extracted Fields", "Extracted Fields"], ["Requirements", "Requirements"], ["Outcome", "Decision"] ].map(([value, label]) => (
              <button type="button" key={value} className={screen === value ? "active" : ""} aria-current={screen === value ? "page" : undefined} onClick={() => setScreen(value)}>{label}</button>
            ))}
          </nav>}
          {!flowScreen && !reviewScreen && <div className="page-heading">
            <div>
              <div className="eyebrow">{requirements?.lgu.name ?? "City Business Permits Office"}</div>
              <h1>{screen}</h1>
              <p>{application?.label ?? "Review supporting documents and extracted information."}</p>
            </div>
            {application && <div className="application-id">APPLICATION <strong>{application.id}</strong></div>}
          </div>}

          {flowScreen && <p className="flow-intro">{screen === "Upload" ? "Upload or select an application to start the AI-powered document check." : screen === "AI Check" ? "Your application is being checked against its required documents." : application?.label}</p>}

          {reviewScreen && finalDecision && <div className="final-decision-banner" role="status">
            <span className="final-decision-check" aria-hidden="true">✓</span>
            <span><strong>Decision recorded</strong><small>{formattedDecisionTime(decisionTimestamp) || "Final decision saved"} · {application.status}</small></span>
          </div>}

          {error && <div className="error-banner" role="alert">{error}</div>}
          {findingUpdateMessage && <div className="finding-update-message" role="status">{findingUpdateMessage}</div>}

          {screen === "Upload" && (
            <section className="card upload-card">
              <div className="card-heading">
                <div><h2>Upload application documents</h2><p>Select the documents you have. You can continue with missing documents.</p></div>
              </div>
              <form onSubmit={submitApplication}>
                {!MOCK_MODE && <label className="reference-field">Reference / label <span>Optional</span>
                  <input value={referenceLabel} onChange={(event) => setReferenceLabel(event.target.value)} placeholder="BP-2026-0001" />
                </label>}
                {MOCK_MODE ? (
                  <div className="demo-upload-notice">
                    <strong>Demo mode: your files are not read. A sample application is loaded instead.</strong>
                    <label className="field-label">Sample application
                      <select value={fixture} onChange={(event) => setFixture(event.target.value)}>
                        {FIXTURES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                      </select>
                    </label>
                  </div>
                ) : (
                  <div className="document-slots">
                    {DOCUMENTS.map(([document, label]) => {
                      const file = files[document];
                      const sizeLabel = file ? file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB` : "PDF, up to 20 MB each";
                      return <article
                        className={`document-slot ${draggingDocument === document ? "dragging" : ""} ${file ? "has-file" : ""}`}
                        key={document}
                        onDragOver={(event) => { event.preventDefault(); setDraggingDocument(document); }}
                        onDragLeave={() => setDraggingDocument(null)}
                        onDrop={(event) => { event.preventDefault(); setDraggingDocument(null); acceptFile(document, event.dataTransfer.files?.[0]); }}
                      >
                        <span className="document-slot-icon" aria-hidden="true">PDF</span>
                        <div className="document-slot-copy">
                          <label htmlFor={`file-${document}`}>{label}</label>
                          <small>{file ? `${file.name} · ${sizeLabel}` : sizeLabel}</small>
                        </div>
                        <label className="choose-pdf">
                          Choose PDF
                          <input className="document-file-input" id={`file-${document}`} type="file" accept="application/pdf,.pdf" onChange={(event) => { acceptFile(document, event.target.files?.[0]); event.target.value = ""; }} />
                        </label>
                        {file && <button className="remove-file" type="button" onClick={() => removeFile(document)}>Remove</button>}
                      </article>;
                    })}
                  </div>
                )}
                {fileError && <p className="upload-file-error" role="alert">{fileError}</p>}
                <div className="form-actions">
                  <p>Missing documents will be flagged for the reviewer.</p>
                  <button className="primary-button start-ai-button" type="submit" disabled={busy || (!MOCK_MODE && !Object.values(files).some(Boolean))}>
                    Start AI Check <span aria-hidden="true">→</span>
                  </button>
                </div>
              </form>
            </section>
          )}

          {screen === "Upload" && pendingApplications.length > 0 && (
            <section className="pending-applications card">
              <div className="card-heading"><div><h2>Or select a pending application</h2><p>Open a case that is already ready for review.</p></div></div>
              <ul>{pendingApplications.map((item) => <li key={item.id}>
                <span><strong>{item.label}</strong><small>{item.id}</small></span>
                <button type="button" onClick={() => openApplication(item.id)}>Open</button>
              </li>)}</ul>
            </section>
          )}

          {screen === "AI Check" && (
            <section className="ai-check-card card" aria-live="polite">
              {!aiCheckError && <span className="splash-spinner ai-check-spinner" role="status" aria-label="Loading" />}
              <h2>{aiCheckError ? "AI Check stopped" : MOCK_MODE ? "Loading sample review" : "Reading your documents"}</h2>
              <p className="ai-check-description">{MOCK_MODE ? "Preparing the selected demo application." : "KalaBASA is checking the documents you selected."}</p>
              <ul className="reading-documents">
                {MOCK_MODE ? <li><span className="reading-dot" />{FIXTURES.find(([value]) => value === fixture)?.[1] ?? fixture} sample</li> :
                  DOCUMENTS.filter(([document]) => files[document]).map(([document, label]) => <li key={document}><span className="reading-dot" />{label}<small>{files[document].name}</small></li>)}
              </ul>
              <p className="elapsed-time">Elapsed: {elapsedSeconds} seconds</p>
              {elapsedSeconds > 60 && !aiCheckError && <p className="long-check-note">Still working. Scanned pages take longer.</p>}
              {aiCheckError && <div className="ai-check-error" role="alert">{aiCheckError}</div>}
              {aiCheckError && <div className="ai-check-actions">
                <button className="primary-button" type="button" onClick={retryProcessing} disabled={busy}>Retry</button>
                <button className="outline-button" type="button" onClick={() => { setAiCheckError(""); setScreen("Upload"); }}>Back to upload</button>
              </div>}
            </section>
          )}
          {screen === "Requirements" && (
            <section className="card">
              <div className="card-heading"><div><h2>Required documents</h2><p>Checklist status based on documents uploaded with this application.</p></div></div>
              {requirements && <div className="requirements-summary">
                <div><strong>{submittedRequiredCount} of {requiredDocuments.length} required documents submitted</strong><span>{requiredCompletion}%</span></div>
                <div className="requirements-progress"><i style={{ width: `${requiredCompletion}%` }} /></div>
              </div>}
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
              {requirements && <div className="review-next-action"><button className="primary-button" type="button" onClick={() => setScreen("Extracted Fields")}>View Extracted Fields <span aria-hidden="true">→</span></button></div>}
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
              {application?.fields.length > 0 && <div className="review-next-action"><button className="primary-button" type="button" onClick={() => setScreen("Findings")}>View Findings ({application.findings.length}) <span aria-hidden="true">→</span></button></div>}
            </section>
          )}

          {screen === "Findings" && (
            <>
            <section className="review-summary-strip">
              <div className="review-summary-count">{application?.findings.length ?? 0}</div>
              <div><strong>{application?.findings.length ? `${application.findings.length} findings need your review` : "No findings need review"}</strong><small>{submittedRequiredCount} of {requiredDocuments.length} required documents submitted</small></div>
            </section>
            <div className={`findings-layout ${showFindingDetailMobile ? "show-detail-mobile" : ""}`}>
              <section className="card finding-list">
                <div className="card-heading"><div><h2>Review findings</h2><p>Each finding includes supporting document evidence.</p></div></div>
                <div className="finding-counts" aria-label="Finding status counts">
                  {[["open", "Open"], ["confirmed", "Confirmed"], ["dismissed", "Dismissed"], ["escalated", "Escalated"]].map(([status, label]) => (
                    <span className={`finding-count count-${status}`} key={status}><strong>{application?.findings.filter((finding) => finding.status === status).length ?? 0}</strong>{label}</span>
                  ))}
                </div>
                {application?.findings.length ? application.findings.map((finding) => (
                  <button
                    className={`finding-item ${selectedFinding?.finding_id === finding.finding_id ? "selected" : ""}`}
                    key={finding.finding_id}
                    onClick={() => { setSelectedFindingId(finding.finding_id); setShowFindingDetailMobile(true); setFindingUpdateMessage(""); }}
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
                <button className="mobile-finding-back" type="button" onClick={() => { setShowFindingDetailMobile(false); setFindingUpdateMessage(""); }}>← <span>Back to findings</span></button>
                <div className="detail-eyebrow">{selectedFinding.rule_id} <span>·</span> {selectedFinding.type.replaceAll("_", " ")}</div>
                <h2>{selectedFinding.field.replaceAll("_", " ")}</h2>
                <p className="detail-message">{selectedFinding.message}</p>
                <h3>Evidence</h3>
                {selectedFinding.type === "cross_document_mismatch" && <p className="difference-caption">Highlighted differences (visual aid only)</p>}
                <div className={`evidence-list ${selectedFinding.type === "cross_document_mismatch" ? "mismatch-evidence-list" : ""}`}>
                  {selectedFinding.evidence.map((evidence, index) => {
                    const fieldForEvidence = application.fields.find((field) =>
                      field.field === selectedFinding.field && field.document === evidence.document && field.page === evidence.page && field.source_text === evidence.source_text);
                    const matchedField = application.fields.find((field) =>
                      field.document === evidence.document && field.page === evidence.page && field.source_text === evidence.source_text && !field.verified);
                    const otherEvidenceTexts = selectedFinding.evidence
                      .filter((item, itemIndex) => itemIndex !== index && item.source_text)
                      .map((item) => item.source_text);
                    return <article className="evidence-card" key={`${evidence.document}-${evidence.page}-${index}`}>
                      <div className="evidence-meta"><strong>{evidence.document.replaceAll("_", " ")}</strong><span>Page {evidence.page}</span></div>
                      {evidence.source_text
                        ? <blockquote>{selectedFinding.type === "cross_document_mismatch"
                          ? highlightWordDifferences(evidence.source_text, otherEvidenceTexts)
                          : textWithHighlight(evidence.source_text, fieldForEvidence?.value)}</blockquote>
                        : <div className="evidence-absence">{evidence.note ?? "No source text was available for this absence."}</div>}
                      {evidence.source_text && evidence.note && <div className="evidence-note">{evidence.note}</div>}
                      {matchedField && <div className="unverified-evidence-warning">This value could not be confirmed in the source. Check the document.</div>}
                    </article>;
                  })}
                </div>
                <label className="field-label note-label">Reviewer note
                  <textarea value={reviewerNote} onChange={(event) => { setReviewerNote(event.target.value); setNoteError(""); }} placeholder="Add a note for the review record…" rows="3" disabled={finalDecision} />
                </label>
                {noteError && <p className="note-error" role="alert">{noteError}</p>}
                <div className="review-actions">
                  <button className="outline-button" disabled={busy || finalDecision} aria-busy={findingUpdating === "confirmed"} onClick={() => updateFinding("confirmed")}>{findingUpdating === "confirmed" ? "Saving…" : "Confirm"}</button>
                  <button className="outline-button" disabled={busy || finalDecision} aria-busy={findingUpdating === "dismissed"} onClick={() => updateFinding("dismissed")}>{findingUpdating === "dismissed" ? "Saving…" : "Dismiss"}</button>
                  <button className="outline-button" disabled={busy || finalDecision} aria-busy={findingUpdating === "escalated"} onClick={() => updateFinding("escalated")}>{findingUpdating === "escalated" ? "Saving…" : "Escalate"}</button>
                </div>
              </section>}
            </div>
            </>
          )}

          {screen === "Outcome" && (
            <section className="card outcome-card">
              <div className={`outcome-icon ${application?.status === "approved" ? "approved" : application?.status === "returned" ? "returned" : ""}`}>
                {application?.status === "approved" ? "✓" : application?.status === "returned" ? "↩" : "…"}
              </div>
              <div className="outcome-copy">
                <span className="eyebrow">REVIEWER DECISION</span>
                <h2>{application?.status === "approved" ? "Application approved" : application?.status === "returned" ? "Application returned" : "Decision pending"}</h2>
                <p>{finalDecision
                  ? "This application already has a final decision. It cannot be changed."
                  : decision === "approve"
                    ? "All findings are dismissed or none were raised. You may approve this application."
                    : decision === "return"
                      ? "At least one finding is confirmed and all findings are resolved. You may return this application for correction."
                      : "Open or escalated findings must be resolved before a final decision."}</p>
                {!finalDecision && <div className="outcome-actions">
                  <button className="primary-button" disabled={busy || decision !== "approve"} onClick={(event) => requestDecision("approve", event)}>Approve application</button>
                  <button className="outline-button" disabled={busy || decision !== "return"} aria-describedby={decision === "locked" || decision === "approve" ? "return-decision-guidance" : undefined} onClick={(event) => requestDecision("return", event)}>Return for correction</button>
                </div>}
                {!finalDecision && decision !== "return" && <p className="outcome-guidance" id="return-decision-guidance">
                  {decision === "locked"
                    ? "To return this application, confirm at least one finding and resolve every other open or escalated finding."
                    : "To return this application, mark at least one finding Confirmed. Dismissing every finding enables approval instead."}
                </p>}
              </div>
            </section>
          )}

          {screen === "Outcome" && application?.findings?.length > 0 && <section className="card decision-findings">
            <div className="card-heading"><div><h2>Finding review record</h2><p>Status and saved reviewer notes for every finding.</p></div></div>
            <ul>{application.findings.map((finding) => <li key={finding.finding_id}>
              <span className={`decision-status status-${finding.status}`}>{finding.status.replaceAll("_", " ")}</span>
              <span className="decision-finding-copy"><strong>{finding.field.replaceAll("_", " ")}</strong><small>{finding.message}</small></span>
              <span className="decision-reviewer-note">{finding.reviewer_note || "No reviewer note"}</span>
            </li>)}</ul>
          </section>}

          {!application && screen !== "Upload" && <div className="card empty-card"><p className="empty-state">Load an application first to view this section.</p></div>}

          {application && <footer className="review-disclaimer">
            <span className="disclaimer-icon">i</span>
            <span>Automated checks support the review only. The reviewer makes the final decision.</span>
            <button onClick={() => setScreen("Outcome")}>Go to outcome <span aria-hidden="true">→</span></button>
          </footer>}
        </main>
      </div>
      <BottomNavigation
        active={screen === "Home" ? "Home" : "Applications"}
        onHome={() => setScreen("Home")}
        onApplications={() => setScreen("Upload")}
        onScan={() => setScreen("Upload")}
      />
      {pendingDecision && <div
        className="decision-dialog-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setPendingDecision(null);
        }}
      >
        <section
          className="decision-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="decision-dialog-title"
          aria-describedby="decision-dialog-description"
        >
          <div className={`decision-dialog-icon ${pendingDecision}`} aria-hidden="true">
            {pendingDecision === "approve" ? "✓" : "↩"}
          </div>
          <span className="eyebrow">FINAL DECISION</span>
          <h2 id="decision-dialog-title">{pendingDecision === "approve" ? "Approve this application?" : "Return this application?"}</h2>
          <p id="decision-dialog-description">
            {pendingDecision === "approve"
              ? `This will approve ${application?.label || "this application"}. You cannot change the decision afterward.`
              : `This will return ${application?.label || "this application"} for correction. You cannot change the decision afterward.`}
          </p>
          <div className="decision-dialog-actions">
            <button
              ref={decisionCancelRef}
              className="outline-button"
              type="button"
              disabled={busy}
              onClick={() => setPendingDecision(null)}
            >Cancel</button>
            <button
              ref={decisionConfirmRef}
              className={`primary-button decision-dialog-confirm ${pendingDecision}`}
              type="button"
              disabled={busy}
              onClick={decide}
            >{busy ? "Saving decision…" : pendingDecision === "approve" ? "Confirm approval" : "Confirm return"}</button>
          </div>
        </section>
      </div>}
    </div>
  );
}

export default App;
