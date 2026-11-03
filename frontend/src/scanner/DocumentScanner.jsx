import { useEffect, useRef, useState } from "react";
import { assessImageQuality, buildScanPdf, cameraErrorMessage, removeScanPage, replaceOrAppendPage, requestCamera } from "./scanner-utils.js";

const DOCUMENTS = [
  ["application_form", "Business Permit Application Form"],
  ["dti_certificate", "DTI Certificate"],
  ["barangay_clearance", "Barangay Business Clearance"],
  ["lease_contract", "Contract of Lease"],
  ["community_tax_certificate", "Community Tax Certificate"],
];

function ScanPagePreview({ page, className = "" }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const nextUrl = URL.createObjectURL(page.blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [page.blob]);
  return url ? <img className={className} src={url} alt={`Captured page ${page.number ?? "preview"}`} /> : null;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not prepare this image. Please retake the page.")), "image/jpeg", 0.84));
}

function friendlyCameraName(device, index) {
  const label = device.label?.toLowerCase() ?? "";
  if (/back|rear|environment/.test(label)) return "Back camera";
  if (/front|user|selfie/.test(label)) return "Front camera";
  return `Camera ${index + 1}`;
}

async function transformPage(page, { rotate = 0, crop = null } = {}) {
  const bitmap = await createImageBitmap(page.blob);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const sx = crop ? Math.round(sourceWidth * crop.left / 100) : 0;
  const sy = crop ? Math.round(sourceHeight * crop.top / 100) : 0;
  const sw = crop ? Math.max(1, Math.round(sourceWidth * crop.width / 100)) : sourceWidth;
  const sh = crop ? Math.max(1, Math.round(sourceHeight * crop.height / 100)) : sourceHeight;
  const outWidth = rotate % 180 === 0 ? sw : sh;
  const outHeight = rotate % 180 === 0 ? sh : sw;
  const scale = Math.min(1, 4000 / Math.max(outWidth, outHeight), Math.sqrt(12_000_000 / (outWidth * outHeight)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(outWidth * scale));
  canvas.height = Math.max(1, Math.floor(outHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotate * Math.PI / 180);
  context.drawImage(bitmap, sx, sy, sw, sh, -(sw * scale) / 2, -(sh * scale) / 2, sw * scale, sh * scale);
  bitmap.close();
  const blob = await canvasBlob(canvas);
  return { ...page, blob, width: canvas.width, height: canvas.height, jpegBytes: new Uint8Array(await blob.arrayBuffer()) };
}

export default function DocumentScanner({ onCancel, onConfirm }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scannerRef = useRef(null);
  const scannerUnavailableRef = useRef(false);
  const scanningRef = useRef(false);
  const requirementRef = useRef(null);
  const overlayRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [pages, setPages] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [replaceId, setReplaceId] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [focusPoint, setFocusPoint] = useState(null);
  const [focusMessage, setFocusMessage] = useState("");
  const [requirementError, setRequirementError] = useState(false);
  const [scannerNotice, setScannerNotice] = useState("");
  const [crop, setCrop] = useState({ left: 0, top: 0, width: 100, height: 100 });
  const [previewPageId, setPreviewPageId] = useState("");
  const [toast, setToast] = useState("");
  const [deletedPage, setDeletedPage] = useState(null);
  const dragIndexRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => { setToast(""); setDeletedPage(null); }, deletedPage ? 6000 : 2200);
    return () => window.clearTimeout(timeout);
  }, [toast, deletedPage]);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setDevices([]);
    setDeviceId("");
    setTorchAvailable(false);
    setTorchOn(false);
  }

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && previewPageId) { setPreviewPageId(""); return; }
      if (event.key === "Escape" && !busy) { stopCamera(); onCancel(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, previewPageId]);

  async function startCamera(requestedDeviceId = "") {
    setCameraBusy(true);
    setCameraError("");
    try {
      stopCamera();
      const next = await requestCamera(navigator.mediaDevices, { deviceId: requestedDeviceId });
      streamRef.current = next;
      setStream(next);
      const available = await navigator.mediaDevices.enumerateDevices?.() ?? [];
      const cameras = available.filter((device) => device.kind === "videoinput");
      setDevices(cameras);
      const activeId = next.getVideoTracks()[0]?.getSettings?.().deviceId ?? requestedDeviceId;
      setDeviceId(activeId || "");
      const capabilities = next.getVideoTracks()[0]?.getCapabilities?.();
      setTorchAvailable(capabilities?.torch === true || Array.isArray(capabilities?.torch));
      setTorchOn(false);
      setFocusMessage(Array.isArray(capabilities?.focusMode) && capabilities.focusMode.length
        ? "Tap the preview to focus where supported."
        : "Automatic focus is controlled by your camera.");
    } catch (error) {
      setCameraError(error.message || cameraErrorMessage(error));
    } finally {
      setCameraBusy(false);
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchAvailable) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn((current) => !current);
    } catch {
      setCameraError("This camera could not change its torch setting.");
    }
  }

  async function focusAt(event) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const clientX = Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : rect.top + rect.height / 2;
    const point = { x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) };
    setFocusPoint({ x: point.x * 100, y: point.y * 100 });
    window.setTimeout(() => setFocusPoint(null), 900);
    const capabilities = track.getCapabilities?.();
    const focusModes = capabilities?.focusMode ?? [];
    const advanced = focusModes.includes("single-shot") ? [{ focusMode: "single-shot" }] : [];
    const constraints = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    if (constraints.pointsOfInterest && capabilities?.pointsOfInterest) advanced.push({ pointsOfInterest: [point] });
    if (!advanced.length) {
      setFocusMessage("This camera manages focus automatically; hold steady for a moment.");
      return;
    }
    try {
      await track.applyConstraints({ advanced });
      setFocusMessage("Focusing…");
    } catch {
      setFocusMessage("This camera manages focus automatically; hold steady for a moment.");
    }
  }

  useEffect(() => {
    if (!stream) return undefined;
    let alive = true;
    let timer = null;
    async function detectDocument() {
      try {
        if (scannerUnavailableRef.current) return;
        if (!scannerRef.current) {
          const { Scanner } = await import("scanic");
          const scanner = new Scanner({ maxProcessingDimension: 700 });
          await scanner.initialize();
          if (!alive) return;
          scannerRef.current = scanner;
        }
        const video = videoRef.current;
        const overlay = overlayRef.current;
        if (!alive || !video?.videoWidth || !video?.videoHeight || scanningRef.current) return;
        const context = overlay?.getContext("2d");
        if (overlay && (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight)) {
          overlay.width = video.videoWidth;
          overlay.height = video.videoHeight;
        }
        scanningRef.current = true;
        const result = await scannerRef.current.scan(video, { mode: "detect", maxProcessingDimension: 700 });
        if (!alive) return;
        context?.clearRect(0, 0, overlay.width, overlay.height);
        if (result.success && result.corners && context) {
          const { topLeft, topRight, bottomRight, bottomLeft } = result.corners;
          context.beginPath();
          context.moveTo(topLeft.x, topLeft.y);
          context.lineTo(topRight.x, topRight.y);
          context.lineTo(bottomRight.x, bottomRight.y);
          context.lineTo(bottomLeft.x, bottomLeft.y);
          context.closePath();
          context.fillStyle = "rgba(255, 143, 42, 0.12)";
          context.fill();
          context.lineWidth = Math.max(3, video.videoWidth / 360);
          context.strokeStyle = "#ff982f";
          context.stroke();
          for (const point of [topLeft, topRight, bottomRight, bottomLeft]) {
            context.beginPath();
            context.arc(point.x, point.y, Math.max(7, video.videoWidth / 180), 0, Math.PI * 2);
            context.fillStyle = "#fff";
            context.fill();
            context.strokeStyle = "#ff7c18";
            context.lineWidth = Math.max(3, video.videoWidth / 360);
            context.stroke();
          }
          setScannerNotice("");
        }
      } catch {
        scannerUnavailableRef.current = true;
        if (alive) setScannerNotice("Automatic edge detection is unavailable. You can still capture and crop the page manually.");
      } finally {
        scanningRef.current = false;
        if (alive && !scannerUnavailableRef.current) timer = window.setTimeout(detectDocument, 140);
      }
    }
    detectDocument();
    return () => { alive = false; if (timer) window.clearTimeout(timer); scanningRef.current = false; };
  }, [stream]);

  async function capture() {
    if (!documentType) {
      setRequirementError(true);
      requirementRef.current?.focus();
      return;
    }
    setRequirementError(false);
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraError("The camera preview is not ready yet. Wait a moment and try again.");
      return;
    }
    if (pages.length >= 10 && !replaceId) {
      setActionError("A scan can contain up to 10 pages.");
      return;
    }
    setCameraBusy(true);
    setActionError("");
    try {
      while (scanningRef.current) await new Promise((resolve) => window.setTimeout(resolve, 20));
      const scale = Math.min(1, 4000 / Math.max(video.videoWidth, video.videoHeight), Math.sqrt(12_000_000 / (video.videoWidth * video.videoHeight)));
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      sourceCanvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      sourceCanvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, sourceCanvas.width, sourceCanvas.height);
      let finalCanvas = sourceCanvas;
      let corrected = false;
      let correctionWarning = "";
      if (scannerRef.current) {
        scanningRef.current = true;
        try {
          const result = await scannerRef.current.scan(sourceCanvas, { mode: "extract", output: "canvas", maxProcessingDimension: 1200 });
          if (result.success && result.output instanceof HTMLCanvasElement) {
            finalCanvas = result.output;
            corrected = true;
          } else {
            setScannerNotice("Page edges were not clear enough to straighten. The photo is kept as captured; use Crop page if needed.");
            correctionWarning = "Page edges were not clear enough to straighten; the original photo is kept.";
          }
        } finally { scanningRef.current = false; }
      } else correctionWarning = "Automatic edge detection was not ready; the original photo is kept.";
      // Use a small sample for the quality check while preserving full scan resolution.
      const sampleCanvas = document.createElement("canvas");
      const sampleScale = Math.min(1, 240 / finalCanvas.width, 240 / finalCanvas.height);
      sampleCanvas.width = Math.max(1, Math.round(finalCanvas.width * sampleScale));
      sampleCanvas.height = Math.max(1, Math.round(finalCanvas.height * sampleScale));
      const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
      sampleContext.drawImage(finalCanvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
      const sampledWarnings = assessImageQuality(sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height));
      const blob = await canvasBlob(finalCanvas);
      const page = { id: replaceId || crypto.randomUUID(), blob, width: finalCanvas.width, height: finalCanvas.height, qualityWarnings: [...sampledWarnings, ...(correctionWarning ? [correctionWarning] : [])], corrected };
      const prepared = await transformPage(page);
      setPages((current) => replaceOrAppendPage(current, prepared, replaceId));
      setSelectedId(page.id);
      setPreviewPageId("");
      setDeletedPage(null);
      setToast(replaceId ? "Page updated" : `Page ${pages.length + 1} captured`);
      setReplaceId("");
      setActionError("");
    } catch (error) {
      setActionError(error.message || "Could not capture this page. Try again.");
    } finally { setCameraBusy(false); }
  }

  async function rotateSelected() {
    const selected = pages.find((page) => page.id === selectedId);
    if (!selected) return;
    try {
      const rotated = await transformPage(selected, { rotate: 90 });
      setPages((current) => current.map((page) => page.id === selectedId ? rotated : page));
    } catch (error) { setActionError(error.message); }
  }

  async function applyCrop() {
    const selected = pages.find((page) => page.id === selectedId);
    if (!selected) return;
    try {
      const cropped = await transformPage(selected, { crop });
      setPages((current) => current.map((page) => page.id === selectedId ? cropped : page));
      setCrop({ left: 0, top: 0, width: 100, height: 100 });
      setActionError("");
    } catch (error) { setActionError(error.message); }
  }

  function removeSelected(pageId = selectedId) {
    const index = pages.findIndex((page) => page.id === pageId);
    if (index < 0) return;
    setDeletedPage({ page: pages[index], index });
    const next = removeScanPage(pages, pageId);
    setPages(next);
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? "");
    setPreviewPageId("");
    setToast("Page deleted");
    setReplaceId("");
  }

  function undoDelete() {
    if (!deletedPage) return;
    setPages((current) => {
      const next = [...current];
      next.splice(Math.min(deletedPage.index, next.length), 0, deletedPage.page);
      return next;
    });
    setSelectedId(deletedPage.page.id);
    setDeletedPage(null);
    setToast("");
  }

  function reorderPage(fromIndex, toIndex) {
    if (fromIndex === null || fromIndex === toIndex || toIndex < 0) return;
    setPages((current) => {
      if (fromIndex >= current.length || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function changeCrop(key, value) {
    const nextValue = Number(value);
    setCrop((current) => {
      const next = { ...current, [key]: nextValue };
      if (key === "left") next.width = Math.min(next.width, 100 - next.left);
      if (key === "top") next.height = Math.min(next.height, 100 - next.top);
      if (key === "width") next.left = Math.min(next.left, 100 - next.width);
      if (key === "height") next.top = Math.min(next.top, 100 - next.height);
      return next;
    });
  }

  async function confirmScan() {
    if (!documentType) { setActionError("Choose the document requirement for these pages."); return; }
    if (!pages.length) { setActionError("Capture at least one page before confirming."); return; }
    setBusy(true);
    setActionError("");
    try {
      const pdf = await buildScanPdf(pages.map((page) => ({ ...page, bytes: page.jpegBytes })));
      const label = DOCUMENTS.find(([type]) => type === documentType)?.[1] ?? documentType;
      const file = new File([pdf], `scan-${documentType}-${Date.now()}.pdf`, { type: "application/pdf", lastModified: Date.now() });
      await onConfirm({ documentType, file, label, pageCount: pages.length });
    } catch (error) {
      setActionError(error.message || "Could not prepare the scan.");
      setBusy(false);
    }
  }

  const selectedPage = pages.find((page) => page.id === selectedId);
  const previewPage = pages.find((page) => page.id === previewPageId);

  return <div className="scanner-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { stopCamera(); onCancel(); } }}>
    <section className="scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
      <header className={`scanner-header ${stream ? "camera-open" : ""}`}>
        <div><span className="scanner-eyebrow">DOCUMENT CAPTURE</span><h2 id="scanner-title">Scan a document</h2><p>Capture pages in order, then review them before processing.</p></div>
        <button type="button" className="scanner-close" aria-label="Cancel and close scanner" disabled={busy} onClick={() => { stopCamera(); onCancel(); }}>×</button>
      </header>
      <div className="scanner-content">
        <label className={`scanner-requirement ${requirementError ? "has-error" : ""}`}>Document requirement
          <select ref={requirementRef} value={documentType} aria-invalid={requirementError} aria-describedby={requirementError ? "scanner-requirement-error" : undefined} onChange={(event) => { setDocumentType(event.target.value); setRequirementError(false); }}>
            <option value="">Choose a requirement</option>
            {DOCUMENTS.map(([type, label]) => <option key={type} value={type}>{label}</option>)}
          </select>
        </label>
        {!documentType && <p className="scanner-requirement-hint">Select the document type before capturing a page.</p>}
        {requirementError && <p className="scanner-requirement-error" id="scanner-requirement-error" role="alert">Choose a document requirement to capture a page.</p>}
        {cameraError && <p className="scanner-message error" role="alert">{cameraError}</p>}
        {actionError && <p className="scanner-message error" role="alert">{actionError}</p>}
        <div className={`scanner-camera ${stream ? "is-live" : ""}`}>
          {stream ? <div className="scanner-camera-live" role="button" tabIndex={0} aria-label="Camera preview. Tap to focus where supported." onClick={focusAt} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") focusAt(event); }}>
            <video ref={videoRef} autoPlay playsInline muted aria-label="Live rear camera preview" />
            <svg className="scanner-framing-guide" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M18 7H82L94 93H6Z" /><path className="scanner-guide-corner" d="M18 16V7H27M73 7H82V16M94 84V93H85M15 93H6V84" /></svg>
            <canvas ref={overlayRef} className="scanner-edge-overlay" aria-hidden="true" />
            {focusPoint && <span className="scanner-focus-ring" style={{ left: `${focusPoint.x}%`, top: `${focusPoint.y}%` }} aria-hidden="true" />}
            {focusMessage && <span className="scanner-focus-hint" aria-live="polite">{focusMessage}</span>}
          </div> : <div className="scanner-camera-empty"><span className="scanner-camera-symbol" aria-hidden="true">Scan</span><div><strong>Camera is off</strong><small>Start the camera to capture another page.</small></div><button className="scanner-primary" type="button" onClick={() => startCamera()} disabled={cameraBusy}>Start camera</button></div>}
        </div>
        <div className="scanner-camera-actions">
          {stream && devices.length > 1 && <label className="scanner-camera-select"><span>Switch camera</span><select aria-label="Switch camera" value={deviceId} onChange={(event) => startCamera(event.target.value)} disabled={cameraBusy}>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{friendlyCameraName(device, index)}</option>)}</select></label>}
          {stream && <>
            {torchAvailable && <button className={`scanner-secondary ${torchOn ? "torch-active" : ""}`} type="button" onClick={toggleTorch} aria-pressed={torchOn}>{torchOn ? "Torch on" : "Torch"}</button>}
            <button className="scanner-secondary" type="button" onClick={() => { setReplaceId(selectedId || ""); setCameraError(""); }} disabled={!selectedId}>Retake selected</button>
            <button className="scanner-primary" type="button" onClick={capture} disabled={cameraBusy}>{replaceId ? "Capture replacement" : "Capture page"}</button>
          </>}
        </div>
        {scannerNotice && stream && <p className="scanner-quality-note" role="status">{scannerNotice}</p>}
        {toast && <div className="scanner-toast" role="status">{toast}{deletedPage && <button type="button" onClick={undoDelete}>Undo</button>}</div>}
        <div className="scanner-pages-heading"><div><strong>Pages</strong><small>{pages.length} of 10 · drag to reorder</small></div></div>
        {pages.length === 0 ? <div className="scanner-no-pages">Captured pages will appear here for review.</div> : <div className="scanner-review-grid">
          <div className="scanner-thumbnail-list" aria-label="Captured pages">
            {pages.map((page, index) => <div className={`scanner-thumbnail ${page.id === selectedId ? "selected" : ""}`} key={page.id} draggable onDragStart={() => { dragIndexRef.current = index; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); reorderPage(dragIndexRef.current, index); dragIndexRef.current = null; }} onDragEnd={() => { dragIndexRef.current = null; }}>
              <button type="button" onClick={() => { setSelectedId(page.id); setPreviewPageId(page.id); }} aria-label={`Open full preview of page ${index + 1}`} aria-pressed={page.id === selectedId}><ScanPagePreview page={page} /><span>Page {index + 1}</span></button>
            </div>)}
          </div>
          {selectedPage && <div className="scanner-page-edit">
            <div className="scanner-large-preview"><ScanPagePreview page={selectedPage} /></div>
            {selectedPage.corrected && <p className="scanner-correction-note" role="status">Page edges detected and perspective corrected.</p>}
            {selectedPage.qualityWarnings?.length > 0 && <ul className="scanner-quality-warnings" role="status">{selectedPage.qualityWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            <div className="scanner-edit-actions"><button type="button" className="scanner-secondary" onClick={rotateSelected}>Rotate 90°</button><button type="button" className="scanner-secondary danger" onClick={removeSelected}>Remove page</button></div>
            <details className="scanner-crop"><summary>Crop page</summary>
              <div className="scanner-crop-controls">
                {[["left", "Left"], ["top", "Top"], ["width", "Width"], ["height", "Height"]].map(([key, label]) => <label key={key}>{label}<input type="range" min={key === "width" || key === "height" ? 20 : 0} max={key === "left" ? 100 - crop.width : key === "top" ? 100 - crop.height : 100} value={crop[key]} onChange={(event) => changeCrop(key, event.target.value)} /></label>)}
                <button type="button" className="scanner-secondary" onClick={applyCrop}>Apply crop</button>
              </div>
            </details>
          </div>}
        </div>}
      </div>
      <footer className="scanner-footer"><small className="scanner-local-note">Your scan stays on this device until you start AI Check.</small><button type="button" className="scanner-secondary" onClick={() => { stopCamera(); onCancel(); }} disabled={busy}>Cancel</button><button type="button" className="scanner-primary" onClick={confirmScan} disabled={busy || pages.length === 0}>{busy ? "Preparing scan…" : `Confirm ${pages.length}`}</button></footer>
      {previewPage && <div className="scanner-preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview page ${pages.findIndex((page) => page.id === previewPage.id) + 1}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewPageId(""); }}><div className="scanner-preview-dialog"><button type="button" className="scanner-preview-close" aria-label="Close preview" onClick={() => setPreviewPageId("")}>×</button><ScanPagePreview page={previewPage} className="scanner-preview-image" />{previewPage.qualityWarnings?.length > 0 && <ul className="scanner-quality-warnings">{previewPage.qualityWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}<div className="scanner-preview-actions"><button type="button" className="scanner-secondary" onClick={() => { setSelectedId(previewPage.id); setReplaceId(previewPage.id); setPreviewPageId(""); if (!stream) startCamera(); }}>Retake</button><button type="button" className="scanner-secondary danger" onClick={() => removeSelected(previewPage.id)}>Delete page</button><button type="button" className="scanner-primary" onClick={() => setPreviewPageId("")}>Done</button></div></div></div>}
    </section>
  </div>;
}
