/**
 * bridge.js —— 运行在页面主世界（MAIN world）
 *
 * 两个不可替代的职责：
 *   1. 访问 B站 接口。字幕列表需要登录态（SESSDATA），只有页面自身的请求
 *      才会自动携带 Cookie，隔离世界发起的跨子域 fetch 会丢 Cookie。
 *   2. 识别「当前正在播放哪个视频」。连播列表（/list/）的 URL 里不含 BV 号，
 *      靠 URL 解析必然失败。改为 hook fetch / XMLHttpRequest，
 *      从播放请求中嗅探 aid 与 cid —— 这个来源对 /video/、/list/、/bangumi/
 *      三种入口全部有效，且天然与切换视频同步。
 */
(() => {
  'use strict';

  // 可能被两条路径重复注入（manifest 声明式 + chrome.scripting 兜底），
  // 主世界没有隔离，必须自己挡住第二次，否则 fetch/XHR 的 hook 会叠两层，消息发两遍。
  if (window.__BILI_SUB_BRIDGE_LOADED__) return;
  window.__BILI_SUB_BRIDGE_LOADED__ = true;

  const CHANNEL = '__bili_sub_bridge__';
  const WBI_CACHE_KEY = '__bili_sub_wbi_keys__';
  const WBI_TTL = 3 * 60 * 60 * 1000;

  const post = (payload) => window.postMessage({ channel: CHANNEL, dir: 'bridge->cs', ...payload }, '*');

  // ══════════════════════════════ MD5 ══════════════════════════════
  const MD5_K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]);
  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  function md5(input) {
    const bytes = new TextEncoder().encode(input);
    const len = bytes.length;
    const bitLen = len * 8;
    const padLen = (((len + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[len] = 0x80;

    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, bitLen >>> 0, true);
    dv.setUint32(padLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);

    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + (((F << MD5_S[i]) | (F >>> (32 - MD5_S[i]))) >>> 0)) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }

    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true);
    odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true);
    odv.setUint32(12, d0, true);
    return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ══════════════════════════════ Wbi 签名 ══════════════════════════════
  // 少一位、错一位都会导致 w_rid 校验失败。B站对签名失败的降级行为是
  // 「返回 200 + 其他视频的字幕」，极其隐蔽，所以这张表必须逐字正确。
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  async function getWbiKeys(force = false) {
    if (!force) {
      try {
        const raw = sessionStorage.getItem(WBI_CACHE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached.expire > Date.now() && cached.img_key && cached.sub_key) return cached;
        }
      } catch (_) { /* 存储不可用时忽略 */ }
    }

    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    const json = await res.json();
    const imgUrl = json?.data?.wbi_img?.img_url;
    const subUrl = json?.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) throw new Error('无法获取 Wbi 密钥');

    const keys = {
      img_key: imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.')),
      sub_key: subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.')),
      expire: Date.now() + WBI_TTL,
    };
    try { sessionStorage.setItem(WBI_CACHE_KEY, JSON.stringify(keys)); } catch (_) { /* noop */ }
    return keys;
  }

  function getMixinKey(imgKey, subKey) {
    const raw = imgKey + subKey;
    let out = '';
    for (const idx of MIXIN_KEY_ENC_TAB) out += raw[idx] ?? '';
    return out.slice(0, 32);
  }

  function signWbi(params, mixinKey) {
    const withTs = { ...params, wts: Math.round(Date.now() / 1000) };
    const query = Object.keys(withTs)
      .sort()
      .map((k) => {
        const v = String(withTs[k]).replace(/[!'()*]/g, '');
        return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
      })
      .join('&');
    return `${query}&w_rid=${md5(query + mixinKey)}`;
  }

  async function signedFetch(url, params, retried = false) {
    const { img_key, sub_key } = await getWbiKeys(retried);
    const q = signWbi(params, getMixinKey(img_key, sub_key));
    const res = await fetch(`${url}?${q}`, { credentials: 'include' });
    const json = await res.json();
    if (json?.code === -403 && !retried) return signedFetch(url, params, true);
    return json;
  }

  // ══════════════════════════════ 播放请求嗅探 ══════════════════════════════
  const current = { aid: null, cid: null, bvid: null, at: 0 };
  let sniffNotifyTimer = null;

  function absorb(rawUrl) {
    const s = String(rawUrl || '');
    if (!s.includes('/x/player/')) return;

    let params;
    try {
      params = new URL(s, location.origin).searchParams;
    } catch (_) {
      return;
    }

    const cid = Number(params.get('cid') || 0);
    if (!cid) return;

    const aid = Number(params.get('aid') || params.get('avid') || 0);
    const bvid = params.get('bvid') || '';

    const changed = cid !== current.cid;
    current.cid = cid;
    if (aid) current.aid = aid;
    if (bvid) current.bvid = bvid;
    current.at = Date.now();

    if (changed) scheduleNotify();
  }

  // 切换视频会产生一连串请求，防抖后只通知一次
  function scheduleNotify() {
    if (sniffNotifyTimer) clearTimeout(sniffNotifyTimer);
    sniffNotifyTimer = setTimeout(() => {
      post({ type: 'videoChanged', data: { aid: current.aid, cid: current.cid, bvid: current.bvid } });
    }, 600);
  }

  function installSniffer() {
    try {
      const origFetch = window.fetch;
      if (origFetch && !origFetch.__bzHooked) {
        const wrapped = function (input) {
          try {
            absorb(typeof input === 'string' ? input : input && input.url);
          } catch (_) { /* 嗅探失败绝不影响页面本身 */ }
          return origFetch.apply(this, arguments);
        };
        wrapped.__bzHooked = true;
        window.fetch = wrapped;
      }
    } catch (_) { /* noop */ }

    try {
      const origOpen = XMLHttpRequest.prototype.open;
      if (!origOpen.__bzHooked) {
        const wrapped = function (method, url) {
          try { absorb(url); } catch (_) { /* noop */ }
          return origOpen.apply(this, arguments);
        };
        wrapped.__bzHooked = true;
        XMLHttpRequest.prototype.open = wrapped;
      }
    } catch (_) { /* noop */ }
  }

  installSniffer();

  // 页面初次加载时，播放请求可能早于 hook 安装，从全局状态补一次
  function seedFromInitialState() {
    try {
      const st = window.__INITIAL_STATE__;
      if (!st) return;
      const vd = st.videoData || st.videoInfo || {};
      const cid = Number(vd?.cid || 0);
      if (!cid || current.cid) return;
      current.cid = cid;
      current.aid = Number(vd?.aid || 0) || current.aid;
      current.bvid = vd?.bvid || current.bvid;
      current.at = Date.now();
    } catch (_) { /* noop */ }
  }

  seedFromInitialState();

  // ══════════════════════════════ 视频信息 ══════════════════════════════
  function bvidFromUrl() {
    const m =
      location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/) ||
      location.search.match(/[?&](?:bvid|BV)=?(BV[0-9A-Za-z]{10})/);
    return m ? m[1] : '';
  }

  async function resolveIdentity() {
    if (current.cid) return { ...current };

    seedFromInitialState();
    if (current.cid) return { ...current };

    const bvid = bvidFromUrl();
    if (!bvid) throw new Error('尚未捕获到播放请求，请先点击播放');

    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      credentials: 'include',
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`取视频信息失败：${json.message || json.code}`);

    const d = json.data;
    const p = Number(new URLSearchParams(location.search).get('p') || 1);
    const page = (d.pages || []).find((x) => x.page === p) || (d.pages || [])[0];

    current.aid = d.aid;
    current.bvid = bvid;
    current.cid = page?.cid ?? d.cid;
    current.at = Date.now();
    return { ...current };
  }

  async function getVideoMeta() {
    const id = await resolveIdentity();
    const meta = {
      aid: id.aid,
      cid: id.cid,
      bvid: id.bvid || bvidFromUrl(),
      title: '',
      duration: 0,
      pageIndex: 1,
      pageCount: 1,
    };

    if (meta.bvid) {
      try {
        const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${meta.bvid}`, {
          credentials: 'include',
        });
        const json = await res.json();
        if (json.code === 0) {
          const d = json.data;
          const pages = d.pages || [];
          const page = pages.find((x) => x.cid === meta.cid);
          meta.title = d.title || '';
          meta.aid = meta.aid || d.aid;
          meta.duration = page?.duration ?? d.duration ?? 0;
          meta.pageIndex = page?.page ?? 1;
          meta.pageCount = pages.length || 1;
        }
      } catch (_) { /* 元信息缺失不影响字幕流程 */ }
    }

    // 连播页面偶尔拿不到 view 接口，用播放器上报的时长兜底
    if (!meta.duration) {
      const v = document.querySelector('video');
      if (v && Number.isFinite(v.duration)) meta.duration = Math.round(v.duration);
    }
    return meta;
  }

  // ══════════════════════════════ 字幕 ══════════════════════════════
  async function getSubtitleTracks(payload) {
    const id = await resolveIdentity();
    const aid = payload.aid || id.aid;
    const cid = payload.cid || id.cid;
    if (!cid) throw new Error('未识别到 cid');

    const params = { aid, cid };
    if (id.bvid) params.bvid = id.bvid;

    const json = await signedFetch('https://api.bilibili.com/x/player/wbi/v2', params);
    if (json.code !== 0) throw new Error(`字幕接口异常：${json.message || json.code}`);

    const data = json.data || {};
    const sub = data.subtitle || {};
    const list = Array.isArray(sub.subtitles) ? sub.subtitles : [];

    return {
      isLogin: !!data.isLogin,
      aid,
      cid,
      tracks: list
        .map((s) => ({
          lan: s.lan,
          lanDoc: s.lan_doc,
          url: s.subtitle_url
            ? s.subtitle_url.startsWith('//')
              ? `https:${s.subtitle_url}`
              : s.subtitle_url
            : '',
          type: s.type ?? 0,
          isAi: String(s.lan || '').startsWith('ai-') || s.type === 1,
        }))
        .filter((t) => t.url),
    };
  }

  async function fetchSubtitleBody(payload) {
    const res = await fetch(payload.url, { credentials: 'include', referrer: location.href });
    if (!res.ok) throw new Error(`字幕下载失败：HTTP ${res.status}`);
    const json = await res.json();
    const body = Array.isArray(json?.body) ? json.body : [];
    if (!body.length) throw new Error('字幕内容为空');

    return body
      .map((it) => ({
        start: Number(it.from) || 0,
        end: Number(it.to) || 0,
        text: String(it.content ?? '').trim(),
      }))
      .filter((it) => it.text)
      .sort((a, b) => a.start - b.start);
  }

  async function getPlayUrl(payload) {
    const id = await resolveIdentity();
    const params = { cid: payload.cid || id.cid, fnval: 16, fourk: 1 };
    const bvid = payload.bvid || id.bvid;
    if (bvid) params.bvid = bvid;
    else params.aid = payload.aid || id.aid;

    const json = await signedFetch('https://api.bilibili.com/x/player/playurl', params);
    if (json.code !== 0) throw new Error(`取音频流失败：${json.message || json.code}`);

    const audios = json.data?.dash?.audio || [];
    if (!audios.length) throw new Error('该视频没有独立音频流');

    return {
      audios: audios
        .map((a) => ({
          id: a.id,
          bandwidth: a.bandwidth,
          baseUrl: a.baseUrl || a.base_url,
          backupUrl: a.backupUrl || a.backup_url || [],
        }))
        .sort((a, b) => b.bandwidth - a.bandwidth),
    };
  }

  // ══════════════════════════════ 消息路由 ══════════════════════════════
  // getSniffed 是纯内存读取，不发网络请求，供内容脚本低成本轮询
  // 登录态判断。
  // 不能用 /x/player/wbi/v2 返回里的 isLogin 当准绳：那个接口在参数或签名
  // 有一点不对时，仍然返回 code:0，只是 data 变成空壳，isLogin 也就跟着 false。
  // 结果就是「接口没给数据」被误读成「没登录」，把已经登录的用户挡在提示框外面。
  // nav 接口是 B站 自己的登录态口径，未登录时明确返回 code:-101。
  async function getLoginState() {
    const cookieHint = /(^|;\s*)DedeUserID=\d+/.test(document.cookie || '');
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
      });
      const json = await res.json();
      const data = json?.data || {};
      const logged = json?.code === 0 && !!data.isLogin;
      return {
        logged: logged || (json?.code === 0 ? false : cookieHint),
        uname: data.uname || '',
        vip: !!data.vipStatus,
        cookieHint,
        code: json?.code ?? null,
        message: json?.message || '',
      };
    } catch (err) {
      // 网络异常时退回看 cookie：DedeUserID 是 B站 登录后必写的非 HttpOnly cookie
      return { logged: cookieHint, cookieHint, uname: '', error: String(err?.message || err) };
    }
  }

  const handlers = {
    getSniffed: async () => ({ ...current }),
    getVideoMeta,
    getSubtitleTracks,
    getLoginState,
    fetchSubtitleBody,
    getPlayUrl,
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'cs->bridge') return;

    const handler = handlers[msg.type];
    const reply = (data) => post({ id: msg.id, ...data });

    if (!handler) {
      reply({ ok: false, error: `未知指令：${msg.type}` });
      return;
    }
    try {
      reply({ ok: true, data: await handler(msg.payload || {}) });
    } catch (err) {
      reply({ ok: false, error: err?.message || String(err) });
    }
  });

  post({ type: 'ready' });
})();
