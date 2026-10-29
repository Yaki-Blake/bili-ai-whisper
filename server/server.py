"""本地服务：音频下载 + faster-whisper 转写 + 增量结果推送。

为什么是「提交任务 + 轮询」而不是一个同步接口：
MV3 的 service worker 会被回收，浏览器侧也无法可靠维持几分钟的挂起请求。
任务化之后，浏览器每 1.2 秒发一次短请求，worker 不会被中途干掉，
用户也能在转写未完成时就拿到已出结果（边转边出）。
"""
from __future__ import annotations

import json
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

# ── 必须在 import flask 之前重定向输出 ──
# 实测踩到的死锁：Windows 终端开了「快速编辑」后，只要用鼠标在窗口里选中文字，
# 任何写控制台的操作都会无限期阻塞。werkzeug 每处理一个请求要写一行访问日志，
# 于是所有处理线程全部卡死 —— 表现为端口还在 LISTENING，但一个请求都不回，
# 浏览器那边就是「本地服务响应超时」，重启扩展也没用。
# 把 stdout/stderr 指到文件后，服务彻底不依赖控制台，随便点窗口都不会卡。
_LOG_PATH = Path(__file__).with_name("server.log")
try:
    _log_fp = open(_LOG_PATH, "w", encoding="utf-8", buffering=1)
    sys.stdout = _log_fp
    sys.stderr = _log_fp
except OSError:  # 目录只读时退化为默认行为，不因此起不来
    pass

from flask import Flask, jsonify, request
from flask_cors import CORS

import asr
import bili
import config

app = Flask(__name__)
CORS(app)

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
RUN_LOCK = threading.Lock()  # 模型是单例，同一时刻只跑一个转写
JOB_TTL = 30 * 60
AUDIO_CACHE_MAX = 800 * 1024 * 1024  # 音频缓存上限，超了按最旧淘汰


def _now() -> float:
    return time.time()


def _prune_jobs() -> None:
    stale = [k for k, v in JOBS.items() if _now() - v["created"] > JOB_TTL and v["status"] in ("done", "error", "cancelled")]
    for k in stale:
        JOBS.pop(k, None)


def _cache_file(cid: str, model: str) -> Path:
    return config.cache_dir() / f"{cid}__{model}.json"


def _load_cache(cid: str, model: str) -> list[dict] | None:
    path = _cache_file(cid, model)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        segs = data.get("segments") or []
        return segs or None
    except (json.JSONDecodeError, OSError):
        return None


