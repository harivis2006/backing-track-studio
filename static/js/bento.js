"use strict";
// The bento tiles on the welcome screen and the website's landing page: the mini mixer illustration,
// tiles sliding in as they come into view, numbers counting up, mockups tilting towards the mouse,
// and (landing page) the scroll progress bar, section counter and parallax.

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// a few parts drawn as waveforms, with the sax removed
function drawLanes() {
  const lanes = [["winds", "Sax / Brass", 0.9, true], ["piano", "Piano", 0.55], ["bass", "Bass", 0.7], ["drums", "Drums", 0.95], ["guitar", "Guitar", 0.45]];
  for (const el of document.querySelectorAll(".pvlanes")) {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    el.innerHTML = lanes.map(([name, label, amp, off]) => {
      const bars = [];
      for (let i = 0; i < 90; i++) {
        const env = name === "winds" ? (i % 30 < 18 ? 1 : 0.08) : 0.55 + 0.45 * Math.sin(i / 7 + amp * 5);
        const v = Math.max(0.05, amp * env * (0.35 + 0.65 * rnd()));
        bars.push(`<rect x="${i * 4}" y="${(1 - v) * 20}" width="2.4" height="${v * 40}" rx="1.2"/>`);
      }
      return `<div class="pvlane${off ? " off" : ""}"><span class="pvname"><i style="background:var(--${name})"></i>${label}</span>
        <svg viewBox="0 0 360 40" preserveAspectRatio="none" style="fill:var(--${name})">${bars.join("")}</svg></div>`;
    }).join("");
  }
}

function countUp(el) {
  const to = parseFloat(el.dataset.count), dec = +el.dataset.dec || 0; let t0 = null;
  const f = ts => { t0 ??= ts; const p = Math.min((ts - t0) / 1400, 1); el.textContent = (to * (1 - (1 - p) ** 4)).toFixed(dec); if (p < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

// slide tiles in (staggered) as they come into view
function revealIn(root) {
  const els = [...root.querySelectorAll("[data-r]")];
  els.forEach((e, k) => { if (e.classList.contains("bt")) e.style.setProperty("--d", (k % 7) * 70 + "ms"); });
  if (reducedMotion || !("IntersectionObserver" in window)) { els.forEach(e => e.classList.add("in")); return; }
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add("in"); e.target.querySelectorAll("[data-count]").forEach(countUp); io.unobserve(e.target);
  }), {threshold: 0.15});
  els.forEach(e => { e.classList.remove("in"); io.observe(e); });
}

// mockups lean towards the mouse, smoothly
function tiltAll(root) {
  if (reducedMotion) return;
  for (const el of root.querySelectorAll(".tilt")) {
    if (el.dataset.tilt) continue; el.dataset.tilt = 1;
    let tx = 0, ty = 0, cx = 0, cy = 0, run = false;
    const loop = () => {
      cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
      el.style.setProperty("--rx", cx.toFixed(2) + "deg"); el.style.setProperty("--ry", cy.toFixed(2) + "deg");
      if (Math.abs(tx - cx) > 0.02 || Math.abs(ty - cy) > 0.02) requestAnimationFrame(loop); else run = false;
    };
    const go = () => { if (!run) { run = true; requestAnimationFrame(loop); } };
    const host = el.closest(".bt, .showcase") || el;
    host.addEventListener("pointermove", e => {
      const r = el.getBoundingClientRect();
      tx = ((e.clientY - r.top) / r.height - 0.5) * -9; ty = ((e.clientX - r.left) / r.width - 0.5) * 11; go();
    });
    host.addEventListener("pointerleave", () => { tx = ty = 0; go(); });
  }
}

// landing page: progress bar, "1/3" counter and parallax, driven by the page's own scroll
function initLandingScroll() {
  const page = $("#setup"), prog = $("#prog"), pill = $("#pill"), lap = $("#lap");
  const secs = [...page.querySelectorAll("section")];
  let last = 0, ticking = false;
  const onScroll = () => {
    const sc = page.scrollTop / ((page.scrollHeight - page.clientHeight) || 1);
    prog.style.transform = `scaleX(${clamp(sc, 0, 1)})`;
    const mid = innerHeight * 0.45; let cur = 1;
    secs.forEach(s => { if (s.getBoundingClientRect().top < mid) cur = +s.dataset.i; });
    if (cur !== last) { pill.textContent = `${cur}/${secs.length}`; pill.classList.add("pop"); setTimeout(() => pill.classList.remove("pop"), 260); last = cur; }
    if (!reducedMotion && lap) {
      const r = lap.getBoundingClientRect(), d = (r.top + r.height / 2 - innerHeight / 2) / innerHeight;
      lap.style.setProperty("--py", (d * -28).toFixed(1) + "px"); lap.style.setProperty("--py2", (d * -60).toFixed(1) + "px");
    }
    ticking = false;
  };
  page.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, {passive: true});
  onScroll();
}

function showWelcome() { drawLanes(); revealIn($("#empty")); tiltAll($("#empty")); }
function showLanding() { drawLanes(); revealIn($("#setup")); tiltAll($("#setup")); initLandingScroll(); }

// welcome tiles that do something
$("#eLink").onclick = () => { $("#linkInput").focus(); $("#linkInput").animate([{boxShadow: "0 0 0 6px #0a84ff55"}, {boxShadow: "0 0 0 0 #0a84ff00"}], 900); };
$("#eFile").onclick = () => $("#file").click();
$("#eCmd").onclick = () => openPalette();
