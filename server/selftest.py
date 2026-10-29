"""接口级验证：完全按扩展的调用方式走一遍 HTTP。

验证点：
  1. POST /asr 立刻返回 job_id（不阻塞）
  2. 轮询过程中能拿到增量 segments（边转边出）
  3. 完成后 segments 覆盖全片
  4. 同 cid 再次提交命中缓存
"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8765"


def call(path, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


health = call("/health")
print("health:", health)

# 用一个已知 cid 直接提交（扩展会把 duration/audioUrl 一起传）
CID = "43124132321"
BVID = "BV1rvxE6HEPT"
DURATION = 177

print("\n[1] 提交任务…")
t0 = time.time()
job = call("/asr", "POST", {"cid": CID, "bvid": BVID, "duration": DURATION, "model": "small"})
print("   ", job)
if job.get("cached"):
    print("    命中缓存，跳过增量验证")
    sys.exit(0)

job_id = job["job_id"]

print("[2] 轮询，观察增量…")
first_seg_at = None
last_n = 0
while True:
    res = call(f"/asr/status?job_id={job_id}")
    n = len(res.get("segments") or [])
    if n > last_n:
        if first_seg_at is None:
            first_seg_at = time.time() - t0
            print(f"    首次出字 {first_seg_at:.1f}s，{n} 句")
        else:
            print(f"    {time.time() - t0:5.1f}s  {n:4d} 句  进度 {res.get('progress')}  {res.get('message')}")
        last_n = n
    if res["status"] in ("done", "error", "cancelled"):
        break
    time.sleep(1.2)

total = time.time() - t0
segs = res.get("segments") or []
print(f"\n[3] 结束 status={res['status']} 共 {len(segs)} 句，总耗时 {total:.1f}s")
if segs:
    print(f"    首句 [{segs[0]['start']}→{segs[0]['end']}] {segs[0]['text'][:40]}")
    print(f"    末句 [{segs[-1]['start']}→{segs[-1]['end']}] {segs[-1]['text'][:40]}")
    print(f"    覆盖率: {segs[-1]['end'] / DURATION * 100:.1f}%")
    print(f"    速度: {DURATION / total:.1f}x 实时")

print("\n[4] 再次提交，验证缓存…")
t1 = time.time()
again = call("/asr", "POST", {"cid": CID, "bvid": BVID, "duration": DURATION, "model": "small"})
print("   ", again, f"耗时 {(time.time() - t1) * 1000:.0f}ms")
res2 = call(f"/asr/status?job_id={again['job_id']}")
print(f"    status={res2['status']} message={res2['message']} 句数={len(res2['segments'])}")
