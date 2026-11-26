"use strict";
// Chord changes: the chord lane under the ruler, the "now → next" chord in the header, and the chord chart.
// The helper detects the chords (backend/chords.py); here they're named, transposed and drawn.
// Chords follow the key you're playing in (Key ±) and, if you've set an instrument, are written for it.

let chords = [];   // [{t, e, root (0-11, -1 = no chord), q}] in song time

const SHARP_NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const SHARP_KEYS = new Set([7, 2, 9, 4, 11, 6]);  // G D A E B F♯ major (and their relative minors) are spelled with sharps
const QUALITY = {maj:"", min:"m", dim:"°", aug:"+", min6:"m6", maj6:"6", min7:"m7", minmaj7:"m(maj7)", maj7:"maj7",
                 "7":"7", dim7:"°7", hdim7:"m7♭5", sus2:"sus2", sus4:"sus4"};

function setChords(list) {
  chords = (list || []).map(([t, e, root, q]) => ({t, e, root, q}));
  $("#chordRow").hidden = !chords.some(c => c.root >= 0);
  $("#chartBtn").disabled = $("#chordRow").hidden;
  syncChordMode(); drawChords(); updateChordNow();
}
// how far chords are shifted from concert pitch as recorded: the key change you're hearing + your instrument
const writtenForYou = () => !!+prefs.inst && prefs.chordsConcert !== true;
const chordShift = () => rateSemis + (writtenForYou() ? +prefs.inst : 0);
function chordName(c, shift = chordShift()) {
  if (!c || c.root < 0) return "N.C.";
  const keyTonic = songKey ? (songKey.major + shift + 120) % 12 : 0;
  const names = SHARP_KEYS.has(keyTonic) ? SHARP_NAMES : NOTE_NAMES;
  return names[(c.root + shift + 120) % 12] + (QUALITY[c.q] ?? c.q);
}
function chordIndexAt(t) {
  let lo = 0, hi = chords.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (chords[m].e <= t) lo = m + 1; else if (chords[m].t > t) hi = m - 1; else return m; }
  return -1;
}
function nextChord(i) { for (let j = i + 1; j < chords.length; j++) if (chords[j].root >= 0) return chords[j]; return null; }

// ---- the lane: one block per chord; names are placed left to right wherever they fit (a name may run over
// the next few short blocks), and the chord playing now is always named, filled in blue
function drawChords() {
  const c = $("#chordCanvas"); if (!c || $("#chordRow").hidden || !duration) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const now = chordIndexAt(curPos()), shift = chordShift();
  g.font = `600 12.5px ${css("--font") || "sans-serif"}`; g.textBaseline = "middle";
  const shown = [];
  for (let i = 0; i < chords.length; i++) {
    const ch = chords[i]; if (ch.e < view.a || ch.t > view.b || ch.root < 0) continue;
    const x0 = Math.max(tToX(ch.t, w), -4) + 1, x1 = Math.min(tToX(ch.e, w), w + 4) - 1; if (x1 - x0 < 1) continue;
    g.fillStyle = cv.chord; g.beginPath(); g.roundRect(x0, 4, x1 - x0, h - 8, Math.min(7, (x1 - x0) / 2)); g.fill();
    shown.push({i, x0, x1});
  }
  let free = -Infinity;  // where the next name may start
  const nowBlock = shown.find(s => s.i === now), nowName = nowBlock && chordName(chords[now], shift);
  const nowLeft = nowBlock ? nowBlock.x0 : Infinity, nowRight = nowBlock ? nowBlock.x0 + Math.max(nowBlock.x1 - nowBlock.x0, g.measureText(nowName).width + 14) : -Infinity;
  g.fillStyle = cv.chordText;
  for (const {i, x0, x1} of shown) {
    if (i === now) { free = nowRight + 6; continue; }
    const name = chordName(chords[i], shift), tw = g.measureText(name).width, tx = Math.max(x0 + 6, 4);
    if (tx < free || tx + tw > Math.min(w - 2, nowLeft - 6 > tx ? nowLeft - 6 : Infinity)) continue;
    if (x1 - x0 < 3) continue;  // too thin to point at
    g.fillText(name, tx, h / 2 + 0.5); free = tx + tw + 10;
  }
  if (nowBlock) {
    g.fillStyle = cv.chordOn; g.beginPath(); g.roundRect(nowBlock.x0, 3, nowRight - nowBlock.x0, h - 6, 8); g.fill();
    g.fillStyle = cv.chordOnText; g.fillText(nowName, nowBlock.x0 + 7, h / 2 + 0.5);
  }
}