def _save_cache(cid: str, model: str, segments: list[dict]) -> None:
    try:
        _cache_file(cid, model).write_text(
            json.dumps({"cid": cid, "model": model, "segments": segments, "savedAt": int(time.time())}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass


def _trim_audio_cache(audio_dir: Path, keep: Path) -> None:
    """音频留着能省掉重复下载，但不能无限涨。超上限时按最旧淘汰。"""
    try:
        files = [p for p in audio_dir.glob("*.m4s") if p.is_file()]
        total = sum(p.stat().st_size for p in files)
        if total <= AUDIO_CACHE_MAX:
            return
        files.sort(key=lambda p: p.stat().st_mtime)
        for p in files:
            if total <= AUDIO_CACHE_MAX:
                break
            if p == keep:
                continue
            size = p.stat().st_size
            p.unlink(missing_ok=True)
            total -= size
    except OSError:
        pass


def _new_job(cid: str, model: str) -> dict:
    job = {
        "id": uuid.uuid4().hex[:12],
        "cid": cid,
        "model": model,
        "status": "queued",
        "progress": 0.0,
        "message": "排队中",
        "segments": [],
        "error": None,
        "cancel": False,
        "created": _now(),
    }
    with JOBS_LOCK:
        JOBS[job["id"]] = job
    return job


def _worker(job_id: str, payload: dict) -> None:
    job = JOBS.get(job_id)
    if not job:
        return

    cid = str(payload.get("cid"))
    model = job["model"]
    audio_path: Path | None = None

    try:
        with RUN_LOCK:
            if job["cancel"]:
                job["status"] = "cancelled"
                job["message"] = "已取消"
                return

            job["status"] = "running"
            job["message"] = "下载音频…"
            job["progress"] = 0.02

            tmp_dir = config.cache_dir() / "audio"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            audio_path = tmp_dir / f"{cid}.m4s"

            need_download = not audio_path.exists() or audio_path.stat().st_size < 10_000
            if need_download:
                urls = [payload.get("audioUrl") or ""] + list(payload.get("backupUrls") or [])
                urls = [u for u in urls if u]

                # 扩展没给地址（或只给了 cid）时，服务端自己取一次
                if not urls:
                    bvid = payload.get("bvid") or ""
                    if not bvid:
                        raise RuntimeError("缺少 bvid，无法获取音频流")
                    job["message"] = "服务端自行取音频流…"
                    urls = bili.fetch_audio_urls(bvid, int(cid))

                try:
                    bili.download_audio(urls, audio_path)
                except Exception:
                    # 扩展给的地址会过期，兜底再取一次公开流
                    fallback = bili.fetch_audio_urls(payload.get("bvid") or "", int(cid))
                    bili.download_audio(fallback, audio_path)

            if job["cancel"]:
                job["status"] = "cancelled"
                job["message"] = "已取消"
                return

            job["message"] = "准备模型…"
            job["progress"] = 0.06

            duration = float(payload.get("duration") or 0)

            def on_stage(text: str) -> None:
                job["message"] = text

            def on_progress(segs: list[dict], ratio: float) -> None:
                job["segments"] = segs
                job["progress"] = max(job["progress"], 0.06 + ratio * 0.92)
                job["message"] = f"转写中 · {len(segs)} 句"

            cfg_now = config.load()
            segments = asr.transcribe(
                str(audio_path),
                model_name=model,
                duration=duration,
                on_progress=on_progress,
                should_cancel=lambda: job["cancel"],
                on_stage=on_stage,
                vad=bool(cfg_now.get("vad", False)),
                beam_size=int(cfg_now.get("beam_size", 1)),
            )

            if job["cancel"]:
                job["status"] = "cancelled"
                job["message"] = "已取消"
                return

            job["segments"] = segments
            job["progress"] = 1.0
            job["status"] = "done"
            job["message"] = f"完成 · {len(segments)} 句"
            _save_cache(cid, model, segments)

    except Exception as exc:  # noqa: BLE001 - 任务级异常统一回传给前端
        traceback.print_exc()  # 控制台留一份完整栈，方便对着报错查
        job["status"] = "error"
        job["error"] = str(exc)
        job["message"] = "失败"
    finally:
        # 成功的音频保留下来（同视频再看可直接复用），失败的多半是坏文件，删掉
        if audio_path and audio_path.exists():
            if job["status"] == "done":
                _trim_audio_cache(audio_path.parent, audio_path)
            else:
                try:
                    audio_path.unlink()
                except OSError:
                    pass


# ══════════════════════════════ 路由 ══════════════════════════════

@app.get("/health")
def health():
    cfg = config.load()
    return jsonify(
        {
            "ok": True,
            "version": "0.2.0",
            "asr_ready": asr.available(),
            "asr_model": asr.loaded_model_name() or cfg.get("default_model", "small"),
            "device": cfg.get("device", "cpu"),
            "backend": "faster-whisper",
        }
    )


@app.post("/asr")
def submit_asr():
    data = request.get_json(silent=True) or {}
    cid = data.get("cid")
    if not cid:
        return jsonify({"error": "缺少 cid"}), 400

    cfg = config.load()
    model = data.get("model") or cfg.get("default_model") or "small"

    if not asr.available():
        return jsonify({"error": "faster-whisper 未安装，请先执行 pip install -r requirements.txt"}), 503

    # 同一 cid 已有任务在跑时直接复用，避免连播来回切换导致重复排队
    with JOBS_LOCK:
        _prune_jobs()
        for job in JOBS.values():
            if job["cid"] == str(cid) and job["model"] == model and job["status"] in ("queued", "running"):
                return jsonify({"job_id": job["id"], "cached": False, "reused": True})

    cached = _load_cache(str(cid), model)
    if cached:
        job = _new_job(str(cid), model)
        job["segments"] = cached
        job["progress"] = 1.0
        job["status"] = "done"
        job["message"] = f"缓存命中 · {len(cached)} 句"
        return jsonify({"job_id": job["id"], "cached": True})

    job = _new_job(str(cid), model)
    threading.Thread(target=_worker, args=(job["id"], data), daemon=True).start()
    return jsonify({"job_id": job["id"], "cached": False})


@app.get("/asr/status")
def asr_status():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"status": "error", "error": "任务不存在或已过期"}), 404

    return jsonify(
        {
            "job_id": job["id"],
            "status": job["status"],
            "progress": round(job["progress"], 3),
            "message": job["message"],
            "segments": job["segments"],
            "error": job["error"],
        }
    )


@app.get("/asr/cancel")
def asr_cancel():
    job_id = request.args.get("job_id", "")
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"ok": True, "note": "任务不存在"})
    job["cancel"] = True
    job["status"] = "cancelled"
    job["message"] = "已取消"
    return jsonify({"ok": True})


@app.get("/config")
def get_config():
    return jsonify(config.load())


@app.post("/config")
def post_config():
    patch = request.get_json(silent=True) or {}
    return jsonify(config.save(patch))


# ── 诊断通道：扩展把页面内状态推上来，用于定位「扩展到底跑到哪一步」 ──
DIAG: list[dict] = []
DIAG_LOCK = threading.Lock()


@app.post("/diag")
def post_diag():
    payload = request.get_json(silent=True) or {}
    record = {"at": time.strftime("%H:%M:%S"), "data": payload}
    with DIAG_LOCK:
        DIAG.append(record)
        del DIAG[:-80]  # 只留最近 80 条
    print(f"[diag] {json.dumps(payload, ensure_ascii=False)}", flush=True)
    return jsonify({"ok": True})


@app.get("/diag")
def get_diag():
    with DIAG_LOCK:
        records = list(DIAG)
    return jsonify({"count": len(records), "latest": records[-1] if records else None, "recent": records[-10:]})


@app.get("/")
def index():
    return jsonify({"service": "bili-sub", "endpoints": ["/health", "/asr", "/asr/status", "/asr/cancel", "/config", "/diag"]})


if __name__ == "__main__":
    cfg = config.load()
    port = int(cfg.get("port", 8765))
    print("=" * 56)
    print("  Bili 本地字幕服务")
    print(f"  监听  http://127.0.0.1:{port}")
    print(f"  模型  {cfg.get('default_model', 'small')} / {cfg.get('device', 'cpu')}")
    print(f"  ASR   {'就绪' if asr.available() else '未安装 faster-whisper'}")
    print("=" * 56)
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
