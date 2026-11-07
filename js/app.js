import { ARTWORKS, FRAMES } from "./artworks.js";
import { warmUp, analysePhoto, estimateScale, placeArtwork, sceneFromLabels } from "./placement.js";

const MAX_PHOTO = 2000; // longest side we keep from an uploaded photo (px)

const $ = (id) => document.getElementById(id);
const els = {
  stage: $("stage"), start: $("start"), photoBox: $("photo-box"), scene: $("scene"), photo: $("photo"),
  art: $("art"), artImg: $("art-img"), handle: $("handle"), badge: $("size-badge"),
  status: $("status"), statusText: $("status-text"), hint: $("hint"),
  artList: $("art-list"), framePicker: $("frame-picker"),
  sizeRange: $("size-range"), sizeValue: $("size-value"),
  saveBtn: $("save-btn"), resetBtn: $("reset-btn"),
  zoomControls: $("zoom-controls"), zoomFit: $("zoom-fit"),
};

const state = {
  artwork: ARTWORKS[0],
  frame: "none",
  hasPhoto: false,
  scene: null,       // wall analysis of the current photo
  pxPerCm: 1,        // photo pixels per real cm (our estimate)
  sizeFactor: 1,     // the visitor's correction to that estimate
  pos: { x: 0.5, y: 0.4 }, // painting centre, as fractions of the photo
  userMoved: false,
  userSized: false,
  selected: false,   // painting tapped: gestures move it instead of zooming
  photoToken: 0,     // ignores stale analysis if a new photo is chosen
};

const aspects = new Map(); // artwork id -> width / height of the image file
const view = { z: 1, x: 0, y: 0 }; // zoom and pan of the whole scene
const MAX_ZOOM = 4;

// ---------- setup ----------

buildArtList();
buildFramePicker();
preloadAspects();
bindPhotoInputs();
bindGestures();
bindControls();
new ResizeObserver(() => state.hasPhoto && layout()).observe(els.stage);

function buildArtList() {
  for (const a of ARTWORKS) {
    const li = document.createElement("li");
    li.className = "art-item";
    li.setAttribute("role", "option");
    li.tabIndex = 0;
    li.dataset.id = a.id;
    li.innerHTML = `
      <div class="art-thumb"><img src="${a.thumb}" alt="" loading="lazy"></div>
      <div class="art-title"></div>
      <div class="art-size">${a.width} × ${a.height} cm</div>`;
    li.querySelector(".art-title").textContent = a.title;
    const choose = () => selectArtwork(a);
    li.addEventListener("click", choose);
    li.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose()));
    els.artList.append(li);
  }
  markSelectedArtwork();
}

function buildFramePicker() {
  for (const [key, f] of Object.entries(FRAMES)) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.frame = key;
    b.innerHTML = `<span class="swatch ${key === "none" ? "none" : ""}" style="${f.color ? `background:${f.color}` : ""}"></span>${f.label}`;
    b.addEventListener("click", () => {
      state.frame = key;
      markSelectedFrame();
      render();
    });
    els.framePicker.append(b);
  }
  markSelectedFrame();
}

function preloadAspects() {
  for (const a of ARTWORKS) {
    const img = new Image();
    img.onload = () => {
      aspects.set(a.id, img.naturalWidth / img.naturalHeight);
      if (a === state.artwork) render();
    };
    img.src = a.image;
  }
}

function markSelectedArtwork() {
  for (const li of els.artList.children) li.setAttribute("aria-selected", li.dataset.id === state.artwork.id);
}
function markSelectedFrame() {
  for (const b of els.framePicker.children) b.setAttribute("aria-checked", b.dataset.frame === state.frame);
}

// ---------- photo in ----------

