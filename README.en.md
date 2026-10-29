<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

# Bili Local Subtitle

Chinese subtitles for Bilibili videos that have none. Everything runs on your own machine — the audio is never uploaded.

**It only acts on videos without official subtitles.** If a video has uploader-provided or Bilibili AI subtitles, the extension stays out of the way by default and leaves a thin notice under the player (with a one-click switch to AI subtitles). No overlay, no covering, no page styling changes.

---

## Measured results (2026-10-29, i5-12450H / 15.8 GB / no GPU acceleration)

The server side is fully working; these numbers are measured, not estimated:

| Item | Measured |
|---|---|
| Test video | 177 s, Chinese, no official subtitles |
| Audio download | 3.12 MB / 0.9 s |
| First subtitle line | **4.8 s** (streams while transcribing) |
| Whole video transcribed | 72.8 s → **2.4× realtime** |
| Coverage | last line 176.6 s / 177 s = **99.8%** |
| Cache hit | **4 ms** |

The extension side has been verified in **Chrome**: script injection, page detection on `/video/` and playlist pages, standing down when official subtitles exist, and one-click switching to AI subtitles all work.

> Some Edge environments return `Blocked` for injection on *every* site. That is a browser-level block, not an extension bug (reproduced with a 20-line standalone probe extension on github / Bilibili / a mail site / a survey site). If you hit it, use Chrome — see the troubleshooting table below.

---

## How it works

```
Page main world   bridge.js   ── signed Bilibili API calls, sniffs the current cid
     │ postMessage
Content script    content.js  ── decides whether subtitles exist, renders the overlay
     │ chrome.runtime
Background        background  ── forwards short requests only
     │ HTTP
Local server      server.py   ── downloads the audio track → faster-whisper → streams back
```

Four design decisions:

1. **Video identity does not come from the URL.** Playlist pages (`/list/`) do not contain a BV id in the address. Instead the extension hooks `fetch` / `XMLHttpRequest` and sniffs `aid` and `cid` from the player request, which works on `/video/`, `/list/` and `/bangumi/`.
2. **The subtitle endpoint requires a Wbi signature.** In practice, a wrong signature **still returns `code: 0`** and silently drops the data. So only `wbi/v2` is used, and the result is validated against the last cue timestamp.
3. **Transcription runs as a job.** An MV3 service worker gets reclaimed, which kills long-running requests. Instead: submit a job, then poll — a short request per second, which also gives you streaming output.
4. **VAD is off.** See pitfall #3 below; leaving it on reduces the output to a single line.

---

## Install

### Step 1: install the extension

> **Chrome is recommended.** One Edge environment was observed here that globally refuses extension script injection — even a 20-line, freshly installed probe extension with complete permissions returned `Blocked` on four different sites, unrelated to the extension code; the same code works fine in Chrome. Both paths are given below, but prefer Chrome.

1. Open Chrome and go to `chrome://extensions/` (Edge: `edge://extensions/`)
2. Turn on **Developer mode** in the top right
3. Click **Load unpacked** and select the `extension` folder
4. Pin the extension to the toolbar
5. **After every change to files inside `extension`, click the reload icon (↻) on this page**, then press F5 on the Bilibili tab. Old scripts do not update themselves — this is the most common cause of "I changed the code but nothing happened"

### Step 2: start the local server

Double-click `server\run.bat`. On first run it will:

- create a virtual environment (any Python 3.11+; **3.13 verified**)
- install dependencies from the Aliyun mirror (~400 MB)
- start the server on `127.0.0.1:8765`

The `small` model (~480 MB) is downloaded on first use through `hf-mirror.com` and reused afterwards.

You are up when you see:

```
============================================================
  服务地址   http://127.0.0.1:8765
  运行日志   server.log （本目录，可用记事本打开）
  停止服务   按 Ctrl 键加 C，或直接关闭本窗口
============================================================
```

The window itself stops scrolling after that: **all logs go to `server.log` in that folder.** This is deliberate — see pitfall #7.

### Step 3: make sure the extension has site access

`chrome://extensions/` → **Details** → **Site access** — `https://www.bilibili.com/*` must be **enabled**.

When this is off, the content script is never injected into Bilibili pages and **nothing at all appears, with no error**. The popup still shows a healthy service status, so it is easy to misread as "everything is fine".

---

## Usage

1. Open a Bilibili video **without subtitles** and press play
2. A floating "字" ball appears in the bottom right; its colour is the state:

