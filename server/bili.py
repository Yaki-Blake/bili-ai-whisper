"""与 B站 相关的服务端逻辑：音频流下载、以及扩展没给地址时的兜底取流。"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlencode

import requests

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

BASE_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "*/*",
}

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

_wbi_cache: dict[str, object] = {"keys": None, "expire": 0.0}


def _get_wbi_keys() -> tuple[str, str]:
    now = time.time()
    if _wbi_cache["keys"] and _wbi_cache["expire"] > now:  # type: ignore[operator]
        return _wbi_cache["keys"]  # type: ignore[return-value]

    r = requests.get(
        "https://api.bilibili.com/x/web-interface/nav",
        headers=BASE_HEADERS,
        timeout=10,
    )
    data = r.json().get("data") or {}
    wbi = data.get("wbi_img") or {}
    img_url = wbi.get("img_url", "")
    sub_url = wbi.get("sub_url", "")
    if not img_url or not sub_url:
        raise RuntimeError("无法获取 Wbi 密钥")

    img_key = img_url.rsplit("/", 1)[-1].split(".")[0]
    sub_key = sub_url.rsplit("/", 1)[-1].split(".")[0]
    _wbi_cache["keys"] = (img_key, sub_key)
    _wbi_cache["expire"] = now + 3 * 3600
    return img_key, sub_key


def sign_wbi(params: dict) -> str:
    img_key, sub_key = _get_wbi_keys()
    raw = img_key + sub_key
    mixin_key = "".join(raw[i] for i in MIXIN_KEY_ENC_TAB)[:32]

    params = {**params, "wts": int(time.time())}
    items = []
    for k in sorted(params.keys()):
        v = str(params[k])
        for ch in "!'()*":
            v = v.replace(ch, "")
        items.append(f"{k}={requests.utils.quote(v, safe='')}")
    query = "&".join(items)

    w_rid = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    return f"{query}&w_rid={w_rid}"


def fetch_audio_urls(bvid: str, cid: int) -> list[str]:
    """服务端兜底：扩展没传地址时，自己取一次公开的 DASH 音频流。"""
    q = sign_wbi({"bvid": bvid, "cid": cid, "fnval": 16, "fourk": 1})
    r = requests.get(
        f"https://api.bilibili.com/x/player/playurl?{q}",
        headers=BASE_HEADERS,
        timeout=15,
    )
    json_data = r.json()
    if json_data.get("code") != 0:
        raise RuntimeError(f"取音频流失败：{json_data.get('message')}")

    dash = (json_data.get("data") or {}).get("dash") or {}
    audios = dash.get("audio") or []
    if not audios:
        raise RuntimeError("该视频没有可用的独立音频流")

    audios.sort(key=lambda a: a.get("bandwidth", 0), reverse=True)
    urls: list[str] = []
    for a in audios:
        base = a.get("baseUrl") or a.get("base_url")
        if base:
            urls.append(base)
        for b in a.get("backupUrl") or a.get("backup_url") or []:
            urls.append(b)
    if not urls:
        raise RuntimeError("音频流地址为空")
    return urls


def download_audio(
    urls: Iterable[str],
    out_path: Path,
    progress_cb: Callable[[float], None] | None = None,
) -> Path:
    """依次尝试多个地址下载音频。B站 CDN 有明显节点差异，失败就换 backup。"""
    last_err: Exception | None = None
    url_list = [u for u in urls if u]

    for idx, url in enumerate(url_list):
        try:
            with requests.get(
                url,
                headers={**BASE_HEADERS, "Range": "bytes=0-"},
                stream=True,
                timeout=(10, 60),
            ) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length") or 0)
                done = 0
                with open(out_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=256 * 1024):
                        if not chunk:
                            continue
                        f.write(chunk)
                        done += len(chunk)
                        if progress_cb and total > 0:
                            progress_cb(min(1.0, done / total))
                if out_path.stat().st_size < 10_000:
                    raise RuntimeError("下载文件过小，可能被风控拦截")
                return out_path
        except Exception as exc:  # noqa: BLE001 - 逐地址降级，最后统一抛错
            last_err = exc
            continue

    raise RuntimeError(f"音频下载失败（尝试了 {len(url_list)} 个地址）：{last_err}")
