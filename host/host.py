#!/opt/homebrew/bin/python3
"""
Media Grabber — Chrome Native Messaging host.

Chrome launches this on demand and speaks the native-messaging protocol over
stdin/stdout: each message is a 4-byte little-endian length prefix followed by
that many bytes of UTF-8 JSON.

It receives a download request from the extension and runs yt-dlp, streaming
progress back to the extension as framed JSON messages.

IMPORTANT: Chrome starts native hosts with a minimal environment (no Homebrew /
nvm PATH), so every external binary is referenced by absolute path and nothing
here relies on $PATH. Nothing may be written to stdout except framed messages —
all debug output goes to host.log next to this file.
"""

import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback

# --- Absolute paths (Chrome's env has no Homebrew PATH) -----------------------
YTDLP = "/opt/homebrew/bin/yt-dlp"
FFMPEG_DIR = "/opt/homebrew/bin"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
WHISPER = "/opt/homebrew/bin/whisper-cli"
HOME = os.path.expanduser("~")
DEFAULT_OUTDIR = os.path.join(HOME, "Downloads")

# Whisper models live beside the deployed host (install.sh downloads one there).
MODEL_DIR = os.path.join(HOME, "Library", "Application Support", "MediaGrabber", "models")
DEFAULT_MODEL = "large-v3"
# 16 of 20 performance cores (M3 Ultra). Leaves 4 P-cores + the E-cores for
# Chrome/ffmpeg/system, since whisper.cpp throughput flattens out well before
# using every core.
WHISPER_THREADS = "16"

# Log to /tmp (always writable) rather than under ~/Documents, which macOS TCC
# can block for a process Chrome spawned — that would hide every error.
LOG_PATH = "/tmp/mediagrabber-host.log"

# Child processes (yt-dlp) inherit our env with Homebrew prepended to PATH, so
# HOME and everything else survive (previously the env was replaced wholesale).
CHILD_ENV = dict(os.environ)
CHILD_ENV["PATH"] = FFMPEG_DIR + ":" + CHILD_ENV.get("PATH", "/usr/bin:/bin")

# Progress line, e.g.:
#   [download]  97.0% of ~  27.68MiB at  694.13KiB/s ETA 00:03 (frag 98/101)
PCT_RE = re.compile(r"\[download]\s+([\d.]+)%")
SPEED_RE = re.compile(r"at\s+(\S+/s)")
ETA_RE = re.compile(r"ETA\s+([\d:]+|Unknown)")
FRAG_RE = re.compile(r"\(frag\s+(\d+)/(\d+)\)")
DEST_RE = re.compile(r"\[download]\s+Destination:\s+(.+)$")
MERGE_RE = re.compile(r'\[Merger]\s+Merging formats into\s+"(.+)"')
# Audio-only runs rename after extraction, so the download's "Destination:" line
# names a file that no longer exists (.mp4 -> .m4a). This lands last and wins.
EXTRACT_RE = re.compile(r"\[ExtractAudio]\s+Destination:\s+(.+)$")
ALREADY_RE = re.compile(r"\[download]\s+(.+)\s+has already been downloaded")

# Characters that are unsafe in a macOS/HFS filename.
UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# whisper-cli -pp, e.g.: "whisper_print_progress_callback: progress =  40%"
WHISPER_PCT_RE = re.compile(r"progress\s*=\s*(\d+)%")
# ffprobe-free duration read from ffmpeg's own stderr, e.g. "Duration: 00:41:07.02,"
DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d\d):(\d\d)")

# Transcript formats we can emit -> the whisper-cli flag that produces each.
TRANSCRIPT_FORMATS = {
    "txt": "-otxt",
    "srt": "-osrt",
    "vtt": "-ovtt",
    "json": "-oj",
}

# Every child process we spawn, so a disconnect can kill it instead of leaving a
# multi-minute whisper run orphaned and eating the CPU. Guarded by a lock because
# the reaper runs on the main thread while a job may be mid-spawn.
_children = []
_children_lock = threading.Lock()


def track_child(proc):
    with _children_lock:
        _children.append(proc)
    return proc


