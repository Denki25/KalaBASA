import assert from "node:assert/strict";
import test from "node:test";
import { assessImageQuality, buildScanPdf, cameraErrorMessage, removeScanPage, replaceOrAppendPage, requestCamera } from "./scanner-utils.js";

test("camera permission denial is shown as a recoverable permission message", async () => {
  const media = { getUserMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } };
  await assert.rejects(requestCamera(media), /Camera access was denied/);
  assert.match(cameraErrorMessage({ name: "NotFoundError" }), /No camera was found/);
});

test("missing camera APIs produce an unavailable-camera message", async () => {
  await assert.rejects(requestCamera({}), /HTTPS or localhost/i);
  let constraints;
  const fakeStream = { getTracks: () => [] };
  assert.equal(await requestCamera({ getUserMedia: async (options) => { constraints = options; return fakeStream; } }), fakeStream);
  assert.equal(constraints.video.facingMode.ideal, "environment");
  assert.equal(constraints.audio, false);
});

test("multiple pages preserve capture order and retakes keep their position", () => {
  const first = { id: "a", page: "first" };
  const second = { id: "b", page: "second" };
  const third = { id: "c", page: "third" };
  let pages = replaceOrAppendPage([], first);
  pages = replaceOrAppendPage(pages, second);
  pages = replaceOrAppendPage(pages, third);
  pages = replaceOrAppendPage(pages, { id: "replacement", page: "retaken" }, "b");
  assert.deepEqual(pages.map((page) => page.page), ["first", "retaken", "third"]);
  assert.deepEqual(removeScanPage(pages, "a").map((page) => page.page), ["retaken", "third"]);
});

test("capture quality warnings flag dark, washed-out, and soft frames without blocking capture", () => {
  const imageData = (width, height, pixelAt) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = pixelAt(x, y);
      data[offset] = value; data[offset + 1] = value; data[offset + 2] = value; data[offset + 3] = 255;
    }
    return { width, height, data };
  };
  assert.match(assessImageQuality(imageData(20, 20, () => 24)).join(" "), /too dark/i);
  assert.match(assessImageQuality(imageData(20, 20, () => 255)).join(" "), /washed out/i);
  assert.match(assessImageQuality(imageData(20, 20, (x, y) => 100 + x * 2 + y * 2)).join(" "), /blurry/i);
});

test("confirmed pages become one ordered multi-page PDF; invalid sizes are rejected", async () => {
  const pages = [
    { width: 100, height: 160, bytes: new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]) },
    { width: 120, height: 180, bytes: new Uint8Array([0xff, 0xd8, 0x02, 0xff, 0xd9]) },
  ];
  const pdf = await buildScanPdf(pages);
  const source = new TextDecoder().decode(await pdf.arrayBuffer());
  assert.equal(pdf.type, "application/pdf");
  assert.match(source, /^%PDF-1\.4/);
  assert.match(source, /\/Count 2/);
  assert.ok(source.indexOf("\u0001") < source.indexOf("\u0002"));
  await assert.rejects(buildScanPdf([{ width: 5000, height: 50, bytes: new Uint8Array([1]) }]), /scanner limit/);
  await assert.rejects(buildScanPdf([]), /between 1 and 10 pages/);
  await assert.rejects(buildScanPdf(Array.from({ length: 2 }, () => ({ width: 10, height: 10, bytes: new Uint8Array(10 * 1024 * 1024) }))), /would exceed 20 MB/);
});
