"use strict";
// Everything drawn on the timeline: waveforms, the bar ruler, zoom & scroll, markers, loop selection,
// plus the play loop that redraws while playing.

// view = the slice of the song currently shown (song seconds). Everything maps time <-> pixels through it.
const view = {a: 0, b: 0};
const viewLen = () => Math.max(0.5, view.b - view.a);
const tToX = (t, w) => (t - view.a) / viewLen() * w;
const xToT = (x, w) => clamp(view.a + x / w * viewLen(), 0, duration);
function setView(a, b, {keep = false} = {}) {
  const len = clamp(b - a, Math.min(2, duration), duration);
  a = clamp(a, 0, Math.max(0, duration - len));
  view.a = a; view.b = a + len;
  $("#zoomLabel").textContent = len >= duration - 0.01 ? "" : `${Math.round(duration / len * 10) / 10}×`;
  $("#zoomFit").hidden = len >= duration - 0.01;
  if (!keep) saveViewSoon();
  drawAll();
}
const zoomBy = (factor, at = (view.a + view.b) / 2) => {
  const len = viewLen() * factor, f = (at - view.a) / viewLen();
  setView(at - f * len, at - f * len + len);
};
let viewTimer = null;
const saveViewSoon = () => { clearTimeout(viewTimer); viewTimer = setTimeout(saveState, 400); };

function columnPeak(p, t0, t1) {
  // Zoomed out: use the precomputed overview. Zoomed in: read the real samples (crisper).
  if (p.buf && !p.isTake && (t1 - t0) * p.buf.sampleRate / rate < 40000 || p.isTake) {
    const sr = p.buf.sampleRate, d = p.buf.getChannelData(0), d2 = p.buf.numberOfChannels > 1 ? p.buf.getChannelData(1) : d;
    const off = p.isTake ? p.start : 0, r = p.isTake ? p.rate : rate;
    let a = Math.floor((t0 / r - off) * sr), b = Math.ceil((t1 / r - off) * sr);
    if (b <= 0 || a >= d.length) return 0;
    a = Math.max(0, a); b = Math.min(d.length, b);
    const step = Math.max(1, Math.floor((b - a) / 96));
    let m = 0; for (let i = a; i < b; i += step) { const v = Math.max(Math.abs(d[i]), Math.abs(d2[i])); if (v > m) m = v; }
    return m * 255;
  }
  const pk = p.peaks, n = pk.length;
  const a = Math.floor(t0 / duration * n), b = Math.max(a + 1, Math.ceil(t1 / duration * n));
  let m = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (pk[i] > m) m = pk[i];
  return m;
}
function renderWaveCache(p) {
  const c = p.canvas, dpr = devicePixelRatio || 1, w = Math.max(1, c.clientWidth), h = c.clientHeight;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const cols = new Float32Array(w);
  for (let x = 0; x < w; x++) cols[x] = columnPeak(p, xToT(x, w), xToT(x + 1, w));
  const mk = alpha => {
    const o = document.createElement("canvas"); o.width = c.width; o.height = c.height;
    const g = o.getContext("2d"); g.scale(dpr, dpr); g.fillStyle = p.color; g.globalAlpha = alpha;
    for (let x = 0; x < w; x++) { const v = Math.sqrt(cols[x] / 255) * (h / 2 - 3); if (v > 0.2) g.fillRect(x, h / 2 - v, 1, Math.max(1, v * 2)); }
    g.globalAlpha = 0.25; g.fillRect(0, h / 2, w, 1 / dpr);
    return o;
  };
  p.cache = {w, h, dim: mk(0.42), bright: mk(1), key: cacheKey(p)};
}
const cacheKey = p => `${view.a.toFixed(3)}:${view.b.toFixed(3)}:${p.isTake ? p.start : ""}:${p.buf ? p.buf.length : 0}:${rate}`;

// Colours come from the stylesheet (--cv-*, and one variable per part), so the light and dark looks both work.
let cv = {};
function readTheme() {
  cv = {tick:css("--cv-tick"), tickMajor:css("--cv-tick-major"), text:css("--cv-text"), playhead:css("--cv-playhead"),
        loop:css("--cv-loop"), loopEdge:css("--cv-loop-edge"), sel:css("--cv-sel"), selEdge:css("--cv-sel-edge"),
        marker:css("--cv-marker"), markerLine:css("--cv-marker-line")};
  for (const p of allParts()) { p.color = css(p.isTake ? "--take" : `--${p.name}`) || p.color; p.cache = null; }
}
readTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readTheme(); requestAnimationFrame(drawAll); });

