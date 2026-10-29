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
    const c = await send('config:get');
    $('defaultModel').value = c.default_model || 'small';
    $('device').value = c.device || 'cpu';
    $('computeType').value = c.compute_type || 'int8';
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
        asrModel: $('defaultModel').value,
      },
    });
  } catch (err) {
    toast('toastSave', `扩展设置保存失败：${err.message}`, true);
    return;
  }

  try {
    await send('config:set', {
      patch: {
        default_model: $('defaultModel').value,
        device: $('device').value,
        compute_type: $('computeType').value,
      },
    });
    toast('toastSave', '已保存。重启服务后识别参数生效。');
  } catch (err) {
    toast('toastSave', `服务端配置保存失败：${err.message}（扩展设置已保存）`, true);
  }
}

$('btnPing').addEventListener('click', async () => {
  toast('toastPing', '检查中…');
  try {
    const d = await send('service:ping');
    toast(
      'toastPing',
      d.asr_ready ? `在线 · ${d.asr_model} · ${d.device}` : '在线，但未安装 faster-whisper',
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

$('device').addEventListener('change', (e) => {
  $('computeType').value = e.target.value === 'cuda' ? 'float16' : 'int8';
});

(async () => {
  await loadExt();
  await loadServer();
})();
