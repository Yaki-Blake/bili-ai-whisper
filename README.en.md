<p align="center">  
  <a href="README.md">简体中文</a> · <b>English</b>  
</p>

# bili-ai-whisper

Bilibili local subtitle filler — Chinese subtitles for videos that have none. Everything runs locally, audio is never uploaded.

## 1. Layout

```
bili-ai-whisper/
├── 启动字幕服务.bat        one-click launcher (calls server\run.bat)
├── extension/              browser extension (MV3)
│   ├── manifest.json       version, permissions, script declarations
│   ├── background.js       forwards short requests, stores settings
│   ├── content/
│   │   ├── bridge.js       main world: Wbi signing, API calls, cid sniffing
│   │   ├── content.js      isolated world: detection, rendering, orchestration
│   │   └── content.css
│   ├── popup/              toolbar popup (status, permissions, AI switch)
│   └── options/            options page
└── server/                 local server (Flask)
    ├── server.py           routes + job queue
    ├── asr.py              faster-whisper wrapper, hallucination filtering
    ├── bili.py             audio download, signing fallback
    ├── config.py           config read/write
    ├── selftest.py         API self test
    ├── requirements.txt
    └── run.bat             creates .venv, installs deps, downloads model on first run
```

## 2. Usage

**Install the extension** (Chrome recommended, see section 3)

1. Open `chrome://extensions/` and enable **Developer mode** (top right)
2. **Load unpacked** → pick the `extension` folder
3. **After every change to files in `extension`, click reload (↻) then press F5** — otherwise the old script keeps running

**Start the server**

Double-click `server\run.bat`. First run downloads about 880 MB in total:

- Python dependencies　~400 MB
- The `small` model　~480 MB

You are ready when you see:

```
  服务地址   http://127.0.0.1:8765
  运行日志   server.log
```

The window goes quiet after that; all logs go to `server.log`.

Dependencies live only in `server\.venv` and the model in `%LOCALAPPDATA%\bili-ai-whisper\cache`. Nothing touches your system environment and no background service is installed — to remove everything, just delete those two folders.

**Watch a video**

Open a Bilibili video without subtitles → press play → a "字" ball appears in the bottom right → first line in about 5 seconds, the rest stream in as it transcribes.

Grey ball with a notice bar underneath means the video has official subtitles and the extension stood down. The bar has two buttons: `Open official subtitles` and `Switch to AI subtitles`.

Click the ball to change font size, re-run, export SRT or clear the cache.

## 3. Known issues

**Functionality**

- Only regular Bilibili videos, playlist pages and bangumi pages; other sites do not work
- Windows only
- Chinese transcription only; no translation for foreign-language videos
- Accuracy is poor — currently only good enough to follow along
- A logged-out account gets no AI subtitle list, so "cannot query" is misread as "none"
- DRM-protected bangumi/movie content may return no audio stream from `playurl`

**Performance**

- CPU with the `small` model runs at ~2.4–4× realtime: a 20-minute video takes 5–8 minutes (the first line arrives in 5 seconds, so you can start watching)
- `medium` is more accurate but 2–3× slower

**Environment traps (handled in code, may reappear on another machine)**

- Some Edge builds **globally refuse extension injection** and return `Blocked` on every site, unrelated to the code — switch to Chrome
- With Windows console QuickEdit on, selecting text with the mouse freezes every request. stdout is redirected to `server.log` to work around it
- VAD on this machine classified speech as silence and emitted a single line. Off by default
- Model loading used to verify over the network and failed on any hiccup. Now loaded straight from the local path

## 4. How the code works

```
bridge.js   main world: signed Bilibili API calls, sniffs aid/cid from player requests
   │ postMessage
content.js  isolated world: detects official subtitles → stands down or starts a job,
            renders in sync via rAF
   │ chrome.runtime
background  only forwards short requests to localhost:8765
   │ HTTP
server.py   downloads the audio track → faster-whisper → returns cues incrementally
```

## 5. Disclaimer

This project is for personal study and technical research only. It does not download, store or redistribute any video content; audio is processed locally and temporarily, and nothing is uploaded to any server. Please comply with Bilibili's terms of service and applicable laws. Any consequences arising from use are borne by the user.

## 6. License

MIT — see [LICENSE](LICENSE).
