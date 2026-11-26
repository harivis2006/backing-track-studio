"use strict";
// Command palette (⌘K / Ctrl+K): type to jump to a song or run anything in the app.

const palette = $("#palette"), palInput = $("#palInput"), palList = $("#palList");
let palItems = [], palSel = 0;

function paletteCommands() {
  const cmds = [];
  const add = (group, label, run, {hint = "", keys = "", off = false} = {}) => { if (!off) cmds.push({group, label, run, hint, keys}); };
  const song = !!(current && stems.length);
  for (const j of jobs.filter(j => j.status === "done"))
    add("Songs", j.title, () => openJob(j.id), {hint: j.duration ? fmt(j.duration) : "", off: current?.id === j.id});
  add("Add", "Paste a YouTube or Spotify link", () => $("#linkInput").focus());
  add("Add", "Choose a song or video file…", () => $("#file").click());
  if (song) {
    add("Playback", playing ? "Pause" : "Play", toggle, {keys: "Space"});
    add("Playback", recording ? "Stop recording" : "Record yourself", () => $("#rec").click(), {keys: "R"});
    add("Playback", "Back to the start", () => seek(loopOn() ? loopA : 0), {keys: "0"});
    for (const [label, list] of PRESETS) {
      const parts = stems.filter(s => list.includes(s.name) && !s.empty); if (!parts.length) continue;
      const removed = parts.every(s => s.mute);
      add("Parts", `${removed ? "Bring back" : "Remove"} ${label}`, () => { parts.forEach(s => { s.mute = !removed; s.solo = false; }); applyGains(); });
    }
    stems.forEach((s, i) => { if (!s.empty) add("Parts", `Solo ${STEM_INFO[s.name].label}`, () => { stems.forEach(o => o.solo = o === s ? !s.solo : false); applyGains(); }, {keys: `⇧${i + 1}`}); });
    add("Parts", "Full mix (unmute everything)", () => { stems.forEach(s => { s.mute = s.solo = false; }); applyGains(); });
    add("Parts", abSaved ? "A/B: back to my mix" : "A/B: hear the original", () => setAB(!abSaved), {keys: "A"});
    for (const v of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1])
      add("Practice", `Speed ${Math.round(v * 100)}%`, () => changePractice(v, semis), {off: Math.abs(v - speed) < 0.001, hint: v === 1 ? "original" : ""});
    add("Practice", "Key up a semitone", () => stepKey(1), {keys: "="});
    add("Practice", "Key down a semitone", () => stepKey(-1), {keys: "-"});
    add("Practice", "Original speed and key", () => changePractice(1, 0), {off: speed === 1 && semis === 0});
    add("Practice", `${prefs.metro ? "Turn off" : "Turn on"} the metronome click`, () => $("#metroBtn").click(), {keys: "K", off: !beats});
    add("Practice", `${prefs.countIn ? "Turn off" : "Turn on"} the count-in`, () => $("#countInBtn").click(), {keys: "C", off: !beats});
    add("Practice", `Loop ${loopOn() ? "off" : "on"}`, () => { $("#loop").checked = !$("#loop").checked; $("#loop").onchange(); }, {keys: "L", off: loopA === null});
    add("Practice", "Add a marker here", () => addMarker(), {keys: "M"});
    for (const m of markers) add("Markers", `Go to “${m.name}”`, () => seek(m.t), {hint: fmt(m.t)});
    add("View", "Show the whole song", () => setView(0, duration), {keys: "⇧Z"});
    if (hasChords()) {
      add("Chords", "Chord chart", openChart, {keys: "H"});
      add("Chords", "Edit the chords", () => { openChart(); $("#chartEdit").click(); });
      add("Chords", prefs.chordsOn === false ? "Show the chords" : "Hide the chords", () => $("#chordsBtn").click(), {keys: "G"});
      if (+prefs.inst) add("Chords", writtenForYou() ? "Show chords at concert pitch" : "Write chords for my instrument", () => $("#chordMode").click());
    }
    if (current.video) {
      add("View", vwrap.classList.contains("show") ? "Hide the video" : "Show the video", () => $("#videoToggle").click(), {keys: "V"});
      add("View", "Video fullscreen", toggleFullscreen, {keys: "F"});
      if (document.pictureInPictureEnabled) add("View", "Pop out the video (picture-in-picture)", () => $("#vidPip").click());
    }
    add("File", "Export…", openExport, {keys: "E"});
    add("File", "Rename this song", () => $("#title").dispatchEvent(new MouseEvent("dblclick", {bubbles: true})));
  }
  add("App", "Settings", () => $("#settingsBtn").click());
  add("App", "Keyboard shortcuts", () => $("#help").showModal(), {keys: "?"});
  return cmds;
}

// fuzzy match: every typed letter in order; earlier, word-start and consecutive matches score higher
function fuzzy(text, q) {
  const t = text.toLowerCase(); let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti); if (i < 0) return -1;
    score += (i === prev + 1 ? 6 : 1) + (i === 0 || " /(“-".includes(t[i - 1]) ? 4 : 0) - i * 0.01;
    prev = i; ti = i + 1;
  }
  return score;
}
function renderPalette() {
  const q = palInput.value.trim().toLowerCase();
  const all = paletteCommands();
  palItems = q ? all.map(c => ({c, s: fuzzy(`${c.label} ${c.group}`, q)})).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.c) : all;
  palSel = clamp(palSel, 0, Math.max(0, palItems.length - 1));
  let html = "", group = null;
  palItems.forEach((c, i) => {
    if (!q && c.group !== group) { group = c.group; html += `<div class="palgroup">${esc(group)}</div>`; }
    html += `<div class="palitem${i === palSel ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === palSel}">
      <span class="pallabel">${esc(c.label)}</span>${q ? `<span class="palg">${esc(c.group)}</span>` : ""}
      ${c.hint ? `<span class="palhint">${esc(c.hint)}</span>` : ""}${c.keys ? `<kbd>${esc(c.keys)}</kbd>` : ""}</div>`;
  });
  palList.innerHTML = html || `<div class="palempty">Nothing matches “${esc(palInput.value)}”</div>`;
  palList.querySelector(".sel")?.scrollIntoView({block: "nearest"});
}
function openPalette() {
  if (palette.open) { palette.close(); return; }
  document.querySelector("dialog[open]")?.close();
  palInput.value = ""; palSel = 0; renderPalette(); palette.showModal(); palInput.focus();
}
function runPalette(i) {
  const c = palItems[i]; if (!c) return;
  palette.close(); c.run(); requestAnimationFrame(drawAll);
}
palInput.addEventListener("input", () => { palSel = 0; renderPalette(); });
palInput.addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); palSel = clamp(palSel + (e.key === "ArrowDown" ? 1 : -1), 0, palItems.length - 1); renderPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(palSel); }
});
palList.addEventListener("click", e => { const it = e.target.closest(".palitem"); if (it) runPalette(+it.dataset.i); });
palList.addEventListener("mousemove", e => {
  const it = e.target.closest(".palitem"); if (!it || +it.dataset.i === palSel) return;
  palList.querySelector(".sel")?.classList.remove("sel"); it.classList.add("sel"); palSel = +it.dataset.i;
});
palette.addEventListener("click", e => { if (e.target === palette) palette.close(); });   // click outside closes
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
}, true);
$("#palBtn").onclick = openPalette;
