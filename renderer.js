// renderer.js — 完整版（Electron 兼容）
// 说明：保留原有业务逻辑（shuffle/repeat/统计/normalize/render），并把目录访问替换为 window.api（preload）优先。
// 如果在浏览器端运行，会回退到原生 showDirectoryPicker / file handles（假如存在）。

import { loadStats, saveStats, loadUIState, saveUIState, loadSessionState, saveSessionState, idbPut, idbGet, idbDelete } from './storage.js';
import { ensureAudioGraph, applyGainSmooth, getAudioContext } from './audioGraph.js';
import { analyzeAndCacheNormalize } from './normalize.js';

/* DOM refs */
const audio = document.getElementById('audio');
const chooseDirBtn = document.getElementById('chooseDir');
const refreshBtn = document.getElementById('refreshBtn');
const clearSavedBtn = document.getElementById('clearSaved');
const playlistEl = document.getElementById('playlist');
const playBtn = document.getElementById('play');
const nextBtn = document.getElementById('next');
const prevBtn = document.getElementById('prev');
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const currentTitle = document.getElementById('currentTitle');
const seek = document.getElementById('seek');
const timeEl = document.getElementById('time');
const dirStatus = document.getElementById('dirStatus');
const togglePlaylistBtn = document.getElementById('togglePlaylistBtn');
const locateBtn = document.getElementById('locateBtn');
const sortSelect = document.getElementById('sortSelect');
const sortDirBtn = document.getElementById('sortDirBtn');
const autoNormalizeCheckbox = document.getElementById('autoNormalize');

/* Manual volume control DOM refs */
const manualVolumeSlider = document.getElementById('manualVolume');
const volumeValueDisplay = document.getElementById('volumeValue');
const resetVolumeBtn = document.getElementById('resetVolume');

/* Update notification DOM refs */
const updateNotification = document.getElementById('updateNotification');
const updateMessage = document.getElementById('updateMessage');
const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
const installUpdateBtn = document.getElementById('installUpdateBtn');
const dismissUpdateBtn = document.getElementById('dismissUpdateBtn');
const updateProgress = document.getElementById('updateProgress');
const updateProgressBar = document.getElementById('updateProgressBar');
const updateProgressText = document.getElementById('updateProgressText');

/* State */
let playlist = []; // items: { name, path?, url?, fileHandle?, size, id, _objectUrl }
let currentIndex = -1;
let currentDirPath = null; // string path (Electron) or FileSystemDirectoryHandle (browser)
let isShuffle = false;
let repeatOne = false;
let playOrder = [];
let orderPos = 0;
let uiState = loadUIState();
let stats = loadStats();
let sessionActive = false;
let sessionIndex = -1;
let currentManualVolumeDb = 0; // Current manual volume adjustment in dB
let sessionState = loadSessionState(); // Track played songs in current session
let playedInCurrentSession = new Set(sessionState.playedInCurrentSession || []); // Set of track IDs played in current session

/* Compatibility shim */
const hasElectronApi = typeof window !== 'undefined' && window.api && typeof window.api.chooseDirectory === 'function';

/* Helpers */
function logDebug(...args){
  console.debug('[player]', ...args);
  if (dirStatus) dirStatus.textContent = String(args[0]);
}
function getTrackId(track){
  if (track.id) return track.id;
  if (typeof track.size === 'number') { track.id = `${track.name}::${track.size}`; }
  else { track.id = track.name; }
  return track.id;
}
function ensureStatsForTrack(track){
  const id = getTrackId(track);
  if (!stats[id]) stats[id] = { playCount:0, skipCount:0, sessionCount:0, completionSum:0, normalizeGain:null, loudnessDb:null, manualVolumeDb:0 };
  return stats[id];
}
function persistStats(){ saveStats(stats); }

/* Sorting + render (same logic as before) */
function getSortedIndices(){
  const indices = playlist.map((_,i)=>i);
  const key = uiState.sortKey || 'default';
  const dir = uiState.sortDir || 'desc';
  if (key === 'default') return indices;
  indices.sort((a,b)=>{
    const ta = playlist[a], tb = playlist[b];
    const sa = stats[getTrackId(ta)] || {}, sb = stats[getTrackId(tb)] || {};
    let cmp = 0;
    if (key === 'play') cmp = (sa.playCount||0) - (sb.playCount||0);
    else if (key === 'skip') cmp = (sa.skipCount||0) - (sb.skipCount||0);
    else if (key === 'completion') {
      const va = sa.sessionCount ? sa.completionSum/sa.sessionCount : 0;
      const vb = sb.sessionCount ? sb.completionSum/sb.sessionCount : 0;
      cmp = va - vb;
    } else if (key === 'name') cmp = ta.name.toLowerCase().localeCompare(tb.name.toLowerCase());
    return dir === 'asc' ? cmp : -cmp;
  });
  return indices;
}

