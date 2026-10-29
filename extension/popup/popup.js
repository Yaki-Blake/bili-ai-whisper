const $ = (id) => document.getElementById(id);
const VER = chrome.runtime.getManifest().version;

const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('后台无响应'));
      if (!res.ok) return reject(new Error(res.error || '调用失败'));
      resolve(res.data);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshStatus() {
  const box = $('status');
  box.className = 'status';
  box.textContent = '正在检查本地服务…';
  try {
    const d = await send('service:ping');
    if (!d.asr_ready) {
      box.className = 'status bad';
      box.textContent = `服务在线，但 faster-whisper 未安装 · 扩展 v${VER}`;
      return;
    }
    box.className = 'status ok';
    box.textContent = `服务在线 · ${d.asr_model || 'small'} · ${d.device || 'cpu'} · 扩展 v${VER}`;
  } catch (err) {
    box.className = 'status bad';
    box.textContent = `服务未连接：${err.message} · 扩展 v${VER}`;
  }
}

async function load() {
  const s = await send('settings:get');
  $('enabled').checked = s.enabled !== false;
  $('fontSize').value = s.fontSize || 22;
  $('asrModel').value = s.asrModel || 'small';
}

function bind(id, key, parse = (v) => v) {
  $(id).addEventListener('change', async (e) => {
    const raw = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    await send('settings:set', { patch: { [key]: parse(raw) } });
  });
}

bind('enabled', 'enabled');
bind('fontSize', 'fontSize', Number);
bind('asrModel', 'asrModel');

$('fontSize').addEventListener('input', (e) => {
  send('settings:set', { patch: { fontSize: Number(e.target.value) } });
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openService').addEventListener('click', () => {
  refreshStatus();
  probeContent(true);
});

// ═══════════════════ 在代码里把站点权限要回来 ═══════════════════
// 「扩展详情页里站点访问权限打着勾」≠「运行时真的授权了」。
// 后者才是 chrome.scripting / content_scripts 认的东西，用
// chrome.permissions.getAll() 一看便知。没授权时，可以在用户手势里
// 用 permissions.request 直接把已声明的 host 权限重新要一次，
// 比让用户在一堆菜单里翻要可靠得多。
// 必须是 manifest 里已声明的来源，否则 permissions.request 会被拒
const BILI_ORIGINS = ['https://www.bilibili.com/*'];

async function regrant() {
  const box = $('csinfo');
  box.className = 'csline';
  box.textContent = '正在请求 B站 站点权限…';
  setDetail('');

  let granted = false;
  let lastErr = '';
  for (const origins of BILI_ORIGINS.map((o) => [o])) {
    try {
      if (await chrome.permissions.request({ origins })) {
        granted = true;
        break;
      }
    } catch (err) {
      lastErr = String((err && err.message) || err);
    }
  }

  if (!granted) {
    box.classList.add('bad');
    box.textContent = '浏览器没有同意授权，仍在拦截注入';
    if (lastErr) setDetail(lastErr);
    return;
  }
  box.textContent = '已授权，正在注入…';
  await sleep(300);
  await probeContent(true);
}

$('regrant').addEventListener('click', regrant);

// 「改用 AI 字幕」：把用户的意图传给页面脚本，和页面里那条让路提示等价。
// 不直接改 storage 里的全局开关 —— 用户只是对这一个视频下命令，
// 不该影响以后所有视频的默认行为。
$('forceAsr').addEventListener('click', async () => {
  const box = $('csinfo');
  const tabId = lastProbe && lastProbe.tabId;
  if (!tabId) {
    box.className = 'csline bad';
    box.textContent = '拿不到当前标签页，关掉弹窗重开一次';
    return;
  }
  box.className = 'csline';
  box.textContent = '已切到 AI 字幕，正在准备音频…';
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'content:forceAsr' });
  } catch (err) {
    box.classList.add('bad');
    box.textContent = `切换失败：${(err && err.message) || err}`;
    return;
  }
  await sleep(700);
  await probeContent(true);
});

load().then(() => {
  refreshStatus();
  probeContent();
});

// ══════════════════════════ 页面内脚本自检 ══════════════════════════
// 「服务在线」只能说明后台能连上本地服务，完全不能说明 B站 页面里注入了脚本。
// 两者是两回事：站点权限没给、页面在装扩展之前就开着、脚本报错，都会让页面里
// 什么都没发生，而 popup 依旧一片绿。这里直接向目标标签页发一条 ping：
// 有回应 = 脚本在跑；连不上 = 脚本没注入，那就立刻自己补一针。
// 结论同时上报给本地服务，便于事后排查。
const BILI = /^https:\/\/([\w-]+\.)?bilibili\.com\//;

let lastProbe = null;
let autoTried = false;

function setDetail(text) {
  const d = $('csdetail');
  if (!text) {
    d.hidden = true;
    d.textContent = '';
    return;
  }
  d.hidden = false;
  d.textContent = text;
}

