const textEncoder = new TextEncoder();

export function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "Camera access was denied. Allow camera permission in your browser settings, then try again.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No camera was found. Connect a webcam or use the image upload option.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "The camera is unavailable or being used by another app. Close that app and try again.";
  }
  if (error?.name === "SecurityError") {
    return "Camera access requires HTTPS or localhost. Open KalaBASA in a secure browser context.";
  }
  return "The camera could not be started. Check browser permissions and try again.";
}

export async function requestCamera(mediaDevices, { deviceId = "", facingMode = "environment" } = {}) {
  if (!mediaDevices?.getUserMedia) {
    throw new Error("Camera capture is unavailable. Use a supported browser on HTTPS or localhost, then allow camera access.");
  }
  const video = {
    width: { ideal: 1920 },
    height: { ideal: 1440 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facingMode } }),
  };
  try {
    return await mediaDevices.getUserMedia({ audio: false, video });
  } catch (error) {
    throw new Error(cameraErrorMessage(error));
  }
}

export function replaceOrAppendPage(pages, page, replaceId = "") {
  if (!replaceId) return [...pages, page];
  const index = pages.findIndex((item) => item.id === replaceId);
  if (index < 0) return [...pages, page];
  return pages.map((item, itemIndex) => itemIndex === index ? { ...page, id: item.id } : item);
}

export function removeScanPage(pages, pageId) {
  return pages.filter((page) => page.id !== pageId);
}

export function assessImageQuality(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  let brightness = 0;
  let clipped = 0;
  const pixels = width * height;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    const value = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
    gray[pixel] = value;
    brightness += value;
    if (value >= 252) clipped += 1;
  }
  const mean = brightness / Math.max(pixels, 1);
  const warnings = [];
  if (mean < 58) warnings.push("This photo looks too dark. Add light and capture the page again.");
  if (clipped / Math.max(pixels, 1) > 0.94) warnings.push("Highlights look washed out. Reduce glare and check that text is still visible.");

  if (width > 2 && height > 2) {
    let laplacianTotal = 0;
    let laplacianSquared = 0;
    let samples = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        const value = gray[index - width] + gray[index - 1] + gray[index + 1] + gray[index + width] - 4 * gray[index];
        laplacianTotal += value;
        laplacianSquared += value * value;
        samples += 1;
      }
    }
    const variance = laplacianSquared / Math.max(samples, 1) - (laplacianTotal / Math.max(samples, 1)) ** 2;
    if (variance < 10 && mean >= 58) warnings.push("This photo may be blurry. Hold the phone steady and check that the text is sharp.");
  }
  return warnings;
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Scan pages must contain JPEG bytes.");
}

function concatBytes(...parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function asPdfBytes(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 10) {
    throw new Error("A scan must contain between 1 and 10 pages.");
  }
  const imageBytes = pages.reduce((total, page) => total + bytesFrom(page.bytes).byteLength, 0);
  if (imageBytes > 19 * 1024 * 1024) {
    throw new Error("The prepared scan PDF would exceed 20 MB. Capture fewer pages or use lower-resolution images.");
  }
  const objects = new Array(3 + pages.length * 3);
  const pageReferences = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  objects[1] = textEncoder.encode("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = textEncoder.encode(`<< /Type /Pages /Kids [${pageReferences}] /Count ${pages.length} >>`);

  pages.forEach((page, index) => {
    const pageNumber = 3 + index * 3;
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    const image = bytesFrom(page.bytes);
    const width = Math.round(page.width);
    const height = Math.round(page.height);
    if (!width || !height || width > 4000 || height > 4000 || width * height > 12_000_000) {
      throw new Error("A captured page is larger than the scanner limit. Retake it and try again.");
    }
    const pageWidth = width / 2;
    const pageHeight = height / 2;
    objects[pageNumber] = textEncoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    const imageHead = textEncoder.encode(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`);
    const imageTail = textEncoder.encode("\nendstream");
    objects[imageNumber] = concatBytes(imageHead, image, imageTail);
    const content = textEncoder.encode(`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ`);
    objects[contentNumber] = textEncoder.encode(`<< /Length ${content.length} >>\nstream\n${new TextDecoder().decode(content)}\nendstream`);
  });
  return objects;
}

export async function buildScanPdf(pages) {
  const objects = await asPdfBytes(pages);
  const chunks = [textEncoder.encode("%PDF-1.4\n")];
  const offsets = [0];
  let byteLength = chunks[0].length;
  for (let number = 1; number < objects.length; number += 1) {
    offsets[number] = byteLength;
    const content = objects[number];
    const prefix = textEncoder.encode(`${number} 0 obj\n`);
    const suffix = textEncoder.encode("\nendobj\n");
    chunks.push(prefix, content, suffix);
    byteLength += prefix.length + content.length + suffix.length;
  }
  const xrefOffset = byteLength;
  const xref = [`xref\n0 ${objects.length}\n`, "0000000000 65535 f \n"];
  for (let number = 1; number < objects.length; number += 1) xref.push(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  const trailer = textEncoder.encode(`${xref.join("")}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  chunks.push(trailer);
  const blob = new Blob(chunks, { type: "application/pdf" });
  if (blob.size > 20 * 1024 * 1024) throw new Error("The prepared scan PDF is over 20 MB. Capture fewer pages or use lower-resolution images.");
  return blob;
}