function renderPlaylist(){
  playlistEl.innerHTML = '';
  const sorted = getSortedIndices();
  for (const pi of sorted){
    const p = playlist[pi];
    const i = pi;
    const div = document.createElement('div');
    div.className = 'item' + (i === currentIndex ? ' active' : '');
    div.dataset.index = String(i);
    const left = document.createElement('div'); left.className = 'filename'; left.textContent = p.name;
    const right = document.createElement('div'); right.className = 'stats';
    const st = stats[getTrackId(p)] || {};
    const avg = st.sessionCount ? (st.completionSum / st.sessionCount) : 0;
    const percent = st.sessionCount ? Math.round(avg*100) : '-';
    const loud = (typeof st.loudnessDb === 'number') ? `${Math.round(st.loudnessDb)}dB` : '';
    // Calculate gain display in dB
    let gainStr = '';
    if (typeof st.normalizeGain === 'number') {
      const gainDb = 20 * Math.log10(st.normalizeGain);
      const sign = gainDb >= 0 ? '+' : '';
      gainStr = `  增益:${sign}${gainDb.toFixed(1)}dB`;
    }
    right.textContent = `播放:${st.playCount||0}  切歌:${st.skipCount||0}  完播:${percent==='-'?'-':percent+'%'} ${loud}${gainStr}`;
    div.appendChild(left); div.appendChild(right);
    div.onclick = async ()=>{
      if (currentIndex !== -1 && currentIndex !== i && audio.currentTime > 1 && !audio.ended) {
        finalizeSessionForIndex(currentIndex, false);
        incrementSkipCount(playlist[currentIndex]);
      }
      await loadTrack(i);
      play();
      // Skip locateCurrentInPlaylist() when user directly clicks playlist item to avoid redundant scrolling
    };
    playlistEl.appendChild(div);
  }
  if (uiState.playlistCollapsed) playlistEl.classList.add('collapsed'); else playlistEl.classList.remove('collapsed');
  if (sortSelect) sortSelect.value = uiState.sortKey || 'default';
  if (sortDirBtn) sortDirBtn.textContent = uiState.sortDir === 'asc' ? '↑' : '↓';
  if (autoNormalizeCheckbox) autoNormalizeCheckbox.checked = !!uiState.autoNormalize;
}

/* Session & stats */
function startSessionIfNeeded(){
  if (currentIndex === -1) return;
  if (sessionActive && sessionIndex === currentIndex) return;
  sessionActive = true; sessionIndex = currentIndex;
  const s = ensureStatsForTrack(playlist[currentIndex]);
  s.sessionCount = (s.sessionCount||0)+1;
  persistStats();
  renderPlaylist();
}
function finalizeSessionForIndex(idx, isComplete=false){
  if (!sessionActive || sessionIndex !== idx) return;
  const s = ensureStatsForTrack(playlist[idx]);
  let frac = 0;
  if (isComplete) frac = 1.0;
  else if (audio.duration && audio.duration > 0) frac = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
  s.completionSum = (s.completionSum||0) + frac;
  sessionActive = false; sessionIndex = -1;
  persistStats();
  renderPlaylist();
}
function incrementPlayCount(track){ const s = ensureStatsForTrack(track); s.playCount = (s.playCount||0)+1; persistStats(); renderPlaylist(); }
function incrementSkipCount(track){ const s = ensureStatsForTrack(track); s.skipCount = (s.skipCount||0)+1; persistStats(); renderPlaylist(); }

