// Media Grabber — background service worker.
// Two jobs: (1) watch network traffic and remember media URLs per tab,
// (2) drive downloads through the native-messaging host `com.cleric.mediagrabber`.

const HOST = "com.cleric.mediagrabber";

// A media URL worth capturing (a manifest or a progressive file).
const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mov|m4v)(\?|#|$)/i;
// Noise to ignore: individual HLS/DASH segments and static assets.
const IGNORE_RE = /\.(ts|m4s|aac|jpg|jpeg|png|gif|svg|css|js|woff2?|vtt|ico)(\?|#|$)/i;
// Known non-content media: player-library placeholders (e.g. Plyr's blank.mp4).
const JUNK_RE = /\/\/cdn\.plyr\.io\/|\/blank\.mp4(\?|#|$)/i;

function classify(url) {
  const m = url.match(MEDIA_RE);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "m3u8") return "HLS";
  if (ext === "mpd") return "DASH";
  return ext.toUpperCase(); // MP4 / WEBM / MOV / M4V
}

// Group all renditions of one stream under a single entry.
function dedupeKey(url) {
  try {
    const u = new URL(url);
    const idx = u.pathname.indexOf(".urlset/"); // common HLS packaging folder
    if (idx !== -1) return u.origin + u.pathname.slice(0, idx + 8);
    return u.origin + u.pathname; // ignore query so a refreshed token still dedupes
  } catch (e) {
    return url;
  }
}

// ---- per-tab captured store (chrome.storage.session, serialized writes) ------
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = () => fn();
  writeChain = writeChain.then(run, run);
  return writeChain;
}

async function getAll() {
  return (await chrome.storage.session.get("captured")).captured || {};
}
async function getTab(tabId) {
  return (await getAll())[tabId] || [];
}
async function setTab(tabId, items) {
  const all = await getAll();
  all[tabId] = items;
  await chrome.storage.session.set({ captured: all });
}

function updateBadge(tabId, n) {
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" });
}

function handleCapture(tabId, item) {
  withLock(async () => {
    const items = await getTab(tabId);
    const key = dedupeKey(item.url);
    const existing = items.find((i) => dedupeKey(i.url) === key);
    if (existing) {
      const newIsMaster = /master/i.test(item.url);
      const oldIsMaster = /master/i.test(existing.url);
      // Keep the freshest master token; otherwise keep the freshest URL.
      if (newIsMaster || !oldIsMaster) {
        existing.url = item.url;
        existing.referer = item.referer || existing.referer;
        existing.ts = item.ts;
      }
    } else {
      items.push(item);
    }
    await setTab(tabId, items);
    updateBadge(tabId, items.length);
  });
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const { url, tabId, requestHeaders } = details;
    if (tabId < 0) return;
    if (IGNORE_RE.test(url)) return;
    if (JUNK_RE.test(url)) return;
    const kind = classify(url);
    if (!kind) return;
    let referer = null;
    for (const h of requestHeaders || []) {
      if (h.name.toLowerCase() === "referer") referer = h.value;
    }
    handleCapture(tabId, { url, kind, referer, ts: Date.now() });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["requestHeaders", "extraHeaders"]
);

// Clear a tab's captures when it navigates (full load or SPA route change).
// Downloads are intentionally NOT touched here — they live independently of the
// page, so navigating or refreshing never affects an in-flight or finished job.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    withLock(async () => {
      await setTab(tabId, []);
      updateBadge(tabId, 0);
    });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  withLock(async () => {
    const all = await getAll();
    delete all[tabId];
    await chrome.storage.session.set({ captured: all });
  });
});

// ---- settings ----------------------------------------------------------------
// Persisted in storage.local so they survive a service-worker restart.
// `formats` = transcript formats (whisper). `mediaFormat` = what to download.
const DEFAULT_SETTINGS = {
  autoTranscribe: false,
  formats: ["txt", "srt"],
  mediaFormat: "video",        // "video" | "m4a"
  quality: { mode: "best" },   // or {mode:"exact", height, formatId, label}
  outdir: null,                // null = the host's default (~/Downloads)
  recentDirs: [],
};
let settings = { ...DEFAULT_SETTINGS };

const settingsReady = chrome.storage.local.get("settings").then((r) => {
  if (r.settings) settings = { ...DEFAULT_SETTINGS, ...r.settings };
});

// ---- job queue ---------------------------------------------------------------
// One job runs at a time; the rest wait. Jobs are global (not tied to a tab),
// survive navigation/refresh, and finished ones persist until dismissed.
// A job is either kind:"download" (yt-dlp) or kind:"transcribe" (whisper.cpp);
// both are driven through the same native host, one port at a time. Sharing the
// queue is deliberate — transcribing while a download saturates the disk and
// four cores would make both slower on a 8GB M1.
let jobs = [];          // ordered job list: {id,kind,title,status,pct,...}
let activePort = null;  // native port of the job currently running
let currentJobId = null;
let jobSeq = 0;

