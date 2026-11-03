import path from "node:path";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8000;
export const MAX_IMAGE_PIXELS = 20_000_000;

const signatures = {
  ".pdf": { mediaType: "application/pdf", extension: ".pdf" },
  ".jpg": { mediaType: "image/jpeg", extension: ".jpg" },
  ".jpeg": { mediaType: "image/jpeg", extension: ".jpeg" },
  ".png": { mediaType: "image/png", extension: ".png" },
};
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export class UploadValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadValidationError";
  }
}

const invalid = (message) => { throw new UploadValidationError(message); };

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions = null;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (jpegFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      dimensions = { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    if (marker === 0xda) {
      const scanStart = offset + segmentLength;
      const hasEndMarker = buffer.length >= scanStart + 2 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
      return dimensions && hasEndMarker && buffer.length > scanStart + 2 ? dimensions : null;
    }
    offset += segmentLength;
  }
  return null;
}

function detectedImage(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(pngSignature)
    && buffer.toString("ascii", 12, 16) === "IHDR"
    && buffer.length >= 45 && buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND") {
    return { mediaType: "image/png", extension: ".png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  const dimensions = jpegDimensions(buffer);
  if (dimensions) return { mediaType: "image/jpeg", extension: ".jpg", ...dimensions };
  return null;
}

export async function validateUploadFile(file) {
  const originalName = path.win32.basename(path.basename(file.originalname ?? "")).trim();
  const extension = path.extname(originalName).toLowerCase();
  const expected = signatures[extension];
  if (!expected) invalid("Unsupported file type. Upload a PDF, JPG, JPEG, or PNG file.");
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) invalid("The uploaded file is empty or unreadable.");

  if (expected.mediaType === "application/pdf") {
    if (file.buffer.length > MAX_PDF_BYTES) invalid("PDF files must be 20 MB or smaller.");
    if (file.buffer.length < 5 || file.buffer.toString("ascii", 0, 5) !== "%PDF-") {
      invalid("The file contents do not match a valid PDF upload.");
    }
    if (file.mimetype && file.mimetype !== "application/pdf" && file.mimetype !== "application/octet-stream") {
      invalid("The uploaded file type does not match its contents.");
    }
    return { mediaType: expected.mediaType, extension: expected.extension };
  }

  if (file.buffer.length > MAX_IMAGE_BYTES) invalid("Image files must be 10 MB or smaller.");
  const image = detectedImage(file.buffer);
  if (!image) {
    const hasMatchingHeader = expected.mediaType === "image/png"
      ? file.buffer.length >= 8 && file.buffer.subarray(0, 8).equals(pngSignature)
      : file.buffer[0] === 0xff && file.buffer[1] === 0xd8;
    invalid(hasMatchingHeader ? "The image is corrupted or cannot be decoded. Please choose another image." : "The uploaded file type does not match its contents.");
  }
  if (image.mediaType !== expected.mediaType) invalid("The uploaded file type does not match its contents.");
  if (!image.width || !image.height || image.width > MAX_IMAGE_DIMENSION || image.height > MAX_IMAGE_DIMENSION
    || image.width * image.height > MAX_IMAGE_PIXELS) {
    invalid("Image dimensions are too large. Use an image up to 8,000 pixels per side and 20 megapixels.");
  }
  if (file.mimetype && file.mimetype !== image.mediaType && file.mimetype !== "application/octet-stream") {
    invalid("The uploaded file type does not match its contents.");
  }

  return { mediaType: image.mediaType, extension: expected.extension };
}