function drawRuler() {
  const c = $("#ruler"); if (!c || !duration) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const X = t => tToX(t, w);
  if (loopA !== null) { g.fillStyle = loopOn() ? cv.loop : cv.sel; g.fillRect(X(loopA), 0, X(loopB) - X(loopA), h); }
  g.font = "10px \"SF Mono\",ui-monospace,Menlo,monospace"; g.textBaseline = "top";
  if (beats) {
    const pxPerBar = X(view.a + beatLen() * beats.perBar);
    const every = pxPerBar > 26 ? 1 : pxPerBar > 13 ? 2 : pxPerBar > 6 ? 4 : pxPerBar > 3 ? 8 : 16;
    for (let i = Math.max(0, beatIndexAt(view.a - 1)); i < beats.times.length && beats.times[i] <= view.b + 1; i++) {
      const bt = beats.times[i];
      const x = Math.round(X(bt)) + 0.5;
      if (isDownbeat(i)) {
        const bar = beats.barOf[i], major = (bar - 1) % every === 0;
        g.fillStyle = major ? cv.tickMajor : cv.tick; g.fillRect(x, major ? 16 : 22, 1, h);
        if (major) { g.fillStyle = cv.text; g.fillText(String(bar), x + 3, 16); }
      } else if (pxPerBar > 30) { g.fillStyle = cv.tick; g.fillRect(x, 25, 1, h); }
    }
  } else {
    const step = [1, 2, 5, 10, 15, 30, 60, 120].find(s => X(view.a + s) > 50) || 300;
    g.fillStyle = cv.text;
    for (let t = Math.ceil(view.a / step) * step; t < view.b; t += step) { const x = Math.round(X(t)) + 0.5; g.fillRect(x, 18, 1, h); g.fillText(fmt(t), x + 3, 16); }
  }
  // markers: flags along the top
  for (const mk of markers) {
    const x = Math.round(X(mk.t)); if (x < -80 || x > w + 2) continue;
    g.fillStyle = cv.marker; g.fillRect(x, 0, 1.5, h);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 7, 0); g.lineTo(x, 7); g.fill();
    g.font = "600 10px \"Avenir Next\",-apple-system,sans-serif"; g.fillText(mk.name, x + 9, 2);
    g.font = "10px ui-monospace,Menlo,monospace";
  }
  const px = Math.round(X(curPos()));
  if (px >= 0 && px <= w) { g.fillStyle = cv.playhead; g.fillRect(px, 0, 1.5, h); }
}
let followView = true;
function drawAll() {
  if (!duration) return;
  const pos = curPos();
  // keep the playhead on screen while playing (page forward like a DAW)
  if (playing && followView && viewLen() < duration - 0.01 && (pos > view.b - viewLen() * 0.03 || pos < view.a))
    setView(pos - viewLen() * 0.05, pos - viewLen() * 0.05 + viewLen(), {keep: true});
  drawRuler();
  for (const p of allParts()) {
    const c = p.canvas; if (!c) continue;
    if (!p.cache || p.cache.w !== c.clientWidth || p.cache.h !== c.clientHeight || p.cache.key !== cacheKey(p)) renderWaveCache(p);
    const {dim, bright} = p.cache, g = c.getContext("2d"), dpr = devicePixelRatio || 1, W = c.width;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, c.height);
    if (loopA !== null) {
      const la = tToX(loopA, W), lb = tToX(loopB, W);
      g.fillStyle = loopOn() ? cv.loop : cv.sel; g.fillRect(la, 0, lb - la, c.height);
      g.fillStyle = loopOn() ? cv.loopEdge : cv.selEdge; g.fillRect(la, 0, dpr, c.height); g.fillRect(lb - dpr, 0, dpr, c.height);
    }
    for (const mk of markers) { const x = tToX(mk.t, W); if (x >= 0 && x <= W) { g.fillStyle = cv.markerLine; g.fillRect(x, 0, dpr, c.height); } }
    g.drawImage(dim, 0, 0);
    const px = Math.round(tToX(pos, W));
    if (px > 0) g.drawImage(bright, 0, 0, Math.min(px, W), c.height, 0, 0, Math.min(px, W), c.height);
    if (px >= 0 && px <= W) { g.fillStyle = cv.playhead; g.fillRect(px, 0, Math.max(1, dpr * 1.5), c.height); }
  }
}
function snap(t, free) {
  if (!beats || free) return t;
  const i = beatIndexAt(t), T = beats.times;
  const cands = [T[Math.max(0, i)], T[Math.min(T.length - 1, i + 1)]];
  const best = cands.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
  return Math.abs(best - t) < beatLen() * 0.5 ? best : t;
}
function barBeatAt(t) {
  if (!beats) return "";
  const i = beatIndexAt(t + 0.02); if (i < 0) return "";
  return beats.barOf[i] ? `bar ${beats.barOf[i]} · beat ${beats.beatInBar[i]}` : `pickup · beat ${beats.beatInBar[i]}`;
}

