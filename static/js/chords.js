"use strict";
// Chord changes: the chord lane under the ruler, the "now → next" chord in the header, and the chord chart.
// The helper detects the chords (backend/chords.py); here they're named, transposed, drawn — and corrected:
// you can retype any bar in the chart or rename a chord in the lane; your fixes are saved with the song.
// Chords follow the key you're playing in (Key ±) and, if you've set an instrument, are written for it.

let chords = [];          // [{t, e, root (0-11, -1 = no chord), q}] in song time, concert pitch
let detectedChords = [];  // what the helper found (kept so "Reset" can go back to it)
let chordsEdited = false, chordUndo = [];

const SHARP_NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const SHARP_KEYS = new Set([7, 2, 9, 4, 11, 6]);  // G D A E B F♯ major (and their relative minors) are spelled with sharps
const QUALITY = {maj:"", min:"m", dim:"°", aug:"+", min6:"m6", maj6:"6", min7:"m7", minmaj7:"m(maj7)", maj7:"maj7",
                 "7":"7", dim7:"°7", hdim7:"m7♭5", sus2:"sus2", sus4:"sus4"};
const toList = arr => (arr || []).map(([t, e, root, q]) => ({t, e, root, q}));
const hasChords = () => chords.some(c => c.root >= 0);
const chordsShown = () => hasChords() && prefs.chordsOn !== false;

function setChords(detected, mine = null) {
  detectedChords = toList(detected);
  chords = mine?.length ? toList(mine) : detectedChords.map(c => ({...c}));
  chordsEdited = !!mine?.length; chordUndo = [];
  syncChordsVisible();
}
function syncChordsVisible() {
  $("#chartBtn").disabled = !hasChords();
  $("#chordsBtn").hidden = !hasChords();
  $("#chordsBtn").setAttribute("aria-pressed", prefs.chordsOn !== false);
  syncChordMode(); if (typeof syncLanes === "function") syncLanes(); updateChordNow.force = true; updateChordNow(); drawChords();
  requestAnimationFrame(() => typeof drawAll === "function" && drawAll());
}
$("#chordsBtn").onclick = () => { prefs.chordsOn = prefs.chordsOn === false; savePrefs(); syncChordsVisible(); };

// how far chords are shifted from concert pitch as shown: the key change you're hearing + your instrument
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

// ---- typing chords: "Gm7", "B♭maj7", "F#m7b5", "C7#9", "Ebø", "NC" ... (as shown, i.e. written for you)
const LETTER = {C:0, D:2, E:4, F:5, G:7, A:9, B:11};
const SUFFIX = {"":"maj", maj:"maj", M:"maj", m:"min", min:"min", mi:"min", "-":"min",
  "7":"7", "9":"7", "11":"7", "13":"7", maj7:"maj7", M7:"maj7", ma7:"maj7", maj9:"maj7", "Δ":"maj7", "Δ7":"maj7", "^7":"maj7",
  m7:"min7", min7:"min7", mi7:"min7", "-7":"min7", m9:"min7", m11:"min7", min9:"min7",
  m7b5:"hdim7", "-7b5":"hdim7", "ø":"hdim7", "ø7":"hdim7", min7b5:"hdim7",
  dim:"dim", "°":"dim", o:"dim", dim7:"dim7", "°7":"dim7", o7:"dim7", aug:"aug", "+":"aug",
  "6":"maj6", "69":"maj6", "6/9":"maj6", m6:"min6", "-6":"min6", min6:"min6",
  sus:"sus4", sus4:"sus4", "7sus":"sus4", "7sus4":"sus4", sus2:"sus2", mM7:"minmaj7", mmaj7:"minmaj7", "m(maj7)":"minmaj7", "-Δ":"minmaj7"};
