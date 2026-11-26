"use strict";
// The notes the horn plays, found by the helper (backend/melody.py) in the separated sax / brass part:
// a mini piano roll above the parts, named and written for your instrument (and following Key ±), with the
// note playing now beside it. Click a note to jump there. N shows / hides it.

let hornNotes = [];   // [{t, e, m}] concert MIDI notes, song time

function setNotes(data) {
  hornNotes = (data?.notes || []).map(([t, e, m]) => ({t, e, m}));
  syncNotes();
}
const hasNotes = () => hornNotes.length >= 8;
const notesShown = () => hasNotes() && prefs.notesOn !== false;
function syncNotes() {
  $("#noteRow").hidden = !notesShown();
  $("#notesBtn").hidden = !hasNotes();
  $("#notesBtn").setAttribute("aria-pressed", prefs.notesOn !== false);
  lastNoteIdx = -2; updateNoteNow();
  requestAnimationFrame(() => { drawNotes(); if (typeof fitLanes === "function") fitLanes(); });
}
$("#notesBtn").onclick = () => { prefs.notesOn = prefs.notesOn === false; savePrefs(); syncNotes(); };

// written note name with octave, spelled with sharps or flats to suit the key you're reading in
function noteName(m, shift = chordShift(), octave = true) {
  const w = m + shift, keyTonic = songKey ? (songKey.major + shift + 120) % 12 : 0;
  const names = SHARP_KEYS.has(keyTonic) ? SHARP_NAMES : NOTE_NAMES;
  return names[(w % 12 + 12) % 12] + (octave ? Math.floor(w / 12) - 1 : "");
}
function noteIndexAt(t) {
  let lo = 0, hi = hornNotes.length - 1;
  while (lo <= hi) { const k = (lo + hi) >> 1; if (hornNotes[k].e <= t) lo = k + 1; else if (hornNotes[k].t > t) hi = k - 1; else return k; }
  return -1;
}

function drawNotes() {
  const c = $("#noteCanvas"); if (!c || $("#noteRow").hidden || !duration) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  // pitch range: what's on screen, at least an octave, so the line's shape reads at any zoom
  let first = -1, last = -1;
  for (let i = 0; i < hornNotes.length; i++) {
    const n = hornNotes[i]; if (n.e < view.a || n.t > view.b) continue;
    if (first < 0) first = i; last = i;
  }
  if (first < 0) return;
  // ignore the odd stray note (bleed, an octave slip) when picking the range; strays are pinned to the edge
  const ms = hornNotes.slice(first, last + 1).map(n => n.m).sort((a, b) => a - b);
  let lo = ms[Math.floor(ms.length * 0.03)], hi = ms[Math.ceil(ms.length * 0.97) - 1];
  if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 6); hi = Math.ceil(mid + 6); }
  const rowH = (h - 6) / (hi - lo + 1), bh = Math.max(2.5, Math.min(rowH, 7));
  const y = m => 3 + (hi - clamp(m, lo, hi)) * rowH + (rowH - bh) / 2;
  // octave guide lines (written C)
  g.fillStyle = cv.tick;
  for (let m = lo; m <= hi; m++) if (((m + chordShift()) % 12 + 12) % 12 === 0) g.fillRect(0, Math.round(y(m) + bh / 2), w, 1);
  const now = noteIndexAt(curPos()), playedTo = curPos();
  g.font = cv.noteFont; g.textBaseline = "bottom";
  let free = -Infinity;
  for (let i = first; i <= last; i++) {
    const n = hornNotes[i];
    const x0 = tToX(n.t, w), x1 = Math.max(tToX(n.e, w), x0 + 1.5), yy = y(n.m);
    g.fillStyle = i === now ? cv.noteOn : cv.note;
    g.globalAlpha = i === now ? 1 : n.e < playedTo ? 0.55 : 0.9;
    g.beginPath(); g.roundRect(x0, yy, x1 - x0, bh, Math.min(bh / 2, (x1 - x0) / 2)); g.fill();
    // names, when zoomed in far enough for them not to collide
    if (x1 - x0 > 9 && x0 > free) {
      const name = noteName(n.m, chordShift(), false), tw = g.measureText(name).width;
      if (x0 + tw < w && yy - 1 > 9) { g.globalAlpha = i === now ? 1 : 0.75; g.fillStyle = i === now ? cv.noteOn : cv.text; g.fillText(name, x0, yy - 1); free = x0 + tw + 3; }
    }
  }
  g.globalAlpha = 1;
}

// "now": the note sounding at the playhead, beside the lane
let lastNoteIdx = -2;
function updateNoteNow() {
  if (!notesShown()) return;
  const i = noteIndexAt(curPos());
  if (i === lastNoteIdx) return;
  lastNoteIdx = i;
  $("#noteNow").textContent = i >= 0 ? noteName(hornNotes[i].m) : "";
}
const refreshNoteText = () => { lastNoteIdx = -2; updateNoteNow(); drawNotes(); };

$("#noteCanvas").addEventListener("click", e => {
  const t = laneTime(e); let i = noteIndexAt(t);
  if (i < 0) i = hornNotes.findIndex(n => n.t > t);   // between notes: the next one
  if (i >= 0) seek(hornNotes[i].t);
});
$("#noteCanvas").addEventListener("mousemove", e => {
  const i = noteIndexAt(laneTime(e)), n = hornNotes[i];
  e.currentTarget.title = n ? `${noteName(n.m)}${writtenForYou() ? ` (concert ${noteName(n.m, rateSemis)})` : ""} · ${fmt(n.t)}` : "Click to jump to a note";
});
