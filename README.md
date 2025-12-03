# 本地文件音乐播放器 

轻量、面向本地音乐目录的 Web 播放器。此README用AI生成。

---

## 关键特色
- 本地目录驱动  
  - 可以选择本地文件夹（使用 File System Access API / showDirectoryPicker），播放器会递归加载目录中的 `.mp3` / `.m4a` 文件并记住上次选择的目录（保存在 IndexedDB），方便下次恢复。
- 加权随机（智能 Shuffle）  
  - 记录每首歌的播放次数（playCount）与被中途切歌次数（skipCount），并基于这些统计做“加权无放回”抽样：
    - 播放次数少的歌曲在随机时权重更高（优先推荐较少播放的曲目）。
    - 被频繁切歌的歌曲权重下降，减少被再次随机到的概率。
- 平均完播率参与权重  
  - 为每次播放会话计算完播比例（currentTime/duration），累积后得到平均完播率；该完播率会乘入随机权重，使“经常被完整听完”的曲目更容易被选中。
- 自动均衡音量（自动归一化）  
  - 首次播放单曲时异步解码（RMS 简化响度估算），计算并缓存每首的归一化增益；播放时将增益平滑应用于输出，降低曲目间响度波动（结果持久化到 localStorage）。
- 可视化与交互增强
  - 折叠 / 展开播放列表、快速“定位当前播放曲目”并高亮；
  - 手动刷新目录（检测文件新增/删除/移动）；支持拖拽单文件添加；
  - 马卡龙浅色主题，圆润按钮与良好交互反馈。
- 数据永久化与隐私  
  - 播放统计（playCount / skipCount / session / completionSum / normalizeGain）保存到 localStorage；目录句柄保存在 IndexedDB（仅在用户允许下用于恢复目录访问）。
  - 所有数据仅保存在本地浏览器，未上传到任何服务器。

---

## 快速开始（本地运行）
1. 克隆仓库并切到项目目录：
   - git clone https://github.com/fengyue765/musicplayer.git
   - cd musicplayer
2. 使用一个简单静态服务器（必须使用 http(s) 或 localhost，以保证模块加载与 File System Access API 工作正常）：
   - Python 3: `python -m http.server 8000`
   - 或 Node: `npx http-server -p 8000`
3. 在浏览器打开：`http://localhost:8000/`
4. 推荐浏览器：Chromium 内核浏览器（Chrome / Edge / Brave）以获得最佳的目录访问支持。Firefox / Safari 对 showDirectoryPicker 支持有限。

---

## 使用说明（要点）
- 选择 / 更换 文件夹：点击“选择 / 更换 文件夹”，授权后将递归加载目录下的 mp3/m4a。
- 刷新目录：若对文件夹做了增删改，点击“刷新目录”重新扫描并更新播放列表。
- 随机（Shuffle）/ 单曲循环（Repeat-One）：切换对应按钮。Shuffle 使用加权抽样并生成无放回顺序；Repeat-One 在启动时会反复播放当前曲目。
- 自动均衡：勾选“自动均衡”可以启用响度归一化（默认可配置）。首次播放未缓存的文件会触发一次背景分析与缓存。
- 统计持久化：播放与切歌统计、完播率、归一化增益会保存在 localStorage（key: `localPlayerStats_v1`）。目录句柄保存在 IndexedDB（key: `lastDir`）。

---

## 设计与实现要点（简要）
- 随机权重公式示例（实现中可配置）：
  - weight = (BASE + 1/(1+playCount) * 1/(1+skipCount * SKIP_PENALTY)) * max(avgCompletion, MIN_COMPLETION)
- 归一化方法：
  - 使用 WebAudio 的 decodeAudioData 对音频解码后计算 RMS 并以目标 dB 计算线性增益，增益值限制到安全范围后缓存。
  - 后续播放直接使用缓存的 normalizeGain，避免重复解码开销。
- 权限/兼容：
  - 若浏览器不支持 File System Access API，会提供拖拽单文件的备选方案，但无法记住目录句柄。

---

## 常见问题
- “无法选择目录 / 页面无法读取文件”：请确认你通过 `http://localhost` 或 HTTPS 打开页面，而不是 `file://`；并使用 Chromium 系浏览器以获得 showDirectoryPicker 支持。
- “播放后音量忽高忽低”：可启用“自动均衡”功能，播放器会分析并平滑应用归一化增益（首次分析时可能有短延迟）。
- “如何清除统计数据或已记住的目录？”：在 UI 中有“清除已记住的文件夹”按钮；若需要清空统计可在浏览器开发者工具中清除 localStorage 对应键，或我可以在 UI 中添加“清空统计”按钮。

---

## 开发与贡献
- 语言：JavaScript / HTML / CSS
- 仓库语言构成（简要）：JavaScript ~73% / CSS ~16% / HTML ~11%

---