// ---- markers (saved per track in this browser)
let markers = [];
function saveMarkers() { markers.sort((a, b) => a.t - b.t); saveState(); drawAll(); }
function addMarker(t = curPos()) {
  if (!current) return;
  // snap to the nearest bar line if one is close
  if (beats) {
    let best = t, bd = Infinity;
    for (const d of beats.downs) { const bt = beats.times[d]; if (Math.abs(bt - t) < bd) { bd = Math.abs(bt - t); best = bt; } }
    if (bd < beatLen() * 2) t = best;
  }
  if (markers.some(m => Math.abs(m.t - t) < 0.3)) return toast("There's already a marker here");
  const bb = barBeatAt(t);
  markers.push({t, name: `Section ${markers.length + 1}`});
  saveMarkers(); toast(`Added a marker at ${fmt(t)}${bb ? " (" + bb.split(" ·")[0] + ")" : ""}. Double-click it to rename, Shift-click to loop it.`);
}
function markerAt(x, c) {
  const r = c.getBoundingClientRect();
  return markers.find(m => { const mx = r.left + tToX(m.t, r.width); return x >= mx - 4 && x <= mx + 10 + m.name.length * 6; });
}
function loopMarker(m) {
  const next = markers.find(o => o.t > m.t + 0.01);
  loopA = m.t; loopB = next ? next.t : duration; $("#loop").checked = true; updateLoopHint();
  seek(loopA); saveState();
}
function jumpMarker(dir) {
  const t = curPos();
  const m = dir > 0 ? markers.find(o => o.t > t + 0.25) : [...markers].reverse().find(o => o.t < t - 0.75);
  if (m) seek(m.t); else if (dir < 0) seek(loopOn() ? loopA : 0);
}