| Colour | Meaning |
|---|---|
| Grey | Idle, or the video already has official subtitles (skipped) |
| Yellow | Checking |
| Blue | Transcribing |
| Green | Subtitles ready |
| Red | Error |

3. The first line shows up after ~5 s, and the rest fill in as transcription progresses (transcription runs at more than 2.4× playback speed, so it always stays ahead)
4. Click the ball to change font size, re-run, export SRT, clear the cache, or ping the service

**Log in to Bilibili first.** When logged out, the API does not return the AI subtitle list, so the extension mistakes "cannot query" for "none" and burns minutes of transcription for nothing. The code now warns about this case.

---

## Pitfalls (all handled in the code)

These were hit for real. Your environment may differ, but they save time:

**1. `pip` fails with `from versions: none`**
pip 26.1.2 with the Tsinghua mirror returns an empty version list; the Aliyun mirror works. `run.bat` defaults to Aliyun and falls back to Tsinghua. Also **do not** run `pip install --upgrade pip` in the script — upgrading to 26 makes package installs fail.

**2. Model download hangs at "loading model…" and then fails**
Two causes stacked:
- `huggingface-hub 2.x` defaults to the Xet transport (`cas-server.xethub.hf.co`), which Chinese mirrors do not proxy → 401. The code sets `HF_HUB_DISABLE_XET=1`.
- Direct access to `huggingface.co` is effectively dead here → `HF_ENDPOINT=https://hf-mirror.com` is set by default.

**3. VAD treats speech as silence (the worst one)**
silero VAD classified 168 of 176 seconds as non-speech and emitted only the opening line. Comparison:

| Config | Segments | Detected speech |
|---|---|---|
| VAD on | 1 segment | 8.99 s / 176.4 s |
| VAD off | 45 segments | 176.4 s / 176.4 s |

So `vad: false` is the default, with hallucination filtering instead. You can change `vad` in `config.json` if you want to experiment.

**4. PyAV version conflict**
`av 19` removed `av.open(metadata_errors=...)` while `faster-whisper 1.2.x` still passes it, causing a `TypeError` during decoding. `requirements.txt` pins `av<19`.

**5. The model is downloaded but loading still fails**
`WhisperModel("small")` verifies the etag over the network every time, so any network hiccup prevents startup. The code now scans the local cache for `model.bin` and loads by path, fully offline.
(`snapshot_download(local_files_only=True)` does not help — it requires a complete snapshot and errors out if `README.md` is missing.)

**6. Parameter tuning, measured**
`beam_size` is the main lever; `cpu_threads` does nothing:

| Config | Time | Speed |
|---|---|---|
| beam=5 | 78.1 s | 2.3× |
| beam=1 | 44.8 s | 3.9× |
| beam=5 + 8 threads | 75.5 s | 2.3× |

Default is `beam_size: 1`, which was also slightly more accurate on this sample.

**7. The process is alive but every request times out (port LISTENING, zero responses)**

The worst failure so far. `py-spy dump` showed 12 worker threads all stuck on the same line:

```
write (colorama\ansitowin32.py)
  ... logging -> werkzeug log_request -> http.server send_response
```

Root cause is the Windows console: with **QuickEdit** enabled, **selecting text with the mouse** blocks any write to the console indefinitely. `http.server.send_response()` writes the access log before sending headers, so every request stalls there — and from the browser it looks like "the local service timed out". Restarting the extension does not help.

Fix: `server.py` redirects `sys.stdout` / `sys.stderr` to `server.log` before `import flask`, so the server no longer depends on the console. The "listening on…" message now comes from `run.bat`.

**8. Chinese text in batch files gets executed as commands**

If `run.bat` is saved as UTF-8 (no BOM), `cmd.exe` parses it byte-wise, mis-splits multibyte Chinese characters and can turn one line into two commands, producing errors like `'Ctrl+C' is not recognized`.

