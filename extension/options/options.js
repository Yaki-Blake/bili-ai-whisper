const $ = (id) => document.getElementById(id);

const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('后台无响应'));
      if (!res.ok) return reject(new Error(res.error || '调用失败'));
      resolve(res.data);
    });
  });

function toast(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('bad', isError);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3200);
}

async function loadExt() {
  const s = await send('settings:get');
  $('serviceUrl').value = s.serviceUrl || 'http://127.0.0.1:8765';
  $('fontSize').value = s.fontSize || 22;
  $('enabled').value = s.enabled === false ? 'false' : 'true';
}

async function loadServer() {
  try {
    // 唯一后端，没有可调的识别参数；这次调用只为确认服务端配置接口可达
    await send('config:get');
  } catch (err) {
    toast('toastSave', `读取服务端配置失败：${err.message}`, true);
  }
}

async function save() {
  try {
    await send('settings:set', {
      patch: {
        serviceUrl: $('serviceUrl').value.trim() || 'http://127.0.0.1:8765',
        fontSize: Number($('fontSize').value) || 22,
        enabled: $('enabled').value === 'true',
      },
    });
    toast('toastSave', '已保存');
  } catch (err) {
    toast('toastSave', `扩展设置保存失败：${err.message}`, true);
  }
}

$('btnPing').addEventListener('click', async () => {
  toast('toastPing', '检查中…');
  try {
    const d = await send('service:ping');
    toast(
      'toastPing',
      d.asr_ready ? `在线 · ${d.asr_model} · ${d.device}` : `在线，但后端未就绪：${d.error || 'sherpa-onnx 不可用'}`,
      !d.asr_ready,
    );
  } catch (err) {
    toast('toastPing', `失败：${err.message}`, true);
  }
});

$('btnSave').addEventListener('click', save);
$('btnReload').addEventListener('click', async () => {
  await loadExt();
  await loadServer();
  toast('toastSave', '已重新读取');
});

(async () => {
  await loadExt();
  await loadServer();
})();