// ---- mouse: click to seek, drag to select, drag edges, wheel to zoom/scroll
let drag = null;
function attachWaveMouse(c, isRuler = false) {
  const toT = x => { const r = c.getBoundingClientRect(); return xToT(x - r.left, r.width); };
  const edgeAt = x => {
    if (loopA === null) return null;
    const r = c.getBoundingClientRect(), pa = r.left + tToX(loopA, r.width), pb = r.left + tToX(loopB, r.width);
    if (Math.abs(x - pa) < 7) return "a"; if (Math.abs(x - pb) < 7) return "b"; return null;
  };
  c.addEventListener("mousemove", e => {
    if (drag) return;
    const mk = isRuler && markerAt(e.clientX, c);
    c.style.cursor = mk ? "pointer" : edgeAt(e.clientX) ? "ew-resize" : "pointer";
    showHover(e.clientX, e.clientY, toT(e.clientX), mk ? `${mk.name} — click to jump · Shift-click to loop · double-click to rename · right-click to delete` : "");
  });
  c.addEventListener("mouseleave", hideHover);
  c.addEventListener("mousedown", e => {
    if (e.button !== 0 || recording) return;
    e.preventDefault();
    const mk = isRuler && markerAt(e.clientX, c);
    if (mk) { e.shiftKey ? loopMarker(mk) : seek(mk.t); return; }
    drag = {c, toT, x0: e.clientX, t0: toT(e.clientX), edge: edgeAt(e.clientX), moved: false};
  });
  if (isRuler) {
    c.addEventListener("dblclick", e => {
      const mk = markerAt(e.clientX, c);
      if (mk) { const n = prompt("Name this marker (e.g. Intro, Head, Solo 1, Bridge)", mk.name); if (n) { mk.name = n.trim().slice(0, 40) || mk.name; saveMarkers(); } }
      else addMarker(snap(toT(e.clientX), e.altKey));
    });
    c.addEventListener("contextmenu", e => {
      const mk = markerAt(e.clientX, c); if (!mk) return;
      e.preventDefault();
      if (confirm(`Delete marker “${mk.name}”?`)) { markers = markers.filter(m => m !== mk); saveMarkers(); }
    });
  }
}
window.addEventListener("mousemove", e => {
  if (!drag) return;
  const t = snap(drag.toT(e.clientX), e.altKey);
  showHover(e.clientX, e.clientY, t);
  if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
  drag.moved = true;
  const t0 = snap(drag.t0, e.altKey);
  if (drag.edge === "a") loopA = Math.min(t, loopB - 0.2);
  else if (drag.edge === "b") loopB = Math.max(t, loopA + 0.2);
  else { loopA = Math.min(t0, t); loopB = Math.max(t0, t); }
  updateLoopHint(); drawAll();
});
function endDrag(e) {
  if (!drag) return;
  const d = drag; drag = null; hideHover();
  if (!e) { drawAll(); return; }
  if (!d.moved) {
    if (loopOn() && (d.t0 < loopA || d.t0 > loopB)) { $("#loop").checked = false; updateLoopHint(); }
    seek(d.t0);
  } else {
    if (loopB - loopA < 0.2) { loopA = loopB = null; }
    else { $("#loop").checked = true; if (!d.edge || playing) seek(d.edge === "b" ? Math.max(loopA, loopB - 2) : loopA); }
    updateLoopHint();
  }
  saveState(); drawAll();
}
window.addEventListener("mouseup", e => endDrag(e));
window.addEventListener("blur", () => endDrag(null));
// Trackpad/mouse wheel over the waveforms: pinch or ⌘/Ctrl+scroll zooms, sideways scroll pans.
$("#rows").addEventListener("wheel", e => {
  if (!duration || !e.target.closest("canvas")) return;
  const c = e.target.closest("canvas"), r = c.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomBy(Math.exp(e.deltaY * 0.01), xToT(e.clientX - r.left, r.width));
    followView = false; setTimeout(() => followView = true, 1500);
  } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
    if (viewLen() >= duration - 0.01) return;
    e.preventDefault();
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const shift = dx / r.width * viewLen();
    setView(view.a + shift, view.b + shift);
    followView = false; setTimeout(() => followView = true, 1500);
  }
}, {passive: false});
function showHover(x, y, t, extra = "") {
  const tip = $("#hovertip"), line = $("#hoverline"), rows = $("#rows");
  const bb = barBeatAt(t);
  tip.textContent = extra || (fmt(t) + (bb ? `  ·  ${bb}` : "")); tip.style.display = "block";
  tip.style.left = Math.min(x + 12, innerWidth - (extra ? 420 : 190)) + "px"; tip.style.top = (y - 28) + "px";
  line.style.display = "block"; line.style.left = (x - rows.getBoundingClientRect().left + rows.scrollLeft) + "px";
  line.style.top = rows.scrollTop + "px"; line.style.height = rows.clientHeight + "px";
}
function hideHover() { if (!drag) { $("#hovertip").style.display = "none"; $("#hoverline").style.display = "none"; } }
function updateLoopHint() {
  const has = loopA !== null;
  $("#loopHint").textContent = has ? `Section ${fmt(loopA)}–${fmt(loopB)}${beats ? ` (${barsIn(loopA, loopB)})` : ""}${loopOn() ? (playing && loopPass > 1 ? ` · pass ${loopPass}` : "") : " · loop off"}`
                                   : "Drag across a waveform or the ruler to select a section";
  $("#clearLoop").style.display = has ? "inline-block" : "none";
  $("#loop").disabled = !has;
}
$("#loop").onchange = () => { updateLoopHint(); if (playing && !recording) play(curPos(), {countIn:false}); saveState(); drawAll(); };
$("#clearLoop").onclick = () => { loopA = loopB = null; $("#loop").checked = false; updateLoopHint(); if (playing && !recording) play(curPos(), {countIn:false}); saveState(); drawAll(); };
$("#master").oninput = e => { ensureCtx(); master.gain.value = +e.target.value; saveState(); };
$("#master").ondblclick = e => { e.target.value = 1; master.gain.value = 1; saveState(); };
$("#play").onclick = toggle;
$("#helpBtn").onclick = () => $("#help").showModal();
attachWaveMouse($("#ruler"), true);

function updateTime() {
  if (!current) return;
  const t = curPos();
  $("#tNow").textContent = fmt(t); $("#tDur").textContent = fmt(duration);
  const bb = barBeatAt(t);
  $("#barbeat").textContent = bb;
  $("#fsTime").textContent = `${fmt(t)} / ${fmt(duration)}${bb ? " · " + bb : ""}`;
}
(function tick() { if (playing) { drawAll(); updateTime(); syncVideo(); updateLoopPass(); } requestAnimationFrame(tick); })();
setInterval(() => { if (playing) { scheduleAhead(); syncVideo(); } }, 40);  // also runs when the tab is hidden
setInterval(() => { if (playing) saveState(); }, 3000);
new ResizeObserver(() => drawAll()).observe($("#rows"));
document.addEventListener("mouseup", e => { const b = e.target.closest("button"); if (b && e.detail) b.blur(); });
