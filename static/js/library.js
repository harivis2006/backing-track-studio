"use strict";
// The track list on the left: polling for progress, adding songs (links, files, drag & drop), delete / retry.

let jobs = [], prevStatus = {}, pollTimer = null, current = null, firstLoad = true;

async function refresh() {
  clearTimeout(pollTimer);
  try { jobs = await (await api("/api/jobs")).json(); }
  catch { $("#offline").style.display = "block"; pollTimer = setTimeout(refresh, 3000); return; }
  $("#offline").style.display = "none";
  for (const j of jobs) {
    const was = prevStatus[j.id];
    if (was && was !== j.status) {
      if (j.status === "done" && watching !== j.id) { toast(`Ready: ${j.title}`, {type:"ok", action:() => openJob(j.id), actionLabel:"Open", ms:12000}); notify(`Ready: ${j.title}`, "Your backing track is ready to play.", j.id); }
      if (j.status === "error") toast(`Couldn't process “${j.title}”: ${j.error}`, {type:"err", ms:12000});
    }
    prevStatus[j.id] = j.status;
  }
  renderLib(); renderProcessing();
  const busy = jobs.filter(j => j.status === "queued" || j.status === "running");
  const run = busy.find(j => j.status === "running");
  document.title = (run ? `(${Math.round((run.progress||0)*100)}%) ` : busy.length ? "(queued) " : "")
                 + (current ? current.title + " · " : "") + "Backing Track Studio";
  pollTimer = setTimeout(refresh, busy.length ? 1200 : 5000);
  if (firstLoad) {
    firstLoad = false;
    const last = localStorage.getItem("bts:last");
    const pick = jobs.find(j => j.id === last && j.status === "done") || jobs.find(j => j.status === "done");
    if (pick && !current) openJob(pick.id);
    else if (!pick && !current) { const busyOne = jobs.find(j => j.status === "running") || jobs.find(j => j.status === "queued"); if (busyOne) showProcessing(busyOne.id); }
  }
  if (current && !jobs.some(j => j.id === current.id)) closeStudio();
}
const eta = s => !s ? "" : s < 60 ? `~${Math.round(s)} s left` : `~${Math.round(s/60)} min left`;
const sourceTag = j => j.matched || /spotify/.test(j.url || "") ? "Spotify" : j.url ? "YouTube" : "";
// One row per song. Rows are only rebuilt when something about them changed (the list is refreshed every
// second while a song is processing), so hovering, clicking and renaming aren't interrupted.
const STEP_LABEL = ["Getting the song", "Splitting", "Finding sax & brass", "Beats & chords"];
function trackRow(j, ahead) {
  const busy = j.status === "queued" || j.status === "running", pct = Math.round((j.progress || 0) * 100);
  let sub, art;
  if (j.status === "done") {
    sub = `${j.duration ? fmt(j.duration) + " · " : ""}${j.stems.length} parts`;
    art = j.video || j.matched || j.url
      ? `<div class="art"><img loading="lazy" src="${apiUrl(`/api/jobs/${j.id}/thumb`)}" alt="" onerror="this.remove()"></div>`
      : `<div class="art">♪</div>`;
  } else if (j.status === "error") {
    sub = "Couldn't finish — click for details"; art = `<div class="art fail">!</div>`;
  } else if (j.status === "queued") {
    sub = ahead ? `In queue · ${ahead} ahead` : "Starting…"; art = `<div class="art ring wait"><b>…</b></div>`;
  } else {
    sub = `${STEP_LABEL[Math.min(3, stepOf(j))]}${j.eta ? " · " + eta(j.eta) : ""}`;
    art = `<div class="art ring" style="--p:${Math.max(2, pct)}"><b>${pct}<small>%</small></b></div>`;
  }
  const tags = j.status === "done" ? [sourceTag(j), j.video ? "video" : ""].filter(Boolean).map(t => `<span class="tag">${t}</span>`).join("") : "";
  const acts = (j.status === "error" ? `<button data-act="retry" title="Try again" aria-label="Try again">↻</button>` : "")
             + `<button data-act="rename" title="Rename" aria-label="Rename">✎</button>`
             + `<button data-act="del" title="${busy ? "Cancel" : "Delete"}" aria-label="${busy ? "Cancel" : "Delete"}">✕</button>`;
  const cls = ["track", current?.id === j.id || watching === j.id ? "active" : "", busy ? "busy" : "", j.status === "error" ? "err" : ""].join(" ");
  return `<div class="${cls}" data-id="${j.id}" title="${esc(j.title)}" tabindex="0">
    ${art}<div class="body"><div class="t">${esc(j.title)}</div><div class="s"><span class="sub">${esc(sub)}</span>${tags}</div></div>
    <div class="acts">${acts}</div></div>`;
}
let libRows = new Map();  // id -> html last drawn
function renderLib() {
  const lib = $("#lib");
  if (lib.querySelector(".t input")) return;  // don't redraw under a rename in progress
  if (!jobs.length) { lib.innerHTML = `<div class="hint" style="padding:10px 12px">Your tracks will appear here.</div>`; libRows = new Map(); return; }
  $("#libSearch").style.display = jobs.length > 5 ? "block" : "none";
  if (jobs.length <= 5) $("#libSearch").value = "";
  const q = $("#libSearch").value.trim().toLowerCase();
  const shown = q ? jobs.filter(j => j.title.toLowerCase().includes(q)) : jobs;
  const waiting = jobs.filter(j => j.status === "queued" || j.status === "running").sort((a, b) => (a.queued_at || a.created) - (b.queued_at || b.created));
  const head = `<div class="libhead">Tracks${q ? ` · ${shown.length} of ${jobs.length}` : ""}</div>`;
  const rows = shown.map(j => [j.id, trackRow(j, j.status === "queued" ? waiting.indexOf(j) : 0)]);
  const sameOrder = lib.firstElementChild?.outerHTML === head && rows.length === libRows.size && rows.every(([id], i) => [...libRows.keys()][i] === id);
  if (!sameOrder) {
    lib.innerHTML = head + rows.map(r => r[1]).join("");
  } else {
    for (const [id, html] of rows) {
      if (libRows.get(id) === html) continue;
      const el = lib.querySelector(`.track[data-id="${id}"]`); if (!el) continue;
      const tmp = document.createElement("div"); tmp.innerHTML = html.trim();
      const fresh = tmp.firstElementChild, oldImg = el.querySelector(".art img"), newImg = fresh.querySelector(".art img");
      if (oldImg && newImg && oldImg.src === newImg.src) newImg.replaceWith(oldImg);  // keep the loaded artwork, no flicker
      el.replaceWith(fresh);
    }
  }
  libRows = new Map(rows);
}