Fix: `run.bat` and the launcher are **GBK (cp936) with CRLF**, plus `chcp 936` inside the script. Do not overwrite these files as UTF-8.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **Nothing on the page at all, not even the ball** | First tell apart "browser blocks it" from "extension not installed": press F12 on the Bilibili page and run `document.documentElement.dataset.bzSub` in the console. A version string = the script runs, the problem is UI; `undefined` = the script never got in |
| **`chrome.scripting` returns `Blocked` on every site** | That Edge build globally refuses extension injection (measured: a 10-line freshly installed probe extension returned `Blocked` on github / Bilibili / mail / survey sites). **Use Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `extension` folder. The same code works there |
| **The video has official subtitles but nothing is visible** | By design: the extension **stands down** when it detects official subtitles. A thin dark bar appears under the player — "this video has official subtitles, extension stood down" — with `Open official subtitles` and `Switch to AI subtitles`. Since v0.3.0 it no longer exits silently |
| **"Not logged in to Bilibili" although you are** | Before 0.3.1 the `isLogin` field of `/x/player/wbi/v2` was used, but that endpoint **returns `code:0`** even with a wrong signature, with an empty `data` and `isLogin: false` — "no data" was misread as "not logged in". Since 0.3.1 it re-checks via `/x/web-interface/nav` and shows the detail (nav code / login cookie present) in the prompt |
| Status stuck at "press play to start" | You have not pressed play. The sniffer needs a player request to capture the cid |
| "Service not connected" | `run.bat` is not running, or port 8765 is taken. Check the server window for errors |
| "Local service timed out" | Look for new lines in `server.log` first. None = the process stalled or exited; present but old = the service is frozen (pitfall #7) |
| Absolutely no reaction, no ball | `chrome://extensions/` → Details → Site access: `https://www.bilibili.com/*` must be enabled |
| Popup says "page script: this tab is not Bilibili" | What it really means is **the tab URL cannot be read**, most often because site access was not granted (see the row above). Since v0.2.3 the popup injects by itself, no manual step needed |
| Popup says "target page: cannot read address" | The tab is not a regular web page (`chrome://extensions`, `chrome://newtab`, extension pages…). Such pages cannot be injected by design. **Switch to the Bilibili video tab, then click the icon** |
| Popup says "injection failed" plus an English error | Send me that line. Since v0.2.4 it reports which step failed — `css:` / `bridge:` / `content:` |
| The launcher window flashes and closes | Double-click `启动字幕服务.bat` in the repo root, or run it from a cmd prompt to see the error |
| Only 1–2 subtitle lines | `vad` was set to `true` in `config.json`; set it back to `false` |
| Transcription is very slow | Expected: `small` on CPU runs at ~2.4–4× realtime. A 20-minute video takes 5–8 minutes |
| Noticeable typos in subtitles | A known limit of the `small` model. Switch to `medium` in settings — 2–3× slower |
| Model download fails | Check that `hf-mirror.com` is reachable; `hf_endpoint` in `config.json` can be changed |
| `pip install` fails | See pitfall #1, or switch to Python 3.12, delete `.venv` and start over |
| Want to verify the whole chain | With the server running: `server\.venv\Scripts\python.exe server\selftest.py` |

Cache location: `%LOCALAPPDATA%\bili-sub\cache` (transcripts + audio; audio is evicted oldest-first above 800 MB).

---

## Known limitations

- Only regular Bilibili videos, playlist pages and bangumi pages. No other sites.
- Chinese transcription only. Foreign-language videos would need translation, which this tool does not do.
- No terminology correction. Whisper is consistently wrong on technical terms; fine if you can tolerate it.
- A logged-out account has no AI subtitle list, which makes detection unreliable.
- Some bangumi / movie content is DRM-protected; `playurl` may return no audio stream and the request fails outright.
- Transcripts are cached by `cid`, so re-watching a video is instant.

---

## Layout

```
bili-sub/
├── 启动字幕服务.bat      one-click launcher (calls server\run.bat)
├── extension/            browser extension (MV3)
│   ├── manifest.json
│   ├── background.js     short request forwarding, settings
│   ├── content/
│   │   ├── bridge.js     main world: signing, API, cid sniffing
│   │   ├── content.js    isolated world: orchestration and rendering
│   │   └── content.css
│   ├── popup/            toolbar popup
│   └── options/          options page
└── server/               local server
    ├── server.py         Flask routes and job queue
    ├── asr.py            faster-whisper wrapper, hallucination filtering
    ├── bili.py           audio download, Wbi signing fallback
    ├── config.py         config read/write
    ├── selftest.py       API-level self test
    ├── requirements.txt
    └── run.bat           one-click start (creates .venv, installs deps, downloads model)
```

`server/.venv/`, `server/server.log`, `server/config.json` and the model cache are all in `.gitignore` and never enter the repo.

## Notes

A personal project written to the standard of "good enough for me", with no promise of generality. The transcription engine is faster-whisper running on CPU.
