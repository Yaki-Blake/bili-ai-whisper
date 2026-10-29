/**
 * background.js —— MV3 service worker
 *
 * 只做两件事：
 *   1. 与本地服务（127.0.0.1:8765）通信，绕开内容脚本的 CORS 限制
 *   2. 托管用户设置
 *
 * 刻意不使用常驻长连接：MV3 的 worker 会被回收，ASR 这类长任务
 * 一律改写成「提交任务 + 轮询状态」，每次都是短请求，worker 不会被中途杀掉。
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  fontSize: 22,
  asrModel: 'small',
  serviceUrl: 'http://127.0.0.1:8765',
};

const SETTINGS_KEY = 'settings';

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function callService(path, options = {}) {
  const s = await getSettings();
  const base = (s.serviceUrl || DEFAULT_SETTINGS.serviceUrl).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 20000);

  try {
    const res = await fetch(`${base}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`本地服务返回了非 JSON 内容（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new Error(json?.error || `本地服务错误 HTTP ${res.status}`);
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('本地服务响应超时');
    if (String(err.message).includes('Failed to fetch')) {
      throw new Error('连不上本地服务，请先运行 server/run.bat');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const handlers = {
  'settings:get': () => getSettings(),
  'settings:set': (msg) => setSettings(msg.patch || {}),

  'service:ping': () => callService('/health', { timeout: 3000 }),

  // 提交转写任务，立刻返回 jobId
  'asr:submit': (msg) =>
    callService('/asr', {
      method: 'POST',
      body: msg.payload,
      timeout: 30000,
    }),

  // 轮询任务状态
  'asr:poll': (msg) =>
    callService(`/asr/status?job_id=${encodeURIComponent(msg.jobId)}`, { timeout: 8000 }),

  'asr:cancel': (msg) =>
    callService(`/asr/cancel?job_id=${encodeURIComponent(msg.jobId)}`, { timeout: 5000 }),

  // 模型与设备参数托管在本地服务端，扩展只提交模型名
  'config:get': () => callService('/config', { timeout: 8000 }),
  'config:set': (msg) =>
    callService('/config', { method: 'POST', body: msg.patch || {}, timeout: 8000 }),

  // 页面内状态上报，方便在服务端远程排查「到底跑到哪一步」
  'diag': (msg) =>
    callService('/diag', { method: 'POST', body: msg.payload || {}, timeout: 4000 }),

  // popup 注入失败时的第二条通道：在 service worker 里再试一次
  'inject:tab': (msg) => ensureInjected(msg.tabId, msg.why || 'popup-fallback'),

  // 排障用：浏览器怎么看待这个扩展的权限
  'env:info': async () => {
    const p = await chrome.permissions.getAll();
    return { ua: navigator.userAgent, origins: p.origins || [], perms: p.permissions || [] };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `未知消息类型：${msg?.type}` });
    return false;
  }
  Promise.resolve(handler(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // 保持异步响应通道
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});

// ═════════════════════ 自动兜底注入 ═════════════════════
// 声明式注入（manifest 的 content_scripts）会失效于几种常见情形：
// 站点权限刚刚授予、扩展刚重载而页面是旧的、页面由站内 SPA 跳转进入等。
// 这里在页面加载完成后主动探活一次，没反应就自己补注入，做到自愈。
const BILI_URL = /^https:\/\/(www|m)\.bilibili\.com\//;

function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'content:ping' }, (res) => {
      void chrome.runtime.lastError; // 没注入时这里必然报错，属正常
      resolve(!!(res && res.ok));
    });
  });
}

async function ensureInjected(tabId, why) {
  const bad = [];
  const note = (step, err) => bad.push(`${step}: ${(err && err.message) || err}`);

  // 三步分开记账，任何一步失败都能指出是哪一步、报了什么
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
  } catch (err) {
    note('css', err);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/bridge.js'],
      world: 'MAIN',
    });
  } catch (err) {
    note('bridge', err);
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch (err) {
    note('content', err);
  }

  const ok = bad.length === 0;
  callService('/diag', {
    method: 'POST',
    body: {
      event: 'auto-inject',
      phase: ok ? 'injected' : 'inject-failed',
      why,
      contentScript: ok,
      reason: bad.join(' | '),
    },
    timeout: 3000,
  }).catch(() => {});
  return { ok, error: bad.join(' | ') };
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = (tab && tab.url) || '';
  // 读不到地址就闭嘴：edge:// 之类的页面本来就不允许注入，
  // 盲目尝试只会在日志里刷一堆无意义的 Blocked。这类情况交给 popup 处理。
  if (!BILI_URL.test(url)) return;
  // 声明式注入通常已经生效，探活通过就直接退出，不做多余动作
  if (await pingTab(tabId)) return;
  await ensureInjected(tabId, 'tab-complete');
});
