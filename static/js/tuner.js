"use strict";
// Tuner: listens to your mic and shows the note you're playing — written for your instrument — and how many
// cents sharp or flat it is. It floats over the studio, so you can keep it open while you play along.
// Pitch is found with the McLeod method (normalised autocorrelation), which copes well with the sax's rich tone.

const tunerDlg = $("#tunerDlg");
let tunerAn = null, tunerSrc = null, tunerTimer = 0, tunerBuf = null, tunerHist = [], tunerQuiet = 0;

async function openTuner() {
  if (tunerDlg.open) return closeTuner();
  ensureCtx();
  let stream;
  try { stream = await getMic(); }
  catch (e) { return toast(`Couldn't use the microphone: ${e.message}`, {type: "err"}); }
  if (ctx.state !== "running") await ctx.resume();
  tunerSrc = ctx.createMediaStreamSource(stream);
  tunerAn = ctx.createAnalyser(); tunerAn.fftSize = 2048;
  tunerSrc.connect(tunerAn);
  tunerBuf = new Float32Array(tunerAn.fftSize); tunerHist = []; tunerQuiet = 0;
  showTuning(null); syncA4(); fillDroneNotes();
  tunerDlg.show(); $("#tunerBtn")?.classList.add("on");
  clearInterval(tunerTimer); tunerTimer = setInterval(tunerTick, 50);
}
function closeTuner() {
  clearInterval(tunerTimer); tunerTimer = 0; stopDrone();
  try { tunerSrc?.disconnect(); } catch {}
  tunerSrc = tunerAn = null;
  if (tunerDlg.open) tunerDlg.close();
  $("#tunerBtn")?.classList.remove("on");
  if (!recording) { micStream?.getTracks().forEach(t => t.stop()); micStream = null; }  // let the mic light go off
}

// McLeod pitch method: the first strong peak of the normalised square difference function
function detectPitch(buf, sr) {
  const n = buf.length;
  let energy = 0; for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
  if (Math.sqrt(energy / n) < 0.008) return null;   // too quiet
  const minLag = Math.floor(sr / 1500), maxLag = Math.min(n >> 1, Math.ceil(sr / 45));
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acf = 0, m = 0;
    for (let i = 0, end = n - tau; i < end; i++) { const a = buf[i], b = buf[i + tau]; acf += a * b; m += a * a + b * b; }
    nsdf[tau] = m ? 2 * acf / m : 0;
  }
  // key maxima: the highest point between each upward and downward zero crossing
  const peaks = []; let pos = false, best = -1;
  for (let tau = minLag + 1; tau < maxLag; tau++) {
    if (!pos && nsdf[tau] > 0 && nsdf[tau - 1] <= 0) { pos = true; best = tau; }
    else if (pos && nsdf[tau] <= 0) { pos = false; peaks.push(best); }
    if (pos && nsdf[tau] > nsdf[best]) best = tau;
  }
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map(p => nsdf[p]));
  if (top < 0.6) return null;                         // no clear pitch (breath, noise, chords)
  const p = peaks.find(q => nsdf[q] >= 0.88 * top);
  const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1], d = a - 2 * b + c;
  const shift = d ? 0.5 * (a - c) / d : 0;            // parabolic peak between samples
  return {freq: sr / (p + shift), clarity: b};
}

function tunerTick() {
  if (!tunerAn) return;
  tunerAn.getFloatTimeDomainData(tunerBuf);
  const r = detectPitch(tunerBuf, ctx.sampleRate);
  if (!r) { if (++tunerQuiet > 8) { tunerHist = []; showTuning(null); } return; }
  tunerQuiet = 0;
  const midi = 69 + 12 * Math.log2(r.freq / (prefs.a4 || 440));
  if (tunerHist.length && Math.abs(midi - tunerHist.at(-1)) > 0.6) tunerHist = [];   // a new note: don't average across it
  tunerHist.push(midi); if (tunerHist.length > 5) tunerHist.shift();
  const sorted = [...tunerHist].sort((x, y) => x - y), m = sorted[sorted.length >> 1];
  showTuning({midi: m, freq: (prefs.a4 || 440) * 2 ** ((m - 69) / 12)});
}

