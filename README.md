# Media Grabber

One-click video downloader. A Chrome extension watches the current page's network
traffic for video streams (HLS `.m3u8`, DASH `.mpd`, or direct `.mp4`/`.webm`/…),
and a tiny local helper runs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) to save
the **highest quality** to `~/Downloads`.

It works on token-protected streams (like course platforms) because it captures
the real manifest URL — token and all — straight from the network, which is the
part DevTools usually loses.

## How it works

```
Chrome page ──(network)──▶ extension captures .m3u8/.mpd/.mp4 URL (+ Referer)
                                   │
                          click "Download"
                                   │
                 chrome.runtime.connectNative
                                   ▼
        host.py (native messaging) ──▶ yt-dlp ──▶ ~/Downloads/<title>.mp4
                                   │
                     (if auto-transcribe is on)
                                   ▼
                       ffmpeg ──▶ whisper.cpp ──▶ <title>.txt + .srt
```

The extension can't run `yt-dlp` itself (extensions can't execute binaries), so a
small Python **native-messaging host** does the download. Chrome launches it on
demand — nothing to keep running.

## Requirements

macOS, and Homebrew at the Apple Silicon prefix (`/opt/homebrew`):

```bash
brew install yt-dlp ffmpeg python
brew install whisper-cpp   # optional, only for transcription
```

Plus Google Chrome. On Intel Macs Homebrew lives at `/usr/local`, so you'll need
to adjust the paths noted below.

> Paths are hardcoded in `host/host.py` because Chrome starts native hosts with a
> minimal environment (no Homebrew/nvm `PATH`). If your Homebrew prefix differs,
> edit `YTDLP` / `FFMPEG_DIR` / `FFMPEG` / `WHISPER` at the top of `host/host.py`,
> and the shebang on line 1.

## Install (one time)

1. Open `chrome://extensions`, turn on **Developer mode** (top-right).
2. **Load unpacked** → select the `extension/` folder.
3. Copy the extension's **ID** (32 letters under its name).
4. In this folder, register the helper with that ID:

   ```bash
   ./install.sh <extension-id>
   ```

That's it — no Chrome restart needed.

## Use

1. Open a page with a video and let it start playing (this triggers the stream
   request the extension listens for). The toolbar icon shows a badge count when
   video is detected.
2. Click the **Media Grabber** toolbar icon.
3. Click **Download** next to the detected video. It saves to `~/Downloads` at
   highest quality, with a live progress bar and a completion notification.

There's also a **"Download this page (yt-dlp)"** option that hands the page URL to
yt-dlp's built-in site extractors (YouTube, Vimeo, etc.) and uses your Chrome
login cookies for that fallback.

### Format, quality and destination

The settings strip at the top of the popup controls what the **next** download does:

- **Format** — `Video (MP4)` or `Audio only (M4A)`. M4A copies the original audio
  with no re-encode, so it's near-instant and lossless relative to the source.
- **Quality** — defaults to `Best`. Pick **Load qualities…** and the helper probes
  the stream (~2s) and lists the resolutions that actually exist, with size
  estimates. Real heights are used rather than canonical labels, because a stream
  may carry 432p and no 480p. Disabled for audio.
- **Save to** — `Downloads` by default. **Choose folder…** opens a real macOS
  folder dialog; previously used folders stay in the list for one-click switching.
- **Name** — the file name for the next download, prefilled from the tab title and
  editable. Type just the stem; the extension (`.mp4`/`.m4a`, shown at the right)
  is added for you. Unsafe characters are cleaned up and a same-named file is
  auto-numbered, so you can't clobber an existing download. It's per-page (not
  remembered), so each page starts from its own title.

These are **snapshotted when you click Download**. Change them and queue a second
video, and the first keeps the settings it was queued with — each job's row shows
its own chip (e.g. `MP4 · 720p`, `M4A`) so you can see exactly what it will do.

### Multiple downloads (queue)

