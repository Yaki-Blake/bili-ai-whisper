/**
 * content.js —— 内容脚本（isolated world）
 *
 * 职责收窄为单一目标：视频没有官方字幕时，用本地 Whisper 生成中文字幕。
 * 有官方字幕的视频直接放行，完全不干预。
 */
(() => {
  'use strict';

  if (window.__BILI_SUB_LOADED__) return;
  window.__BILI_SUB_LOADED__ = true;

  const CHANNEL = '__bili_sub_bridge__';
  const VER = '0.3.1';

  const state = {
    cid: null,
    aid: null,
    bvid: '',
    meta: null,
    cues: [],
    settings: null,
    source: '',
    phase: 'idle',
    statusText: '',
    progress: 0,
    isError: false,
    jobId: null,
    cancelled: true,
    panelOpen: false,
    // 默认策略是「有官方字幕就让路」。用户点「改用本地转写」后置 true，
    // 强制忽略官方字幕轨走 ASR。切视频时自动复位，避免一个视频的选择影响后续。
    forceAsr: false,
    trackCount: -1,
    trackInfo: '',
    _lastCue: undefined,
    renderTarget: null,
    video: null,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ══════════════════════════ 与 bridge 通信 ══════════════════════════
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'bridge->cs') return;

    if (msg.type === 'ready') return;

    if (msg.type === 'videoChanged') {
      const data = msg.data || {};
      if (data.cid && data.cid !== state.cid) handleVideoChange(data.cid, data.aid, data.bvid);
      return;
    }

    const task = pending.get(msg.id);
    if (!task) return;
    pending.delete(msg.id);
    clearTimeout(task.timer);
    if (msg.ok) task.resolve(msg.data);
    else task.reject(new Error(msg.error || '桥接调用失败'));
  });

  function callBridgeOnce(type, payload, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('桥接响应超时'));
        }
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, dir: 'cs->bridge', id, type, payload }, '*');
    });
  }

  async function callBridge(type, payload, retries = 4) {
    let lastErr;
    for (let i = 0; i < retries; i += 1) {
      try {
        return await callBridgeOnce(type, payload);
      } catch (err) {
        lastErr = err;
        if (!String(err.message).includes('超时')) throw err;
        await sleep(350);
      }
    }
    throw lastErr;
  }

  const sendRuntime = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('后台无响应'));
        if (!res.ok) return reject(new Error(res.error || '后台调用失败'));
        return resolve(res.data);
      });
    });

  // ══════════════════════════ 渲染层 ══════════════════════════
  const MOUNT_SELECTORS = ['.bpx-player-video-wrap', '.bpx-player-container', '#bilibili-player'];

  function getVideoEl() {
    return document.querySelector('#bilibili-player video') || document.querySelector('video');
  }

  function getMountPoint() {
    for (const sel of MOUNT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return getVideoEl()?.parentElement ?? null;
  }

  function ensureOverlay() {
    const mount = getMountPoint();
    if (!mount) return null;
    state.renderTarget = mount;

    if (getComputedStyle(mount).position === 'static') {
      mount.style.setProperty('position', 'relative', 'important');
    }

    let layer = mount.querySelector(':scope > .bz-sub-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'bz-sub-layer';
      layer.innerHTML = '<div class="bz-sub-line bz-empty"></div>';
      mount.appendChild(layer);
    }
    applyStyle(layer);
    return layer;
  }

  function applyStyle(layer) {
    if (!layer || !state.settings) return;
    layer.style.setProperty('--bz-font-size', `${state.settings.fontSize || 22}px`);
  }

  function removeOverlay() {
    document.querySelectorAll('.bz-sub-layer').forEach((el) => el.remove());
    state.renderTarget = null;
  }

  // 一次性轻提示。用于「让路」这种用户不会主动察觉的事件，
  // 5 秒后自动消失，不拦截鼠标。
  let hintTimer = 0;
  function flashHint(text) {
    document.getElementById('bz-sub-hint')?.remove();
    const el = document.createElement('div');
    el.id = 'bz-sub-hint';
    el.className = 'bz-sub-hint';
    el.textContent = text;
    document.body.appendChild(el);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.remove(), 5000);
  }

  // ── 「让路」状态条 ───────────────────────────────────────────────
  // 有官方字幕时扩展不接管，这是产品规则。但"不接管"必须看得见：
  // 早先版本只是 removeOverlay 后 return，页面上什么都没留下，
  // 用户的第一反应是"扩展坏了"。所以让路时留一条细条，写明原因，
  // 并给两个出口：打开 B站 官方字幕 / 改用本地 AI 转写。
  function clearYieldBar() {
    document.getElementById('bz-sub-yield')?.remove();
  }

  // B站 播放器（新版 bpx / 旧版）字幕文本是否真的在屏幕上
  function officialSubtitleVisible() {
    const sels = [
      '.bpx-player-subtitle-panel-text',
      '.bpx-player-subtitle-wrap',
      '.bilibili-player-video-subtitle',
      '.squirtle-subtitle-wrap',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      if ((el.textContent || '').trim()) return true;
    }
    return false;
  }

  // 试着替用户点开官方字幕：先点控制栏的字幕按钮，再点弹出菜单里的语言项。
  // B站 的类名换过几轮，所以按可能性从新到旧依次尝试；全都找不到就返回 false，
  // 由调用方退回"告诉用户在哪儿点"。
  function tryOpenOfficialSubtitle() {
    const btnSels = [
      '.bpx-player-ctrl-subtitle',
      '.bpx-player-ctrl-btn[aria-label*="字幕"]',
      '.bilibili-player-video-btn-subtitle',
      '.squirtle-subtitle-btn',
    ];
    let hit = null;
    for (const s of btnSels) {
      hit = document.querySelector(s);
      if (hit) break;
    }
    if (!hit) return false;
    hit.click();
    setTimeout(() => {
      if (officialSubtitleVisible()) return;
      const itemSels = [
        '.bpx-player-ctrl-subtitle-menu li:not([class*="disabled"])',
        '.bilibili-player-video-btn-subtitle-menu li',
        '.squirtle-subtitle-list-item',
      ];
      for (const s of itemSels) {
        const item = document.querySelector(s);
        if (item) {
          item.click();
          return;
        }
      }
    }, 260);
    return true;
  }

  function showYieldBar(lanDoc) {
    if (document.getElementById('bz-sub-yield')) return;
    const bar = document.createElement('div');
    bar.id = 'bz-sub-yield';
    bar.className = 'bz-sub-yield';
    bar.innerHTML = `
      <span class="bz-y-text">本视频自带${lanDoc}字幕，扩展已让路</span>
      <button type="button" data-act="official">打开官方字幕</button>
      <button type="button" data-act="force">改用 AI 字幕</button>
      <button type="button" data-act="close" class="bz-y-close" title="关闭">×</button>`;
    document.body.appendChild(bar);

    bar.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      const act = btn && btn.dataset.act;
      if (!act) return;
      const text = bar.querySelector('.bz-y-text');

      if (act === 'close') {
        bar.remove();
        return;
      }

      if (act === 'force') {
        state.forceAsr = true;
        clearYieldBar();
        flashHint('已切换为本地转写，正在准备音频…');
        await cancelCurrentJob();
        init();
        return;
      }

      if (act === 'official') {
        const found = tryOpenOfficialSubtitle();
        if (!found) {
          if (text) text.textContent = '没找到播放器字幕按钮：在播放器右下角找「字幕」图标手动打开';
          return;
        }
        setTimeout(() => {
          if (!text) return;
          text.textContent = officialSubtitleVisible()
            ? '官方字幕已打开'
            : '还没打开：点播放器右下角「字幕」图标，选中文';
        }, 900);
      }
    });
  }

  function renderCue(cue) {
    const line = state.renderTarget?.querySelector(':scope > .bz-sub-layer .bz-sub-line');
    if (!line) return;
    line.textContent = cue ? cue.text : '';
    line.classList.toggle('bz-empty', !cue);
  }

  function findCue(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) return null;
    const c = cues[ans];
    return t <= c.end + 0.25 ? c : null;
  }

  function tick() {
    const video = state.video || getVideoEl();
    if (!video || !state.cues.length) return;
    const cue = findCue(state.cues, video.currentTime);
    if (cue !== state._lastCue) {
      state._lastCue = cue;
      renderCue(cue);
    }
  }

  // timeupdate 只有 ~4Hz，字幕切换最多会晚 250ms，肉眼可见。
  // 播放期间用 rAF 驱动，暂停即停，后台标签页浏览器自动不调度。
  let rafId = 0;
  function startTick() {
    if (rafId) return;
    const loop = () => {
      tick();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function stopTick() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function bindVideo(video) {
    if (!video) return;
    state.video = video;
    if (video.__bzBound) return;
    video.__bzBound = true;
    video.addEventListener('timeupdate', tick);
    video.addEventListener('seeking', () => {
      state._lastCue = undefined;
      tick();
    });
    video.addEventListener('play', startTick);
    video.addEventListener('playing', startTick);
    video.addEventListener('pause', () => {
      stopTick();
      tick();
    });
    video.addEventListener('ended', stopTick);
    if (!video.paused) startTick();
  }

  function waitForVideo(timeout = 20000) {
    return new Promise((resolve) => {
      const now = getVideoEl();
      if (now) {
        resolve(now);
        return;
      }
      const t0 = Date.now();
      const timer = setInterval(() => {
        const v = getVideoEl();
        if (v || Date.now() - t0 > timeout) {
          clearInterval(timer);
          resolve(v || null);
        }
      }, 300);
    });
  }

  // ══════════════════════════ 缓存 ══════════════════════════
  const cacheKey = (cid) => `sub:${cid}`;

  async function readCache(cid) {
    const obj = await chrome.storage.local.get(cacheKey(cid));
    return obj[cacheKey(cid)] || null;
  }

  async function writeCache(cid, cues, model) {
    try {
      await chrome.storage.local.set({ [cacheKey(cid)]: { cues, model, savedAt: Date.now() } });
    } catch (_) {
      // 配额不足时放弃缓存，不影响播放
    }
  }

  // ══════════════════════════ 主流程 ══════════════════════════
  async function handleVideoChange(cid, aid, bvid) {
    await cancelCurrentJob();
    stopTick();
    state.forceAsr = false;
    state.video = null;
    state.cid = cid;
    state.aid = aid;
    state.bvid = bvid || '';
    await sleep(900); // 等播放器重建完成
    init();
  }

  async function init() {
    resetSession();

    if (!state.settings) state.settings = await sendRuntime('settings:get').catch(() => null);
    if (state.settings && state.settings.enabled === false) {
      removeOverlay();
      setPhase('idle', '已关闭（设置里未启用）');
      return;
    }

    const video = await waitForVideo();
    if (!video) {
      setPhase('idle', '未找到播放器');
      return;
    }
    bindVideo(video);
    setPhase('checking', '正在检查字幕…');

    let meta;
    try {
      meta = await callBridge('getVideoMeta', {});
    } catch (err) {
      setPhase('error', `识别视频失败：${err.message}`);
      return;
    }

    state.meta = meta;
    state.cid = meta.cid;
    state.aid = meta.aid;
    state.bvid = meta.bvid || state.bvid;

    let tracks = [];
    let isLogin = true;
    try {
      const res = await callBridge('getSubtitleTracks', { aid: meta.aid, cid: meta.cid });
      tracks = res.tracks || [];
      isLogin = res.isLogin;
    } catch (err) {
      setPhase('error', `字幕查询失败：${err.message}`);
      return;
    }

    // wbi/v2 的 isLogin 不能当准绳：该接口在参数或签名有偏差时照样返回 code:0，
    // 只是 data 成了空壳，isLogin 也跟着 false。于是「接口没给数据」会被读成
    // 「没登录」——用户明明登录着，却被挡住要求登录。这里用 nav 接口复核一次，
    // 只有 nav 也说不登录，才真的按未登录处理。
    if (!isLogin && tracks.length === 0) {
      try {
        state.loginInfo = await callBridge('getLoginState', {});
        if (state.loginInfo?.logged) isLogin = true;
      } catch (_) {
        state.loginInfo = null;
      }
    }

    state.trackCount = tracks.length;
    state.trackInfo = tracks.map((t) => `${t.lan}:${t.lanDoc || ''}`).join(' | ');

    // ── 关键分支：有官方字幕就让路，不接管（用户手动要求时除外） ──
    // 让路必须「让得可见」：早先版本直接 removeOverlay 后 return，界面上什么都不留，
    // 用户会以为扩展坏了。现在保留悬浮球 + 弹一次提示，并提供接管入口。
    if (tracks.length > 0 && !state.forceAsr) {
      removeOverlay();
      const lanDoc = tracks[0].lanDoc || '官方';
      setPhase('skipped', `已让路（自带${lanDoc}字幕）`);
      showYieldBar(lanDoc);
      return;
    }

    // ── 无官方字幕：走本地转写 ──
    clearYieldBar();
    ensureOverlay();

    const cached = await readCache(meta.cid);
    if (cached?.cues?.length) {
      state.cues = cached.cues;
      state.source = 'cache';
      setPhase('ready', `已载入缓存（${cached.cues.length} 句）`, 100);
      state._lastCue = undefined;
      tick();
      return;
    }

    // 未登录时接口不返回 AI 字幕列表，容易把「查不到」误判成「没有」，
    // 从而白跑几分钟转写。这里必须停下来让用户确认。
    if (!isLogin) {
      const li = state.loginInfo;
      const extra = li
        ? `<br>（检测结果：nav ${li.code ?? '?'}${li.message ? ` ${li.message}` : ''}${li.cookieHint ? ' · 有登录 cookie' : ' · 无登录 cookie'}）`
        : '';
      setPhase('idle', '未登录，无法判断是否有 AI 字幕');
      showPrompt(
        '未登录 B站',
        'B站的 AI 字幕需要登录后才可见。未登录时无法判断这个视频到底有没有字幕，直接转写可能白等几分钟。' + extra,
        '登录后再试',
        // 用户可能在别的标签页刚登录完，这里直接重新走一遍检测，比刷新整页轻
        () => init(),
        { retryText: '仍要本地识别', onAlt: () => startAsr() },
      );
      return;
    }

    await startAsr();
  }

  function showPrompt(title, body, primaryText, onPrimary, opts = {}) {
    if (document.querySelector('#bz-sub-prompt')) return;
    const box = document.createElement('div');
    box.id = 'bz-sub-prompt';
    box.className = 'bz-sub-prompt';
    box.innerHTML = `
      <div class="bz-sp-title">${title}</div>
      <div class="bz-sp-body">${body}</div>
      <div class="bz-sp-actions">
        ${opts.retryText ? `<button data-act="alt">${opts.retryText}</button>` : ''}
        <button data-act="primary">${primaryText}</button>
      </div>`;
    box.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      box.remove();
      if (act === 'primary' && onPrimary) onPrimary();
      if (act === 'alt' && opts.onAlt) opts.onAlt();
    });
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 30000);
  }

  function resetSession() {
    state.cues = [];
    state.cancelled = true;
    state.jobId = null;
    state._lastCue = undefined;
    state.progress = 0;
    state.isError = false;
    state.source = '';
    renderCue(null);
  }

  async function cancelCurrentJob() {
    state.cancelled = true;
    const id = state.jobId;
    state.jobId = null;
    if (!id) return;
    try {
      await sendRuntime('asr:cancel', { jobId: id });
    } catch (_) {
      // 服务未启动或任务已结束时忽略
    }
  }

  async function startAsr() {
    if (!state.meta) return;
    setPhase('working', '正在获取音频流…', 5);

    let audios;
    try {
      const res = await callBridge('getPlayUrl', { cid: state.cid, bvid: state.bvid, aid: state.aid });
      audios = res.audios;
    } catch (err) {
      setPhase('error', `获取音频流失败：${err.message}`);
      return;
    }

    const best = audios[0];
    state.cancelled = false;

    let job;
    try {
      job = await sendRuntime('asr:submit', {
        payload: {
          cid: state.cid,
          bvid: state.bvid,
          title: state.meta.title,
          duration: state.meta.duration,
          audioUrl: best.baseUrl,
          backupUrls: best.backupUrl || [],
          model: state.settings?.asrModel || 'small',
        },
      });
    } catch (err) {
      setPhase('error', `提交转写失败：${err.message}（先运行 server/run.bat）`);
      return;
    }

    state.jobId = job.job_id;
    setPhase('working', job.cached ? '读取转写缓存…' : '本地转写中，字幕会边转边出现…', 10);
    pollLoop(job.job_id);
  }

  async function pollLoop(jobId) {
    let failures = 0;

    while (!state.cancelled && state.jobId === jobId) {
      let res;
      try {
        res = await sendRuntime('asr:poll', { jobId });
        failures = 0;
      } catch (err) {
        failures += 1;
        if (failures >= 3) {
          setPhase('error', `轮询失败：${err.message}`);
          return;
        }
        await sleep(1500);
        continue;
      }

      if (res.status === 'error') {
        setPhase('error', `转写失败：${res.error || '未知错误'}`);
        return;
      }

      if (res.segments && res.segments.length) {
        mergeSegments(res.segments);
        const pct = Math.min(96, 10 + (res.progress || 0) * 86);
        setPhase('working', `转写中 · 已出 ${state.cues.length} 句`, pct);
      } else if (res.message) {
        setPhase('working', res.message, state.progress);
      }

      if (res.status === 'done') {
        const cues = res.segments || state.cues;
        state.cues = cues;
        state.source = 'asr';
        setPhase('ready', `完成 · ${cues.length} 句`, 100);
        state._lastCue = undefined;
        tick();
        await writeCache(state.cid, cues, state.settings?.asrModel || 'small');
        return;
      }

      await sleep(1200);
    }
  }

  function mergeSegments(incoming) {
    const map = new Map(state.cues.map((c) => [c.start.toFixed(2), c]));
    for (const c of incoming) {
      const key = Number(c.start).toFixed(2);
      map.set(key, {
        start: Number(c.start),
        end: Number(c.end),
        text: String(c.text || '').trim(),
      });
    }
    state.cues = [...map.values()].filter((c) => c.text).sort((a, b) => a.start - b.start);
    state._lastCue = undefined;
    tick();
  }

  // ══════════════════════════ UI ══════════════════════════
  const PHASE_COLOR = {
    idle: '#9a9aa5',
    checking: '#f0b429',
    working: '#378add',
    ready: '#1d9e75',
    skipped: '#9a9aa5',
    error: '#e24b4a',
  };

  function setPhase(phase, text, progress) {
    state.phase = phase;
    state.statusText = text;
    state.isError = phase === 'error';
    if (typeof progress === 'number') state.progress = progress;

    const fab = document.querySelector('#bz-sub-fab');
    if (fab) {
      fab.style.color = PHASE_COLOR[phase] || '#9a9aa5';
      fab.title = phase === 'skipped' ? '官方字幕已让路（点击可改用本地转写）' : '本地字幕';
    }

    // 让路状态下，「重新识别」没有意义（重来一次还是让路），改为接管入口
    const retry = document.querySelector('#bz-sub-panel [data-act="retry"]');
    if (retry) retry.textContent = phase === 'skipped' ? '改用本地转写' : '重新识别';

    const st = document.querySelector('#bz-sub-panel [data-role="status"]');
    if (st) {
      st.textContent = text;
      st.classList.toggle('bz-error', state.isError);
    }
    const bar = document.querySelector('#bz-sub-panel [data-role="bar"]');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, state.progress || 0))}%`;

    reportDiag();
  }

  // 把页面内状态推给本地服务，便于在服务端直接看到「扩展跑到哪一步了」。
  // 只在状态变化时触发，做了节流，不会造成请求风暴。
  let diagAt = 0;
  function reportDiag(extra) {
    const now = Date.now();
    if (now - diagAt < 600 && !extra) return;
    diagAt = now;
    sendRuntime('diag', {
      payload: {
        url: location.pathname.slice(0, 80),
        cid: state.cid,
        phase: state.phase,
        status: state.statusText,
        tracks: state.trackCount,
        trackInfo: state.trackInfo,
        cues: state.cues.length,
        source: state.source,
        fab: !!document.getElementById('bz-sub-fab'),
        forceAsr: state.forceAsr,
        login: state.loginInfo
          ? `nav:${state.loginInfo.code ?? '?'}${state.loginInfo.logged ? '/in' : '/out'}${state.loginInfo.cookieHint ? '/cookie' : ''}`
          : '',
        ...extra,
      },
    }).catch(() => {});
  }

  function ensureUi() {
    if (document.querySelector('#bz-sub-fab')) return;

    const fab = document.createElement('div');
    fab.id = 'bz-sub-fab';
    fab.className = 'bz-sub-fab';
    fab.textContent = '字';
    fab.title = '本地字幕';
    fab.addEventListener('click', () => {
      state.panelOpen = !state.panelOpen;
      const panel = document.querySelector('#bz-sub-panel');
      if (panel) panel.style.display = state.panelOpen ? 'flex' : 'none';
    });
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'bz-sub-panel';
    panel.className = 'bz-sub-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="bz-p-head">
        <span class="bz-p-title">本地字幕</span>
        <button class="bz-p-close" data-act="close">×</button>
      </div>
      <div class="bz-p-status" data-role="status">待机</div>
      <div class="bz-p-bar"><i data-role="bar" style="width:0%"></i></div>
      <label class="bz-p-row">
        <span>字号</span>
        <input type="range" min="16" max="36" step="1" value="${state.settings?.fontSize || 22}" data-act="fontSize">
      </label>
      <label class="bz-p-row">
        <span>启用</span>
        <input type="checkbox" data-act="enabled" ${state.settings?.enabled === false ? '' : 'checked'}>
      </label>
      <div class="bz-p-actions">
        <button data-act="retry">重新识别</button>
        <button data-act="export">导出 SRT</button>
        <button data-act="clear">清缓存</button>
        <button data-act="service">检查服务</button>
      </div>
    `;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('change', onPanelChange);
    document.body.appendChild(panel);
  }

  async function onPanelClick(e) {
    const act = e.target?.dataset?.act;
    if (!act) return;

    if (act === 'close') {
      state.panelOpen = false;
      e.target.closest('.bz-sub-panel').style.display = 'none';
      return;
    }

    if (act === 'retry') {
      await cancelCurrentJob();
      if (state.cid) await chrome.storage.local.remove(cacheKey(state.cid));
      // 从「让路」状态点进来，等于用户要求用本地转写覆盖官方字幕
      if (state.phase === 'skipped') {
        state.forceAsr = true;
        flashHint('已切换为本地转写，正在准备音频…');
      }
      init();
      return;
    }

    if (act === 'export') {
      exportSrt();
      return;
    }

    if (act === 'clear') {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('sub:'));
      await chrome.storage.local.remove(keys);
      setPhase('idle', `已清理 ${keys.length} 条缓存`);
      return;
    }

    if (act === 'service') {
      try {
        const d = await sendRuntime('service:ping');
        setPhase('idle', `服务在线 · ${d.asr_model || '模型未加载'}`);
      } catch (err) {
        setPhase('error', `服务未连接：${err.message}`);
      }
    }
  }

  async function onPanelChange(e) {
    const act = e.target?.dataset?.act;
    if (!act) return;

    const value = e.target.type === 'checkbox'
      ? e.target.checked
      : e.target.type === 'range'
        ? Number(e.target.value)
        : e.target.value;

    state.settings = await sendRuntime('settings:set', { patch: { [act]: value } });

    if (act === 'fontSize') applyStyle(state.renderTarget?.querySelector(':scope > .bz-sub-layer'));
    if (act === 'enabled') {
      if (value) {
        init();
      } else {
        removeOverlay();
        setPhase('idle', '已关闭');
      }
    }
  }

  function exportSrt() {
    if (!state.cues.length) {
      setPhase('idle', '还没有字幕可导出');
      return;
    }
    const fmt = (t) => {
      const h = String(Math.floor(t / 3600)).padStart(2, '0');
      const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
      const s = String(Math.floor(t % 60)).padStart(2, '0');
      const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
      return `${h}:${m}:${s},${ms}`;
    };
    const body = state.cues
      .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`)
      .join('\n\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.meta?.title || 'subtitle').replace(/[\\/:*?"<>|]/g, '_')}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    setPhase(state.phase, `已导出 ${state.cues.length} 句`);
  }

  // ══════════════════════════ 启动 ══════════════════════════
  // B站是 SPA：从首页点进视频不会重新加载页面，而 content_scripts 只在页面加载时注入一次。
  // 若只在视频页 URL 上匹配，用户「先开首页再点视频」时脚本根本不会运行——表现为扩展完全无反应。
  // 所以匹配范围放宽到全站，由这里自行判断当前页是不是视频页，并在路由切换时重建 UI。
  function isVideoPage() {
    return /^\/(video|list|bangumi\/play)\//.test(location.pathname);
  }

  function teardownUi() {
    stopTick();
    cancelCurrentJob();
    removeOverlay();
    for (const id of ['bz-sub-fab', 'bz-sub-panel', 'bz-sub-hint', 'bz-sub-prompt', 'bz-sub-yield']) {
      document.getElementById(id)?.remove();
    }
    state.cid = null;
    state.cues = [];
    state.trackCount = -1;
    state.trackInfo = '';
  }

  let probeTimer = 0;

  async function probeOnce(silent) {
    try {
      const info = await callBridgeOnce('getSniffed', {}, 3000);
      if (info?.cid && info.cid !== state.cid) {
        await handleVideoChange(info.cid, info.aid, info.bvid);
      } else if (!silent && !info?.cid) {
        setPhase('idle', '点一下播放就开始识别');
      }
    } catch (_) {
      if (!silent) setPhase('idle', '等待播放器加载…');
    }
  }

  function startProbe() {
    if (probeTimer) clearInterval(probeTimer);
    setTimeout(() => probeOnce(false), 1500);
    setTimeout(() => probeOnce(true), 6000);
    probeTimer = setInterval(() => probeOnce(true), 5000);
  }

  async function onEnterVideo() {
    resetSession();
    state.cid = null;
    ensureUi();
    setPhase('idle', '正在等待播放请求…');
    startProbe();
  }

  async function onRouteChange() {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = 0;
    }
    if (!isVideoPage()) {
      teardownUi();
      return;
    }
    await onEnterVideo();
  }

  // 轮询比对 pathname，比劫持 history API 更稳（B站跳转方式不止一种）
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    onRouteChange();
  }, 700);

  // 任何 await 都可能因后台无响应而长期挂起。给消息调用加一道超时，
  // 绝不让「拿设置」这种非关键步骤把整个 UI 卡死。
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise.catch(() => fallback),
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }

  async function boot() {
    // 先建 UI、再处理异步：即使后面任何一步失败，用户也能看见球。
    ensureUi();
    // 给页面盖个戳：隔离世界的 DOM 改动页面可见，用户只要在 F12 控制台
    // 敲 document.documentElement.dataset.bzSub 就能确认脚本到底进没进来，
    // 不必依赖 popup、也不必找 console 日志。
    document.documentElement.setAttribute('data-bz-sub', VER);
    setPhase('idle', '扩展已加载，等待播放…');
    console.log(`[bz-sub] content script 已运行 v${VER}`, location.pathname);

    reportDiag({ event: 'boot', ver: VER });

    state.settings = await withTimeout(sendRuntime('settings:get'), 2500, {
      enabled: true,
      fontSize: 22,
      asrModel: 'small',
    });

    // 非视频页不挂任何 UI，等路由跳进视频页再初始化
    if (!isVideoPage()) {
      document.getElementById('bz-sub-fab')?.remove();
      document.getElementById('bz-sub-panel')?.remove();
      return;
    }
    await onEnterVideo();
  }

  // 供 popup 自检使用：有回应就证明 content script 真的注入了并跑起来了。
  // 这个 listener 必须在任何 await 之前注册，否则脚本卡在异步里时 popup 会误报未注入。
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    // popup 上的「改用 AI 字幕」按钮走这条路：和页面内让路条上的按钮等价
    if (msg && msg.type === 'content:forceAsr') {
      state.forceAsr = true;
      clearYieldBar();
      flashHint('已切换为本地转写，正在准备音频…');
      cancelCurrentJob().then(() => init());
      reply({ ok: true, ver: VER });
      return true;
    }
    if (!msg || msg.type !== 'content:ping') return;
    reply({
      ok: true,
      ver: VER,
      href: location.pathname.slice(0, 80),
      phase: state.phase,
      status: state.statusText,
      cid: state.cid,
      tracks: state.trackCount,
      fab: !!document.getElementById('bz-sub-fab'),
      cues: state.cues.length,
    });
    return true;
  });

  boot();
})();
