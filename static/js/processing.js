"use strict";
// The screen you see while a song is being split: progress, the steps, the seven parts "coming alive",
// tips while you wait — and the song opens by itself when it's ready.
// Shown when you add a song (if nothing is playing), or when you click a song that's still processing.

let watching = null;   // id of the song this screen is showing
let lastWatchedStatus = null, tipTimer = null, tipIdx = 0, coverLoaded = false;

const STEPS = [
  {title: "Get the song", sub: "Download or read the file"},
  {title: "Split into parts", sub: "Vocals, guitar, piano, bass, drums"},
  {title: "Find the sax & brass", sub: "Pulls winds out of everything else"},
  {title: "Beats, chords & form", sub: "So loops, the click and the chart line up"},
];
const TIPS = [
  ["⌘K", "Jump to any song or command from anywhere."],
  ["H", "Open the chord chart — written for your instrument."],
  ["[ ]", "Slow down or speed up in 5% steps, without changing the pitch."],
  ["L", "Drag across a waveform to pick a section, then loop it."],
  ["R", "Record yourself over the band, with latency correction."],
  ["A", "A/B: flip between your backing track and the original."],
  ["C", "A one-bar count-in before every play."],
  ["F", "Watch the video fullscreen while you play."],
];

// which step a job is on, from its stage label
function stepOf(j) {
  if (j.status === "done") return 4;
  const s = (j.stage || "").toLowerCase();
  if (/saving|analys/.test(s)) return 3;
  if (/sax|brass|woodwind/.test(s)) return 2;
  if (/split|loading ai/.test(s)) return 1;
  return 0;
}

function buildProcessing() {
  $("#pSteps").innerHTML = STEPS.map((s, i) => `<li data-i="${i}"><i class="pdot"></i><div><b>${s.title}</b><small>${s.sub}</small></div></li>`).join("");
  $("#pParts").innerHTML = STEMS_ORDER.map(name => `<div class="bt ppart" data-r data-part="${name}" style="--c:var(--${name})">
      <div class="eqz">${"<i></i>".repeat(7)}</div><small>${STEM_INFO[name].label}<i class="pstate">Waiting</i></small></div>`).join("");
}
const STEMS_ORDER = ["vocals", "winds", "guitar", "piano", "other", "bass", "drums"];

function showProcessing(id) {
  const j = jobs.find(x => x.id === id); if (!j) return;
  if (current) closeStudio();
  watching = id; lastWatchedStatus = j.status; coverLoaded = false;
  $("#empty").style.display = "none"; $("#studio").style.display = "none";
  const el = $("#processing"); el.hidden = false;
  $("#pCover").removeAttribute("src"); $("#pArt").removeAttribute("src"); el.classList.remove("hascover", "finished");
  revealIn(el); renderProcessing(); renderLib();
  clearInterval(tipTimer); showTip(); tipTimer = setInterval(showTip, 6000);
}
function hideProcessing() {
  if (!watching) return;
  watching = null; clearInterval(tipTimer);
  $("#processing").hidden = true;
}
function showTip() {
  const [k, text] = TIPS[tipIdx++ % TIPS.length], t = $("#pTip");
  t.classList.remove("in"); void t.offsetWidth;
  t.innerHTML = `<kbd>${k}</kbd><span>${text}</span>`; t.classList.add("in");
}

