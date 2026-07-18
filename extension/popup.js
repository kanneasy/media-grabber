// Media Grabber — popup UI.

const listEl = document.getElementById("list");
const pageRowEl = document.getElementById("pageRow");
const jobsSection = document.getElementById("jobsSection");
const jobsEl = document.getElementById("jobs");
const footerEl = document.getElementById("footer");
const autoTxEl = document.getElementById("autoTranscribe");
const fmtSel = document.getElementById("fmtSel");
const qualSel = document.getElementById("qualSel");
const destSel = document.getElementById("destSel");

let currentTab = null;
let pollTimer = null;
let detectedItems = [];
let probedQualities = null; // filled on demand — probing costs a network trip
let uiSettings = {
  mediaFormat: "video",
  quality: { mode: "best" },
  outdir: null,
  recentDirs: [],
};

// ---- settings strip ----------------------------------------------------------
function saveSettings(patch) {
  uiSettings = { ...uiSettings, ...patch };
  chrome.runtime.sendMessage({ cmd: "setSettings", settings: patch });
}

// Read at CLICK time and frozen into the job, so changing the strip afterwards
// never affects a download that's already queued.
function currentOptions() {
  return {
    format: uiSettings.mediaFormat || "video",
    quality: uiSettings.quality || { mode: "best" },
    outdir: uiSettings.outdir || null,
  };
}

function shortDir(p) {
  return p ? p.split("/").filter(Boolean).pop() : "Downloads";
}

function qualityLabel(q) {
  if (!q || q.mode !== "exact") return "Best";
  return q.label || q.height + "p";
}

function fpsSuffix(fps) {
  return fps && fps >= 50 ? String(Math.round(fps)) : "";
}

function renderQuality() {
  const isAudio = uiSettings.mediaFormat === "m4a";
  qualSel.disabled = isAudio; // audio has no resolution to choose
  const q = uiSettings.quality;
  let html = '<option value="best">Best</option>';
  if (probedQualities && probedQualities.length) {
    for (const p of probedQualities) {
      const mb = p.estBytes ? " · ~" + Math.round(p.estBytes / 1048576) + " MB" : "";
      html += `<option value="${p.height}">${escapeHtml(p.height + "p" + fpsSuffix(p.fps) + mb)}</option>`;
    }
  } else {
    // Keep a saved pick visible even before this popup has probed.
    if (q && q.mode === "exact") {
      html += `<option value="${q.height}">${escapeHtml(qualityLabel(q))}</option>`;
    }
    html += '<option value="__probe">Load qualities…</option>';
  }
  qualSel.innerHTML = html;
  qualSel.value = !isAudio && q && q.mode === "exact" ? String(q.height) : "best";
}

function renderDest() {
  const cur = uiSettings.outdir || "";
  const recents = (uiSettings.recentDirs || []).filter((d) => d && d !== cur);
  let html = '<option value="">Downloads (default)</option>';
  if (cur) html += `<option value="${escapeHtml(cur)}">${escapeHtml(shortDir(cur))}</option>`;
  for (const d of recents) {
    html += `<option value="${escapeHtml(d)}">${escapeHtml(shortDir(d))}</option>`;
  }
  html += '<option value="__pick">Choose folder…</option>';
  destSel.innerHTML = html;
  destSel.value = cur;
  destSel.title = cur || "~/Downloads";
}

function renderSettings() {
  fmtSel.value = uiSettings.mediaFormat || "video";
  renderQuality();
  renderDest();
}

function probeQualities() {
  const item = detectedItems[0];
  if (!item) {
    renderQuality();
    return;
  }
  qualSel.disabled = true;
  qualSel.innerHTML = '<option>Loading…</option>';
  chrome.runtime.sendMessage(
    { cmd: "probe", url: item.url, source: "media", referer: item.referer },
    (resp) => {
      qualSel.disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        probedQualities = null;
        renderQuality();
        qualSel.title = (resp && resp.error) || "Could not read qualities";
        return;
      }
      probedQualities = resp.qualities || [];
      qualSel.title = "";
      renderQuality();
    }
  );
}

// ---- helpers -----------------------------------------------------------------
function niceName(item, tabTitle) {
  if (tabTitle && tabTitle.trim()) return tabTitle.trim();
  try {
    const u = new URL(item.url);
    return u.pathname.split("/").filter(Boolean).pop() || u.hostname;
  } catch (e) {
    return item.url;
  }
}
function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return url; }
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---- detected videos (per current tab) ---------------------------------------
function enqueue(req) {
  chrome.runtime.sendMessage({ cmd: "enqueue", req }, () => refresh());
}

