// Reads a receipt photo on the phone itself (Tesseract OCR); the photo never leaves the device.
// Tesseract and its English + Arabic language data download on first use, then the browser caches them.

import { loadScript } from "./ui.js";
import { findAmountCandidates } from "./receipt-parse.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

let workerPromise = null;
let reportProgress = () => {};

function describe(message) {
  const s = message.status || "";
  if (s.includes("recognizing")) return "Reading the text…";
  if (s.includes("loading") || s.includes("initializ")) return "Getting the text reader ready (slower the first time)…";
  return "Working…";
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT);
      return window.Tesseract.createWorker("eng+ara", 1, {
        logger: (m) => reportProgress({ label: describe(m), progress: m.progress ?? 0 }),
      });
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't open that photo. Try taking it again.")); };
    img.src = url;
  });
}

// Shrinks big phone photos (faster, and within iOS canvas limits), converts to grayscale
// and stretches contrast so faded thermal paper reads better.
async function prepare(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, 1600 / img.naturalWidth, 3200 / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    px[i] = g;
    hist[g | 0]++;
  }
  const total = w * h;
  let lo = 0, hi = 255, seen = 0;
  for (; lo < 255 && (seen += hist[lo]) < total * 0.02; lo++);
  seen = 0;
  for (; hi > 0 && (seen += hist[hi]) < total * 0.02; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.min(255, Math.max(0, ((px[i] - lo) * 255) / span));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// Resolves to [{ value, score }], most likely total first. onProgress({ label, progress 0..1 }).
export async function scanReceipt(file, onProgress = () => {}) {
  reportProgress = onProgress;
  onProgress({ label: "Preparing the photo…", progress: 0 });
  const canvas = await prepare(file);
  const worker = await getWorker();
  onProgress({ label: "Reading the text…", progress: 0 });
  const { data } = await worker.recognize(canvas);
  return findAmountCandidates(data.text);
}
