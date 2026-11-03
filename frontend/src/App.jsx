import { useEffect, useMemo, useState } from "react";
import logo from "../../design/splash/KalaBASA (4).png";
import DocumentScanner from "./scanner/DocumentScanner.jsx";
import Reports from "./Reports.jsx";
import Profile from "./Profile.jsx";
import { SettingsProvider, useSettings } from "./settings.jsx";

const MOCK_MODE = import.meta.env.MOCK_MODE === true;
const AUTH_DISABLED = import.meta.env.AUTH_DISABLED === true;

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
  let response;
  try {
    response = await window.fetch(url, { ...options, headers });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the KalaBASA API. Keep `npm run start:api` running, then check http://localhost:3000/api/health. On phone testing, also confirm your HTTPS tunnel is still open.");
    }
    throw error;
  }
  if (response.status === 401 && session) {
    clearSession();
    window.location.reload();
  }
  return response;
}
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
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
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

function greetingForNow() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning, Reviewer!";
  if (hour < 18) return "Good afternoon, Reviewer!";
  return "Good evening, Reviewer!";
}

const iconArtwork = {
  "arrow-left": <path d="M19 12H5m7 7-7-7 7-7" />,
  "arrow-right": <path d="M5 12h14m-7-7 7 7-7 7" />,
  check: <path d="m5 12 4.2 4.2L19 6.5" />,
  alert: <><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 3h.01" /></>,
  return: <><path d="M9 14 4 9l5-5" /><path d="M4 9h9a6 6 0 0 1 6 6v1" /></>,
  upload: <><path d="M12 15V4m-4 4 4-4 4 4" /><path d="M5 14v5h14v-5" /></>,
  file: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h4M10 13h5M10 17h5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
};