/* Shuffle weight generation */
const BASE = 0.01;
const SKIP_PENALTY = 2.0;
const MIN_COMPLETION = 0.05;
const COMPLETION_WEIGHT = 0.3; // Reduced from 1.0 to 0.3 to lower completion rate impact
function computeWeightForTrack(track){
  const id = getTrackId(track);
  const s = stats[id] || { playCount:0, skipCount:0, sessionCount:0, completionSum:0 };
  const playCount = s.playCount || 0;
  const skipCount = s.skipCount || 0;
  const sessionCount = s.sessionCount || 0;
  const completionSum = s.completionSum || 0;
  const avgCompletion = sessionCount > 0 ? (completionSum / sessionCount) : MIN_COMPLETION;
  
  // Adjust completion factor: use weighted average between 1.0 and avgCompletion
  // This reduces the impact of completion rate on the final weight
  const completionFactor = 1.0 + (Math.max(avgCompletion, MIN_COMPLETION) - 1.0) * COMPLETION_WEIGHT;
  
  const factor = (1 / (1 + playCount)) * (1 / (1 + skipCount * SKIP_PENALTY));
  const w = (BASE + factor) * completionFactor;
  return w;
}
function generateWeightedOrder(startIndex = null){
  const indices = playlist.map((_,i)=>i);
  
  // Filter out tracks that have been played in current session
  const availableIndices = indices.filter(i => {
    const id = getTrackId(playlist[i]);
    return !playedInCurrentSession.has(id);
  });
  
  // If all tracks have been played, reset the session and use all tracks
  let idxs, ws;
  if (availableIndices.length === 0) {
    logDebug('所有歌曲已播放一轮，重置播放会话');
    playedInCurrentSession.clear();
    saveSessionState({ playedInCurrentSession: [] });
    idxs = indices.slice();
    ws = indices.map(i => computeWeightForTrack(playlist[i]));
  } else {
    idxs = availableIndices.slice();
    ws = availableIndices.map(i => computeWeightForTrack(playlist[i]));
  }
  
  const order = [];
  if (typeof startIndex === 'number' && startIndex >= 0){
    const pos = idxs.indexOf(startIndex);
    if (pos !== -1) {
      order.push(startIndex);
      idxs.splice(pos,1);
      ws.splice(pos,1);
    }
  }
  while (idxs.length){
    const total = ws.reduce((a,b)=>a+b,0);
    if (total <= 0){
      order.push(...idxs);
      break;
    }
    let r = Math.random() * total;
    let pick = 0;
    for (let i=0;i<idxs.length;i++){
      r -= ws[i];
      if (r <= 0){
        pick = i;
        break;
      }
    }
    order.push(idxs[pick]);
    idxs.splice(pick,1);
    ws.splice(pick,1);
  }
  return order;
}

/* Normalization plumbing */
function applyCombinedGain(normalizeGain, manualVolumeDb) {
  const ok = ensureAudioGraph(audio);
  if (!ok) return;
  
  // Convert dB to linear gain: gain = 10^(dB/20)
  // This is the inverse of dB = 20*log10(gain)
  const manualGainLinear = Math.pow(10, manualVolumeDb / 20);
  
  // Combine auto-normalize gain with manual volume adjustment
  const combinedGain = normalizeGain * manualGainLinear;
  
  applyGainSmooth(combinedGain);
}

function onTrackLoadedApplyNormalize(track){
  const ok = ensureAudioGraph(audio);
  if (!ok) return;
  
  const id = getTrackId(track);
  const s = stats[id] || {};
  
  // Get the base normalize gain (either from stats or 1.0 if auto-normalize is off)
  let normalizeGain = 1.0;
  if (uiState.autoNormalize && s.normalizeGain != null) {
    normalizeGain = s.normalizeGain;
    applyCombinedGain(normalizeGain, currentManualVolumeDb);
  } else if (uiState.autoNormalize && s.normalizeGain == null) {
    // Need to analyze first
    analyzeAndCacheNormalize(track, stats).then(res=>{
      if (!res) return;
      persistStats();
      if (currentIndex !== -1 && getTrackId(playlist[currentIndex]) === id){
        applyCombinedGain(res.normalizeGain, currentManualVolumeDb);
      }
    }).catch(e=>{
      console.warn('normalize analyze error', e);
    });
    // Apply manual volume with default gain in the meantime
    applyCombinedGain(1.0, currentManualVolumeDb);
  } else {
    // Auto-normalize is off, just apply manual volume
    applyCombinedGain(1.0, currentManualVolumeDb);
  }
}

function updateManualVolume(volumeDb) {
  currentManualVolumeDb = volumeDb;
  
  // Save to current track stats
  if (currentIndex !== -1 && playlist[currentIndex]) {
    const track = playlist[currentIndex];
    const s = ensureStatsForTrack(track);
    s.manualVolumeDb = volumeDb;
    persistStats();
  }
  
  // Apply the new volume
  if (currentIndex !== -1 && playlist[currentIndex]) {
    const track = playlist[currentIndex];
    const id = getTrackId(track);
    const s = stats[id] || {};
    const normalizeGain = (uiState.autoNormalize && s.normalizeGain != null) ? s.normalizeGain : 1.0;
    applyCombinedGain(normalizeGain, volumeDb);
  }
  
  // Update UI
  const sign = volumeDb >= 0 ? '+' : '';
  volumeValueDisplay.textContent = `${sign}${volumeDb.toFixed(1)} dB`;
}

function loadManualVolumeForTrack(track) {
  const id = getTrackId(track);
  const s = stats[id] || {};
  const volumeDb = s.manualVolumeDb ?? 0;
  
  currentManualVolumeDb = volumeDb;
  manualVolumeSlider.value = volumeDb;
  
  const sign = volumeDb >= 0 ? '+' : '';
  volumeValueDisplay.textContent = `${sign}${volumeDb.toFixed(1)} dB`;
}