function bindPhotoInputs() {
  for (const input of [$("file-input"), $("file-input-2")]) {
    input.addEventListener("click", () => warmUp().catch(() => {}));
    input.addEventListener("change", () => {
      if (input.files[0]) loadPhotoFile(input.files[0]);
      input.value = "";
    });
  }
  $("sample-btn").addEventListener("click", loadSampleRoom);

  // desktop drag-and-drop
  const stage = els.stage;
  stage.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("dragover"); });
  stage.addEventListener("dragleave", () => stage.classList.remove("dragover"));
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    stage.classList.remove("dragover");
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (file) { warmUp().catch(() => {}); loadPhotoFile(file); }
  });
}

async function loadPhotoFile(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    alert("Sorry, that photo couldn't be opened. Please try a JPG or PNG.");
    return;
  }
  const s = Math.min(1, MAX_PHOTO / Math.max(bitmap.width, bitmap.height));
  const c = els.photo;
  c.width = Math.round(bitmap.width * s);
  c.height = Math.round(bitmap.height * s);
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();

  const token = startNewPhoto(estimateScale(null, c.width, c.height));
  setStatus("Finding a good spot…");
  const scene = await analysePhoto(c);
  if (token !== state.photoToken) return;
  setStatus(null);
  state.scene = scene;
  if (!state.userSized) state.pxPerCm = estimateScale(scene, c.width, c.height);
  if (!state.userMoved) autoPlace(true);
  render();
}

function loadSampleRoom() {
  const { canvas, scene } = drawSampleRoom();
  const c = els.photo;
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext("2d").drawImage(canvas, 0, 0);
  startNewPhoto(estimateScale(scene, c.width, c.height));
  state.scene = scene;
  autoPlace(false);
  render();
}

// Reset per-photo state and show the stage. Returns a token for this photo.
function startNewPhoto(pxPerCm) {
  Object.assign(state, {
    hasPhoto: true, scene: null, pxPerCm, sizeFactor: 1,
    userMoved: false, userSized: false, photoToken: state.photoToken + 1,
  });
  els.start.hidden = true;
  els.photoBox.hidden = false;
  els.saveBtn.disabled = els.resetBtn.disabled = false;
  syncSizeRange();
  setSelected(false);
  resetView();
  layout();
  autoPlace(false);
  render();
  showHint();
  return state.photoToken;
}

// ---------- layout & drawing ----------

// Fit the photo inside the stage, keeping its shape.
function layout() {
  const pw = els.photo.width, ph = els.photo.height;
  const sw = els.stage.clientWidth;
  // on phones, shrink the stage to the photo's shape so there are no empty bands
  els.stage.style.height = "";
  if (innerWidth < 900) els.stage.style.height = `${Math.min(els.stage.clientHeight, Math.round((sw * ph) / pw))}px`;
  const sh = els.stage.clientHeight;
  const s = Math.min(sw / pw, sh / ph);
  els.photoBox.style.width = `${Math.round(pw * s)}px`;
  els.photoBox.style.height = `${Math.round(ph * s)}px`;
  applyView();
  render();
}

// Real size of the painting in cm. We trust the photo's shape and match the
// longer side to the listed size.
function artSizeCm(a = state.artwork) {
  const aspect = aspects.get(a.id) ?? a.width / a.height;
  const long = Math.max(a.width, a.height);
  return aspect >= 1 ? { w: long, h: long / aspect } : { w: long * aspect, h: long };
}

// Painting rectangle (including frame) in photo pixels.
function artRect() {
  const { w, h } = artSizeCm();
  const f = FRAMES[state.frame];
  const ppc = state.pxPerCm * state.sizeFactor;
  const border = f.width + f.gap;
  const W = (w + border * 2) * ppc;
  const H = (h + border * 2) * ppc;
  return {
    x: state.pos.x * els.photo.width - W / 2,
    y: state.pos.y * els.photo.height - H / 2,
    w: W, h: H, face: f.width * ppc, gap: f.gap * ppc, ppc,
  };
}