function Icon({ name, size = 18, className = "" }) {
  return <svg className={`app-icon ${className}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{iconArtwork[name]}</svg>;
}

function activityIconName(item) {
  if (item.action === "application_approved") return "check";
  if (item.action === "application_returned") return "return";
  if (item.action === "finding_updated" || item.text === "Inconsistency flagged") return "alert";
  return "upload";
}

function fileExtension(file) {
  return file?.name?.split(".").pop()?.toLowerCase() ?? "";
}

function fileTypeLabel(file) {
  const extension = fileExtension(file);
  return extension === "jpeg" ? "JPEG" : extension.toUpperCase();
}

function FilePreview({ file }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const extension = fileExtension(file);
  const isImage = ["jpg", "jpeg", "png"].includes(extension);
  useEffect(() => {
    if (!isImage) return undefined;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  if (!isImage) return <span className="file-preview-pdf"><Icon name="file" size={17} />PDF</span>;
  return previewUrl
    ? <img className="file-preview-image" src={previewUrl} alt={`Preview of ${file.name}`} />
    : <span className="file-preview-image-placeholder" aria-hidden="true"><Icon name="file" size={17} /></span>;
}

function timeAgo(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function BottomNavigation({ active, onHome, onApplications, onScan, onReports, onProfile }) {
  return (
    <nav className="bottom-navigation" aria-label="Main navigation">
      <button className={active === "Home" ? "active" : ""} type="button" onClick={onHome} aria-current={active === "Home" ? "page" : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m3.5 10 8.5-7 8.5 7v10a.8.8 0 0 1-.8.8h-5.4v-6.3h-4.6v6.3H4.3a.8.8 0 0 1-.8-.8z" /></svg>Home
      </button>
      <button className={active === "Applications" ? "active" : ""} type="button" onClick={onApplications} aria-current={active === "Applications" ? "page" : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /></svg>Applications
      </button>
      <button className="scan-nav-action" type="button" aria-label="Open document scanner" onClick={onScan}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2m8 0h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2m-8 0H6a2 2 0 0 1-2-2v-2"/><path d="M8 9h8a2 2 0 0 1 2 2v4H6v-4a2 2 0 0 1 2-2Z"/><circle cx="12" cy="12" r="1.5"/></svg>
      </button>
      <button className={active === "Reports" ? "active" : ""} type="button" onClick={onReports} aria-current={active === "Reports" ? "page" : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M7 16V9m5 7V4m5 12v-5" /></svg>Reports
      </button>
      <button className={active === "Profile" ? "active" : ""} type="button" onClick={onProfile} aria-current={active === "Profile" ? "page" : undefined}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>Profile
      </button>
    </nav>
  );
}

function HomeScreen({ onUpload, onReports, onProfile, onOpenApplication, user, onSignOut, scannerOpen, onOpenScanner, onCloseScanner, onConfirmScan }) {
  const [applications, setApplications] = useState([]);
  const [activity, setActivity] = useState([]);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [loadingAllActivity, setLoadingAllActivity] = useState(false);
  const [showAllApplications, setShowAllApplications] = useState(false);
  const [stats, setStats] = useState({ pending: 0, processed_today: 0, flagged: 0 });
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch("/api/applications").then((response) => {
        if (!response.ok) throw new Error("Could not load applications.");
        return response.json();
      }),
      apiFetch("/api/activity?limit=5").then((response) => {
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
  const suggestions = query.trim() ? filteredApplications.slice(0, 5) : [];
  const showSuggestions = searchFocused && query.trim().length > 0;
  const visibleActivity = showAllActivity ? activity : activity.slice(0, 5);
  const visibleApplications = showAllApplications ? filteredApplications : filteredApplications.slice(0, 5);

  function openApplication(application) {
    setQuery("");
    setSearchFocused(false);
    setActiveSuggestion(-1);
    onOpenApplication(application.id);
  }

  function handleSearchKeyDown(event) {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((active) => (active + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((active) => (active <= 0 ? suggestions.length - 1 : active - 1));
    } else if (event.key === "Enter" && suggestions.length > 0) {
      event.preventDefault();
      openApplication(suggestions[activeSuggestion >= 0 ? activeSuggestion : 0]);
    } else if (event.key === "Escape") {
      setSearchFocused(false);
      setActiveSuggestion(-1);
    }
  }

  async function toggleAllActivity() {
    if (showAllActivity) {
      setShowAllActivity(false);
      return;
    }
    setLoadingAllActivity(true);
    try {
      const response = await apiFetch("/api/activity?limit=5000");
      if (!response.ok) throw new Error("Could not load all activity.");
      setActivity(await response.json());
      setShowAllActivity(true);
    } catch {
      setLoadError("Could not load all activity. Please try again.");
    } finally {
      setLoadingAllActivity(false);
    }
  }

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
        <h1>{greetingForNow()}</h1>
        <p>Let’s make the permit process faster and more accurate.</p>
      </section>

      <div className={`home-search-wrap${showSuggestions ? " suggestions-open" : ""}`}>
        <div className="home-search">
          <svg className="search-icon" aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="10.8" cy="10.8" r="6.8" />
            <path d="m16 16 4.2 4.2" />
          </svg>
          <label className="visually-hidden" htmlFor="application-search">Search applications by ID or name</label>
          <input
            id="application-search"
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showSuggestions}
            aria-controls="application-search-suggestions"
            aria-activedescendant={activeSuggestion >= 0 ? `application-suggestion-${activeSuggestion}` : undefined}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveSuggestion(-1);
              setSearchFocused(true);
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => {
              setSearchFocused(false);
              setActiveSuggestion(-1);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search by applicant or application ID"
          />
          {query ? (
            <button className="search-clear" type="button" aria-label="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={() => {
              setQuery("");
              setActiveSuggestion(-1);
            }}>
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15" /></svg>
            </button>
          ) : (
            <span className="search-hint">ID or name</span>
          )}
        </div>
        {showSuggestions && (
          <div className="search-suggestions" id="application-search-suggestions" role="listbox" aria-label="Matching applications">
            {loading ? (
              <p className="search-suggestion-empty">Loading applications...</p>
            ) : suggestions.length > 0 ? suggestions.map((item, index) => (
              <button
                className={`search-suggestion${activeSuggestion === index ? " active" : ""}`}
                id={`application-suggestion-${index}`}
                key={item.id}
                type="button"
                role="option"
                aria-selected={activeSuggestion === index}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={() => openApplication(item)}
              >
                <span className="suggestion-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20"><path d="M5 2.8h6l4 4v10.4H5zM11 2.8v4h4M7.5 10h5M7.5 13h5" /></svg>
                </span>
                <span className="suggestion-copy"><strong>{item.label}</strong><small>{item.id}</small></span>
                <span className={`suggestion-status status-${item.status}`}>{item.status.replaceAll("_", " ")}</span>
              </button>
            )) : (
              <p className="search-suggestion-empty">No applications found. Try another name or ID.</p>
            )}
          </div>
        )}
      </div>

      <section className="home-stats" aria-label="Application statistics">
        <article className="home-stat pending-stat"><span className="stat-icon"><Icon name="file" /></span><strong>{stats.pending}</strong><span>Pending</span></article>
        <article className="home-stat processed-stat"><span className="stat-icon"><Icon name="check" /></span><strong>{stats.processed_today}</strong><span>Processed<br />Today</span></article>
        <article className="home-stat flagged-stat"><span className="stat-icon"><Icon name="alert" /></span><strong>{stats.flagged}</strong><span>Flagged</span></article>
      </section>

      <button className="home-upload-card" type="button" onClick={onUpload}>
        <span className="upload-art" aria-hidden="true"><Icon name="upload" size={24} /><i>AI</i></span>
        <span className="upload-copy"><strong>Let KalaBASA do the check</strong><small>Upload an application to get started.</small><small>AI-assisted review.</small></span>
        <span className="upload-arrow" aria-hidden="true"><Icon name="arrow-right" size={16} /></span>
      </button>

      {loadError && <p className="home-load-error" role="alert">{loadError}</p>}

      <section className="home-activity" aria-labelledby="recent-activity-heading">
        <div className="home-section-heading">
          <h2 id="recent-activity-heading">{showAllActivity ? "All Activity" : "Recent Activity"}</h2>
          <button className="activity-view-all" type="button" onClick={toggleAllActivity} disabled={loadingAllActivity}>
            {loadingAllActivity ? "Loading..." : showAllActivity ? "Show recent" : "View all"}
          </button>
        </div>
        {loading ? <p className="home-empty">Loading activity...</p> : activity.length === 0 ? (
          <p className="home-empty">No activity yet</p>
        ) : (
          <ol className="activity-list">
            {visibleActivity.map((item, index) => (
              <li className="activity-item" key={`${item.application_id}-${item.action}-${item.timestamp}-${index}`}>
                <span className={`activity-dot activity-${item.action}`}><Icon name={activityIconName(item)} size={15} /></span>
                <span className="activity-copy"><strong>{item.text}</strong><small>{applications.find((application) => application.id === item.application_id)?.label ?? item.application_id}</small></span>
                <time dateTime={item.timestamp}>{timeAgo(item.timestamp)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="home-applications" aria-labelledby="applications-heading">
        <div className="home-section-heading">
          <h2 id="applications-heading">Applications</h2>
          <span>{filteredApplications.length}</span>
          <button className="activity-view-all" type="button" onClick={() => setShowAllApplications((showAll) => !showAll)}>
            {showAllApplications ? "Show recent" : "View all"}
          </button>
        </div>
        {loading ? <p className="home-empty">Loading applications...</p> : filteredApplications.length === 0 ? (
          <p className="home-empty">No applications match your search.</p>
        ) : (
          <ul className="application-list">
            {visibleApplications.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => openApplication(item)}>
                  <span className="application-file-icon"><Icon name="file" size={16} /></span>
                  <span className="application-row-copy"><strong>{item.label}</strong><small>{item.id}</small></span>
                  <span className={`application-status status-${item.status}`}>{item.status.replaceAll("_", " ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BottomNavigation active="Home" onHome={() => {}} onApplications={onUpload} onScan={onOpenScanner} onReports={onReports} onProfile={onProfile} />
      {scannerOpen && <DocumentScanner onCancel={onCloseScanner} onConfirm={onConfirmScan} />}
    </main>
  );
}

function AppContent() {
  const { aiAutoCheck } = useSettings();
  const [application, setApplication] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [screen, setScreen] = useState("Home");
  const [selectedFindingId, setSelectedFindingId] = useState(null);
  const [fixture, setFixture] = useState(DEFAULT_FIXTURE);
  const [files, setFiles] = useState({});
  const [batchFiles, setBatchFiles] = useState([]);
  const [referenceLabel, setReferenceLabel] = useState("");
  const [fileError, setFileError] = useState("");
  const [pendingApplications, setPendingApplications] = useState([]);
  const [checkApplicationId, setCheckApplicationId] = useState(null);
  const [aiCheckError, setAiCheckError] = useState("");
  const [checkStartedAt, setCheckStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [documentProgress, setDocumentProgress] = useState({});
  const [draggingDocument, setDraggingDocument] = useState(null);
  const [reviewerNote, setReviewerNote] = useState("");
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
  const [decisionConfirmation, setDecisionConfirmation] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanNeedsManualCheck, setScanNeedsManualCheck] = useState(false);
  const [scannedDocumentType, setScannedDocumentType] = useState("");

  const selectedFinding = useMemo(
    () => application?.findings.find((finding) => finding.finding_id === selectedFindingId) ?? application?.findings[0] ?? null,
    [application, selectedFindingId],
  );
  const decision = outcomeFor(application);

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
        const response = await apiFetch("/api/lgus/bagong-dalisay-demo/requirements", { signal: controller.signal });
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
  }, [retryAttempt]);

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
    if (screen !== "AI Check" || !checkApplicationId || aiCheckError) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const response = await apiFetch(`/api/applications/${checkApplicationId}/progress`);
        if (!response.ok) return;
        const progress = await response.json();
        if (!active) return;
        setDocumentProgress(Object.fromEntries((progress.documents ?? []).map((item) => [item.document, item.status])));
      } catch {
        // Keep the last known status if a progress poll briefly fails.
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 700);
    return () => { active = false; window.clearInterval(interval); };
  }, [screen, checkApplicationId, aiCheckError]);

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
        setDecisionTimestamp(entry?.timestamp ?? application.updated_at ?? null);
      })
      .catch(() => { if (active) setDecisionTimestamp(application.updated_at ?? null); });
    return () => { active = false; };
  }, [application?.id, application?.status]);

  async function request(url, options = {}) {
    const response = await apiFetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "The request could not be completed.");
    return data;
  }

  async function processApplication(id) {
    const processed = await request(`/api/applications/${id}/process`, { method: "POST" });
    setApplication(processed);
    setSelectedFindingId(processed.findings[0]?.finding_id ?? null);
    setScreen("Findings");
  }

  function confirmScan({ documentType, file }) {
    if (files[documentType]) {
      setFileError(`Remove the existing ${DOCUMENTS.find(([type]) => type === documentType)?.[1] ?? documentType} file before adding a scan.`);
      setScannerOpen(false);
      setScreen("Upload");
      return;
    }
    const nextFiles = { ...files, [documentType]: file };
    setFiles(nextFiles);
    setScannedDocumentType(documentType);
    setFileError("");
    setScannerOpen(false);
    if (aiAutoCheck) {
      setScanNeedsManualCheck(false);
      void submitApplication(null, nextFiles);
    } else {
      setScanNeedsManualCheck(true);
      setScreen("Upload");
    }
  }

  function acceptFile(document, file) {
    setFileError("");
    if (!file) return false;
    const extension = fileExtension(file);
    const expectedType = extension === "pdf" ? "application/pdf" : ["jpg", "jpeg"].includes(extension) ? "image/jpeg" : extension === "png" ? "image/png" : "";
    if (!expectedType || (file.type && file.type !== expectedType && file.type !== "application/octet-stream")) {
      setFileError("Choose a PDF, JPG, JPEG, or PNG file that matches its filename.");
      return false;
    }
    const limit = expectedType === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (file.size > limit) {
      setFileError(expectedType === "application/pdf" ? "PDF files must be 20 MB or smaller." : "Image files must be 10 MB or smaller.");
      return false;
    }
    setFiles((current) => ({ ...current, [document]: file }));
    return true;
  }

  function queueMultipleFiles(fileList) {
    setFileError("");
    const queued = [];
    for (const [index, file] of Array.from(fileList ?? []).entries()) {
      const extension = fileExtension(file);
      const expectedType = extension === "pdf" ? "application/pdf" : ["jpg", "jpeg"].includes(extension) ? "image/jpeg" : extension === "png" ? "image/png" : "";
      if (!expectedType || (file.type && file.type !== expectedType && file.type !== "application/octet-stream")) {
        setFileError(`${file.name}: choose a PDF, JPG, JPEG, or PNG file that matches its filename.`);
        continue;
      }
      if (file.size > (expectedType === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
        setFileError(`${file.name}: ${expectedType === "application/pdf" ? "PDF files must be 20 MB or smaller." : "Image files must be 10 MB or smaller."}`);
        continue;
      }
      queued.push({ id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`, file });
    }
    if (queued.length) setBatchFiles((current) => [...current, ...queued]);
  }

  function assignBatchFile(id, document) {
    if (!document) return;
    if (files[document]) {
      setFileError(`Remove the existing ${DOCUMENTS.find(([type]) => type === document)?.[1] ?? document} file before replacing it.`);
      return;
    }
    const queued = batchFiles.find((item) => item.id === id);
    if (!queued || !acceptFile(document, queued.file)) return;
    setBatchFiles((current) => current.filter((item) => item.id !== id));
  }

  function removeFile(document) {
    setFiles((current) => ({ ...current, [document]: null }));
    if (document === scannedDocumentType) {
      setScannedDocumentType("");
      setScanNeedsManualCheck(false);
    }
    setFileError("");
  }

  async function submitApplication(event, submissionFiles = files) {
    event?.preventDefault();
    if (batchFiles.length) {
      setFileError("Assign each selected file to a document requirement or remove it before continuing.");
      return;
    }
    setBusy(true);
    setError("");
    setAiCheckError("");
    setCheckApplicationId(null);
    setDocumentProgress(Object.fromEntries(DOCUMENTS.filter(([document]) => submissionFiles[document]).map(([document]) => [document, "queued"])));
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
        formData.set("lgu_id", "bagong-dalisay-demo");
        formData.set("label", referenceLabel.trim() || "Business Permit Application");
        for (const [document] of DOCUMENTS) {
          const file = submissionFiles[document];
          if (!file) continue;
          formData.append("document_types[]", document);
          formData.append("files", file);
        }
        created = await request("/api/applications", { method: "POST", body: formData });
      }
      createdId = created.id;
      setScanNeedsManualCheck(false);
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
    setDocumentProgress(Object.fromEntries(DOCUMENTS.filter(([document]) => files[document]).map(([document]) => [document, "queued"])));
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
      setDecisionTimestamp(new Date().toISOString());
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDecision() {
    const outcome = decisionConfirmation;
    setDecisionConfirmation(null);
    if (outcome) await decide(outcome);
  }

  async function openApplication(id) {
    setBusy(true);
    setError("");
    try {
      const selected = await request(`/api/applications/${id}`);
      setApplication(selected);
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
  const checkingDocuments = DOCUMENTS.filter(([document]) => files[document]);
  const completedDocumentCount = checkingDocuments.filter(([document]) => documentProgress[document] === "complete").length;
  const reviewScreen = ["Findings", "Extracted Fields", "Requirements", "Outcome"].includes(screen);
  const activeStepIndex = screen === "Upload" ? 0 : screen === "AI Check" || screen === "Requirements" || screen === "Extracted Fields" ? 1 : 2;
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

  if (!session && !AUTH_DISABLED) {
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
    return <HomeScreen onUpload={() => setScreen("Upload")} onReports={() => setScreen("Reports")} onProfile={() => setScreen("Profile")} onOpenApplication={openApplication} user={session?.user ?? null} onSignOut={signOut} scannerOpen={scannerOpen} onOpenScanner={() => setScannerOpen(true)} onCloseScanner={() => setScannerOpen(false)} onConfirmScan={confirmScan} />;
  }

  return (
    <div className={`app-shell ${flowScreen ? "review-flow-shell" : ""} ${reviewScreen ? "review-screen-shell" : ""} ${screen === "Reports" ? "reports-screen-shell" : ""} ${screen === "Profile" ? "profile-screen-shell" : ""}`}>
      {flowScreen ? (
        <header className="flow-header">
          <div className="flow-header-art" aria-hidden="true" />
          <button className="flow-back" type="button" aria-label="Back to Home" onClick={() => setScreen("Home")}>
            <Icon name="arrow-left" size={18} />
          </button>
          <div className="flow-header-title">AI-Assisted <span>Review</span></div>
          {session && <button className="signout-link" type="button" onClick={signOut}>Sign out</button>}
        </header>
      ) : reviewScreen ? (
        <header className="review-header">
          <div className="review-header-main">
            <button className="review-back" type="button" onClick={() => setScreen("Home")} aria-label="Back to Home">
              <Icon name="arrow-left" size={18} />
            </button>
            <div className="review-header-copy">
              <strong>{application?.label || application?.id || "Application review"}</strong>
              {application?.label && <small>{application.id}</small>}
            </div>
            {session && <button className="signout-link" type="button" onClick={signOut}>Sign out</button>}
          </div>
          <div className="review-header-meta">
            <span className={`review-header-status ${finalDecision ? "final" : ""}`}>{application?.status?.replaceAll("_", " ") ?? "No application"}</span>
            {MOCK_MODE && <span className="demo-badge"><span />Demo mode / mocked data</span>}
          </div>
        </header>
      ) : screen === "Reports" ? (
        <header className="flow-header reports-flow-header">
          <div className="flow-header-art" aria-hidden="true" />
          <button className="flow-back" type="button" aria-label="Back to Home" onClick={() => setScreen("Home")}><Icon name="arrow-left" size={18} /></button>
        </header>
      ) : screen === "Profile" ? (
        <header className="flow-header profile-flow-header">
          <div className="flow-header-art" aria-hidden="true" />
          <button className="flow-back" type="button" aria-label="Back to Home" onClick={() => setScreen("Home")}><Icon name="arrow-left" size={18} /></button>
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
            {session && <button className="signout-link" type="button" onClick={signOut}>Sign out</button>}
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
            <button className={`nav-item ${screen === "Reports" ? "active" : ""}`} type="button" onClick={() => setScreen("Reports")}><span className="nav-number">06</span><span>Reports</span></button>
          </nav>
          <div className="sidebar-foot">
            <span className={`status-dot ${application ? "ready" : ""}`} />
            {application ? application.status.replaceAll("_", " ") : "No application loaded"}
          </div>
        </aside>}

        <main className={`main-content ${flowScreen ? "flow-main" : ""} ${reviewScreen ? "review-main" : ""}`}>
          {(flowScreen || reviewScreen) && (
            <nav className={`review-stepper review-stepper-${activeStepIndex}`} aria-label="AI-assisted review steps">
              {["Upload", "AI Check", "Review"].map((step, index) => {
                return <span className={`review-step ${index === activeStepIndex ? "active" : index < activeStepIndex ? "complete" : ""}`} key={step} aria-current={index === activeStepIndex ? "step" : undefined}>
                  <i aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">{index < activeStepIndex
                    ? <path d="m5 12 4.3 4.3L19 6.8" />
                    : index === 0
                      ? <path d="M12 15V4m-4 4 4-4 4 4M5 14v5h14v-5" />
                      : index === 1
                        ? <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>
                        : <><path d="M7 3h7l4 4v14H7zM14 3v5h4M10 13h5" /><path d="m10 17 2 2 4-4" /></>}</svg></i>
                  <span>{step}</span><small>{index === 0 ? "Files received" : index === 1 ? "AI document check" : "Reviewer decision"}</small>
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
            <span className="final-decision-check"><Icon name="check" size={16} /></span>
            <span><strong>Decision recorded</strong><small>{formattedDecisionTime(decisionTimestamp) || "Final decision saved"} · {application.status}</small></span>
          </div>}

          {error && <div className="error-banner" role="alert">{error}</div>}

          {screen === "Reports" && <Reports apiFetch={apiFetch} lguName={session?.user?.role === "admin" ? "All authorized LGUs" : session?.user?.lgu_id === requirements?.lgu.id ? requirements.lgu.name : `LGU ${session?.user?.lgu_id ?? "Authorized LGU"}`} />}
          {screen === "Profile" && <Profile user={session?.user ?? null} lguName={session?.user?.lgu_id === requirements?.lgu.id ? requirements.lgu.name : `LGU ${session?.user?.lgu_id ?? "ACCOUNT SETTINGS"}`} onSignOut={session ? signOut : undefined} />}

          {screen === "Upload" && (
            <section className="card upload-card">
              <div className="card-heading">
                <div><h2>Upload application documents</h2><p>PDF, JPG, JPEG, or PNG · up to 20 MB per PDF and 10 MB per image. You can continue with missing documents.</p></div>
              </div>
              <form onSubmit={submitApplication}>
                {scanNeedsManualCheck && <p className="scan-ready-note" role="status">Scan saved on this device. Start AI Check when you’re ready.</p>}
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
                  <>
                  <div className="batch-upload-control">
                    <div><strong>Add several files at once</strong><small>Choose multiple documents, then assign each file to its requirement.</small></div>
                    <label className="choose-pdf batch-file-picker">Choose files
                      <input className="document-file-input" type="file" multiple accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png" onChange={(event) => { queueMultipleFiles(event.target.files); event.target.value = ""; }} />
                    </label>
                  </div>
                  {batchFiles.length > 0 && <ul className="batch-file-list" aria-label="Files to assign">{batchFiles.map(({ id, file }) => (
                    <li key={id}>
                      <FilePreview file={file} />
                      <span className="batch-file-copy"><strong>{file.name}</strong><small>{fileTypeLabel(file)} · {Math.max(1, Math.round(file.size / 1024))} KB</small></span>
                      <select aria-label={`Assign ${file.name}`} value="" onChange={(event) => assignBatchFile(id, event.target.value)}>
                        <option value="">Assign document…</option>
                        {DOCUMENTS.map(([document, label]) => <option key={document} value={document} disabled={Boolean(files[document])}>{label}</option>)}
                      </select>
                      <button className="remove-file" type="button" aria-label={`Remove ${file.name}`} onClick={() => setBatchFiles((current) => current.filter((item) => item.id !== id))}>Remove</button>
                    </li>
                  ))}</ul>}
                  <div className="document-slots">
                    {DOCUMENTS.map(([document, label]) => {
                      const file = files[document];
                      const sizeLabel = file ? `${fileTypeLabel(file)} · ${file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`}` : "PDF, JPG, JPEG, or PNG";
                      return <article
                        className={`document-slot ${draggingDocument === document ? "dragging" : ""} ${file ? "has-file" : ""}`}
                        key={document}
                        onDragOver={(event) => { event.preventDefault(); setDraggingDocument(document); }}
                        onDragLeave={() => setDraggingDocument(null)}
                        onDrop={(event) => { event.preventDefault(); setDraggingDocument(null); acceptFile(document, event.dataTransfer.files?.[0]); }}
                      >
                        <span className="document-slot-icon">{file ? <FilePreview file={file} /> : <Icon name="file" size={17} />}</span>
                        <div className="document-slot-copy">
                          <label htmlFor={`file-${document}`}>{label}</label>
                          <small>{file ? `${file.name} · ${sizeLabel}` : sizeLabel}</small>
                        </div>
                        <label className="choose-pdf">
                          Choose file
                          <input className="document-file-input" id={`file-${document}`} type="file" accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png" onChange={(event) => { acceptFile(document, event.target.files?.[0]); event.target.value = ""; }} />
                        </label>
                        {file && <button className="remove-file" type="button" onClick={() => removeFile(document)}>Remove</button>}
                      </article>;
                    })}
                  </div>
                  </>
                )}
                {fileError && <p className="upload-file-error" role="alert">{fileError}</p>}
                <div className="form-actions">
                  <p>Missing documents will be flagged for the reviewer.</p>
                  <button className="primary-button start-ai-button" type="submit" disabled={busy || (!MOCK_MODE && !Object.values(files).some(Boolean))}>
                    {scanNeedsManualCheck ? "Run AI Check" : "Start AI Check"} <Icon name="arrow-right" size={16} />
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
              {!MOCK_MODE && checkingDocuments.length > 0 && <div className="document-progress-summary"><span>{completedDocumentCount} of {checkingDocuments.length} documents checked</span><div className="document-progress-track"><i style={{ width: `${(completedDocumentCount / checkingDocuments.length) * 100}%` }} /></div></div>}
              <ul className="reading-documents">
                {MOCK_MODE ? <li className="reading-document complete"><span className="reading-state" aria-label="Complete"><Icon name="check" size={14} /></span><span className="reading-document-copy">{FIXTURES.find(([value]) => value === fixture)?.[1] ?? fixture} sample<small>Sample review</small></span><span className="reading-state-label">Complete</span></li> :
                  checkingDocuments.map(([document, label]) => {
                    const status = documentProgress[document] ?? "queued";
                    const stateLabel = status === "complete" ? "Checked" : status === "checking" ? "Checking" : status === "reading" ? "Reading" : status === "failed" ? "Failed" : "Waiting";
                    return <li className={`reading-document ${status}`} key={document}>
                      <span className="reading-state" role="status" aria-label={stateLabel}>{status === "complete" ? <Icon name="check" size={14} /> : status === "failed" ? <Icon name="alert" size={14} /> : status === "checking" || status === "reading" ? <i /> : <b />}</span>
                      <span className="reading-document-copy">{label}<small>{files[document].name}</small></span>
                      <span className="reading-state-label">{stateLabel}</span>
                    </li>;
                  })}
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
              {requirements && <div className="review-next-action"><button className="primary-button" type="button" onClick={() => setScreen("Extracted Fields")}>View Extracted Fields <Icon name="arrow-right" size={16} /></button></div>}
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
                    : <span className="unverified"><Icon name="alert" size={14} />Unverified — review source</span>}</td>
                </tr>)}</tbody>
              </table></div> : <p className="empty-state">Load or process an application to view extracted fields.</p>}
              {application?.fields.length > 0 && <div className="review-next-action"><button className="primary-button" type="button" onClick={() => setScreen("Findings")}>View Findings ({application.findings.length}) <Icon name="arrow-right" size={16} /></button></div>}
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
                    onClick={() => { setSelectedFindingId(finding.finding_id); setShowFindingDetailMobile(true); }}
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
                <button className="mobile-finding-back" type="button" onClick={() => setShowFindingDetailMobile(false)}><Icon name="arrow-left" size={15} />Back to findings</button>
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
                  <button className="outline-button" disabled={busy || finalDecision} onClick={() => updateFinding("confirmed")}>Confirm</button>
                  <button className="outline-button" disabled={busy || finalDecision} onClick={() => updateFinding("dismissed")}>Dismiss</button>
                  <button className="outline-button" disabled={busy || finalDecision} onClick={() => updateFinding("escalated")}>Escalate</button>
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
                <p>{decision === "approve"
                  ? "All findings have been dismissed or no findings were raised. You may approve this application."
                  : decision === "return"
                    ? "At least one finding is confirmed. Return the application for correction."
                    : "Open or escalated findings must be resolved before a final decision."}</p>
                <div className="outcome-actions">
                  <button className="primary-button" disabled={busy || decision !== "approve" || finalDecision} onClick={() => setDecisionConfirmation("approve")}>Approve application</button>
                  <button className="outline-button" disabled={busy || decision !== "return" || finalDecision} onClick={() => setDecisionConfirmation("return")}>Return for correction</button>
                </div>
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

          {!application && screen !== "Upload" && screen !== "Reports" && screen !== "Profile" && <div className="card empty-card"><p className="empty-state">Load an application first to view this section.</p></div>}

          {application && screen !== "Reports" && screen !== "Profile" && <footer className="review-disclaimer">
            <span className="disclaimer-icon">i</span>
            <span>Automated checks support the review only. The reviewer makes the final decision.</span>
            <button onClick={() => setScreen("Outcome")}>Go to outcome <Icon name="arrow-right" size={15} /></button>
          </footer>}
        </main>
      </div>
      {screen === "Reports" && <div className="reports-bottom-fade" aria-hidden="true" />}
      <BottomNavigation
        active={screen === "Profile" ? "Profile" : screen === "Reports" ? "Reports" : screen === "Home" ? "Home" : "Applications"}
        onHome={() => setScreen("Home")}
        onApplications={() => setScreen("Upload")}
        onScan={() => setScannerOpen(true)}
        onReports={() => setScreen("Reports")}
        onProfile={() => setScreen("Profile")}
      />
      {scannerOpen && <DocumentScanner onCancel={() => setScannerOpen(false)} onConfirm={confirmScan} />}
      {decisionConfirmation && <div
        className="decision-confirm-backdrop"
        onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDecisionConfirmation(null); }}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) setDecisionConfirmation(null); }}
      >
        <section className="decision-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-confirm-title" aria-describedby="decision-confirm-description">
          <span className={`decision-confirm-icon ${decisionConfirmation}`}><Icon name={decisionConfirmation === "approve" ? "check" : "return"} size={19} /></span>
          <div className="decision-confirm-copy">
            <span className="eyebrow">FINAL REVIEW DECISION</span>
            <h2 id="decision-confirm-title">{decisionConfirmation === "approve" ? "Approve this application?" : "Return this application?"}</h2>
            <p id="decision-confirm-description">{decisionConfirmation === "approve"
              ? "This will mark the application as approved. This action cannot be undone."
              : "This will return the application for correction. This action cannot be undone."}</p>
          </div>
          <div className="decision-confirm-actions">
            <button className="outline-button" type="button" disabled={busy} onClick={() => setDecisionConfirmation(null)}>Cancel</button>
            <button className={`primary-button ${decisionConfirmation}`} type="button" disabled={busy} onClick={confirmDecision}>
              {busy ? "Saving..." : decisionConfirmation === "approve" ? "Confirm approval" : "Confirm return"}
            </button>
          </div>
        </section>
      </div>}
    </div>
  );
}

export default function App() {
  return <SettingsProvider><AppContent /></SettingsProvider>;
}