def kill_children():
    """Terminate anything still running. Called when Chrome closes our stdin."""
    with _children_lock:
        procs = list(_children)
        _children.clear()
    for p in procs:
        if p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


def log(msg):
    try:
        with open(LOG_PATH, "a") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


# Runs at import — if this line is missing from the log, Python never started
# (exec/permission/location problem) rather than a logic error inside the host.
log("=== module loaded (py=%s argv=%s) ===" % (sys.version.split()[0], sys.argv))


# --- Native messaging framing -------------------------------------------------
def read_message():
    """Read one framed message from stdin. Returns dict or None on EOF."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None
    return json.loads(data.decode("utf-8"))


_write_lock = threading.Lock()


def send_message(obj):
    """Write one framed message to stdout. Thread-safe."""
    data = json.dumps(obj).encode("utf-8")
    with _write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def sanitize_title(title):
    title = UNSAFE_FILENAME.sub(" ", title or "").strip()
    # Collapse whitespace and trim to a sane length.
    title = re.sub(r"\s+", " ", title)
    return title[:180] if title else ""


# Completed-output extensions. We only treat one of THESE as a collision (not a
# leftover ".part"), so an interrupted download can still resume rather than
# spawning a new numbered file. Split by kind so grabbing the audio of a video
# you already have doesn't get a pointless "(1)" — Foo.mp4 and Foo.m4a coexist.
VIDEO_EXTS = ("mp4", "mkv", "webm", "mov", "m4v")
AUDIO_EXTS = ("m4a", "mp3")
FINAL_EXTS = VIDEO_EXTS + AUDIO_EXTS


def unique_title(outdir, title, exts=FINAL_EXTS):
    """Return `title`, or `title (n)` if a finished file with that stem exists."""
    def taken(stem):
        return any(
            os.path.exists(os.path.join(outdir, "%s.%s" % (stem, e)))
            for e in exts
        )
    if not taken(title):
        return title
    n = 1
    while taken("%s (%d)" % (title, n)):
        n += 1
    return "%s (%d)" % (title, n)


def check_writable(outdir, create=True):
    """Return (ok, error_message).

    macOS TCC frequently blocks a Chrome-spawned process from ~/Downloads,
    ~/Documents and ~/Desktop, so probe with a real write before committing to
    a long job — otherwise it fails silently minutes in.
    """
    try:
        if create:
            os.makedirs(outdir, exist_ok=True)
        probe = os.path.join(outdir, ".mediagrabber_write_test")
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return True, None
    except Exception as e:
        log("OUTDIR not writable (%s): %s" % (outdir, e))
        return False, (
            "Can't write to %s — macOS blocked it. Grant Google Chrome Full Disk "
            "Access in System Settings > Privacy & Security, then retry." % outdir
        )


def format_args(req):
    """Return (yt-dlp selector args, extensions that count as a collision).

    Options are snapshotted into the job when the user clicks Download, so what
    arrives here is exactly what was chosen at that moment.
    """
    fmt = req.get("format") or "video"
    if fmt == "m4a":
        # -x with m4a copies the AAC bitstream (no re-encode); mp3 would force a
        # slow, lossy transcode, which is why it isn't offered.
        # "ba/b": prefer a real audio-only rendition (HLS splits them out), but
        # fall back to the muxed file for progressive sources that have no
        # audio-only format — bare "ba" hard-errors on those.
        return ["-f", "ba/b", "-x", "--audio-format", "m4a"], AUDIO_EXTS

    quality = req.get("quality") or {}
    if quality.get("mode") == "exact" and quality.get("formatId"):
        fid = quality["formatId"]
        height = quality.get("height")
        if height:
            # Probed id first, then a height cap, then the WORST rendition. A cap
            # that matches nothing is a hard error in yt-dlp, and the id can go
            # stale between probe and download (refreshed token), so both need a
            # degrade path rather than a failure.
            selector = "%s+ba/bv*[height<=%s]+ba/wv*+ba/w" % (fid, height)
        else:
            selector = "%s+ba/bv*+ba/b" % fid
        return ["-f", selector], VIDEO_EXTS

    return ["-f", "bv*+ba/b"], VIDEO_EXTS  # default: best video+audio


def build_command(req):
    """Translate a download request into a yt-dlp argv list."""
    url = req["url"]
    source = req.get("source", "media")  # "media" (captured stream) or "page"
    referer = req.get("referer")
    title = sanitize_title(req.get("title", ""))
    outdir = req.get("outdir") or DEFAULT_OUTDIR

    sel, collide_exts = format_args(req)

    if title:
        title = unique_title(outdir, title, collide_exts)
        out_tmpl = os.path.join(outdir, title + ".%(ext)s")
    else:
        out_tmpl = os.path.join(outdir, "%(title)s.%(ext)s")

    cmd = [
        YTDLP,
        url,
    ] + sel + [
        "--ffmpeg-location", FFMPEG_DIR,
        "-o", out_tmpl,
        "--newline",                    # progress on its own line
        "--no-playlist",                # a single lesson, not a playlist
        "--no-mtime",
        "--no-update",                  # drop the "version is old" nag lines
        "--no-restrict-filenames",
    ]

    if referer:
        cmd += ["--add-header", "Referer: " + referer]

    # A captured manifest URL carries its own auth token, so no cookies needed.
    # A bare page URL handed to yt-dlp's extractors may need the login session.
    if source == "page":
        cmd += ["--cookies-from-browser", "chrome"]

    return cmd, outdir


def run_download(req):
    try:
        cmd, outdir = build_command(req)
    except Exception as e:
        send_message({"type": "error", "message": "Bad request: %s" % e})
        return

    # A user-chosen destination may be TCC-blocked; fail fast and clearly.
    ok, err = check_writable(outdir)
    if not ok:
        send_message({"type": "error", "message": err})
        return

    log("RUN: " + " ".join(cmd))
    send_message({"type": "started", "url": req.get("url"), "outdir": outdir})

    final_path = None
    last_pct_sent = -1.0
    already = False
    used_cookies = "--cookies-from-browser" in cmd

    try:
        proc = track_child(subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,   # fold errors into the same stream
            bufsize=1,
            universal_newlines=True,
            env=CHILD_ENV,
        ))
    except FileNotFoundError:
        send_message({"type": "error", "message": "yt-dlp not found at " + YTDLP})
        return

    tail = []  # keep last lines for error reporting
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line:
            continue
        tail.append(line)
        if len(tail) > 25:
            tail.pop(0)
        log(line)

        m = DEST_RE.search(line)
        if m:
            final_path = m.group(1).strip()
        m = MERGE_RE.search(line)
        if m:
            final_path = m.group(1).strip()
        m = ALREADY_RE.search(line)
        if m:
            final_path = m.group(1).strip()
            already = True
        m = EXTRACT_RE.search(line)
        if m:
            final_path = m.group(1).strip()

        pm = PCT_RE.search(line)
        if pm:
            pct = float(pm.group(1))
            # Throttle: only forward on a >=0.5% change (or completion).
            if pct >= 100.0 or abs(pct - last_pct_sent) >= 0.5:
                last_pct_sent = pct
                sm = SPEED_RE.search(line)
                em = ETA_RE.search(line)
                fm = FRAG_RE.search(line)
                send_message({
                    "type": "progress",
                    "pct": pct,
                    "speed": sm.group(1) if sm else None,
                    "eta": em.group(1) if em else None,
                    "frag": ("%s/%s" % (fm.group(1), fm.group(2))) if fm else None,
                })

    proc.wait()
    log("EXIT CODE: %s  final_path=%s" % (proc.returncode, final_path))

    if proc.returncode == 0:
        send_message({"type": "done", "ok": True, "file": final_path,
                      "outdir": outdir, "already": already})
        return

    # Failure. If we tried cookies-from-browser, that's the most common culprit
    # (locked keychain / Chrome storage) — retry once without it.
    err_text = "\n".join(tail[-8:])
    if used_cookies:
        log("Retrying without --cookies-from-browser")
        send_message({"type": "info", "message": "Retrying without browser cookies..."})
        req2 = dict(req)
        req2["source"] = "media"  # drops the cookies flag
        cmd2, _ = build_command(req2)
        log("RUN(retry): " + " ".join(cmd2))
        try:
            proc2 = subprocess.run(
                cmd2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                universal_newlines=True,
                env=CHILD_ENV,
            )
            for l in proc2.stdout.splitlines():
                log(l)
                m = (EXTRACT_RE.search(l) or MERGE_RE.search(l) or
                     DEST_RE.search(l) or ALREADY_RE.search(l))
                if m:
                    final_path = m.group(1).strip()
            if proc2.returncode == 0:
                send_message({"type": "done", "ok": True, "file": final_path, "outdir": outdir})
                return
            err_text = "\n".join(proc2.stdout.splitlines()[-8:])
        except Exception as e:
            err_text = str(e)

    send_message({"type": "error", "message": err_text or ("yt-dlp exited %s" % proc.returncode)})


# --- Quality probe ------------------------------------------------------------
def run_probe(req):
    """List the real video renditions behind a URL so the UI can offer them.

    Canonical labels can't be assumed (a stream may carry 432p and no 480p), and
    a `height<=N` cap matching nothing is a hard error in yt-dlp — so the picker
    is built from what actually exists, with each height's concrete format_id.
    """
    url = req["url"]
    source = req.get("source", "media")
    referer = req.get("referer")

    cmd = [
        YTDLP, url,
        "-J",                       # dump metadata as JSON, download nothing
        "--no-warnings",
        "--no-playlist",
        "--no-update",
        "--socket-timeout", "10",
    ]
    if referer:
        cmd += ["--add-header", "Referer: " + referer]
    if source == "page":
        cmd += ["--cookies-from-browser", "chrome"]

    log("PROBE: " + " ".join(cmd[:3]) + " …")
    try:
        # stderr kept SEPARATE here — stdout must stay pure JSON.
        proc = track_child(subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, env=CHILD_ENV,
        ))
        out, err = proc.communicate(timeout=60)
    except FileNotFoundError:
        send_message({"type": "error", "message": "yt-dlp not found at " + YTDLP})
        return
    except subprocess.TimeoutExpired:
        try: proc.kill()
        except Exception: pass
        send_message({"type": "error", "message": "Timed out reading formats"})
        return

    if proc.returncode != 0:
        log("PROBE FAILED: " + (err or "")[-500:])
        send_message({"type": "error",
                      "message": (err or "").strip().splitlines()[-1:] and
                      (err or "").strip().splitlines()[-1] or
                      "Could not read formats (exit %s)" % proc.returncode})
        return

    try:
        data = json.loads(out)
    except Exception as e:
        send_message({"type": "error", "message": "Unreadable format data: %s" % e})
        return

    duration = data.get("duration") or 0
    # Keep the highest-bitrate rendition per height. Audio entries have NO
    # 'height' key at all, so .get() is load-bearing.
    best_per_height = {}
    for f in data.get("formats", []):
        h = f.get("height")
        if not h or f.get("vcodec") == "none":
            continue
        cur = best_per_height.get(h)
        if cur is None or (f.get("tbr") or 0) > (cur.get("tbr") or 0):
            best_per_height[h] = f

    qualities = []
    for h in sorted(best_per_height, reverse=True):
        f = best_per_height[h]
        tbr = f.get("tbr") or 0
        # These streams carry no filesize field; estimate from bitrate × duration.
        est = int(tbr * 1000 / 8 * duration) if (tbr and duration) else None
        qualities.append({
            "height": h,
            "formatId": f.get("format_id"),
            "tbr": tbr,
            "fps": f.get("fps"),
            "estBytes": est,
        })

    log("PROBE OK: %d heights %s" % (len(qualities), [q["height"] for q in qualities]))
    send_message({"type": "formats", "qualities": qualities,
                  "duration": duration, "title": data.get("title")})


# --- Folder picker ------------------------------------------------------------
OSASCRIPT = "/usr/bin/osascript"


def run_pick_folder(req):
    """Show a real macOS folder chooser and return the chosen POSIX path.

    Driven from the background worker, not the popup: the dialog steals focus,
    which closes the Chrome popup and would take a popup-owned port (and this
    dialog) down with it.

    Bare `activate` brings the dialog to the front without needing the Automation
    permission that `tell application "System Events"` would prompt for.
    """
    cmd = [
        OSASCRIPT,
        "-e", "activate",
        "-e", 'POSIX path of (choose folder with prompt "Choose download folder")',
    ]
    log("PICKFOLDER: opening chooser")
    try:
        proc = track_child(subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, env=CHILD_ENV,
        ))
        out, err = proc.communicate(timeout=300)  # generous: a human is choosing
    except FileNotFoundError:
        send_message({"type": "error", "message": "osascript not found at " + OSASCRIPT})
        return
    except subprocess.TimeoutExpired:
        try: proc.kill()
        except Exception: pass
        send_message({"type": "error", "message": "Folder picker timed out"})
        return

    if proc.returncode != 0:
        text = (err or "").strip()
        if "User canceled" in text or "-128" in text:
            log("PICKFOLDER: cancelled")
            send_message({"type": "folder", "cancelled": True})
            return
        log("PICKFOLDER FAILED: " + text[-300:])
        send_message({"type": "error", "message": text or "Folder picker failed"})
        return

    # `POSIX path of` yields a trailing slash; keep "/" itself intact.
    path = (out or "").strip()
    path = path.rstrip("/") or "/"
    if not path:
        send_message({"type": "error", "message": "No folder returned"})
        return

    # Validate now rather than at download time — a TCC-blocked pick (Desktop,
    # Documents) should be reported while the user is still thinking about it.
    ok, werr = check_writable(path, create=False)
    if not ok:
        send_message({"type": "error", "message": werr})
        return

    log("PICKFOLDER OK: " + path)
    send_message({"type": "folder", "path": path})


# --- Transcription ------------------------------------------------------------
def resolve_model(name):
    """Return (model_path, error_message). Accepts 'small.en' or a full path."""
    if os.path.isabs(name):
        path = name
    else:
        path = os.path.join(MODEL_DIR, "ggml-%s.bin" % name)
    if not os.path.isfile(path):
        have = []
        try:
            have = sorted(f for f in os.listdir(MODEL_DIR) if f.endswith(".bin"))
        except Exception:
            pass
        return None, (
            "Whisper model '%s' not found at %s.%s Run ./install.sh to download it."
            % (name, path, (" Installed: %s." % ", ".join(have)) if have else "")
        )
    return path, None


def extract_audio(src, dst):
    """Decode any container to the 16 kHz mono PCM wav whisper-cli requires.

    whisper-cli only reads flac/mp3/ogg/wav, so an mp4/mkv/m4a always needs this
    step — it is not an optimization. Returns (ok, error_text).
    """
    cmd = [
        FFMPEG, "-y", "-loglevel", "error",
        "-i", src,
        "-vn",              # drop video
        "-ac", "1",         # mono
        "-ar", "16000",     # 16 kHz — whisper's native rate
        "-c:a", "pcm_s16le",
        dst,
    ]
    log("FFMPEG: " + " ".join(cmd))
    try:
        proc = track_child(subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            universal_newlines=True, env=CHILD_ENV,
        ))
        out, _ = proc.communicate()
    except FileNotFoundError:
        return False, "ffmpeg not found at " + FFMPEG
    if proc.returncode != 0:
        return False, (out or "").strip()[-500:] or "ffmpeg exited %s" % proc.returncode
    return True, None


def run_transcribe(req):
    src = req.get("file")
    if not src or not os.path.isfile(src):
        send_message({"type": "error", "message": "File not found: %s" % (src or "(none)")})
        return

    model_path, err = resolve_model(req.get("model") or DEFAULT_MODEL)
    if err:
        log("MODEL MISSING: " + err)
        send_message({"type": "error", "message": err})
        return

    formats = [f for f in (req.get("formats") or ["txt", "srt"]) if f in TRANSCRIPT_FORMATS]
    if not formats:
        send_message({"type": "error", "message": "No valid transcript formats requested"})
        return

    stem = os.path.splitext(src)[0]
    outdir = os.path.dirname(src)
    expected = dict((f, "%s.%s" % (stem, f)) for f in formats)

    # Already transcribed? Don't burn minutes of CPU redoing it.
    if not req.get("force") and all(os.path.isfile(p) for p in expected.values()):
        log("TRANSCRIBE: already present for " + src)
        send_message({"type": "done", "ok": True, "file": src,
                      "outputs": expected, "already": True})
        return

    # Same TCC preflight as downloads: transcripts land next to the media, so a
    # blocked ~/Downloads must fail here rather than after minutes of whisper.
    # create=False — the directory already exists, we just need write access.
    ok, err = check_writable(outdir, create=False)
    if not ok:
        send_message({"type": "error", "message": err})
        return

    send_message({"type": "started", "file": src, "stage": "extracting"})
    send_message({"type": "info", "message": "Extracting audio…"})

    # Temp wav goes to /tmp: always writable, and a 40-minute video's 16 kHz mono
    # wav is ~75 MB, which we do not want sitting in ~/Downloads if we crash.
    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="mediagrabber-")
    os.close(fd)
    try:
        ok, err = extract_audio(src, tmp_wav)
        if not ok:
            send_message({"type": "error", "message": "Audio extraction failed: %s" % err})
            return

        cmd = [
            WHISPER,
            "-m", model_path,
            "-f", tmp_wav,
            "-of", stem,            # whisper appends .txt/.srt/... itself
            "-t", WHISPER_THREADS,
            "-pp",                  # emit progress we can forward to the popup
        ]
        for f in formats:
            cmd.append(TRANSCRIPT_FORMATS[f])

        # An ".en" model is English-only and rejects a language flag; a
        # multilingual model can auto-detect.
        if ".en" not in os.path.basename(model_path):
            cmd += ["-l", req.get("language") or "auto"]

        log("WHISPER: " + " ".join(cmd))
        send_message({"type": "info", "message": "Transcribing…"})

        try:
            proc = track_child(subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                bufsize=1, universal_newlines=True, env=CHILD_ENV,
            ))
        except FileNotFoundError:
            send_message({"type": "error", "message":
                "whisper-cli not found at %s — run: brew install whisper-cpp" % WHISPER})
            return

        tail = []
        last_pct = -1
        for line in proc.stdout:
            line = line.rstrip("\n")
            if not line:
                continue
            tail.append(line)
            if len(tail) > 25:
                tail.pop(0)
            log(line)
            m = WHISPER_PCT_RE.search(line)
            if m:
                pct = int(m.group(1))
                if pct != last_pct:
                    last_pct = pct
                    send_message({"type": "progress", "pct": float(pct),
                                  "stage": "transcribing"})

        proc.wait()
        log("WHISPER EXIT: %s" % proc.returncode)

        if proc.returncode != 0:
            send_message({"type": "error", "message":
                "\n".join(tail[-8:]) or "whisper-cli exited %s" % proc.returncode})
            return

        written = dict((f, p) for f, p in expected.items() if os.path.isfile(p))
        if not written:
            send_message({"type": "error", "message":
                "whisper-cli finished but wrote no transcript next to the video"})
            return

        send_message({"type": "done", "ok": True, "file": src,
                      "outputs": written, "already": False})
    finally:
        try:
            os.remove(tmp_wav)
        except Exception:
            pass


def main():
    log("=== host started ===")
    try:
        while True:
            req = read_message()
            if req is None:
                log("stdin closed, exiting")
                break
            action = req.get("action")
            log("REQ action=%s" % action)
            if action == "ping":
                send_message({"type": "pong", "ytdlp": YTDLP, "whisper": WHISPER})
            elif action == "download":
                run_download(req)
            elif action == "probe":
                run_probe(req)
            elif action == "pickFolder":
                run_pick_folder(req)
            elif action == "transcribe":
                run_transcribe(req)
            else:
                send_message({"type": "error", "message": "unknown action: %s" % action})
    except Exception:
        log("FATAL:\n" + traceback.format_exc())
        try:
            send_message({"type": "error", "message": "host crashed; see host.log"})
        except Exception:
            pass
    finally:
        # Chrome closed the port (or we crashed) — never leave a whisper run
        # orphaned, it would hold 4 cores for minutes with nobody listening.
        kill_children()


if __name__ == "__main__":
    main()