function render() {
  if (!state.hasPhoto) return;
  const a = state.artwork;
  const f = FRAMES[state.frame];
  const r = artRect();
  const d = els.photoBox.clientWidth / els.photo.width; // photo px -> screen px
  const art = els.art;
  if (els.artImg.getAttribute("src") !== a.image) els.artImg.src = a.image;
  Object.assign(art.style, {
    left: `${r.x * d}px`, top: `${r.y * d}px`,
    width: `${r.w * d}px`, height: `${r.h * d}px`,
  });
  art.style.setProperty("--u", `${r.ppc * d}px`);
  art.style.setProperty("--frame", `${r.face * d}px`);
  art.style.setProperty("--gap", `${r.gap * d}px`);
  for (const k of ["light", "mid", "dark", "gapColor"]) art.style.setProperty(`--f-${k}`, f[k] ?? "transparent");
  art.classList.toggle("framed", !!f.color);
  art.setAttribute("aria-label", `${a.title}, ${a.width} × ${a.height} cm. Drag to move.`);
  els.badge.textContent = `${a.title} · ${a.width} × ${a.height} cm`;
}

function autoPlace(glide) {
  const r = artRect();
  state.pos = placeArtwork(state.scene, r.w / els.photo.width, r.h / els.photo.height);
  if (glide) {
    els.art.classList.add("gliding");
    setTimeout(() => els.art.classList.remove("gliding"), 650);
  }
}

function selectArtwork(a) {
  state.artwork = a;
  markSelectedArtwork();
  if (state.hasPhoto && !state.userMoved) autoPlace(true);
  else clampPos();
  render();
}

function setStatus(text) {
  els.status.hidden = !text;
  if (text) els.statusText.textContent = text;
}

let hintTimer;
function showHint() {
  els.hint.textContent = matchMedia("(pointer: coarse)").matches
    ? "Tap the painting to move it · pinch to zoom"
    : "Click the painting to move it · scroll to zoom";
  els.hint.hidden = false;
  els.hint.classList.remove("fade");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => els.hint.classList.add("fade"), 4000);
}

// ---------- moving, resizing & zooming ----------
// Tapping the painting selects it: then gestures move and resize it.
// Otherwise gestures zoom and pan the whole scene (room + painting).

function setSelected(on) {
  state.selected = on;
  els.art.classList.toggle("active", on);
}

function applyView() {
  const W = els.photoBox.clientWidth, H = els.photoBox.clientHeight;
  view.z = clamp(view.z, 1, MAX_ZOOM);
  view.x = clamp(view.x, W - W * view.z, 0);
  view.y = clamp(view.y, H - H * view.z, 0);
  els.scene.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  els.scene.style.setProperty("--zoom", view.z);
  const zoomed = view.z > 1.01;
  els.photoBox.classList.toggle("zoomed", zoomed);
  els.zoomFit.hidden = !zoomed;
}

// Zoom to z while keeping the point (px, py) in the photo box still.
function zoomAt(z, px, py, animate = false) {
  const nz = clamp(z, 1, MAX_ZOOM);
  view.x = px - ((px - view.x) * nz) / view.z;
  view.y = py - ((py - view.y) * nz) / view.z;
  view.z = nz;
  if (animate) {
    els.scene.classList.add("animate");
    setTimeout(() => els.scene.classList.remove("animate"), 320);
  }
  applyView();
}

function resetView(animate = false) {
  zoomAt(1, 0, 0, animate);
}