// ---- now → next, in the header and the fullscreen bar
let lastChordIdx = -2;
function updateChordNow() {
  const el = $("#chordNow");
  if (!chords.length || $("#chordRow").hidden) { el.hidden = true; lastChordIdx = -2; return; }
  el.hidden = false;
  const i = chordIndexAt(curPos());
  if (i === lastChordIdx && !updateChordNow.force) return;
  lastChordIdx = i; updateChordNow.force = false;
  const cur = chords[i], nxt = nextChord(i);
  el.innerHTML = `<b>${esc(chordName(cur))}</b>${nxt ? `<span>→ ${esc(chordName(nxt))}</span>` : ""}`;
  $("#fsChord").textContent = chordName(cur) + (nxt ? `  → ${chordName(nxt)}` : "");
  if (chartDlg.open) highlightChartBar();
}
const refreshChordText = () => { updateChordNow.force = true; updateChordNow(); drawChords(); if (chartDlg.open) renderChart(); };

// ---- concert / written for you
function syncChordMode() {
  const btn = $("#chordMode"), inst = INSTRUMENTS.find(i => i.id === prefs.instrument);
  btn.hidden = !+prefs.inst;
  const label = inst?.label.match(/\((.+)\)/)?.[1] || "you";
  btn.textContent = writtenForYou() ? `For ${label}` : "Concert";
  btn.title = writtenForYou() ? "Chords are written for your instrument. Click for concert pitch." : "Chords are at concert pitch. Click to write them for your instrument.";
}
$("#chordMode").onclick = () => { prefs.chordsConcert = writtenForYou(); savePrefs(); syncChordMode(); refreshChordText(); };
$("#chordCanvas").addEventListener("click", e => {
  const r = e.currentTarget.getBoundingClientRect(), t = view.a + (e.clientX - r.left) / r.width * viewLen();
  const i = chordIndexAt(t); if (i >= 0) seek(chords[i].t);
});

// ---- the chord chart: bars in rows of four, like a lead sheet (click a bar to jump there)
const chartDlg = $("#chartDlg");
let chartBars = [];
function barsForChart() {
  if (!beats?.times?.length) {  // no beat grid: just list the changes
    return chords.filter(c => c.root >= 0).map(c => ({t: c.t, e: c.e, names: [chordName(c)]}));
  }
  const starts = []; for (let i = 0; i < beats.times.length; i++) if (isDownbeat(i)) starts.push(beats.times[i]);
  const bars = [];
  starts.forEach((t, k) => {
    const e = starts[k + 1] ?? Math.min(duration, t + (t - (starts[k - 1] ?? t - 2)));
    const names = []; let lastRoot = null;
    for (const c of chords) {
      if (c.e <= t || c.t >= e || c.root < 0) continue;
      if (Math.min(c.e, e) - Math.max(c.t, t) < beatLen() * 0.75) continue;   // passing chords shorter than a beat are left out
      if (c.root === lastRoot) continue;  // E♭maj7 → E♭ in one bar reads as just E♭maj7
      names.push(chordName(c)); lastRoot = c.root;
    }
    bars.push({t, e, names});
  });
  return bars;
}
function renderChart() {
  chartBars = barsForChart();
  const title = current?.title || "", shiftNote = writtenForYou() ? $("#chordMode").textContent : "Concert pitch";
  $("#chartMeta").textContent = `${shiftNote}${rateSemis ? ` · key ${rateSemis > 0 ? "+" : ""}${rateSemis}` : ""}${beats ? ` · ♩ ${Math.round(beats.tempo)}` : ""}`;
  $("#chartTitle").textContent = title;
  let prev = null;
  $("#chartGrid").innerHTML = chartBars.map((b, i) => {
    const txt = b.names.join(" ");
    const sim = txt && txt === prev; prev = txt || prev;
    return `<button class="bar${sim ? " sim" : ""}${txt ? "" : " nc"}" data-i="${i}" title="Bar ${i + 1} · ${fmt(b.t)}">
      <small>${i + 1}</small>${sim ? "<span>%</span>" : b.names.map(n => `<span>${esc(n)}</span>`).join("") || "<span>N.C.</span>"}</button>`;
  }).join("");
  highlightChartBar();
}
function highlightChartBar() {
  const t = curPos(), i = chartBars.findIndex(b => t >= b.t && t < b.e);
  const was = $("#chartGrid .bar.now"); if (was && +was.dataset.i === i) return;
  was?.classList.remove("now");
  const el = $(`#chartGrid .bar[data-i="${i}"]`); if (!el) return;
  el.classList.add("now"); if (playing) el.scrollIntoView({block: "nearest", behavior: "smooth"});
}
function openChart() { if ($("#chordRow").hidden) return; renderChart(); chartDlg.showModal(); highlightChartBar(); }
$("#chartGrid").addEventListener("click", e => { const b = e.target.closest(".bar"); if (b) seek(chartBars[+b.dataset.i].t); });
$("#chartBtn").onclick = openChart;