function setTarget(url) {
  const box = $('cstarget');
  box.className = 'csline';
  if (!url) {
    box.textContent = '目标页：读不到地址（该标签页不可脚本化，或不是网页）';
    return;
  }
  box.textContent = `目标页：${shortUrl(url)}`;
  if (!BILI.test(url)) box.classList.add('bad');
}

function renderProbe(r) {
  const box = $('csinfo');
  box.className = 'csline';
  box.onclick = null;
  box.title = '';
  setDetail('');
  // 只要页面脚本没跑起来，就把「重新授权」摆出来：
  // 权限已授时点它不会弹窗、也不会有副作用。
  $('fixrow').hidden = !!r.ok;
  // 让路状态下给一个直接切 AI 字幕的按钮：很多人根本不知道
  // 右下角那个「字」点开还有这一层。
  $('skiprow').hidden = !(r.ok && r.phase === 'skipped');

  if (r.ok) {
    box.classList.add('ok');
    box.textContent =
      `页面脚本：已运行 v${r.ver} · ${r.phase || 'idle'}` +
      ` · 球${r.fab ? '✓' : '✗'}` +
      (r.cid ? ` · cid ${r.cid}` : '');
    if (r.phase === 'skipped') {
      setDetail('这个视频自带官方字幕，扩展按规则让路了。要覆盖它：点下面的按钮，或在页面右下角点「字」。');
    } else if (!r.fab && r.phase === 'idle' && !r.cid) {
      setDetail('脚本在跑，但没建出悬浮球：多半是当前页面不是播放页（/video/、/list/、番剧），或者视频信息还没嗅探到。');
    }
    return;
  }

  box.classList.add('bad');
  if (r.reason === 'not-bili') {
    box.textContent = '页面脚本：这个标签页不是 B站（可点此做注入测试）';
    box.classList.add('clickable');
    if (r.tabId) box.onclick = () => testInject(r);
    return;
  }
  if (r.reason === 'inject-failed') {
    box.textContent = '页面脚本：注入失败（下面两行请一起发我）';
    setDetail([r.detail, r.env].filter(Boolean).join('\n'));
    return;
  }
  box.textContent = '页面脚本：未运行（点此手动注入）';
  box.classList.add('clickable');
  if (r.tabId) box.onclick = () => injectNow(r);
  if (r.detail) setDetail(r.detail);
}

function shortUrl(url) {
  const s = String(url).replace(/^https?:\/\//, '');
  return s.length > 34 ? `${s.slice(0, 34)}…` : s;
}

// 浏览器认为这个扩展到底拿到了哪些来源的授权。
// 「详情页里打着勾」和「运行时 getAll 里有这一项」是两件事，这里要看后者的答案。
async function envLine() {
  let info;
  try {
    info = await send('env:info');
  } catch (err) {
    return `环境：读取失败 ${(err && err.message) || err}`;
  }
  const ua = info.ua || '';
  const ver = (ua.match(/Edg\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/) || [, '?'])[1];
  const origins = info.origins || [];
  const hasBili = origins.some((o) => o.includes('bilibili.com'));
  const names = origins
    .map((o) => o.replace(/^https?:\/\//, '').replace(/\/\*$/, ''))
    .join(' , ');
  const perms = (info.perms || []).join(',') || '（空）';
  return (
    `浏览器 ${ver} · 运行时授权 ${origins.length} 个来源：${names || '（空）'}` +
    `${hasBili ? '' : ' ← 不含 bilibili'} · 已批权限 ${perms}`
  );
}

function probeOnce(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, reason: 'timeout' });
      }
    }, 1500);
    chrome.tabs.sendMessage(tabId, { type: 'content:ping' }, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, reason: 'no-receiver', detail: err.message });
      resolve(res && res.ok ? res : { ok: false, reason: 'empty', detail: JSON.stringify(res || {}) });
    });
  });
}

// 三步分开做、分别记账：任何一步失败都能指出是哪一步、报了什么，
// 而不是笼统一句「注入失败」。CSS 失败不拦后续，UI 顶多没样式，仍能用。
// 开头先跑两个「不读文件」的探针：
//   1. func 注入一段函数 —— 失败说明整个 scripting 被拒（权限/引擎层）
//   2. css 传字符串而不是文件 —— 失败说明连样式注入都不允许
// 探针过、文件不过，那就是读文件的问题（路径编码之类），方向完全不同。
async function inject(tabId) {
  const log = [];
  const failedSteps = new Set();

  const step = async (label, run, show) => {
    try {
      const v = await run();
      log.push(`${label}: ok${show ? `(${show(v)})` : ''}`);
    } catch (err) {
      const m = (err && err.message) || err;
      log.push(`${label}: ${m}`);
      failedSteps.add(label);
    }
  };

  const real = ['css', 'bridge', 'content'];

  // 探针：不读文件，直接注入一段函数
  await step(
    '探针fn',
    () => chrome.scripting.executeScript({ target: { tabId }, func: () => location.href }),
    (r) => (r && r[0] && r[0].result) || '?'
  );
  // 探针：样式用字符串而不是文件
  await step('探针css', () => chrome.scripting.insertCSS({ target: { tabId }, css: ':root{}' }));

  await step('css', () =>
    chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] })
  );
  // 顺序要紧：bridge 在页面主世界，content 依赖它探测视频信息
  await step('bridge', () =>
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/bridge.js'],
      world: 'MAIN',
    })
  );
  await step('content', () =>
    chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] })
  );

  const hardFail = real.some((k) => failedSteps.has(k));
  return hardFail ? log.join(' | ') : true;
}