function parseChord(tok) {
  if (/^(n\.?c\.?|none|-)$/i.test(tok)) return {root: -1, q: "N"};
  const m = tok.match(/^([A-Ga-g])([#♯b♭]?)(.*)$/); if (!m) return null;
  let root = LETTER[m[1].toUpperCase()] + (/[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0);
  let suf = m[3].split("/")[0].replace(/♭/g, "b").replace(/♯/g, "#").trim();  // a slash bass note isn't kept
  let q = SUFFIX[suf] ?? SUFFIX[suf.replace(/^maj/i, "maj")];
  if (!q) {  // altered or extended chords (7♭9, 7♯11, 13♭9, 7alt...) are kept as written
    if (!/^[\w#b+()-]{1,10}$/.test(suf)) return null;
    q = suf.replace(/b(?=\d)/g, "♭").replace(/#/g, "♯");
  }
  return {root: (root - chordShift() + 240) % 12, q};  // stored at concert pitch
}

// ---- changing chords: replace [t0, t1) with the given chords, splitting the span on beats where possible
function beatsIn(t0, t1) { return (beats?.times || []).filter(b => b >= t0 - 0.02 && b < t1 - 0.02); }
function replaceRange(t0, t1, items) {
  chordUndo.push(JSON.stringify(chords)); if (chordUndo.length > 100) chordUndo.shift();
  const bs = beatsIn(t0, t1), n = items.length, cuts = [t0];
  for (let j = 1; j < n; j++) cuts.push(bs.length >= n ? bs[Math.round(j * bs.length / n)] : t0 + (t1 - t0) * j / n);
  cuts.push(t1);
  const out = [];
  for (const c of chords) {
    if (c.e <= t0 || c.t >= t1) { out.push({...c}); continue; }
    if (c.t < t0) out.push({...c, e: t0});
    if (c.e > t1) out.push({...c, t: t1});
  }
  items.forEach((it, j) => out.push({t: cuts[j], e: cuts[j + 1], root: it.root, q: it.q}));
  out.sort((a, b) => a.t - b.t);
  chords = [];
  for (const c of out) {  // join neighbours that are now the same chord
    const last = chords.at(-1);
    if (last && last.root === c.root && last.q === c.q && Math.abs(last.e - c.t) < 0.02) last.e = c.e; else chords.push(c);
  }
  chordsChanged();
}
let pendingSave = null;  // {timer, run}: the next save, sent 400 ms after the last edit (or straight away on song switch)
function chordsChanged() {
  chordsEdited = true; syncChordsVisible(); if (chartDlg.open) renderChart();
  const id = current?.id, body = JSON.stringify({list: chords.map(c => [c.t, c.e, c.root, c.q])});  // captured now, not later
  if (!id) return;
  if (pendingSave) clearTimeout(pendingSave.timer);
  const run = async () => {
    pendingSave = null;
    try { await api(`/api/jobs/${id}/chords`, {method: "PUT", headers: {"Content-Type": "application/json"}, body}); }
    catch (e) { toast(`Couldn't save your chord changes: ${e.message}`, {type: "err"}); }
  };
  pendingSave = {timer: setTimeout(run, 400), run};
}
function flushChordSave() { if (pendingSave) { clearTimeout(pendingSave.timer); pendingSave.run(); } }
function undoChord() {
  if (!chordUndo.length) return;
  chords = JSON.parse(chordUndo.pop()); chordsChanged();
}
async function resetChords() {
  if (!confirm("Go back to the detected chords? Your changes to this song's chords will be lost.")) return;
  if (pendingSave) { clearTimeout(pendingSave.timer); pendingSave = null; }
  try { await api(`/api/jobs/${current.id}/chords`, {method: "DELETE"}); } catch (e) { return toast(e.message, {type: "err"}); }
  chordUndo.push(JSON.stringify(chords));
  chords = detectedChords.map(c => ({...c})); chordsEdited = false; syncChordsVisible(); if (chartDlg.open) renderChart();
}
// "Gm7 C7" -> chords, or null with a message if something can't be read
function parseLine(text, prevBar) {
  const toks = text.replace(/\|/g, " ").trim().split(/\s+/).filter(Boolean);
  if (toks.length === 1 && toks[0] === "%") return prevBar ? prevBar.items : null;
  const items = toks.map(parseChord);
  const bad = toks.find((t, i) => !items[i]);
  if (bad) { toast(`Couldn't read “${bad}” as a chord — try e.g. Gm7, B♭maj7, F♯m7♭5, C7♯9 or NC`, {type: "err"}); return null; }
  return items;
}

// ---- the lane: one block per chord; names are placed left to right wherever they fit (a name may run over
// the next few short blocks), and the chord playing now is always named, filled in blue
function drawChords() {
  const c = $("#chordCanvas"); if (!c || c.hidden || $("#chordRow").hidden || !duration) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const now = chordIndexAt(curPos()), shift = chordShift();
  g.font = cv.laneFont; g.textBaseline = "middle";
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
  if (!chordsShown()) { el.hidden = true; $("#fsChord").textContent = ""; lastChordIdx = -2; return; }
  el.hidden = false;
  const i = chordIndexAt(curPos());
  if (i === lastChordIdx && !updateChordNow.force) return;
  lastChordIdx = i; updateChordNow.force = false;
  const cur = chords[i], nxt = nextChord(i);
  el.innerHTML = `<b>${esc(chordName(cur))}</b>${nxt ? `<span>→ ${esc(chordName(nxt))}</span>` : ""}`;
  $("#fsChord").textContent = chordName(cur) + (nxt ? `  → ${chordName(nxt)}` : "");
  if (chartDlg.open) highlightChartBar();
}
const refreshChordText = () => { updateChordNow.force = true; updateChordNow(); drawChords(); if (typeof refreshNoteText === "function") refreshNoteText(); if (chartDlg.open && !chartEditing()) renderChart(); };

// ---- concert / written for you
function syncChordMode() {
  const btn = $("#chordMode"), inst = INSTRUMENTS.find(i => i.id === prefs.instrument);
  btn.hidden = !+prefs.inst;
  const label = inst?.label.match(/\((.+)\)/)?.[1] || "you";
  btn.textContent = writtenForYou() ? `For ${label}` : "Concert";
  btn.title = writtenForYou() ? "Chords are written for your instrument. Click for concert pitch." : "Chords are at concert pitch. Click to write them for your instrument.";
}
$("#chordMode").onclick = () => { prefs.chordsConcert = writtenForYou(); savePrefs(); syncChordMode(); refreshChordText(); };

// lane: click a chord to jump there, double-click to rename it
const laneTime = e => { const r = e.currentTarget.getBoundingClientRect(); return view.a + (e.clientX - r.left) / r.width * viewLen(); };
$("#chordCanvas").addEventListener("click", e => { const i = chordIndexAt(laneTime(e)); if (i >= 0) seek(chords[i].t); });
$("#chordCanvas").addEventListener("dblclick", e => {
  const i = chordIndexAt(laneTime(e)); if (i < 0) return;
  const c = chords[i];
  popInput(e.clientX, e.currentTarget.getBoundingClientRect().bottom + 6, c.root < 0 ? "" : chordName(c),
    `Rename this chord (${fmt(c.t)}–${fmt(c.e)}). Several chords split it.`, text => {
      const items = parseLine(text); if (items) replaceRange(c.t, c.e, items); return !!items;
    });
});
function popInput(x, y, value, hint, onEnter) {
  $("#chordPop")?.remove();
  const pop = document.createElement("div"); pop.id = "chordPop"; pop.className = "menu chordpop";
  pop.innerHTML = `<input value="${esc(value)}" spellcheck="false" autocomplete="off" aria-label="Chord"><small>${esc(hint)} Enter saves · Esc cancels</small>`;
  document.body.appendChild(pop);
  pop.style.left = clamp(x - 140, 10, innerWidth - 310) + "px"; pop.style.top = Math.min(y, innerHeight - 120) + "px";
  const input = pop.querySelector("input"); input.focus(); input.select();
  input.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") pop.remove();
    if (ev.key === "Enter" && onEnter(input.value)) pop.remove();
  };
  input.onblur = () => setTimeout(() => pop.remove(), 150);
}

// ---- the chord chart: bars in rows of four, like a lead sheet. Click a bar to jump there; in Edit mode,
// click a bar and type its chords (Tab moves on to the next bar).
const chartDlg = $("#chartDlg");
let chartBars = [];
const chartEditing = () => chartDlg.classList.contains("editing");
function barsForChart() {
  if (!beats?.times?.length) {  // no beat grid: one box per chord
    return chords.filter(c => c.root >= 0).map(c => ({t: c.t, e: c.e, items: [c], names: [chordName(c)]}));
  }
  const starts = []; for (let i = 0; i < beats.times.length; i++) if (isDownbeat(i)) starts.push(beats.times[i]);
  return starts.map((t, k) => {
    const e = starts[k + 1] ?? Math.min(duration, t + (t - (starts[k - 1] ?? t - 2)));
    const items = []; let lastRoot = null;
    for (const c of chords) {
      if (c.e <= t || c.t >= e || c.root < 0) continue;
      if (Math.min(c.e, e) - Math.max(c.t, t) < beatLen() * 0.75) continue;   // passing chords shorter than a beat are left out
      if (c.root === lastRoot) continue;  // E♭maj7 → E♭ in one bar reads as just E♭maj7
      items.push(c); lastRoot = c.root;
    }
    return {t, e, items, names: items.map(c => chordName(c))};
  });
}
function renderChart() {
  chartBars = barsForChart();
  const shiftNote = writtenForYou() ? $("#chordMode").textContent : "Concert pitch";
  $("#chartMeta").textContent = `${shiftNote}${rateSemis ? ` · key ${rateSemis > 0 ? "+" : ""}${rateSemis}` : ""}${beats ? ` · ♩ ${Math.round(beats.tempo)}` : ""}`;
  $("#chartTitle").textContent = current?.title || "";
  $("#chartEdited").hidden = !chordsEdited; $("#chartReset").hidden = !chordsEdited; $("#chartUndo").disabled = !chordUndo.length;
  let prev = null;
  $("#chartGrid").innerHTML = chartBars.map((b, i) => {
    const txt = b.names.join(" ");
    const sim = !chartEditing() && txt && txt === prev; prev = txt || prev;
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
  el.classList.add("now"); if (playing && !chartEditing()) el.scrollIntoView({block: "nearest", behavior: "smooth"});
}
function editBar(i) {
  $("#chartGrid .bar.edit")?.dispatchEvent(new Event("cancel"));  // close any other bar first (this redraws the chart)
  const bar = chartBars[i], el = $(`#chartGrid .bar[data-i="${i}"]`); if (!bar || !el) return;
  el.classList.add("edit");
  el.innerHTML = `<small>${i + 1}</small><input value="${esc(bar.names.join(" "))}" spellcheck="false" autocomplete="off" aria-label="Chords in bar ${i + 1}">`;
  const input = el.querySelector("input"); input.focus(); input.select();
  let done = false;
  const commit = move => {
    if (done) return; done = true;
    const text = input.value.trim();
    if (text && text !== bar.names.join(" ")) {
      const items = parseLine(text, chartBars[i - 1]);
      if (!items) { done = false; input.focus(); return; }
      replaceRange(bar.t, bar.e, items);
    } else renderChart();
    if (move) editBar(clamp(i + move, 0, chartBars.length - 1));  // straight away, so fast typing lands in the next bar
  };
  el.addEventListener("cancel", () => { if (!done) { done = true; renderChart(); } }, {once: true});
  input.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); commit(0); }
    else if (ev.key === "Tab") { ev.preventDefault(); commit(ev.shiftKey ? -1 : 1); }
    else if (ev.key === "Escape") { ev.preventDefault(); done = true; renderChart(); }
  };
  input.onblur = () => setTimeout(() => { if (!done && document.activeElement !== input) commit(0); }, 120);
}
function openChart() { if (!hasChords()) return; chartDlg.classList.remove("editing"); syncEditBtn(); renderChart(); chartDlg.showModal(); highlightChartBar(); }
function syncEditBtn() {
  const on = chartEditing();
  $("#chartEdit").setAttribute("aria-pressed", on); $("#chartEdit").textContent = on ? "Done editing" : "Edit chords";
  $("#chartHelp").hidden = !on;
}
$("#chartGrid").addEventListener("click", e => {
  const b = e.target.closest(".bar"); if (!b || e.target.tagName === "INPUT") return;
  if (chartEditing()) editBar(+b.dataset.i); else seek(chartBars[+b.dataset.i].t);
});
$("#chartEdit").onclick = () => { chartDlg.classList.toggle("editing"); syncEditBtn(); renderChart(); };
$("#chartUndo").onclick = undoChord;
$("#chartReset").onclick = resetChords;
chartDlg.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && e.target.tagName !== "INPUT") { e.preventDefault(); undoChord(); }
});
$("#chartBtn").onclick = openChart;