function render(items) {
  listEl.innerHTML = "";
  if (!items.length) {
    listEl.innerHTML =
      '<div class="empty">No video detected yet.<br/>Play the video or reload the page, then reopen this.</div>';
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="item-main">
        <div class="item-name">${escapeHtml(niceName(item, currentTab.title))}</div>
        <div class="item-sub">${escapeHtml(hostOf(item.url))}</div>
      </div>
      <span class="badge ${item.kind.toLowerCase()}">${item.kind}</span>
      <button class="dl">Download</button>`;
    row.querySelector("button").addEventListener("click", () => {
      enqueue({
        url: item.url, kind: item.kind, referer: item.referer,
        source: "media", title: currentTab.title,
        ...currentOptions(),
      });
    });
    listEl.appendChild(row);
  }
}

function renderPageRow() {
  if (!currentTab || !/^https?:/.test(currentTab.url || "")) return;
  pageRowEl.innerHTML = `
    <div class="item">
      <div class="item-main">
        <div class="item-name">Download this page (yt-dlp)</div>
        <div class="item-sub">${escapeHtml(hostOf(currentTab.url))} — uses yt-dlp's site extractors</div>
      </div>
      <button class="dl">Grab</button>`;
  pageRowEl.querySelector("button").addEventListener("click", () => {
    enqueue({
      url: currentTab.url, source: "page", title: currentTab.title,
      ...currentOptions(),
    });
  });
}

// ---- downloads list ----------------------------------------------------------
function baseName(path) {
  return (path || "").split("/").pop();
}

// The options this job was queued with — visible proof that a job keeps its own
// settings even after the strip changes.
function optionChip(job) {
  if (job.kind === "transcribe") return "";
  const bits = [job.format === "m4a" ? "M4A" : "MP4"];
  if (job.format !== "m4a") {
    bits.push(job.quality && job.quality.mode === "exact"
      ? (job.quality.label || job.quality.height + "p")
      : "Best");
  }
  if (job.outdir) bits.push(shortDir(job.outdir));
  return bits.join(" · ");
}

function buildJobRow(job) {
  const row = document.createElement("div");
  row.className = "job";
  const st = job.status;
  const pct = job.pct || 0;
  const isTx = job.kind === "transcribe";

  let titleText, titleClass = "", pctText = "", metaText = "";
  let barClass = "bar", fillClass = "bar-fill", fillWidth = "";
  // Offer "Transcribe" only on a finished download that produced a real file.
  let showTranscribe = false;

  if (st === "done") {
    titleClass = "done";
    if (isTx) {
      titleText = "✓ " + (job.title || "Transcript");
      const exts = Object.keys(job.outputs || {}).map((f) => "." + f).join(" ");
      metaText = (exts ? "Transcript " + exts : "Transcript saved") +
        (job.already ? " — already there" : "");
    } else {
      titleText = "✓ " + (job.title || "Saved to Downloads");
      metaText = (job.file ? baseName(job.file) : "Saved to Downloads") +
        (job.already ? " — already there" : "");
      showTranscribe = !!job.file;
    }
    fillClass += " done"; fillWidth = "100%";
  } else if (st === "error") {
    titleClass = "error";
    titleText = "✗ " + (job.title || "Failed");
    metaText = job.error || "See /tmp/mediagrabber-host.log";
    fillClass += " error"; fillWidth = "100%";
  } else if (st === "queued") {
    titleText = job.title || "Video";
    metaText = isTx ? "Queued for transcription" : "Queued";
    barClass += " hidden";
  } else if (st === "downloading" && pct > 0) {
    titleText = job.title || (isTx ? "Transcribing…" : "Downloading…");
    pctText = pct.toFixed(isTx ? 0 : 1) + "%";
    fillWidth = pct + "%";
    if (isTx) {
      fillClass += " transcribe";
      metaText = "Transcribing locally…";
    } else {
      const bits = [];
      if (job.speed) bits.push(job.speed);
      if (job.eta && job.eta !== "Unknown") bits.push("ETA " + job.eta);
      if (job.frag) bits.push("frag " + job.frag);
      metaText = bits.join(" · ");
    }
  } else {
    // starting, or running before the first real percentage → indeterminate.
    // Transcription's warm-up (audio extraction, model load) is the slow part
    // here, so surface the host's own stage message rather than a generic word.
    titleText = job.title || "Video";
    if (isTx) metaText = job.info || "Preparing…";
    else metaText = st === "downloading" ? "Preparing…" : "Connecting…";
    barClass += " indeterminate";
    if (isTx) fillClass += " transcribe";
  }

  row.innerHTML = `
    <div class="job-head">
      <span class="job-title ${titleClass}">${escapeHtml(titleText)}</span>
      ${optionChip(job) ? `<span class="job-chip">${escapeHtml(optionChip(job))}</span>` : ""}
      ${pctText ? `<span class="job-pct">${pctText}</span>` : ""}
      ${showTranscribe ? `<button class="job-tx" title="Transcribe with whisper.cpp">Transcribe</button>` : ""}
      <button class="job-x" title="Dismiss">×</button>
    </div>
    <div class="${barClass}"><div class="${fillClass}" style="${fillWidth ? "width:" + fillWidth : ""}"></div></div>
    ${metaText ? `<div class="job-meta">${escapeHtml(metaText)}</div>` : ""}`;
  row.querySelector(".job-x").addEventListener("click", () => {
    chrome.runtime.sendMessage({ cmd: "dismiss", id: job.id }, () => refresh());
  });
  const txBtn = row.querySelector(".job-tx");
  if (txBtn) {
    txBtn.addEventListener("click", () => {
      txBtn.disabled = true;
      chrome.runtime.sendMessage({ cmd: "transcribe", file: job.file }, () => refresh());
    });
  }
  return row;
}

function renderJobs(jobs) {
  jobs = jobs || [];
  if (!jobs.length) {
    jobsSection.classList.add("hidden");
    jobsEl.innerHTML = "";
    return;
  }
  jobsSection.classList.remove("hidden");
  // Active (running/queued) in queue order first, then finished newest-first.
  const active = jobs.filter((j) => j.status !== "done" && j.status !== "error");
  const finished = jobs.filter((j) => j.status === "done" || j.status === "error").reverse();
  jobsEl.innerHTML = "";
  for (const job of active.concat(finished)) jobsEl.appendChild(buildJobRow(job));
}

// ---- live refresh ------------------------------------------------------------
function ensurePolling(jobs) {
  const anyActive = (jobs || []).some((j) => j.status !== "done" && j.status !== "error");
  if (anyActive && !pollTimer) {
    pollTimer = setInterval(refresh, 1000);
  } else if (!anyActive && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function refresh() {
  chrome.runtime.sendMessage({ cmd: "getState", tabId: currentTab.id }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    renderJobs(resp.jobs);
    ensurePolling(resp.jobs);
  });
}

// Live updates pushed from the background worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "jobs") {
    renderJobs(msg.jobs);
    ensurePolling(msg.jobs);
  }
});

// ---- init --------------------------------------------------------------------
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || { title: "", url: "" };
  footerEl.textContent = "v" + chrome.runtime.getManifest().version;
  autoTxEl.addEventListener("change", () => {
    chrome.runtime.sendMessage({
      cmd: "setSettings",
      settings: { autoTranscribe: autoTxEl.checked },
    });
  });

  fmtSel.addEventListener("change", () => {
    saveSettings({ mediaFormat: fmtSel.value });
    renderQuality(); // audio has no resolution, so this disables/reset it
  });

  qualSel.addEventListener("change", () => {
    const v = qualSel.value;
    if (v === "__probe") return probeQualities();
    if (v === "best") return saveSettings({ quality: { mode: "best" } });
    const p = (probedQualities || []).find((x) => String(x.height) === v);
    if (p) {
      saveSettings({
        quality: {
          mode: "exact", height: p.height, formatId: p.formatId,
          label: p.height + "p" + fpsSuffix(p.fps),
        },
      });
    }
  });

  destSel.addEventListener("change", () => {
    const v = destSel.value;
    if (v === "__pick") {
      // The macOS dialog steals focus and usually closes this popup, so the
      // background owns the pick and persists it; this callback may never run.
      destSel.disabled = true;
      chrome.runtime.sendMessage({ cmd: "pickFolder" }, (resp) => {
        destSel.disabled = false;
        if (!chrome.runtime.lastError && resp && resp.ok && resp.settings) {
          uiSettings = { ...uiSettings, ...resp.settings };
        }
        renderDest();
      });
      return;
    }
    saveSettings({ outdir: v || null });
    renderDest();
  });

  chrome.runtime.sendMessage({ cmd: "getState", tabId: currentTab.id }, (resp) => {
    if (chrome.runtime.lastError) return;
    const items = (resp && resp.items) || [];
    detectedItems = items;
    render(items);
    if (items.length === 0) renderPageRow();
    else pageRowEl.innerHTML = "";
    if (resp && resp.settings) {
      autoTxEl.checked = !!resp.settings.autoTranscribe;
      uiSettings = { ...uiSettings, ...resp.settings };
    }
    renderSettings();
    renderJobs(resp && resp.jobs);
    ensurePolling(resp && resp.jobs);
  });
})();