function baseName(path) {
  return (path || "").split("/").pop();
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
  });
}

function broadcastJobs() {
  chrome.storage.session.set({ jobs });
  chrome.runtime.sendMessage({ type: "jobs", jobs }).catch(() => {}); // popup may be closed
}

function enqueue(req) {
  const job = {
    id: ++jobSeq,
    kind: "download",
    title: req.title || "",
    url: req.url,
    source: req.source || "media",
    referer: req.referer || null,
    // Snapshot of the options chosen at the moment Download was clicked.
    // startJob() reads ONLY from here, never from current settings, so changing
    // the settings strip afterwards can't affect an already-queued job.
    format: req.format || "video",
    quality: req.quality || { mode: "best" },
    outdir: req.outdir || null,
    status: "queued",
    pct: 0,
  };
  jobs.push(job);
  broadcastJobs();
  pump();
  return job.id;
}

// Queue a transcription of an already-downloaded file. Deduped by path so a
// re-download that auto-chains, plus a manual "Transcribe" click, don't run
// whisper over the same file twice.
function enqueueTranscribe(file, force) {
  if (!file) return null;
  const pending = jobs.find(
    (j) => j.kind === "transcribe" && j.file === file &&
           j.status !== "done" && j.status !== "error"
  );
  if (pending) return pending.id;

  const job = {
    id: ++jobSeq,
    kind: "transcribe",
    title: baseName(file),
    file,
    force: !!force,
    status: "queued",
    pct: 0,
  };
  jobs.push(job);
  broadcastJobs();
  pump();
  return job.id;
}

// Start the next queued job if nothing is currently running.
function pump() {
  if (activePort) return;
  const next = jobs.find((j) => j.status === "queued");
  if (next) startJob(next);
}

function startJob(job) {
  job.status = "starting";
  job.pct = 0;
  currentJobId = job.id;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    job.status = "error";
    job.error = String(e);
    activePort = null;
    currentJobId = null;
    broadcastJobs();
    pump();
    return;
  }
  activePort = port;

  // Free the slot and advance the queue. Called directly on done/error/cancel
  // rather than relying on onDisconnect, whose firing on a self-initiated
  // disconnect is not guaranteed.
  const finish = () => {
    if (activePort === port) {
      activePort = null;
      currentJobId = null;
    }
    try { port.disconnect(); } catch (e) {}
    pump();
  };

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "started":
        job.status = "downloading";
        broadcastJobs();
        break;
      case "progress":
        job.status = "downloading";
        job.pct = msg.pct;
        job.speed = msg.speed;
        job.eta = msg.eta;
        job.frag = msg.frag;
        broadcastJobs();
        break;
      case "info":
        job.info = msg.message;
        broadcastJobs();
        break;
      case "done":
        job.status = "done";
        job.pct = 100;
        job.already = msg.already;
        if (job.kind === "transcribe") {
          job.outputs = msg.outputs || {};
          notify(
            msg.already ? "Transcript already exists" : "Transcript ready",
            baseName(Object.values(job.outputs)[0] || job.file)
          );
        } else {
          job.file = msg.file;
          notify(
            msg.already ? "Already in Downloads" : "Download complete",
            baseName(msg.file) || "Saved to Downloads"
          );
          // The whole point of the feature: chain straight into transcription
          // with no user step. pump() below starts it once this port is freed.
          if (settings.autoTranscribe && msg.file) enqueueTranscribe(msg.file);
        }
        broadcastJobs();
        finish();
        break;
      case "error":
        job.status = "error";
        job.error = msg.message;
        notify("Download failed", (msg.message || "").split("\n").pop() || "See host.log");
        broadcastJobs();
        finish();
        break;
    }
  });

  // Only meaningful for an UNEXPECTED disconnect (host crashed / not installed).
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (activePort !== port) return; // already finished or superseded
    activePort = null;
    currentJobId = null;
    if (!job.cancelled && job.status !== "done" && job.status !== "error") {
      job.status = "error";
      job.error = err ? err.message : "native host disconnected (is it installed?)";
      notify("Download failed", job.title || "");
      broadcastJobs();
    }
    pump();
  });

  if (job.kind === "transcribe") {
    port.postMessage({
      action: "transcribe",
      file: job.file,
      formats: settings.formats,
      force: job.force,
    });
  } else {
    port.postMessage({
      action: "download",
      url: job.url,
      source: job.source,
      referer: job.referer,
      title: job.title,
      // From the job's snapshot — deliberately not from `settings`.
      format: job.format,
      quality: job.quality,
      outdir: job.outdir,
    });
  }
  broadcastJobs();
}