function renderProcessing() {
  if (!watching) return;
  const j = jobs.find(x => x.id === watching);
  if (!j) { hideProcessing(); $("#empty").style.display = ""; showWelcome(); return; }
  const el = $("#processing"), pct = Math.round((j.progress || 0) * 100), step = stepOf(j);
  el.dataset.status = j.status;
  $("#pTitle").textContent = j.title;
  $("#pSource").textContent = [sourceTag(j) || "Your file", j.duration ? fmt(j.duration) : ""].filter(Boolean).join(" · ");

  // cover art appears once the download has got far enough to have one
  if (!coverLoaded && (j.status === "running" || j.status === "done") && step >= 1) {
    const img = $("#pCover");
    img.onload = () => { coverLoaded = true; el.classList.add("hascover"); $("#pArt").src = img.src; };
    img.onerror = () => {};
    img.src = apiUrl(`/api/jobs/${j.id}/thumb?s=${step}`);
  }

  if (j.status === "queued") {
    const order = x => x.queued_at ?? x.created;
    const ahead = jobs.filter(x => x.status === "running" || (x.status === "queued" && order(x) < order(j))).length;
    $("#pPct").textContent = "…"; $("#pStage").textContent = ahead ? `Waiting — ${ahead} song${ahead > 1 ? "s" : ""} ahead in the queue` : "Starting…";
    $("#pEta").textContent = "";
  } else if (j.status === "error") {
    $("#pPct").textContent = "!"; $("#pStage").textContent = "Couldn't finish this one"; $("#pEta").textContent = j.error || "";
  } else if (j.status === "done") {
    $("#pPct").textContent = "✓"; $("#pStage").textContent = "Ready — opening…"; $("#pEta").textContent = "";
  } else {
    $("#pPct").innerHTML = `${pct}<span>%</span>`; $("#pStage").textContent = j.stage || "Working…";
    $("#pEta").textContent = j.eta ? eta(j.eta).replace("~", "About ") : step === 0 ? "Working out how long this will take…" : "";
  }
  $("#pBar").style.transform = `scaleX(${j.status === "done" ? 1 : Math.max(0.02, j.progress || 0)})`;
  $("#pRetry").hidden = j.status !== "error";
  $("#pCancel").textContent = j.status === "error" ? "Delete" : "Cancel";

  // steps checklist
  for (const li of $("#pSteps").children) {
    const i = +li.dataset.i;
    li.className = j.status === "error" && i === step ? "fail" : i < step || j.status === "done" ? "done" : i === step && j.status === "running" ? "now" : "";
  }
  // the seven parts: listening while their model runs, ticked once that model has finished
  const live = {1: ["vocals", "drums", "bass", "guitar", "piano", "other"], 2: ["winds", "other"]}[step] || [];
  for (const t of $("#pParts").children) {
    const name = t.dataset.part;
    const ready = step >= 3 || j.status === "done" || (step === 2 && name !== "winds" && name !== "other");
    const state = j.status === "error" ? "Stopped" : ready ? "Separated ✓" : live.includes(name) && j.status === "running" ? "Listening…" : "Waiting";
    t.classList.toggle("live", state === "Listening…"); t.classList.toggle("ready", state === "Separated ✓");
    t.querySelector(".pstate").textContent = state;
  }
  // the bottom-right tile: other songs in the queue, or offer a notification
  const others = jobs.filter(x => x.id !== j.id && (x.status === "queued" || x.status === "running"));
  const canNotify = "Notification" in window && Notification.permission === "default";
  $("#pSide").innerHTML = j.status === "error"
    ? `<div class="big">↻</div><small>Links fail sometimes<i>Try again, or paste another upload of the same song</i></small>`
    : others.length
    ? `<div class="big">${others.length} more</div><small>in the queue<i>${esc(others.slice(0, 2).map(x => x.title).join(" · "))}</i></small>`
    : canNotify ? `<div class="big">🔔</div><small>Notify me when it's ready<i>so you can do something else</i></small>`
    : `<div class="big">${Math.max(1, Math.round((j.duration || 300) / 60 * 1.3))} min</div><small>for this song<i>about 1.3× its length on Apple Silicon</i></small>`;
  $("#pSide").classList.toggle("clickable", !others.length && canNotify);

  // finished while you were watching: open it
  if (j.status === "done" && lastWatchedStatus !== "done") {
    el.classList.add("finished");
    setTimeout(() => { if (watching === j.id) { hideProcessing(); el.classList.remove("finished"); openJob(j.id); } }, 1400);
  }
  lastWatchedStatus = j.status;
}

$("#pCancel").onclick = async () => {
  const j = jobs.find(x => x.id === watching); if (!j) return;
  const busy = j.status === "queued" || j.status === "running";
  if (!confirm(busy ? `Stop processing “${j.title}”?` : `Delete “${j.title}”?`)) return;
  try { await api(`/api/jobs/${j.id}`, {method: "DELETE"}); } catch (e) { return toast(e.message, {type: "err"}); }
  hideProcessing(); $("#empty").style.display = ""; showWelcome(); refresh();
};
$("#pRetry").onclick = async () => {
  try { await api(`/api/jobs/${watching}/retry`, {method: "POST"}); refresh(); } catch (e) { toast(e.message, {type: "err"}); }
};
$("#pSide").onclick = () => { if ($("#pSide").classList.contains("clickable")) Notification.requestPermission().then(renderProcessing); };
buildProcessing();