function bindGestures() {
  const box = els.photoBox;
  const pointers = new Map();
  let start = null;  // snapshot when a gesture (or finger count) begins
  let mode = null;   // "drag" | "pinch" | "handle" (painting) or "pan" | "zoom" (view)
  let moved = false;
  let lastTap = null;

  const local = (p) => {
    const b = box.getBoundingClientRect();
    return { x: p.x - b.left, y: p.y - b.top };
  };

  const snapshot = () => {
    const pts = [...pointers.values()];
    const s = els.scene.getBoundingClientRect(); // on-screen size, including zoom
    start = {
      pos: { ...state.pos }, size: state.sizeFactor, view: { ...view }, s,
      mid: midpoint(pts), dist: distance(pts),
    };
    if (mode === "handle") {
      start.centre = { x: s.left + state.pos.x * s.width, y: s.top + state.pos.y * s.height };
      start.dist = Math.hypot(pts[0].x - start.centre.x, pts[0].y - start.centre.y);
    }
  };

  box.addEventListener("pointerdown", (e) => {
    if (els.zoomControls.contains(e.target)) return;
    box.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      moved = false;
      const onArt = els.art.contains(e.target);
      if (onArt) setSelected(true);
      mode = e.target === els.handle ? "handle" : onArt ? "drag" : "pan";
    } else if (pointers.size === 2) {
      mode = state.selected ? "pinch" : "zoom";
      moved = true;
    }
    els.art.classList.toggle("dragging", mode === "drag" || mode === "pinch");
    els.hint.classList.add("fade");
    snapshot();
  });

  box.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!mode) return;
    const pts = [...pointers.values()];
    const m = midpoint(pts);
    if (Math.hypot(m.x - start.mid.x, m.y - start.mid.y) > 6) moved = true;

    if (mode === "pan") {
      view.x = start.view.x + (m.x - start.mid.x);
      view.y = start.view.y + (m.y - start.mid.y);
      applyView();
      return;
    }
    if (mode === "zoom") {
      // keep the spot that was under the fingers under the fingers
      const z = clamp(start.view.z * (distance(pts) / start.dist), 1, MAX_ZOOM);
      const a = local(start.mid), b = local(m);
      view.x = b.x - ((a.x - start.view.x) * z) / start.view.z;
      view.y = b.y - ((a.y - start.view.y) * z) / start.view.z;
      view.z = z;
      applyView();
      return;
    }

    const { s } = start;
    if (mode === "drag" || mode === "pinch") {
      state.pos = {
        x: start.pos.x + (m.x - start.mid.x) / s.width,
        y: start.pos.y + (m.y - start.mid.y) / s.height,
      };
      state.userMoved = true;
    }
    if (mode === "pinch" && start.dist > 0) {
      setSize(start.size * (distance(pts) / start.dist));
    }
    if (mode === "handle" && start.dist > 0) {
      const dNow = Math.hypot(pts[0].x - start.centre.x, pts[0].y - start.centre.y);
      setSize(start.size * (dNow / start.dist));
    }
    clampPos();
    render();
  });

  const end = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) {
      if (mode === "pan" && !moved && e.type === "pointerup") tapped(local({ x: e.clientX, y: e.clientY }));
      mode = null;
      els.art.classList.remove("dragging");
    } else {
      // one finger lifted from a pinch: carry on with the remaining finger
      if (mode === "pinch") mode = "drag";
      if (mode === "zoom") mode = "pan";
      snapshot();
    }
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);

  // tap off the painting: deselect it. Double-tap: zoom in / back out.
  function tapped(p) {
    setSelected(false);
    const now = performance.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      if (view.z > 1.01) resetView(true);
      else zoomAt(2.5, p.x, p.y, true);
      lastTap = null;
    } else {
      lastTap = { t: now, ...p };
    }
  }

  // mouse wheel / trackpad pinch: resize the selected painting, otherwise zoom
  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    if (state.selected) {
      setSize(state.sizeFactor * factor);
      render();
    } else {
      const p = local({ x: e.clientX, y: e.clientY });
      zoomAt(view.z * factor, p.x, p.y);
    }
  }, { passive: false });

  // zoom buttons
  const centre = () => [els.photoBox.clientWidth / 2, els.photoBox.clientHeight / 2];
  $("zoom-in").addEventListener("click", () => zoomAt(view.z * 1.5, ...centre(), true));
  $("zoom-out").addEventListener("click", () => zoomAt(view.z / 1.5, ...centre(), true));
  els.zoomFit.addEventListener("click", () => resetView(true));

  // keyboard: arrows move, +/- resize
  els.art.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      state.pos.x += moves[e.key][0];
      state.pos.y += moves[e.key][1];
      state.userMoved = true;
    } else if (e.key === "+" || e.key === "=") setSize(state.sizeFactor * 1.05);
    else if (e.key === "-") setSize(state.sizeFactor / 1.05);
    else if (e.key === "Escape") return setSelected(false);
    else return;
    e.preventDefault();
    clampPos();
    render();
  });
}