// rename: the ✎ button, double-clicking a song's name in the list, or the title above the player
function renameInline(el, job, onDone) {
  const input = document.createElement("input");
  input.value = job.title; input.className = "rename"; input.setAttribute("aria-label", "Song name"); input.spellcheck = false;
  const old = el.innerHTML; el.innerHTML = ""; el.appendChild(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const t = input.value.trim();
    el.textContent = job.title;
    if (save && t && t !== job.title) {
      try {
        const j = await (await api(`/api/jobs/${job.id}`, {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({title: t})})).json();
        job.title = j.title; if (current?.id === job.id) { current.title = j.title; $("#title").textContent = j.title; }
        el.textContent = j.title;
      } catch (e) { toast(e.message, {type: "err"}); el.innerHTML = old; }
    }
    onDone?.(); refresh();
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onclick = e => e.stopPropagation();
  input.onblur = () => finish(true);
}
function renameTrack(id) {
  const j = jobs.find(x => x.id === id), el = $(`#lib .track[data-id="${id}"] .t`); if (!j || !el) return;
  renameInline(el, j);
}
$("#lib").addEventListener("dblclick", e => {
  const t = e.target.closest(".track .t"); if (!t || t.querySelector("input")) return;
  e.preventDefault(); renameTrack(t.closest(".track").dataset.id);
});
$("#lib").addEventListener("click", async e => {
  const el = e.target.closest(".track"); if (!el) return;
  const id = el.dataset.id, j = jobs.find(j => j.id === id); if (!j) return;
  const act = e.target.closest("button")?.dataset.act;
  try {
    if (act === "del") {
      const busy = j.status === "queued" || j.status === "running";
      if (!confirm(busy ? `Stop processing “${j.title}”?` : `Delete “${j.title}”, its parts and any takes you recorded?`)) return;
      if (current?.id === id) closeStudio();
      await api(`/api/jobs/${id}`, {method:"DELETE"});
      localStorage.removeItem("bts:" + id);
      return refresh();
    }
    if (act === "retry") { await api(`/api/jobs/${id}/retry`, {method:"POST"}); return refresh(); }
    if (act === "rename") return renameTrack(id);
    if (e.target.closest(".t input")) return;
    if (j.status === "done") openJob(id); else showProcessing(id);
  } catch (err) { toast(err.message, {type:"err"}); }
});
$("#lib").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("track")) e.target.click(); });
async function uploadFiles(files) {
  for (const f of files) {
    if (!AUDIO_EXT.test(f.name) && !/^(audio|video)\//.test(f.type)) { toast(`“${f.name}” isn't an audio or video file`, {type:"err"}); continue; }
    const fd = new FormData(); fd.append("file", f);
    try { const job = await (await api("/api/upload", {method:"POST", body:fd})).json(); await refresh(); if (!current) showProcessing(job.id); else toast(`Added “${f.name}” — click it in the list to watch its progress`); }
    catch (err) { toast(`Couldn't add ${f.name}: ${err.message}`, {type:"err"}); }
    refresh();
  }
}
function linkKey(u) {  // so the same song pasted twice (with different tracking params) is recognised
  try {
    const url = new URL(u.trim());
    if (/youtu\.?be/.test(url.hostname)) return "yt:" + (url.searchParams.get("v") || url.pathname.split("/").filter(Boolean).pop());
    if (/spotify/.test(url.hostname)) return "sp:" + url.pathname.replace(/^\/intl-[a-z]+/, "");
    return url.origin + url.pathname;
  } catch { return u.trim(); }
}
$("#linkForm").onsubmit = async e => {
  e.preventDefault();
  const url = $("#linkInput").value.trim(); if (!url) return;
  const dup = jobs.find(j => j.url && linkKey(j.url) === linkKey(url) && j.status !== "error");
  if (dup) {
    $("#linkInput").value = "";
    if (dup.status === "done") { openJob(dup.id); toast(`Already in your library: ${dup.title}`); }
    else toast(`Already being processed: ${dup.title}`);
    return;
  }
  try {
    const job = await (await api("/api/link", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({url})})).json();
    $("#linkInput").value = ""; await refresh();
    if (!current) showProcessing(job.id); else toast("Added — click it in the list to watch its progress");
  } catch (err) { toast(err.message, {type:"err"}); }
};
const drop = $("#drop");
drop.onclick = () => $("#file").click();
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } };
$("#file").onchange = e => { uploadFiles([...e.target.files]); e.target.value = ""; };
let dragDepth = 0;
document.addEventListener("dragenter", e => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); dragDepth++; drop.classList.add("over"); } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("over"); } });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  e.preventDefault(); dragDepth = 0; drop.classList.remove("over");
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});