/* Load / play control (adapted for Electron: path -> file:// via window.api.getFileUrl) */
async function loadTrack(idx){
  if (idx < 0 || idx >= playlist.length) return;
  currentIndex = idx;
  const item = playlist[idx];
  
  // Mark track as played in current session
  const trackId = getTrackId(item);
  if (!playedInCurrentSession.has(trackId)) {
    playedInCurrentSession.add(trackId);
    saveSessionState({ playedInCurrentSession: Array.from(playedInCurrentSession) });
  }
  
  if (item.path && hasElectronApi){
    audio.src = window.api.getFileUrl(item.path);
  } else if (item.fileHandle){
    try {
      const file = await item.fileHandle.getFile();
      if (item._objectUrl) URL.revokeObjectURL(item._objectUrl);
      item._objectUrl = URL.createObjectURL(file);
      item.size = file.size;
      getTrackId(item);
      audio.src = item._objectUrl;
    } catch (e) { console.error('读取文件失败', e); alert('无法读取某个文件（权限/文件损坏），请检查。'); return; }
  } else if (item.url) {
    audio.src = item.url;
  } else if (item.path) {
    // fallback: may be file:// already
    audio.src = item.path;
  }
  currentTitle.textContent = item.name;
  renderPlaylist();
  
  // Load manual volume for this track
  loadManualVolumeForTrack(item);
  
  // Apply normalization and manual volume
  onTrackLoadedApplyNormalize(item);
}

function preparePlayStart(){
  if (!playlist.length) return;
  if (isShuffle) {
    playOrder = generateWeightedOrder(currentIndex >= 0 ? currentIndex : 0);
    orderPos = Math.max(0, playOrder.indexOf(currentIndex >= 0 ? currentIndex : playOrder[0]));
    const idx = playOrder[orderPos];
    loadTrack(idx);
  } else {
    loadTrack(0);
  }
}
function play(){ if (currentIndex === -1 && playlist.length) preparePlayStart(); audio.play(); }
function pause(){ audio.pause(); }