You can queue up several videos: click **Download** on one, navigate to the next
lesson, click **Download** again, and so on. They appear under **Downloads** in
the popup and run **one at a time** (so each gets full bandwidth); the rest wait
their turn.

- Downloads are independent of the page — **navigating or refreshing never
  interrupts them**, and they keep running even if you close the popup.
- If a file with the same name already exists, the new one is auto-numbered
  (`… (1).mp4`, `… (2).mp4`).
- Finished downloads **stay in the list** until you dismiss them with the **×**.
  Clicking **×** on a running download cancels it and moves to the next in queue.

## Transcription (local, no API)

Transcription runs [whisper.cpp](https://github.com/ggerganov/whisper.cpp) on
your machine. **No API key, no tokens, nothing uploaded** — the audio never
leaves the laptop.

Two ways to trigger it:

- **Auto** — tick **Auto-transcribe after download** in the popup. Every finished
  download is queued for transcription automatically, no extra clicks.
- **Manual** — click **Transcribe** on any finished download in the Activity list.

Output lands **next to the video**, same basename: `Lecture 1.mp4` produces
`Lecture 1.txt` (plain text) and `Lecture 1.srt` (timestamped subtitles).

Transcription shares the download queue and runs **one job at a time** — on an
8 GB M1, transcribing while downloading would make both slower.

### Speed and the model

`install.sh` downloads the `small.en` model (~466 MB) to
`~/Library/Application Support/MediaGrabber/models/`.

Measured on an M1: **~13x realtime** — 4m12s of audio in 19s, so a 40-minute
lecture takes about 3 minutes. Already-transcribed files are skipped instantly.

To use a different model, download it into that folder and change
`DEFAULT_MODEL` in `host/host.py`:

```bash
MODEL_NAME=medium.en ./install.sh <extension-id>   # downloads it for you
```

`small.en` is the default deliberately: `medium.en` needs ~2.6 GB of RAM and
`large-v3` ~4.7 GB, which is a bad trade on an 8 GB machine with Chrome open.
Use a non-`.en` model (e.g. `small`) if you need languages other than English.

## Troubleshooting

- **"native host disconnected (is it installed?)"** — you haven't run
  `./install.sh <extension-id>`, or the ID changed (it changes if you remove and
  re-add the unpacked extension — just run `install.sh` again with the new ID).
- **"Specified native messaging host not found."** — Chrome can't see the host
  manifest. If you launched Chrome with a custom profile
  (`--user-data-dir=/some/path`, e.g. a dev/debug instance), Chrome looks for
  native-host manifests **inside that dir**, not the default profile's location.
  `install.sh` auto-registers into any Chrome that's *running* when you run it; if
  the target profile wasn't running, re-run with its dir:
  `MG_EXTRA_USER_DATA_DIRS="/some/path" ./install.sh <extension-id>`. The same
  cause makes **"Choose folder…"** silently fail to open Finder — the folder
  picker uses the same native host.
- **No video detected** — reload the page (or scrub/play the video) with the popup
  closed, then reopen it. The manifest request fires once when the player mounts.
- **See what the helper did** — every run is logged to `/tmp/mediagrabber-host.log`.
  (The helper itself is deployed by `install.sh` to
  `~/Library/Application Support/MediaGrabber/host.py` — it can't run from
  `~/Documents` because macOS TCC blocks Chrome from executing scripts there.
  Re-run `install.sh` after editing `host/host.py` to redeploy.)
- **Filename** — uses the browser tab's title. Rename after if you like.

## Scope / notes

- Downloads bypass Chrome's download UI (the helper writes straight to
  `~/Downloads`). That's intended.
- Only downloads content you can already access; token-gated HLS is read normally
  by yt-dlp (no DRM circumvention).

## Roadmap (v2 ideas, not built yet)

- One-click batch of a whole course module
- Per-site preferences

## License

MIT — see [LICENSE](LICENSE).