function showTuning(t) {
  tunerDlg.classList.toggle("idle", !t);
  const inst = +prefs.inst || 0, it = INSTRUMENTS.find(i => i.id === prefs.instrument);
  $("#tFor").textContent = inst ? `Written for ${it ? it.label.replace(/ \(.*\)/, "") : "your instrument"}` : "Concert pitch";
  if (!t) { $("#tNote").textContent = "–"; $("#tOct").textContent = ""; $("#tCents").textContent = "Play a long note"; $("#tFreq").textContent = "";
            $("#tNeedle").style.transform = "translateX(-50%)"; tunerDlg.dataset.tune = ""; return; }
  const near = Math.round(t.midi), cents = Math.round((t.midi - near) * 100), written = near + inst;
  $("#tNote").textContent = NOTE_NAMES[(written % 12 + 12) % 12];
  $("#tOct").textContent = Math.floor(written / 12) - 1;
  $("#tCents").textContent = cents === 0 ? "In tune" : `${Math.abs(cents)} cents ${cents > 0 ? "sharp" : "flat"}`;
  $("#tFreq").textContent = `${t.freq.toFixed(1)} Hz${inst ? ` · concert ${NOTE_NAMES[(near % 12 + 12) % 12]}` : ""}`;
  $("#tNeedle").style.transform = `translateX(calc(-50% + ${clamp(cents, -50, 50) / 50} * var(--half)))`;
  tunerDlg.dataset.tune = Math.abs(cents) <= 5 ? "good" : Math.abs(cents) <= 15 ? "close" : "off";
}

function syncA4() { $("#a4Out").textContent = prefs.a4 || 440; }
$("#a4Down").onclick = () => { prefs.a4 = Math.max(430, (prefs.a4 || 440) - 1); savePrefs(); syncA4(); if (drone) startDrone(); };
$("#a4Up").onclick = () => { prefs.a4 = Math.min(450, (prefs.a4 || 440) + 1); savePrefs(); syncA4(); if (drone) startDrone(); };
$("#tunerClose").onclick = closeTuner;
$("#tunerBtn").onclick = openTuner;
tunerDlg.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); closeTuner(); } });

// ---- drone: a soft, steady note (written for you; it sounds at concert pitch in the right octave)
let drone = null;
function fillDroneNotes() {
  const inst = +prefs.inst || 0, sel = $("#droneNote"), keep = sel.value;
  sel.innerHTML = NOTE_NAMES.map((n, w) => `<option value="${w}">${n}</option>`).join("");
  // default: the song's key, as you read it
  const tonic = songKey ? ((songKey.prefer === "minor" ? songKey.major + 9 : songKey.major) + rateSemis + inst) % 12 : (inst + 0) % 12;
  sel.value = keep !== "" && drone ? keep : String((tonic + 12) % 12);
}
function startDrone() {
  ensureCtx(); if (ctx.state !== "running") ctx.resume();
  stopDrone(true);
  const written = +$("#droneNote").value, concert = ((written - (+prefs.inst || 0)) % 12 + 12) % 12;
  const f = (prefs.a4 || 440) * 2 ** ((48 + concert - 69) / 12);   // C3..B3
  const out = ctx.createGain(); out.gain.value = 0; out.connect(ctx.destination);
  const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 1400; tone.connect(out);
  const oscs = [[1, "triangle", 0.6], [2, "sine", 0.25], [0.5, "sine", 0.35]].map(([mul, type, lvl]) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = f * mul; g.gain.value = lvl;
    o.connect(g); g.connect(tone); o.start(); return o;
  });
  out.gain.setTargetAtTime(+$("#droneVol").value * 0.5, ctx.currentTime, 0.08);
  drone = {out, oscs};
  $("#droneBtn").setAttribute("aria-pressed", true);
}
function stopDrone(quick = false) {
  if (!drone) return;
  const {out, oscs} = drone; drone = null;
  out.gain.setTargetAtTime(0, ctx.currentTime, quick ? 0.02 : 0.1);
  oscs.forEach(o => o.stop(ctx.currentTime + (quick ? 0.1 : 0.5)));
  $("#droneBtn").setAttribute("aria-pressed", false);
}
$("#droneBtn").onclick = () => drone ? stopDrone() : startDrone();
$("#droneNote").onchange = () => { if (drone) startDrone(); };
$("#droneVol").oninput = () => { if (drone) drone.out.gain.setTargetAtTime(+$("#droneVol").value * 0.5, ctx.currentTime, 0.03); };
