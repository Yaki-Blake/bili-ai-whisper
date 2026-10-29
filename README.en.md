<p align="center">  
  <a href="README.md">简体中文</a> · <b>English</b>  
</p>

# bili-ai-whisper

Bilibili local subtitle filler — Chinese subtitles for videos that have none. Everything runs locally, audio is never uploaded.

The backend is **SenseVoice-Small** only (more accurate on Chinese than whisper, roughly 25–35× realtime on CPU). v0.4.1 dropped the faster-whisper fallback, cutting the dependency footprint from ~343 MB to ~205 MB.

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
    ├── asr.py              decode entry point, SenseVoice dispatch, loud failure
    ├── asr_sensevoice.py   SenseVoice chunked decoding, sentence splitting
    ├── audio_util.py       decodes everything to 16k mono
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

Double-click `server\run.bat`. First run downloads about 430 MB in total:

- Python dependencies　~200 MB (Flask, requests, PyAV, sherpa-onnx, numpy)
- The SenseVoice model　~228 MB

You are ready when you see:

```
  服务地址   http://127.0.0.1:8765
  运行日志   server.log
```

The window goes quiet after that; all logs go to `server.log`.

Dependencies live only in `server\.venv` and the model in `%LOCALAPPDATA%\bili-ai-whisper\cache`. Nothing touches your system environment and no background service is installed — to remove everything, just delete those two folders.

**Watch a video**

Open a Bilibili video without subtitles → press play → a "字" ball appears in the bottom right → first line in about 2 seconds, the rest stream in as it transcribes.

Grey ball with a notice bar underneath means the video has official subtitles and the extension stood down. The bar has two buttons: `Open official subtitles` and `Switch to AI subtitles`.

Click the ball to change font size, re-run, export SRT or clear the cache.

## 3. Known issues

**Functionality**

- Only regular Bilibili videos, playlist pages and bangumi pages; other sites do not work
- Windows only
- Chinese transcription only; no translation for foreign-language videos
- Everyday speech is readable, but technical terms still break: `void *` comes out as 「word新」, `字节` occasionally as 「字己」
- A logged-out account gets no AI subtitle list, so "cannot query" is misread as "none"
- DRM-protected bangumi/movie content may return no audio stream from `playurl`

**Performance**

- SenseVoice runs at ~25–35× realtime: a 20-minute video takes ~40 s, a 50-minute one ~90 s. Measured end to end: 176 s of audio in 6.6 s, model load included
- Decoding loads the whole track into memory: ~230 MB for one hour of audio

**Environment traps (handled in code, may reappear on another machine)**

- Some Edge builds **globally refuse extension injection** and return `Blocked` on every site, unrelated to the code — switch to Chrome
- With Windows console QuickEdit on, selecting text with the mouse freezes every request. stdout is redirected to `server.log` to work around it
- The SenseVoice model is fetched over plain HTTP (no huggingface_hub any more); flaky networks can still interrupt it. Mitigated with `.part` staging plus three retries
- SenseVoice token timestamps drift on "long chunk + long silence" — a 10-second line can be labelled 25 seconds. Fixed with 20-second chunks plus a break on any pause over 2 seconds

## 4. How the code works

```
bridge.js   main world: signed Bilibili API calls, sniffs aid/cid from player requests
   │ postMessage
content.js  isolated world: detects official subtitles → stands down or starts a job,
            renders in sync via rAF
   │ chrome.runtime
background  only forwards short requests to localhost:8765
   │ HTTP
server.py   downloads the audio track → hands it to asr → returns cues incrementally
   │
asr.py      decodes (PyAV → 16k mono) → SenseVoice in 20-second chunks, split on
            punctuation and pauses; missing deps raise instead of silently degrading
```

## 5. Disclaimer

This project is for personal study and technical research only. It does not download, store or redistribute any video content; audio is processed locally and temporarily, and nothing is uploaded to any server. Please comply with Bilibili's terms of service and applicable laws. Any consequences arising from use are borne by the user.

## 6. License

MIT — see [LICENSE](LICENSE).