function setSize(f) {
  state.sizeFactor = Math.min(2.5, Math.max(0.4, f));
  state.userSized = true;
  syncSizeRange();
}

function syncSizeRange() {
  const pct = Math.round(state.sizeFactor * 100);
  els.sizeRange.value = pct;
  els.sizeValue.textContent = `${pct}%`;
}

// Keep the painting's centre on the photo.
function clampPos() {
  state.pos.x = Math.min(1, Math.max(0, state.pos.x));
  state.pos.y = Math.min(1, Math.max(0, state.pos.y));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const midpoint = (pts) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const distance = (pts) => (pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));

// ---------- controls ----------

function bindControls() {
  els.sizeRange.addEventListener("input", () => {
    setSize(els.sizeRange.value / 100);
    render();
  });
  els.resetBtn.addEventListener("click", () => {
    state.userMoved = false;
    autoPlace(true);
    render();
  });
  els.saveBtn.addEventListener("click", saveImage);
}

// ---------- saving ----------

async function saveImage() {
  const photo = els.photo;
  const a = state.artwork;
  const f = FRAMES[state.frame];
  const r = artRect();
  const caption = Math.round(photo.height * 0.07);

  const c = document.createElement("canvas");
  c.width = photo.width;
  c.height = photo.height + caption;
  const ctx = c.getContext("2d");
  ctx.drawImage(photo, 0, 0);

  // tight contact shadow so it sits flush against the wall
  for (const [alpha, offset, blur] of [[0.28, 0.1, 0.25], [0.12, 0.3, 0.9]]) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${alpha})`;
    ctx.shadowOffsetY = r.ppc * offset;
    ctx.shadowBlur = r.ppc * blur;
    ctx.fillStyle = f.color ?? "#888";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  const img = await loadImage(a.image);
  const inset = r.face + r.gap;
  const inner = { x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 };
  if (f.color) drawFrame(ctx, r, f);
  ctx.drawImage(img, inner.x, inner.y, inner.w, inner.h);
  if (f.color) drawFrameShadow(ctx, r);

  // caption strip
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, photo.height, c.width, caption);
  ctx.fillStyle = "#1d1d1b";
  ctx.textBaseline = "middle";
  const fs = Math.round(caption * 0.34);
  ctx.font = `500 ${fs}px Georgia, serif`;
  const frameText = state.frame === "none" ? "unframed" : `${f.label.toLowerCase()} frame`;
  ctx.fillText(`${a.title}  ·  ${a.width} × ${a.height} cm  ·  ${frameText}`, fs, photo.height + caption / 2);

  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
  const file = new File([blob], `${a.id}-on-my-wall.jpg`, { type: "image/jpeg" });

  // phones: open the share sheet (save to Photos, send to a friend…)
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: a.title });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: file.name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Four mitred frame edges, lit from above, plus the shadow gap inside them.
function drawFrame(ctx, r, f) {
  const { x, y, w, h, face: t } = r;
  const side = (color, pts) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.fill();
  };
  side(f.light, [[x, y], [x + w, y], [x + w - t, y + t], [x + t, y + t]]);
  side(f.dark, [[x, y + h], [x + w, y + h], [x + w - t, y + h - t], [x + t, y + h - t]]);
  side(f.mid, [[x, y], [x + t, y + t], [x + t, y + h - t], [x, y + h]]);
  side(f.mid, [[x + w, y], [x + w - t, y + t], [x + w - t, y + h - t], [x + w, y + h]]);
  ctx.fillStyle = f.gapColor;
  ctx.fillRect(x + t, y + t, w - t * 2, h - t * 2);
}

// Soft shadow the frame casts into the gap and onto the top of the canvas.
function drawFrameShadow(ctx, r) {
  const x = r.x + r.face, y = r.y + r.face, w = r.w - r.face * 2, h = r.h - r.face * 2;
  const depth = r.gap + r.ppc * 0.8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  let g = ctx.createLinearGradient(0, y, 0, y + depth);
  g.addColorStop(0, "rgba(0,0,0,0.5)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, depth);
  g = ctx.createLinearGradient(x, 0, x + depth * 0.6, 0);
  g.addColorStop(0, "rgba(0,0,0,0.3)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, depth * 0.6, h);
  ctx.restore();
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ---------- sample room ----------

// Draws a simple living room and the matching wall map, so people can try the
// page without a photo of their own.
function drawSampleRoom() {
  const W = 1600, H = 1200;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const floorY = 0.8, sofa = { x0: 0.25, x1: 0.75, top: 0.5 };
  const table = { x0: 0.81, x1: 0.89, top: 0.66 };

  // wall with soft light from the upper left
  let grad = g.createLinearGradient(0, 0, 0, H * floorY);
  grad.addColorStop(0, "#ebe6de");
  grad.addColorStop(1, "#ddd6cb");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H * floorY);
  grad = g.createRadialGradient(W * 0.2, 0, 0, W * 0.2, 0, W * 0.9);
  grad.addColorStop(0, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H * floorY);

  // skirting and timber floor
  g.fillStyle = "#f5f3ef";
  g.fillRect(0, H * (floorY - 0.025), W, H * 0.025);
  g.fillStyle = "#b68c60";
  g.fillRect(0, H * floorY, W, H * (1 - floorY));
  g.strokeStyle = "rgba(80,50,20,0.18)";
  g.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    const y = H * floorY + (H * (1 - floorY) * i) / 6;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }

  // sofa
  const sx = W * sofa.x0, sw = W * (sofa.x1 - sofa.x0), st = H * sofa.top, sb = H * (floorY - 0.015);
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.beginPath(); g.ellipse(sx + sw / 2, H * floorY, sw * 0.52, H * 0.012, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#3f3a33";
  for (const lx of [sx + sw * 0.06, sx + sw * 0.94]) g.fillRect(lx - 6, sb - 4, 12, H * floorY - sb + 4);
  roundRect(g, sx + sw * 0.04, st, sw * 0.92, H * 0.16, 26, "#7d8b78");        // back
  roundRect(g, sx, st + H * 0.1, sw * 0.08, sb - st - H * 0.1, 22, "#71806c");  // left arm
  roundRect(g, sx + sw * 0.92, st + H * 0.1, sw * 0.08, sb - st - H * 0.1, 22, "#71806c"); // right arm
  roundRect(g, sx + sw * 0.07, st + H * 0.15, sw * 0.86, sb - st - H * 0.15, 18, "#87957f"); // seat
  roundRect(g, sx + sw * 0.1, st + H * 0.06, sw * 0.12, H * 0.1, 16, "#d9cbb3"); // cushions
  roundRect(g, sx + sw * 0.78, st + H * 0.06, sw * 0.12, H * 0.1, 16, "#c9a98a");

  // side table and vase
  const tx = W * table.x0, tw = W * (table.x1 - table.x0), tt = H * table.top;
  g.fillStyle = "#5a4634";
  g.fillRect(tx, tt, tw, H * 0.02);
  g.fillRect(tx + tw * 0.1, tt, 8, H * floorY - tt);
  g.fillRect(tx + tw * 0.9 - 8, tt, 8, H * floorY - tt);
  roundRect(g, tx + tw * 0.35, tt - H * 0.08, tw * 0.3, H * 0.08, 12, "#e9e3d6");

  // matching wall map
  const gw = 96, gh = 72;
  const labels = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const fx = (x + 0.5) / gw, fy = (y + 0.5) / gh;
      let l = "wall";
      if (fy >= floorY) l = "floor";
      else if (fx >= sofa.x0 && fx <= sofa.x1 && fy >= sofa.top) l = "sofa";
      else if (fx >= table.x0 && fx <= table.x1 && fy >= table.top - 0.08) l = "table";
      labels.push(l);
    }
  }
  return { canvas: c, scene: sceneFromLabels(labels, gw, gh) };
}

function roundRect(g, x, y, w, h, r, color) {
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}
