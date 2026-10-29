<p align="center">  
  <b>简体中文</b> · <a href="README.en.md">English</a>  
</p>

# bili-ai-whisper

B站本地字幕补全 —— 给没有字幕的视频补中文字幕，转写全程在本机完成，音频不上传。

默认后端是 **SenseVoice-Small**（中文比 whisper 更准，CPU 上约 25–35 倍实时），环境不支持时自动退回 faster-whisper。

## 1. 文件结构

```
bili-ai-whisper/
├── 启动字幕服务.bat        一键启动（转调 server\run.bat）
├── extension/              浏览器扩展（MV3）
│   ├── manifest.json       版本、权限、脚本声明
│   ├── background.js       短请求转发、设置读写
│   ├── content/
│   │   ├── bridge.js       主世界：Wbi 签名、调接口、嗅探 cid
│   │   ├── content.js      隔离世界：判断、渲染、编排
│   │   └── content.css
│   ├── popup/              工具栏弹窗（状态、授权、切换 AI 字幕）
│   └── options/            设置页
└── server/                 本地服务（Flask）
    ├── server.py           路由 + 任务队列
    ├── asr.py              后端分发、whisper 封装、幻觉过滤
    ├── asr_sensevoice.py   SenseVoice 分块识别、按标点与停顿切句
    ├── audio_util.py       统一解码成 16k 单声道
    ├── bili.py             音频下载、签名兜底
    ├── config.py           配置读写
    ├── selftest.py         接口自检
    ├── requirements.txt
    └── run.bat             首次建 .venv、装依赖、下模型
```

## 2. 怎么用

**装扩展**（建议用 Chrome，见第 3 节）

1. 打开 `chrome://extensions/`，开启右上角「开发人员模式」
2. 「加载已解压的扩展程序」→ 选 `extension` 文件夹
3. **以后每次改过 `extension` 里的文件，都要点一次 ↻ 再按 F5**，否则跑的还是旧脚本

**起服务**

双击 `server\run.bat`。首次运行会下载，共约 630 MB：

- Python 依赖　约 400 MB
- SenseVoice 模型　约 228 MB

看到下面这段就成了：

```
  服务地址   http://127.0.0.1:8765
  运行日志   server.log
```

窗口之后不再输出，日志都写进 `server.log`。

依赖只装在 `server\.venv` 里，模型在 `%LOCALAPPDATA%\bili-ai-whisper\cache`，不改系统环境、不装后台服务。不想要了直接删掉这两个目录即可。

**看视频**

打开无字幕的 B站视频 → 点播放 → 右下角出现「字」球 → 约 2 秒出第一句，之后边转边补。

球是灰的且底下有条提示 = 这个视频自带官方字幕，扩展主动让路了。条上有两个按钮：`打开官方字幕`、`改用 AI 字幕`。

球点开可以调字号、重新识别、导出 SRT、清缓存。

## 3. 存在的问题

**功能性**

- 只支持 B站普通视频、连播列表、番剧页，其他站点无法使用
- 只支持 Windows 系统
- 只做中文转写，无法翻译外语
- 日常对话基本可读，但技术术语仍会错：`void *` 会被写成「word新」，`字节` 偶尔变「字己」
- 未登录 B站 时接口不给 AI 字幕列表，会被误判成「没字幕」
- 番剧/影视区有版权保护的内容，`playurl` 可能取不到音频流

**性能**

- SenseVoice 约 25–35 倍实时：20 分钟视频约 40 秒，50 分钟约 90 秒。实测 176 秒音频端到端 6.6 秒（含模型加载）
- 退回 whisper 后备时只有 2–8 倍实时，会明显跟不上播放
- 长音频解码要一次性读进内存：1 小时音频约 230 MB

**环境坑（代码里已规避，换机器可能复现）**

- 部分 Edge 会**全局拒绝扩展注入**，任何站点都返回 `Blocked`，与代码无关 —— 换 Chrome
- Windows 控制台开「快速编辑」后，鼠标一选中文字，服务所有请求都会卡死。已把 stdout 重定向到 `server.log` 规避
- VAD 在本机会把人声判成静音，只出 1 句。默认已关闭
- 模型加载若走联网校验，网络一抖就起不来。已改为本地路径直载
- SenseVoice 的 token 时间戳在「长块 + 长静音」下会漂移，一句 10 秒的话可能标成 25 秒。已改成 20 秒分块 + 停顿超 2 秒断句

## 4. 代码逻辑

```
bridge.js   主世界：带登录态调 B站接口，从播放请求里嗅探 aid/cid
   │ postMessage
content.js  隔离世界：判断有无官方字幕 → 让路或起转写，rAF 同步渲染
   │ chrome.runtime
background  只转发短请求到 localhost:8765
   │ HTTP
server.py   下载音轨 → 按 backend 分发 → 按句增量返回
              ├─ SenseVoice（默认）  20 秒分块，按标点与停顿切句
              └─ faster-whisper     兜底，装了 sherpa-onnx 就不会走到
```

## 5. 免责声明

本项目仅供个人学习与技术研究使用。不下载、不存储、不分发任何视频内容；音频只在本机临时处理，不上传任何服务器。使用时请遵守 B站 用户协议及相关法律法规，由此产生的一切后果由使用者自行承担。

## 6. 许可证

MIT，详见 [LICENSE](LICENSE)。
