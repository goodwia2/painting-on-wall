// Works out where a painting should go on someone's photo.
//
// A small AI model (SegFormer, trained on the ADE20K room dataset) labels
// every part of the photo – wall, sofa, window, floor, existing pictures and so
// on. We turn that into a coarse grid and look for a clear patch of wall,
// preferring the spot above a sofa / sideboard / bed, or where a picture
// already hangs. The model runs in the visitor's browser; the photo is never
// uploaded anywhere. If anything fails we fall back to a simple rule.

const LIB_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
const MODEL = "Xenova/segformer-b0-finetuned-ade-512-512";
const GRID = 96; // grid columns; rows follow the photo's shape

// Things a painting can be hung over (they're on, or are, the wall).
const HANGABLE = new Set(["wall", "painting", "poster", "mirror", "bulletin board"]);
// Things already hanging on the wall: a great spot for the new painting.
const EXISTING_ART = new Set(["painting", "poster", "mirror"]);
// Furniture people usually hang art above.
const FURNITURE = new Set([
  "sofa", "cushion", "pillow", "bed", "table", "cabinet", "desk",
  "chest of drawers", "counter", "fireplace", "buffet", "bench", "coffee table",
]);

let segmenterPromise = null;

// Start downloading the model early so it's ready when a photo arrives.
export function warmUp() {
  if (!segmenterPromise) {
    segmenterPromise = import(LIB_URL)
      .then(({ pipeline }) => pipeline("image-segmentation", MODEL, { dtype: "q8" }))
      .catch((err) => {
        segmenterPromise = null;
        throw err;
      });
  }
  return segmenterPromise;
}

