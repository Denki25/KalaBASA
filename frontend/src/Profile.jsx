import { useEffect, useRef, useState } from "react";
import { useSettings } from "./settings.jsx";
import frontendPackage from "../package.json";

function initialsFor(user) {
  const parts = String(user?.full_name ?? "Reviewer").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "R";
}

export default function Profile({ user, lguName, onSignOut }) {
  const { aiAutoCheck, setAiAutoCheck } = useSettings();
  const [toast, setToast] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const cancelSignOutRef = useRef(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!confirmSignOut) return undefined;
    cancelSignOutRef.current?.focus();
    function handleKeyDown(event) {
      if (event.key === "Escape") setConfirmSignOut(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmSignOut]);

  function toggleAutoCheck() {
    const next = !aiAutoCheck;
    setAiAutoCheck(next);
    setToast(`AI Auto Check turned ${next ? "on" : "off"}`);
  }

  return <section className="profile-page">
    <section className="profile-account-panel" aria-labelledby="account-heading">
      <div className="profile-account-row">
        <span className="profile-avatar" aria-hidden="true">{initialsFor(user)}</span>
        <div className="profile-account-copy">
          <h2 id="account-heading">{user?.full_name || "Reviewer"}</h2>
          <span>{user?.email || "Email not available"}</span>
        </div>
      </div>
      <div className="profile-account-meta">
        <div><span>ROLE</span><strong>{user?.role ? `${user.role[0].toUpperCase()}${user.role.slice(1)}` : "Local reviewer"}</strong></div>
        <div><span>LGU</span><strong>{lguName || "Not assigned"}</strong></div>
      </div>
    </section>

    <section className="profile-card preferences-card" aria-labelledby="preferences-heading">
      <h2 id="preferences-heading" className="profile-section-label">PREFERENCES</h2>
      <div className="preference-row">
        <div className="preference-copy">
          <strong>AI Auto Check</strong>
          <p>Automatically run AI Check right after you confirm a scan. When off, your scan stays on this device until you start AI Check manually.</p>
        </div>
        <div className="settings-switch-control">
          <span className="settings-switch-state">{aiAutoCheck ? "On" : "Off"}</span>
          <button className={`settings-switch ${aiAutoCheck ? "is-on" : ""}`} type="button" role="switch" aria-checked={aiAutoCheck} aria-label="AI Auto Check" onClick={toggleAutoCheck}>
            <span />
          </button>
        </div>
      </div>
      <p className="settings-toast" role={toast ? "status" : undefined}>{toast || <>&nbsp;</>}</p>
      <div className="profile-version-row"><span>App version</span><strong>{frontendPackage.version}</strong></div>
      <p className="profile-privacy-note"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5m0-8h.01"/></svg>AI results are advisory. A human reviewer makes the final decision.</p>
    </section>

    {onSignOut && <button className="profile-signout" type="button" onClick={() => setConfirmSignOut(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/></svg>Sign out</button>}
    {confirmSignOut && <div className="decision-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmSignOut(false); }}>
      <section className="decision-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-signout-title" aria-describedby="profile-signout-description">
        <span className="decision-confirm-icon profile-confirm-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/></svg></span>
        <div className="decision-confirm-copy"><span className="eyebrow">ACCOUNT</span><h2 id="profile-signout-title">Sign out?</h2><p id="profile-signout-description">You'll need to sign in again to continue reviewing applications.</p></div>
        <div className="decision-confirm-actions"><button ref={cancelSignOutRef} className="outline-button" type="button" onClick={() => setConfirmSignOut(false)}>Cancel</button><button className="primary-button profile-confirm-signout" type="button" onClick={onSignOut}>Sign out</button></div>
      </section>
    </div>}
  </section>;
}
