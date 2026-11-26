"use strict";
// Speed and key controls (the slowed-down / transposed audio is made by the server).

let practiceTimer = null;
function updatePracticeUI() {
  $("#spOut").textContent = Math.round(speed * 100) + "%"; $("#spOut").classList.toggle("changed", speed !== 1);
  $("#kOut").textContent = (semis > 0 ? "+" : "") + semis; $("#kOut").classList.toggle("changed", semis !== 0);
  $("#practiceReset").hidden = speed === 1 && semis === 0;
  $("#spDown").disabled = speed <= SPEEDS[0]; $("#spUp").disabled = speed >= SPEEDS.at(-1);
  $("#kDown").disabled = semis <= -12; $("#kUp").disabled = semis >= 12;
}
const MAX_AUDIO_MB = 2600;  // decoded audio the page may hold while switching versions (old + new), to stay clear of tab limits
const audioMB = sp => live().length * (duration / sp / 60) * 21.2;
function changePractice(newSpeed, newSemis) {
  if (!current || recording) return;
  if (newSpeed < speed && audioMB(newSpeed) + audioMB(rate) > MAX_AUDIO_MB) {
    const slowest = SPEEDS.find(v => audioMB(v) + audioMB(rate) <= MAX_AUDIO_MB) || 1;
    toast(`This song is too long to slow down below ${Math.round(slowest * 100)}% in the browser — loop a section and export it, or mute parts you don't need.`, {type: "err", ms: 8000});
    return;
  }
  speed = newSpeed; semis = newSemis; updatePracticeUI(); saveState();
  clearTimeout(practiceTimer);
  $("#practiceStatus").textContent = speed === rate && semis === rateSemis ? "" : "…";
  practiceTimer = setTimeout(() => loadVariant(loadToken), 700);
}
function stepSpeed(dir) {
  const i = SPEEDS.findIndex(v => Math.abs(v - speed) < 0.001);
  const ni = clamp((i < 0 ? SPEEDS.indexOf(1) : i) + dir, 0, SPEEDS.length - 1);
  if (SPEEDS[ni] !== speed) changePractice(SPEEDS[ni], semis);
}
function stepKey(dir) { const k = clamp(semis + dir, -12, 12); if (k !== semis) changePractice(speed, k); }
$("#spDown").onclick = () => stepSpeed(-1); $("#spUp").onclick = () => stepSpeed(1);
$("#kDown").onclick = () => stepKey(-1); $("#kUp").onclick = () => stepKey(1);
$("#practiceReset").onclick = () => changePractice(1, 0);
function syncToggles() {
  $("#countInBtn").setAttribute("aria-pressed", prefs.countIn); $("#metroBtn").setAttribute("aria-pressed", prefs.metro);
  $("#countInBtn").disabled = $("#metroBtn").disabled = !beats;
  $("#countInBtn").title = beats ? "Count in before playing (C)" : "No steady beat was detected in this song";
  $("#metroBtn").title = beats ? "Metronome click (K)" : "No steady beat was detected in this song";
}
$("#countInBtn").onclick = () => { prefs.countIn = !prefs.countIn; savePrefs(); syncToggles(); };
$("#metroBtn").onclick = () => {
  prefs.metro = !prefs.metro; savePrefs(); syncToggles();
  if (!prefs.metro) { for (const c of clickNodes) { try { c.stop(); } catch {} } clickNodes = []; }
  else if (playing) { clickHorizon = ctx.currentTime; scheduleClicks(); }
};