// Analyse a photo (an HTMLCanvasElement). Resolves to a "scene" object used by
// placeArtwork(), or null if the model couldn't run.
export async function analysePhoto(canvas) {
  try {
    const segmenter = await warmUp();
    const small = downscale(canvas, 512);
    const url = URL.createObjectURL(await new Promise((r) => small.toBlob(r, "image/jpeg", 0.9)));
    let segments;
    try {
      segments = await segmenter(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return buildScene(segments, canvas.width / canvas.height);
  } catch (err) {
    console.warn("Wall detection unavailable, using simple placement.", err);
    return null;
  }
}

function downscale(canvas, max) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

function buildScene(segments, aspect) {
  const gw = GRID;
  const gh = Math.max(8, Math.round(GRID / aspect));
  const labels = new Array(gw * gh).fill("");
  for (const { label, mask } of segments) {
    const name = label.trim();
    const { width: mw, height: mh, data, channels = 1 } = mask;
    for (let y = 0; y < gh; y++) {
      const my = Math.min(mh - 1, Math.floor(((y + 0.5) / gh) * mh));
      for (let x = 0; x < gw; x++) {
        const mx = Math.min(mw - 1, Math.floor(((x + 0.5) / gw) * mw));
        if (data[(my * mw + mx) * channels] > 127) labels[y * gw + x] = name;
      }
    }
  }
  return sceneFromLabels(labels, gw, gh);
}

// labels: one label name per grid cell, row by row.
export function sceneFromLabels(labels, gw, gh) {
  const has = (set) => labels.map((l) => set.has(l));
  const hangable = has(HANGABLE);
  return {
    gw, gh, labels,
    hangable,
    integral: integralImage(hangable, gw, gh),
    art: largestBlob(has(EXISTING_ART), gw, gh),
    furniture: largestBlob(has(FURNITURE), gw, gh),
    wallFraction: labels.filter((l) => l === "wall").length / labels.length,
  };
}

// Guess how many photo pixels make one real centimetre.
export function estimateScale(scene, photoW, photoH) {
  let cmPerPhotoHeight = 240; // a typical phone shot of a wall from 2–3 m away
  if (scene) {
    const sofa = largestBlob(scene.labels.map((l) => l === "sofa" || l === "cushion"), scene.gw, scene.gh);
    const ceilFloor = wallSpan(scene);
    if (sofa && sofa.w / scene.gw > 0.2) {
      // a sofa is usually about 2.1 m wide
      cmPerPhotoHeight = (210 / (sofa.w / scene.gw)) * (photoH / photoW);
    } else if (ceilFloor) {
      // both ceiling and floor visible: assume a 2.6 m room
      cmPerPhotoHeight = 260 / ceilFloor;
    }
  }
  let pxPerCm = photoH / cmPerPhotoHeight;
  // keep a 60 cm painting between 10% and 50% of the photo width
  pxPerCm = clamp(pxPerCm, (photoW * 0.1) / 60, (photoW * 0.5) / 60);
  return pxPerCm;
}

// Fraction of photo height between the ceiling and floor in the middle.
function wallSpan({ labels, gw, gh }) {
  let total = 0, n = 0;
  for (let x = Math.floor(gw * 0.3); x < gw * 0.7; x++) {
    let ceil = -1, floor = -1;
    for (let y = 0; y < gh; y++) {
      const l = labels[y * gw + x];
      if (l === "ceiling") ceil = y;
      if ((l === "floor" || l === "rug") && floor < 0) floor = y;
    }
    if (ceil >= 0 && floor > ceil) { total += (floor - ceil) / gh; n++; }
  }
  return n > gw * 0.15 ? total / n : null;
}

// Pick the centre point (as 0–1 fractions of the photo) for a painting whose
// size is given as fractions of the photo width/height.
export function placeArtwork(scene, fw, fh) {
  const fallback = { x: 0.5, y: clamp(0.4, fh / 2 + 0.03, 1 - fh / 2 - 0.03) };
  if (!scene || scene.wallFraction < 0.05) return fallback;

  const { gw, gh, integral, art, furniture } = scene;
  const w = Math.max(1, Math.round(fw * gw));
  const h = Math.max(1, Math.round(fh * gh));
  if (w >= gw || h >= gh) return fallback;

  // Where we'd ideally like the centre to be.
  let idealX = 0.5, idealY = 0.4, pull = 1;
  if (art && art.w * art.h > gw * gh * 0.01) {
    idealX = art.cx / gw;
    idealY = art.cy / gh;
    pull = 2;
  } else if (furniture && furniture.w > gw * 0.15) {
    idealX = furniture.cx / gw;
    // bottom of the painting ~20 cm above the furniture: roughly 6% of the photo
    idealY = furniture.top / gh - 0.06 - fh / 2;
    pull = 1.5;
  }

  let best = null;
  for (let y = 0; y + h <= gh; y++) {
    for (let x = 0; x + w <= gw; x++) {
      const coverage = rectSum(integral, gw, x, y, w, h) / (w * h);
      if (coverage < 0.85) continue;
      const cx = (x + w / 2) / gw;
      const cy = (y + h / 2) / gh;
      const score =
        coverage * 4 -
        Math.abs(cx - idealX) * 1.2 * pull -
        Math.abs(cy - idealY) * 1.6 * pull;
      if (!best || score > best.score) best = { score, x: cx, y: cy };
    }
  }
  return best ? { x: best.x, y: best.y } : fallback;
}

// ---- small grid helpers ----

function integralImage(cells, w, h) {
  const I = new Float32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += cells[y * w + x] ? 1 : 0;
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

function rectSum(I, w, x, y, rw, rh) {
  const W = w + 1;
  return I[(y + rh) * W + x + rw] - I[y * W + x + rw] - I[(y + rh) * W + x] + I[y * W + x];
}

// Biggest connected group of true cells: its box and centre.
function largestBlob(cells, w, h) {
  const seen = new Uint8Array(cells.length);
  let best = null;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let n = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, y = (j / w) | 0;
      n++; sx += x; sy += y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= cells.length || seen[k] || !cells[k]) continue;
        if ((k === j - 1 || k === j + 1) && ((k / w) | 0) !== y) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (!best || n > best.n) {
      best = { n, cx: sx / n + 0.5, cy: sy / n + 0.5, top: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  }
  return best && best.n >= 4 ? best : null;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
