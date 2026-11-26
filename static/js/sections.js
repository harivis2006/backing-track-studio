"use strict";
// The song's form, found by the helper (backend/sections.py): a strip above the chords with each chorus
// (each time through the tune) or section. Click one to loop it, shift-click to stretch the loop over several.

let sections = [];        // [{t, e, name}]
let sectionForm = null;   // bars per chorus, when the song repeats a form

function setSections(data) {
  sections = (data?.list || []).map(([t, e, name]) => ({t, e, name}));
  sectionForm = data?.form || null;
  syncLanes();
}
const sectionsShown = () => sections.length > 1;
const sectionAt = t => sections.findIndex(s => t >= s.t && t < s.e);

// the row under the ruler holds the form strip and/or the chord lane
function syncLanes() {
  const ch = chordsShown(), fo = sectionsShown();
  $("#chordRow").hidden = !(ch || fo);
  $("#chordCanvas").hidden = !ch;
  $("#formCanvas").hidden = !fo;
  $("#chordRow .lbl").textContent = ch ? "Chords" : "Form";
  $("#chartBtn").hidden = !ch;
  if (!ch) $("#chordMode").hidden = true;
  requestAnimationFrame(drawSections);
  if (typeof fitLanes === "function") requestAnimationFrame(fitLanes);
}

// the loop is exactly some run of sections → its name ("Chorus 2", "Chorus 2–3")
function loopName() {
  if (loopA === null || !sections.length) return "";
  const near = (a, b) => Math.abs(a - b) < 0.05;
  const i = sections.findIndex(s => near(s.t, loopA)), j = sections.findIndex(s => near(s.e, loopB));
  if (i < 0 || j < i) return "";
  if (i === j) return sections[i].name;
  const [a, b] = [sections[i].name, sections[j].name];
  const num = /^(.*) (\d+)$/, ma = a.match(num), mb = b.match(num);
  return ma && mb && ma[1] === mb[1] ? `${a}–${mb[2]}` : `${a} – ${b}`;
}

function loopSection(i, extend = false) {
  const s = sections[i]; if (!s || recording) return;
  if (extend && loopA !== null) { loopA = Math.min(loopA, s.t); loopB = Math.max(loopB, s.e); }
  else { loopA = s.t; loopB = s.e; }
  $("#loop").checked = true; updateLoopHint();
  seek(loopA); saveState(); drawAll();
}

// shorter and shorter names until one fits
function fitName(g, name, room) {
  const m = name.match(/^(\w+) (\d+)$/);
  const tries = m ? [name, `${m[1].slice(0, 2)} ${m[2]}`, m[2]] : [name, name.slice(0, 3)];
  return tries.find(t => g.measureText(t).width <= room) || "";
}

function drawSections() {
  const c = $("#formCanvas"); if (!c || c.hidden || $("#chordRow").hidden || !duration) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  g.font = cv.formFont; g.textBaseline = "middle";
  const now = sectionAt(curPos());
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]; if (s.e < view.a || s.t > view.b) continue;
    const x0 = Math.max(tToX(s.t, w), -8) + 1.5, x1 = Math.min(tToX(s.e, w), w + 8) - 1.5; if (x1 - x0 < 2) continue;
    const looped = loopA !== null && s.t >= loopA - 0.05 && s.e <= loopB + 0.05;
    g.fillStyle = looped ? cv.chordOn : cv.chord;
    g.beginPath(); g.roundRect(x0, 1, x1 - x0, h - 2, Math.min(6, (x1 - x0) / 2)); g.fill();
    if (i === now && !looped) { g.strokeStyle = cv.chordOn; g.lineWidth = 1.5; g.stroke(); }
    const lx = Math.max(x0, 0) + 8, name = fitName(g, s.name, Math.min(x1, w) - lx - 6);
    if (name) { g.fillStyle = looped ? cv.chordOnText : i === now ? cv.chordOn : cv.formText; g.fillText(name, lx, h / 2 + 0.5); }
  }
}

$("#formCanvas").addEventListener("click", e => { const i = sectionAt(laneTime(e)); if (i >= 0) loopSection(i, e.shiftKey); });
$("#formCanvas").addEventListener("mousemove", e => {
  const s = sections[sectionAt(laneTime(e))];
  e.currentTarget.title = s ? `${s.name} · ${fmt(s.t)}–${fmt(s.e)}${beats ? ` (${barsIn(s.t, s.e)})` : ""}\nClick to loop it · shift-click to add it to the loop` : "";
});