// Remove a job. If it's the one running, cancel it (kills its yt-dlp) and start
// the next queued job.
function dismiss(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  const running = job.id === currentJobId;
  job.cancelled = true;
  jobs = jobs.filter((j) => j.id !== id);
  broadcastJobs();
  if (running) {
    const p = activePort;
    activePort = null;
    currentJobId = null;
    if (p) { try { p.disconnect(); } catch (e) {} }
    pump();
  }
}

// Recover jobs after a service-worker restart. A job left as running is actually
// dead (its host died with the worker), so requeue it — yt-dlp resumes its .part,
// and a transcribe job either redoes the work or short-circuits on the transcript
// it already wrote. Gated on settingsReady so a resumed transcribe uses the real
// format list rather than racing against the defaults.
Promise.all([settingsReady, chrome.storage.session.get("jobs")]).then(([, r]) => {
  if (Array.isArray(r.jobs) && r.jobs.length) {
    jobs = r.jobs;
    jobSeq = jobs.reduce((m, j) => Math.max(m, j.id), 0);
    for (const j of jobs) {
      if (j.status === "downloading" || j.status === "starting") j.status = "queued";
    }
    pump();
  }
});

// ---- one-shot native calls ---------------------------------------------------
// Probe and folder-pick each get their OWN port, separate from `activePort`, so
// they neither block nor are blocked by a running download.
function nativeOnce(payload, timeoutMs, cb) {
  let port = null;
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { if (port) port.disconnect(); } catch (e) {}
    cb(result);
  };
  const timer = setTimeout(() => finish({ error: "timed out" }), timeoutMs);
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    finish({ error: String(e) });
    return;
  }
  port.onMessage.addListener((msg) => finish({ msg }));
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    finish({ error: err ? err.message : "native host disconnected (is it installed?)" });
  });
  port.postMessage(payload);
}

// Probing costs a real network round-trip, so remember it per URL.
const probeCache = new Map();

// ---- message router (popup <-> background) -----------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "getState") {
    settingsReady.then(() => getTab(msg.tabId)).then((items) => {
      // Filter on read too, so junk captured before a code change (still sitting
      // in session storage) never shows up.
      const clean = items.filter((i) => !JUNK_RE.test(i.url) && !IGNORE_RE.test(i.url));
      clean.sort((a, b) => b.ts - a.ts);
      sendResponse({ items: clean, jobs, settings });
    });
    return true; // async
  }
  if (msg.cmd === "setSettings") {
    settings = { ...settings, ...msg.settings };
    chrome.storage.local.set({ settings });
    sendResponse({ ok: true, settings });
    return false;
  }
  if (msg.cmd === "transcribe") {
    sendResponse({ ok: true, id: enqueueTranscribe(msg.file, msg.force) });
    return false;
  }
  if (msg.cmd === "enqueue") {
    sendResponse({ ok: true, id: enqueue(msg.req) });
    return false;
  }
  if (msg.cmd === "dismiss") {
    dismiss(msg.id);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.cmd === "probe") {
    const cached = probeCache.get(msg.url);
    if (cached) {
      sendResponse({ ok: true, qualities: cached, cached: true });
      return false;
    }
    nativeOnce(
      { action: "probe", url: msg.url, source: msg.source, referer: msg.referer },
      60000,
      (r) => {
        if (r.error) return sendResponse({ ok: false, error: r.error });
        if (r.msg && r.msg.type === "formats") {
          probeCache.set(msg.url, r.msg.qualities);
          sendResponse({ ok: true, qualities: r.msg.qualities });
        } else {
          sendResponse({ ok: false, error: (r.msg && r.msg.message) || "Could not read formats" });
        }
      }
    );
    return true; // async
  }
  if (msg.cmd === "pickFolder") {
    // The macOS dialog steals focus and closes the popup, so this response often
    // goes nowhere — saving to storage.local is what actually carries the result.
    nativeOnce({ action: "pickFolder" }, 310000, (r) => {
      if (r.error) return sendResponse({ ok: false, error: r.error });
      if (r.msg && r.msg.type === "folder") {
        if (r.msg.cancelled) return sendResponse({ ok: true, cancelled: true });
        const dir = r.msg.path;
        const recents = [dir, ...(settings.recentDirs || []).filter((d) => d !== dir)].slice(0, 5);
        settings = { ...settings, outdir: dir, recentDirs: recents };
        chrome.storage.local.set({ settings });
        sendResponse({ ok: true, path: dir, settings });
      } else {
        sendResponse({ ok: false, error: (r.msg && r.msg.message) || "Folder picker failed" });
      }
    });
    return true; // async
  }
});