playBtn.onclick = ()=>{ if (!audio.src && playlist.length) preparePlayStart(); if (audio.paused) play(); else pause(); };
audio.onplay = ()=>{ playBtn.innerHTML = '<i class="ri-pause-fill"></i>'; startSessionIfNeeded(); const ac = getAudioContext(); if (ac && ac.state === 'suspended') ac.resume().catch(()=>{}); };
audio.onpause = ()=> playBtn.innerHTML = '<i class="ri-play-fill"></i>';
audio.ontimeupdate = ()=>{ if (audio.duration) { seek.value = (audio.currentTime / audio.duration) * 100; timeEl.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`; } };
seek.oninput = ()=>{ if (audio.duration) audio.currentTime = (seek.value/100) * audio.duration; };

prevBtn.onclick = ()=>{
  if (!playlist.length) return;
  if (isShuffle){
    if (orderPos > 0){
      orderPos = Math.max(0, orderPos - 1);
      const idx = playOrder[orderPos];
      if (currentIndex !== -1 && audio.currentTime > 1 && !audio.ended) { finalizeSessionForIndex(currentIndex,false); incrementSkipCount(playlist[currentIndex]); }
      loadTrack(idx).then(()=> play());
      locateCurrentInPlaylist(); // scroll if expanded, don't auto-expand
    } else {
      orderPos = Math.max(0, playOrder.length - 1);
      const idx = playOrder[orderPos];
      if (currentIndex !== -1 && audio.currentTime > 1 && !audio.ended) { finalizeSessionForIndex(currentIndex,false); incrementSkipCount(playlist[currentIndex]); }
      loadTrack(idx).then(()=> play());
      locateCurrentInPlaylist(); // scroll if expanded, don't auto-expand
    }
  } else {
    const prevIdx = (currentIndex - 1 + playlist.length) % playlist.length;
    if (currentIndex !== -1 && audio.currentTime > 1 && !audio.ended){ finalizeSessionForIndex(currentIndex,false); incrementSkipCount(playlist[currentIndex]); }
    loadTrack(prevIdx).then(()=> play());
    locateCurrentInPlaylist(); // scroll if expanded, don't auto-expand
  }
};

nextBtn.onclick = ()=>{
  if (!playlist.length) return;
  if (currentIndex !== -1 && audio.currentTime > 1 && !audio.ended && !repeatOne){
    finalizeSessionForIndex(currentIndex, false);
    incrementSkipCount(playlist[currentIndex]);
  }
  gotoNext();
};

audio.onended = ()=>{
  if (currentIndex !== -1){
    finalizeSessionForIndex(currentIndex, true);
    incrementPlayCount(playlist[currentIndex]);
  }
  if (repeatOne){
    audio.currentTime = 0;
    play();
    return;
  }
  gotoNext();
};

function gotoNext(){
  if (!playlist.length) return;
  if (isShuffle){
    orderPos++;
    if (orderPos >= playOrder.length){
      playOrder = generateWeightedOrder();
      orderPos = 0;
    }
    const idx = playOrder[orderPos];
    loadTrack(idx).then(()=> play());
    locateCurrentInPlaylist(); // scroll if expanded, don't auto-expand
  } else {
    const nextIdx = (currentIndex + 1) % playlist.length;
    loadTrack(nextIdx).then(()=> play());
    locateCurrentInPlaylist(); // scroll if expanded, don't auto-expand
  }
}

/* Shuffle & Repeat handlers */
shuffleBtn.onclick = ()=>{
  isShuffle = !isShuffle;
  shuffleBtn.style.filter = isShuffle ? 'brightness(1.05)' : '';
  logDebug('Shuffle ' + (isShuffle ? 'ENABLED' : 'DISABLED'));
  if (isShuffle){
    playOrder = generateWeightedOrder(currentIndex >= 0 ? currentIndex : 0);
    if (currentIndex >= 0){
      const pos = playOrder.indexOf(currentIndex);
      orderPos = pos >= 0 ? pos : 0;
    } else orderPos = 0;
  } else {
    playOrder = [];
    orderPos = 0;
  }
};

repeatBtn.onclick = ()=>{
  repeatOne = !repeatOne;
  repeatBtn.style.filter = repeatOne ? 'brightness(1.05)' : '';
  logDebug('Repeat-One ' + (repeatOne ? 'ENABLED' : 'DISABLED'));
};

/* File/Directory functions (Electron-aware) */
function extMatches(name){ return ['.mp3','.m4a'].some(e => name.toLowerCase().endsWith(e)); }
function formatTime(sec){ if (!isFinite(sec)) return '0:00'; sec = Math.floor(sec); const m = Math.floor(sec/60); const s = sec%60; return `${m}:${s.toString().padStart(2,'0')}`; }

function normalizeFilesFromReadResult(files){
  // files from window.api.readDirectory: [{name,path,size}]
  return files.filter(f => extMatches(f.name)).map(f => ({ name: f.name, path: f.path, size: f.size }));
}

/* Persist directory path (use localStorage for cross-platform simplicity) */
function saveDirectoryPath(p){ try { localStorage.setItem('lastDirPath_v1', p); } catch(e){} }
function getStoredDirectoryPath(){ try { return localStorage.getItem('lastDirPath_v1'); } catch(e){ return null; } }
function clearStoredDirectoryPath(){ try { localStorage.removeItem('lastDirPath_v1'); } catch(e){} }

/* choose/refresh/restore */
chooseDirBtn.onclick = async ()=>{
  try {
    if (hasElectronApi){
      const dirPath = await window.api.chooseDirectory();
      if (!dirPath) return;
      currentDirPath = dirPath;
      playlist = [];
      dirStatus.textContent = '加载中…';
      const res = await window.api.readDirectory(dirPath);
      if (!res.ok) { dirStatus.textContent = '读取目录失败: ' + (res.error||''); return; }
      playlist = normalizeFilesFromReadResult(res.files);
      if (!playlist.length) { dirStatus.textContent = '所选目录未包含 mp3 或 m4a 文件。'; renderPlaylist(); return; }
      renderPlaylist(); await loadTrack(0);
      dirStatus.textContent = `已加载 ${playlist.length} 首歌曲（已记住该目录）`;
      saveDirectoryPath(dirPath);
      // start watch
      await window.api.watchDirectory(dirPath);
      window.api.onDirChanged((info) => {
        if (info.dirPath === currentDirPath) {
          dirStatus.textContent = `检测到目录变更（${info.eventType}），刷新中…`;
          setTimeout(()=> refreshDirectory(), 300);
        }
      });
    } else {
      // browser fallback
      if (!window.showDirectoryPicker) { alert('浏览器不支持目录访问，请用 Electron 或 Chromium 并通过本地服务器打开。'); return; }
      const dirHandle = await window.showDirectoryPicker();
      if (!dirHandle) return;
      currentDirPath = dirHandle;
      playlist = [];
      dirStatus.textContent = '加载中…';
      const results = await walkDirectory(dirHandle);
      playlist = results;
      if (!playlist.length) { dirStatus.textContent = '所选目录未包含 mp3 或 m4a 文件。'; renderPlaylist(); return; }
      renderPlaylist(); await loadTrack(0);
      dirStatus.textContent = `已加载 ${playlist.length} 首歌曲（会尝试记住该目录）`;
      try { await idbPut('lastDir', dirHandle); } catch(e){ console.warn(e); }
    }
  } catch (err) { console.error(err); if (err && err.name !== 'AbortError') dirStatus.textContent = '选择目录失败：' + (err.message||err); }
};

refreshBtn.onclick = async ()=> { await refreshDirectory(); };
clearSavedBtn.onclick = async ()=>{
  if (hasElectronApi){
    clearStoredDirectoryPath();
    dirStatus.textContent = '已清除已记住的目录。';
    currentDirPath = null;
  } else {
    await clearStoredDirectoryHandle();
    dirStatus.textContent = '已清除已记住的目录。';
    currentDirPath = null;
  }
};

(async function tryRestoreLastDirectory(){
  applyUIStateToDom();
  if (hasElectronApi){
    const stored = getStoredDirectoryPath();
    if (!stored){ dirStatus.textContent = '尚未记住任何目录，点击“选择 / 更换 文件夹”以开始。'; return; }
    try {
      dirStatus.textContent = '恢复上次目录中…';
      currentDirPath = stored;
      const res = await window.api.readDirectory(stored);
      if (!res.ok){ dirStatus.textContent = '恢复目录失败：' + (res.error||''); return; }
      playlist = normalizeFilesFromReadResult(res.files);
      if (!playlist.length){ dirStatus.textContent = '上次目录中未找到 mp3 / m4a 文件。'; renderPlaylist(); return; }
      renderPlaylist(); await loadTrack(0); dirStatus.textContent = `已恢复上次目录，共 ${playlist.length} 首歌曲。`;
      await window.api.watchDirectory(stored);
      window.api.onDirChanged((info) => {
        if (info.dirPath === currentDirPath){ dirStatus.textContent = `检测到目录变更（${info.eventType}），刷新中…`; setTimeout(()=> refreshDirectory(), 300); }
      });
    } catch (e){ console.error('恢复目录失败', e); dirStatus.textContent = '恢复上次目录失败，请手动重新选择目录。'; }
  } else {
    // browser flow
    applyUIStateToDom();
    if (!window.showDirectoryPicker) { dirStatus.textContent = '当前浏览器不支持记住目录（需要 File System Access API）。'; return; }
    const stored = await getStoredDirectoryHandle();
    if (!stored) { dirStatus.textContent = '尚未记住任何目录，点击“选择 / 更换 文件夹”以开始。'; return; }
    const ok = await verifyPermission(stored);
    if (!ok) { dirStatus.textContent = '已记住目录，但尚未授权读取权限。请点击“选择 / 更换 文件夹”并允许访问以刷新权限。'; return; }
    try {
      dirStatus.textContent = '恢复上次目录中…';
      currentDirPath = stored;
      const results = await walkDirectory(stored);
      playlist = results;
      if (!playlist.length) { dirStatus.textContent = '上次目录中未找到 mp3 / m4a 文件。'; renderPlaylist(); return; }
      renderPlaylist(); await loadTrack(0);
      dirStatus.textContent = `已恢复上次目录，共 ${playlist.length} 首歌曲。`;
    } catch (e) { console.error('恢复目录失败', e); dirStatus.textContent = '恢复上次目录失败，请手动重新选择目录。'; }
  }
})();

async function refreshDirectory(){
  if (!currentDirPath) { dirStatus.textContent = '未选择目录，无法刷新。'; return; }
  dirStatus.textContent = '刷新中…';
  try {
    if (hasElectronApi){
      const res = await window.api.readDirectory(currentDirPath);
      if (!res.ok){ dirStatus.textContent = '刷新失败：' + (res.error||''); return; }
      const newList = normalizeFilesFromReadResult(res.files);
      // maintain current track if possible
      const oldIds = playlist.map(p => getTrackId(p)), oldIdToIndex = {};
      oldIds.forEach((id, idx)=> oldIdToIndex[id] = idx);
      const newIds = newList.map(p => getTrackId(p));
      const added = newIds.filter(id => !oldIdToIndex.hasOwnProperty(id));
      const removed = oldIds.filter(id => !newIds.includes(id));
      let newCurrentIndex = -1;
      if (currentIndex !== -1){
        const curId = getTrackId(playlist[currentIndex]);
        newCurrentIndex = newIds.indexOf(curId);
      }
      playlist = newList;
      if (isShuffle){
        playOrder = generateWeightedOrder(currentIndex >= 0 ? currentIndex : 0);
        orderPos = Math.max(0, playOrder.indexOf(currentIndex >= 0 ? currentIndex : playOrder[0]));
      }
      if (newCurrentIndex !== -1){ await loadTrack(newCurrentIndex); if (!audio.paused) play(); locateCurrentInPlaylist(); } // scroll if expanded, don't auto-expand
      else { if (currentIndex !== -1) { finalizeSessionForIndex(currentIndex,false); audio.pause(); currentIndex = -1; currentTitle.textContent = '（当前曲目已被删除或移动）'; } if (playlist.length) await loadTrack(0); }
      renderPlaylist(); dirStatus.textContent = `刷新完成。新增 ${added.length} / 删除 ${removed.length}。共 ${playlist.length} 首。`;
    } else {
      // browser flow
      const newList = await walkDirectory(currentDirPath);
      // similar merge logic...
      playlist = newList;
      renderPlaylist();
      dirStatus.textContent = `刷新完成，共 ${playlist.length} 首`;
    }
  } catch (e) { console.error('刷新失败', e); dirStatus.textContent = '刷新失败，请重新选择目录或检查权限。'; }
}

/* drag/drop/paste */
document.addEventListener('dragover', e=> e.preventDefault());
document.addEventListener('drop', e=>{ e.preventDefault(); const files = Array.from(e.dataTransfer.files || []); if (!files.length) return; addFilesFromFileList(files); renderPlaylist(); });
document.addEventListener('paste', e=>{ const items = Array.from(e.clipboardData.items || []); const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean); if (files.length) { addFilesFromFileList(files); renderPlaylist(); } });

/* add files helpers */
function addFilesFromFileList(fileList){
  for (const f of fileList) {
    if (!extMatches(f.name)) continue;
    const url = URL.createObjectURL(f);
    const item = { name: f.name, url, size: f.size };
    getTrackId(item);
    playlist.push(item);
  }
  if (playlist.length && currentIndex === -1) loadTrack(0);
  else renderPlaylist();
}
async function addFilesFromHandles(handles){
  for (const h of handles) {
    if (h.kind !== 'file') continue;
    if (!extMatches(h.name)) continue;
    try {
      const file = await h.getFile();
      const item = { name: h.name, path: h.name, fileHandle: h, size: file.size };
      getTrackId(item);
      playlist.push(item);
    } catch (e) { console.error('读取 handle 失败', e); }
  }
  if (playlist.length && currentIndex === -1) await loadTrack(0);
  else renderPlaylist();
}

/* walkDirectory & permission helpers (browser fallback) */
async function walkDirectory(dirHandle, pathPrefix = ''){
  const results = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      if (!extMatches(name)) continue;
      const fullPath = pathPrefix + name;
      try {
        const file = await handle.getFile();
        results.push({ name, path: fullPath, fileHandle: handle, size: file.size });
      } catch (e) { console.error('读取文件失败', e); }
    } else if (handle.kind === 'directory') {
      const nested = await walkDirectory(handle, pathPrefix + name + '/');
      results.push(...nested);
    }
  }
  return results;
}
async function saveDirectoryHandle(handle){ try { await idbPut('lastDir', handle); } catch (e) { console.warn(e); } }
async function getStoredDirectoryHandle(){ try { return await idbGet('lastDir'); } catch (e) { return null; } }
async function clearStoredDirectoryHandle(){ try { await idbDelete('lastDir'); } catch (e) { console.warn(e); } }
async function verifyPermission(handle){
  if (!handle) return false;
  try {
    const opts = { mode: 'read' };
    if (await handle.queryPermission(opts) === 'granted') return true;
    if (await handle.requestPermission(opts) === 'granted') return true;
  } catch (e) { console.warn('verifyPermission', e); }
  return false;
}

/* UI helpers */
function applyUIStateToDom(){
  if (uiState.playlistCollapsed) playlistEl.classList.add('collapsed'); else playlistEl.classList.remove('collapsed');
  if (sortSelect) sortSelect.value = uiState.sortKey || 'default';
  if (sortDirBtn) sortDirBtn.textContent = uiState.sortDir === 'asc' ? '↑' : '↓';
  if (autoNormalizeCheckbox) autoNormalizeCheckbox.checked = !!uiState.autoNormalize;
}
togglePlaylistBtn.onclick = ()=>{ uiState.playlistCollapsed = !uiState.playlistCollapsed; saveUIState(uiState); applyUIStateToDom(); renderPlaylist(); };
locateBtn.onclick = ()=> locateCurrentInPlaylist(true); // explicit user action to expand and locate
function locateCurrentInPlaylist(shouldExpand = false){ 
  if (currentIndex === -1) return; 
  if (shouldExpand && uiState.playlistCollapsed) { 
    uiState.playlistCollapsed = false; 
    saveUIState(uiState); 
    applyUIStateToDom(); 
    requestAnimationFrame(()=> setTimeout(scrollToActiveItem, 180)); 
  } else if (!uiState.playlistCollapsed) {
    scrollToActiveItem(); 
  }
  // If collapsed and shouldExpand is false, do nothing (don't auto-expand)
}
function scrollToActiveItem(){ const selector = `.item[data-index="${currentIndex}"]`; const el = playlistEl.querySelector(selector); if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('locate-highlight'); setTimeout(()=> el.classList.remove('locate-highlight'), 2000); }

/* sort controls / autoNormalize */
if (sortSelect) sortSelect.onchange = ()=>{ uiState.sortKey = sortSelect.value; saveUIState(uiState); renderPlaylist(); };
if (sortDirBtn) sortDirBtn.onclick = ()=>{ uiState.sortDir = (uiState.sortDir === 'asc') ? 'desc' : 'asc'; saveUIState(uiState); applyUIStateToDom(); renderPlaylist(); };
if (autoNormalizeCheckbox) {
  autoNormalizeCheckbox.onchange = ()=>{
    uiState.autoNormalize = !!autoNormalizeCheckbox.checked;
    saveUIState(uiState);
    if (currentIndex !== -1) {
      onTrackLoadedApplyNormalize(playlist[currentIndex]);
    }
  };
  autoNormalizeCheckbox.checked = !!uiState.autoNormalize;
}

/* Manual volume control handlers */
if (manualVolumeSlider) {
  manualVolumeSlider.oninput = () => {
    const volumeDb = parseFloat(manualVolumeSlider.value);
    updateManualVolume(volumeDb);
  };
}

if (resetVolumeBtn) {
  resetVolumeBtn.onclick = () => {
    manualVolumeSlider.value = 0;
    updateManualVolume(0);
  };
}

/* initial apply */
applyUIStateToDom();
renderPlaylist();

/* Auto-updater UI handlers (Electron only) */
if (hasElectronApi && window.api.checkForUpdates) {
  // Setup update event listeners
  window.api.onUpdateChecking(() => {
    console.log('[renderer] Checking for updates...');
    updateMessage.textContent = '正在检查更新...';
    updateNotification.style.display = 'block';
    downloadUpdateBtn.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    updateProgress.style.display = 'none';
  });

  window.api.onUpdateAvailable((info) => {
    console.log('[renderer] Update available:', info.version);
    updateMessage.textContent = `发现新版本 ${info.version}！`;
    downloadUpdateBtn.style.display = 'inline-block';
    installUpdateBtn.style.display = 'none';
    updateProgress.style.display = 'none';
  });

  window.api.onUpdateNotAvailable((info) => {
    console.log('[renderer] No update available. Current version:', info.version);
    updateMessage.textContent = '已是最新版本';
    downloadUpdateBtn.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    updateProgress.style.display = 'none';
    // Auto-hide after 3 seconds
    setTimeout(() => {
      updateNotification.style.display = 'none';
    }, 3000);
  });

  window.api.onUpdateError((err) => {
    console.error('[renderer] Update error:', err);
    updateMessage.textContent = '检查更新失败：' + (err.message || '未知错误');
    downloadUpdateBtn.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    updateProgress.style.display = 'none';
  });

  window.api.onUpdateDownloadProgress((progress) => {
    console.log('[renderer] Download progress:', progress.percent);
    updateProgress.style.display = 'block';
    updateProgressBar.style.width = progress.percent + '%';
    updateProgressText.textContent = Math.round(progress.percent) + '%';
    updateMessage.textContent = `正在下载更新... (${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB)`;
  });

  window.api.onUpdateDownloaded((info) => {
    console.log('[renderer] Update downloaded:', info.version);
    updateMessage.textContent = `新版本 ${info.version} 已下载完成！`;
    downloadUpdateBtn.style.display = 'none';
    installUpdateBtn.style.display = 'inline-block';
    updateProgress.style.display = 'none';
  });

  // Button handlers
  downloadUpdateBtn.onclick = async () => {
    console.log('[renderer] Downloading update...');
    updateMessage.textContent = '开始下载更新...';
    downloadUpdateBtn.disabled = true;
    downloadUpdateBtn.textContent = '下载中...';
    try {
      await window.api.downloadUpdate();
    } catch (err) {
      console.error('[renderer] Download failed:', err);
      updateMessage.textContent = '下载失败：' + (err.message || '未知错误');
      downloadUpdateBtn.disabled = false;
      downloadUpdateBtn.textContent = '重试下载';
    }
  };

  installUpdateBtn.onclick = () => {
    console.log('[renderer] Installing update...');
    window.api.installUpdate();
  };

  dismissUpdateBtn.onclick = () => {
    updateNotification.style.display = 'none';
  };
}

/* Expose internals for debugging */
window.__player = {
  playlist,
  stats,
  uiState,
  getShuffleState: () => ({isShuffle, playOrder: playOrder.slice(), orderPos}),
  getRepeatState: () => repeatOne,
  getSessionState: () => ({
    playedInCurrentSession: Array.from(playedInCurrentSession),
    totalTracks: playlist.length,
    remainingTracks: playlist.length - playedInCurrentSession.size
  }),
  resetSession: () => {
    playedInCurrentSession.clear();
    saveSessionState({ playedInCurrentSession: [] });
    logDebug('播放会话已手动重置');
  },
  regenerateShuffle: () => { if (playlist.length) { playOrder = generateWeightedOrder(currentIndex>=0?currentIndex:0); orderPos = Math.max(0, playOrder.indexOf(currentIndex>=0?currentIndex:playOrder[0])); logDebug('Regenerated playOrder'); renderPlaylist(); } }
};