// 在「不是B站」的页面上做一次纯注入测试：能区分「B站 特有被拦」
// 和「这个浏览器根本不允许本扩展往任何页面塞脚本」。
async function testInject(r) {
  const box = $('csinfo');
  if (!r.tabId) return;
  box.className = 'csline';
  box.textContent = '正在测试注入…';
  box.onclick = null;
  setDetail('');
  const res = await inject(r.tabId);
  box.classList.remove('ok');
  if (res === true) {
    box.classList.add('ok');
    box.textContent = '注入测试：成功 —— 该站点允许注入，问题只在 B站';
  } else {
    box.classList.add('bad');
    box.textContent = '注入测试：同样被拦 —— 浏览器层面在拒绝本扩展';
    setDetail(res);
  }
}

async function injectNow(r) {
  const box = $('csinfo');
  if (!r.tabId) return;
  box.className = 'csline';
  box.textContent = '正在注入脚本…';
  box.onclick = null;
  const ok = await inject(r.tabId);
  if (ok !== true) {
    box.classList.add('bad');
    box.textContent = `注入失败：${ok}`;
    return;
  }
  await sleep(700);
  await probeContent();
}

async function probeContent(force) {
  const box = $('csinfo');
  box.className = 'csline';
  box.textContent = '页面脚本：检查中…';
  box.onclick = null;
  setDetail('');
  if (force) autoTried = false;

  let r;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      r = { ok: false, reason: 'no-tab', detail: '拿不到当前标签页' };
    } else {
      const url = tab.url || '';
      setTarget(url);
      // 读不到地址有两种可能：不是 B站，或者站点权限没给。后者同样会让
      // 声明式注入失效，所以不能因为「地址为空」就下结论，直接探活更可靠。
      const definitelyNotBili = !!url && !BILI.test(url);
      let res = definitelyNotBili ? { ok: false, reason: 'not-bili' } : await probeOnce(tab.id);

      // 探活不通就自己补一针：点开 popup 已经构成一次用户手势，
      // activeTab 权限在这一刻生效。
      if (!res.ok && !definitelyNotBili && !autoTried) {
        autoTried = true;
        box.textContent = '页面脚本：未运行，正在自动注入…';
        const first = await inject(tab.id);
        if (first === true) {
          await sleep(800);
          res = await probeOnce(tab.id);
        }
        // 第一条通道（popup 上下文）不通，再走 service worker 通道。
        // 两边报错都留着，能直接区分「权限问题」和「上下文问题」。
        if (!res.ok) {
          let second = '';
          try {
            const r2 = await send('inject:tab', { tabId: tab.id, why: 'popup-fallback' });
            second = r2 && r2.ok ? '' : (r2 && r2.error) || 'unknown';
          } catch (err) {
            second = String((err && err.message) || err);
          }
          if (second === '') {
            await sleep(800);
            res = await probeOnce(tab.id);
          }
          if (!res.ok) {
            res = {
              ok: false,
              reason: 'inject-failed',
              detail: `popup: ${first === true ? 'ok' : first} | bg: ${second || 'ok'}`,
            };
          }
        }
      }
      r = { ...res, tabId: tab.id, url };
    }
  } catch (err) {
    r = { ok: false, reason: 'error', detail: String((err && err.message) || err) };
  }

  // 失败时把浏览器怎么看这个扩展的权限一并摆出来：
  // 站点权限 UI 上打着勾、运行时却没授权的情况是真实存在的。
  if (!r.ok && r.reason !== 'not-bili') r.env = await envLine();

  lastProbe = r;
  renderProbe(r);

  // 上报给本地服务，出问题时不用截图也能看到结论
  send('diag', {
    payload: {
      event: 'popup-probe',
      ver: VER,
      phase: r.ok ? r.phase : 'no-content-script',
      cid: r.ok ? r.cid : null,
      tracks: r.ok ? r.tracks : -1,
      fab: r.ok ? !!r.fab : false,
      contentScript: !!r.ok,
      reason: r.reason || '',
      detail: r.detail || '',
      env: r.env || '',
      href: r.url || '',
    },
  }).catch(() => {});
}
