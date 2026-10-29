<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

# Bili 本地字幕补全

给 B站没有字幕的视频补中文字幕，转写全程在本机完成，音频不上传。

## 1. 文件结构

```
bili-sub/
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
    ├── asr.py              faster-whisper 封装、幻觉过滤
    ├── bili.py             音频下载、签名兜底
    ├── config.py           配置读写
    ├── selftest.py         接口自检
    ├── requirements.txt
    └── run.bat             首次建 .venv、装依赖、下模型
```

`.venv`、`server.log`、`config.json`、模型缓存都在 `.gitignore` 里。

## 2. 怎么用

**装扩展**（用 Chrome，别用 Edge，见第 3 节）

1. 打开 `chrome://extensions/`，开启右上角「开发人员模式」
2. 「加载已解压的扩展程序」→ 选 `extension` 文件夹
3. **以后每次改过 `extension` 里的文件，都要点一次 ↻ 再按 F5**，否则跑的还是旧脚本

**起服务**

双击 `server\run.bat`。首次会自动建虚拟环境、装依赖（约 400 MB）、下模型（约 480 MB）。看到下面这段就成了：

```
  服务地址   http://127.0.0.1:8765
  运行日志   server.log
```

窗口之后不再输出，日志都写进 `server.log`。

**看视频**

打开无字幕的 B站视频 → 点播放 → 右下角出现「字」球 → 约 5 秒出第一句，之后边转边补。

球是灰的且底下有条提示 = 这个视频自带官方字幕，扩展主动让路了。条上有两个按钮：`打开官方字幕`、`改用 AI 字幕`。

球点开可以调字号、重新识别、导出 SRT、清缓存。

## 3. 存在的问题

**功能性**

- 只支持 B站普通视频、连播列表、番剧页，其他站点不管
- 只做中文转写，外文视频不翻译
- 不做术语校正，Whisper 对专业名词有稳定错法（如「双非」→「双肥」）
- 未登录 B站 时接口不给 AI 字幕列表，会被误判成「没字幕」
- 番剧/影视区有版权保护的内容，`playurl` 可能取不到音频流

**性能**

- CPU + `small` 模型约 2.4–4 倍实时：20 分钟视频要等 5–8 分钟（首句只要 5 秒，可以先看着）
- 换 `medium` 更准，但慢 2–3 倍

**环境坑（代码里已规避，换机器可能复现）**

- 部分 Edge 会**全局拒绝扩展注入**，任何站点都返回 `Blocked`，与代码无关 —— 换 Chrome
- Windows 控制台开「快速编辑」后，鼠标一选中文字，服务所有请求都会卡死。已把 stdout 重定向到 `server.log` 规避
- VAD 在本机会把人声判成静音，只出 1 句。默认已关闭
- 模型加载若走联网校验，网络一抖就起不来。已改为本地路径直载

## 4. 代码逻辑

```
bridge.js   主世界：带登录态调 B站接口，从播放请求里嗅探 aid/cid
   │ postMessage
content.js  隔离世界：判断有无官方字幕 → 让路或起转写，rAF 同步渲染
   │ chrome.runtime
background  只转发短请求到 localhost:8765
   │ HTTP
server.py   下载音轨 → faster-whisper → 按句增量返回
```

四个关键点：

**1. 视频识别不靠 URL。** `/list/` 连播页地址里没有 BV 号，所以 hook 了 `fetch` 和 `XMLHttpRequest`，从播放请求里嗅探 `aid` / `cid`，三种页面类型通用。

**2. 只走 `wbi/v2` 并做结果校验。** 这个接口签错名**仍然返回 `code: 0`**，只是静默丢数据。所以除了正确签名，还会用「末句时间戳 vs 视频时长」判断结果是否可信。

**3. 转写做成任务制。** MV3 的 service worker 会被回收，长连接必断。改成「提交任务拿 job_id + 每秒轮询」，顺带实现了边转边出字。

**4. 先让路，再覆盖。** 有官方字幕就退出，只在播放器下方留一条细提示；用户点「改用 AI 字幕」才置 `forceAsr` 重新接管。转写结果按 `cid` 缓存，重看秒开。
