# 本地文件音乐播放器 

轻量、面向本地音乐目录的播放器。此README用AI生成。

## 近期更新 (v1.1.0)

✅ 已解决的问题：
- ✅ 均衡效果优化：调整目标响度从 -20dB 到 -10dB，增益范围从 0.5-2.5 扩展到 0.2-4.0
- ✅ 增益显示：播放列表中显示每首曲目的实际增益值（如"增益：+2.3dB"）
- ✅ 折叠bug修复：切换歌曲和刷新目录时不再自动展开播放列表
- ✅ 自动更新：集成 electron-updater，支持从 GitHub Releases 自动检测和安装更新

待解决问题：
- 增加单次启动播放器后不会随机到相同歌曲的功能
- 增加歌名词频统计功能，生成听歌报告与偏好设置
- 增加更多类型的播放功能，如wav，flac，midi等

---

## 关键特色
- 本地目录驱动  
  - 可以选择本地文件夹（使用 File System Access API / showDirectoryPicker），播放器会递归加载目录中的 `.mp3` / `.m4a` 文件并记住上次选择的目录（保存在 IndexedDB），方便下次恢复。
- 加权随机（智能 Shuffle）  
  - 记录每首歌的播放次数（playCount）与被中途切歌次数（skipCount），并基于这些统计做"加权无放回"抽样：
    - 播放次数少的歌曲在随机时权重更高（优先推荐较少播放的曲目）。
    - 被频繁切歌的歌曲权重下降，减少被再次随机到的概率。
- 平均完播率参与权重  
  - 为每次播放会话计算完播比例（currentTime/duration），累积后得到平均完播率；该完播率会乘入随机权重，使"经常被完整听完"的曲目更容易被选中。
- 自动均衡音量（自动归一化）  
  - 首次播放单曲时异步解码（RMS 简化响度估算），计算并缓存每首的归一化增益；播放时将增益平滑应用于输出，降低曲目间响度波动（结果持久化到 localStorage）。
  - 目标响度：-10dB，增益范围：0.2x - 4.0x
  - 播放列表中显示每首曲目的实际增益值
- 自动更新功能 (Electron)
  - 应用启动时自动检查 GitHub Releases 上的新版本
  - 发现更新时显示通知横幅，支持手动下载和安装
  - 更新下载时显示进度条
  - 下载完成后可一键安装并重启应用
- 可视化与交互增强
  - 折叠 / 展开播放列表、快速"定位当前播放曲目"并高亮；
  - 手动刷新目录（检测文件新增/删除/移动）；支持拖拽单文件添加；
  - 马卡龙浅色主题，圆润按钮与良好交互反馈。
- 数据永久化与隐私  
  - 播放统计（playCount / skipCount / session / completionSum / normalizeGain）保存到 localStorage；目录句柄保存在 IndexedDB（仅在用户允许下用于恢复目录访问）。
  - 所有数据仅保存在本地浏览器，未上传到任何服务器。
---

## 快速开始

- 安装依赖（推荐先同步 lockfile）：
  - 如果 lockfile 与 package.json 不一致，请先运行：
    ```bash
    npm install
    git add package-lock.json
    git commit -m "chore: update package-lock.json"
    ```
  - 然后使用干净安装：
    ```bash
    npm ci
    ```
- 在对应平台上运行 electron-builder：
  - Windows:
    ```bash
    npx electron-builder --win --x64 --publish never
    ```
  - macOS:
    ```bash
    npx electron-builder --mac --x64 --publish never
    ```
  - Linux:
    ```bash
    npx electron-builder --linux --x64 --publish never
    ```
- 构建产物默认输出在 `dist/` 目录下（例如 .exe、.dmg、AppImage 等）。
  - 也可以在github的Actions中使用Build Electron app创建工作流进行自动构建。

### 以下适用于1.x版本，使用WebUI支持
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
1. npm ci 报 “package.json 与 package-lock.json 不一致”
   - 原因：package.json 被修改但 lockfile 未更新。
   - 解决：
     ```bash
     npm install
     # 或仅更新 lockfile
     npm install --package-lock-only
     git add package-lock.json
     git commit -m "chore: regenerate package-lock.json"
     ```
   - 之后在 CI 使用 `npm ci`。

2. Windows 上 npm ci / electron-builder 报 EBUSY 或文件被锁定（例如 default_app.asar）
   - 先关闭所有可能占用项目文件的程序（Electron 应用、node 进程、编辑器的终端或调试会话）。
   - 在任务管理器结束 `node.exe` / `electron.exe` 等进程，或重启电脑释放锁。
   - 如需强制清理：
     ```powershell
     # 在管理员 PowerShell 中
     Remove-Item -Recurse -Force .\node_modules
     Remove-Item -Recurse -Force "$env:LocalAppData\electron-builder\Cache\winCodeSign"
     npm ci
     ```
   - 若找不到占用进程，可使用 Sysinternals Process Explorer 的 “Find Handle or DLL” 功能查找并关闭句柄。

3. Windows 下解压 electron-builder 的工具包报 “Cannot create symbolic link”
   - 原因：7-Zip 解压包含符号链接的文件（.dylib 等）时，当前账号无权限创建 symlink。
   - 解决（按顺序尝试）：
     - 以管理员权限运行终端重试（右键 → 以管理员身份运行）。
     - 启用 Developer Mode（设置 → 更新与安全 → 面向开发人员 → 开启）。
     - 如必要，临时关闭杀毒软件/Windows Defender 实时保护或将 `%LocalAppData%\electron-builder\Cache` 加入排除。
   - 清除缓存并重试：
     ```powershell
     Remove-Item -Recurse -Force "$env:LocalAppData\electron-builder\Cache\winCodeSign"
     npm ci
     npx electron-builder --win --x64 --publish never
     ```

---

## 开发与贡献
- 开发者：Github Copilot (GPT-5 mini)
- 语言：JavaScript / HTML / CSS
- 仓库语言构成（简要）：JavaScript ~78% / CSS ~13% / HTML ~9%

---

