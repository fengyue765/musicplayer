// main.js — 修复/增强：解决 shuffle 与 repeat-one 行为问题，增加诊断日志与稳健性
// 依赖：storage.js, audioGraph.js, normalize.js（保持原有模块结构）

import { loadStats, saveStats, loadUIState, saveUIState, idbPut, idbGet, idbDelete } from './storage.js';
import { ensureAudioGraph, applyGainSmooth, getAudioContext } from './audioGraph.js';
import { analyzeAndCacheNormalize } from './normalize.js';

/* --- DOM references --- */
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

/* --- State --- */
let playlist = [];
let currentIndex = -1;
let currentDirHandle = null;
let isShuffle = false;
let repeatOne = false;
let playOrder = []; // indices into playlist, used when isShuffle === true
let orderPos = 0;
let uiState = loadUIState();
let stats = loadStats();
let sessionActive = false;
let sessionIndex = -1;

/* --- Helpers --- */
function getTrackId(track){
  if (track.id) return track.id;
  if (typeof track.size === 'number') { track.id = `${track.name}::${track.size}`; }
  else { track.id = track.name; }
  return track.id;
}
function ensureStatsForTrack(track){
  const id = getTrackId(track);
  if (!stats[id]) stats[id] = { playCount:0, skipCount:0, sessionCount:0, completionSum:0, normalizeGain:null, loudnessDb:null };
  return stats[id];
}
function persistStats(){ saveStats(stats); }
function logDebug(...args){
  // 输出到 console 并在 dirStatus 显示短消息（保留最后一行）
  console.debug('[player]', ...args);
  if (dirStatus) {
    dirStatus.textContent = String(args[0]);
  }
}

/* --- Sorting + rendering --- */
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
    right.textContent = `播放:${st.playCount||0}  切歌:${st.skipCount||0}  完播:${percent==='-'?'-':percent+'%'}`;
    div.appendChild(left); div.appendChild(right);
    div.onclick = async ()=>{
      if (currentIndex !== -1 && currentIndex !== i && audio.currentTime > 1 && !audio.ended) {
        finalizeSessionForIndex(currentIndex, false);
        incrementSkipCount(playlist[currentIndex]);
      }
      await loadTrack(i);
      play();
      locateCurrentInPlaylist();
    };
    playlistEl.appendChild(div);
  }
  if (uiState.playlistCollapsed) playlistEl.classList.add('collapsed'); else playlistEl.classList.remove('collapsed');
  if (sortSelect) sortSelect.value = uiState.sortKey || 'default';
  if (sortDirBtn) sortDirBtn.textContent = uiState.sortDir === 'asc' ? '↑' : '↓';
  if (autoNormalizeCheckbox) autoNormalizeCheckbox.checked = !!uiState.autoNormalize;
}

/* --- Session & stats --- */
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

/* --- Shuffle weight generation (unchanged) --- */
const BASE = 0.01;
const SKIP_PENALTY = 2.0;
const MIN_COMPLETION = 0.05;
function computeWeightForTrack(track){
  const id = getTrackId(track);
  const s = stats[id] || { playCount:0, skipCount:0, sessionCount:0, completionSum:0 };
  const playCount = s.playCount || 0;
  const skipCount = s.skipCount || 0;
  const sessionCount = s.sessionCount || 0;
  const completionSum = s.completionSum || 0;
  const avgCompletion = sessionCount > 0 ? (completionSum / sessionCount) : MIN_COMPLETION;
  const factor = (1 / (1 + playCount)) * (1 / (1 + skipCount * SKIP_PENALTY));
  const w = (BASE + factor) * Math.max(avgCompletion, MIN_COMPLETION);
  return w;
}
function generateWeightedOrder(startIndex = null){
  // robust generation: always include all indices and return array of indices
  const indices = playlist.map((_,i)=>i);
  const weights = indices.map(i => computeWeightForTrack(playlist[i]));
  const idxs = indices.slice();
  const ws = weights.slice();
  const order = [];
  // if startIndex provided, ensure it's first in the order (and removed from candidate lists)
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

/* --- Normalization plumbing --- */
function onTrackLoadedApplyNormalize(track){
  if (!uiState.autoNormalize) return;
  // ensure audio graph exists
  const ok = ensureAudioGraph(audio);
  if (!ok) return;
  const id = getTrackId(track);
  const s = stats[id] || {};
  if (s.normalizeGain != null){
    applyGainSmooth(s.normalizeGain);
    return;
  }
  // analyze in background
  analyzeAndCacheNormalize(track, stats).then(res=>{
    if (!res) return;
    persistStats();
    if (currentIndex !== -1 && getTrackId(playlist[currentIndex]) === id){
      applyGainSmooth(res.normalizeGain);
    }
  }).catch(e=>{
    console.warn('normalize analyze error', e);
  });
}

/* --- Load / play control --- */
async function loadTrack(idx){
  if (idx < 0 || idx >= playlist.length) return;
  currentIndex = idx;
  const item = playlist[idx];
  if (item.fileHandle){
    try {
      const file = await item.fileHandle.getFile();
      if (item._objectUrl) URL.revokeObjectURL(item._objectUrl);
      item._objectUrl = URL.createObjectURL(file);
      item.size = file.size;
      getTrackId(item);
      audio.src = item._objectUrl;
    } catch (e) { console.error('读取文件失败', e); alert('无法读取某个文件（权限/文件损坏），请检查。'); return; }
  } else if (item.url) audio.src = item.url;
  currentTitle.textContent = item.name;
  renderPlaylist();
  onTrackLoadedApplyNormalize(item);
}

function preparePlayStart(){
  if (!playlist.length) return;
  if (isShuffle) {
    // regenerate playOrder robustly and align orderPos to currentIndex if present
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
audio.onplay = ()=>{ playBtn.textContent = '⏸'; startSessionIfNeeded(); const ac = getAudioContext(); if (ac && ac.state === 'suspended') ac.resume().catch(()=>{}); };
audio.onpause = ()=> playBtn.textContent = '▶️';
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
      locateCurrentInPlaylist();
    } else {
      // already at start of shuffle order; wrap to last
      orderPos = Math.max(0, playOrder.length - 1);
      const idx = playOrder[orderPos];
      if (currentIndex !== -1 && audio.currentTime > 1 && !audio.ended) { finalizeSessionForIndex(currentIndex,false); incrementSkipCount(playlist[currentIndex]); }
      loadTrack(idx).then(()=> play());
      locateCurrentInPlaylist();
    }
  } else {
    const prevIdx = (currentIndex - 1 + playlist.length) % playlist.length;
    if (currentIndex !== -1 && audio.currentTime > 1 && !audio.ended){ finalizeSessionForIndex(currentIndex,false); incrementSkipCount(playlist[currentIndex]); }
    loadTrack(prevIdx).then(()=> play());
    locateCurrentInPlaylist();
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
    // repeat single track; do not advance orderPos
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
      // reshuffle and start from beginning
      playOrder = generateWeightedOrder();
      orderPos = 0;
    }
    const idx = playOrder[orderPos];
    loadTrack(idx).then(()=> play());
    locateCurrentInPlaylist();
  } else {
    const nextIdx = (currentIndex + 1) % playlist.length;
    loadTrack(nextIdx).then(()=> play());
    locateCurrentInPlaylist();
  }
}

/* --- Shuffle & Repeat button handlers (fixed and more robust) --- */
shuffleBtn.onclick = ()=>{
  isShuffle = !isShuffle;
  shuffleBtn.style.filter = isShuffle ? 'brightness(1.05)' : '';
  logDebug('Shuffle ' + (isShuffle ? 'ENABLED' : 'DISABLED'));
  if (isShuffle){
    // generate new weighted order and align with currentIndex if present
    playOrder = generateWeightedOrder(currentIndex >= 0 ? currentIndex : 0);
    // ensure orderPos points to currentIndex's position in playOrder
    if (currentIndex >= 0){
      const pos = playOrder.indexOf(currentIndex);
      orderPos = pos >= 0 ? pos : 0;
    } else {
      orderPos = 0;
    }
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

/* --- File/Directory functions (unchanged) --- */
function extMatches(name){ return ['.mp3','.m4a'].some(e => name.toLowerCase().endsWith(e)); }
function formatTime(sec){ if (!isFinite(sec)) return '0:00'; sec = Math.floor(sec); const m = Math.floor(sec/60); const s = sec%60; return `${m}:${s.toString().padStart(2,'0')}`; }

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

/* Persist directory handle via IDB */
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

/* choose/refresh/restore */
chooseDirBtn.onclick = async ()=>{
  if (!window.showDirectoryPicker) { alert('您的浏览器不支持目录访问。请使用 Chromium 系浏览器或用拖拽方式添加文件。'); return; }
  try {
    const dirHandle = await window.showDirectoryPicker();
    if (!dirHandle) return;
    currentDirHandle = dirHandle;
    playlist = [];
    dirStatus.textContent = '加载中…';
    const results = await walkDirectory(dirHandle);
    playlist = results;
    if (!playlist.length) { dirStatus.textContent = '所选目录未包含 mp3 或 m4a 文件。'; return; }
    renderPlaylist(); await loadTrack(0);
    dirStatus.textContent = `已加载 ${playlist.length} 首歌曲（已记住该目录）`;
    const ok = await verifyPermission(dirHandle); if (ok) await saveDirectoryHandle(dirHandle);
  } catch (err) { if (err && err.name !== 'AbortError') console.error(err); }
};
refreshBtn.onclick = async ()=> { await refreshDirectory(); };
clearSavedBtn.onclick = async ()=>{ await clearStoredDirectoryHandle(); dirStatus.textContent = '已清除记住的目录。'; currentDirHandle = null; };

(async function tryRestoreLastDirectory(){
  applyUIStateToDom();
  if (!window.showDirectoryPicker) { dirStatus.textContent = '当前浏览器不支持记住目录（需要 File System Access API）。'; return; }
  const stored = await getStoredDirectoryHandle();
  if (!stored) { dirStatus.textContent = '尚未记住任何目录，点击“选择 / 更换 文件夹”以开始。'; return; }
  const ok = await verifyPermission(stored);
  if (!ok) { dirStatus.textContent = '已记住目录，但尚未授权读取权限。请点击“选择 / 更换 文件夹”并允许访问以刷新权限。'; return; }
  try {
    dirStatus.textContent = '恢复上次目录中…';
    currentDirHandle = stored;
    const results = await walkDirectory(stored);
    playlist = results;
    if (!playlist.length) { dirStatus.textContent = '上次目录中未找到 mp3 / m4a 文件。'; return; }
    renderPlaylist(); await loadTrack(0); dirStatus.textContent = `已恢复上次目录，共 ${playlist.length} 首歌曲。`; locateCurrentInPlaylist();
  } catch (e) { console.error('恢复目录失败', e); dirStatus.textContent = '恢复上次目录失败，请手动重新选择目录。'; }
})();

async function refreshDirectory(){
  if (!currentDirHandle) { dirStatus.textContent = '未选择目录，无法刷新。'; return; }
  dirStatus.textContent = '刷新中…';
  try {
    const newList = await walkDirectory(currentDirHandle);
    const oldIds = playlist.map(p => getTrackId(p)), oldIdToIndex = {};
    oldIds.forEach((id, idx)=> oldIdToIndex[id] = idx);
    const newIds = newList.map(p => getTrackId(p));
    const added = newIds.filter(id => !oldIdToIndex.hasOwnProperty(id));
    const removed = oldIds.filter(id => !newIds.includes(id));
    let newCurrentIndex = -1;
    if (currentIndex !== -1) {
      const curId = getTrackId(playlist[currentIndex]);
      newCurrentIndex = newIds.indexOf(curId);
    }
    playlist = newList;
    // If playOrder was active, rebuild it to reflect new playlist size and maintain current
    if (isShuffle) {
      playOrder = generateWeightedOrder(currentIndex >= 0 ? currentIndex : 0);
      // align orderPos to currentIndex if possible
      orderPos = Math.max(0, playOrder.indexOf(currentIndex >= 0 ? currentIndex : playOrder[0]));
    }
    if (newCurrentIndex !== -1) { await loadTrack(newCurrentIndex); if (!audio.paused) play(); locateCurrentInPlaylist(); }
    else { if (currentIndex !== -1) { finalizeSessionForIndex(currentIndex,false); audio.pause(); currentIndex = -1; currentTitle.textContent = '（当前曲目已被删除或移动）'; } if (playlist.length) await loadTrack(0); }
    renderPlaylist(); dirStatus.textContent = `刷新完成。新增 ${added.length} / 删除 ${removed.length}。共 ${playlist.length} 首。`;
  } catch (e) { console.error('刷新失败', e); dirStatus.textContent = '刷新失败，请重新选择目录或检查权限。'; }
}

/* drag & drop & paste */
document.addEventListener('dragover', e=> e.preventDefault());
document.addEventListener('drop', e=>{ e.preventDefault(); const files = Array.from(e.dataTransfer.files || []); if (!files.length) return; addFilesFromFileList(files); renderPlaylist(); });
document.addEventListener('paste', e=>{ const items = Array.from(e.clipboardData.items || []); const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean); if (files.length) { addFilesFromFileList(files); renderPlaylist(); } });

/* UI helpers */
function applyUIStateToDom(){
  if (uiState.playlistCollapsed) playlistEl.classList.add('collapsed'); else playlistEl.classList.remove('collapsed');
  if (sortSelect) sortSelect.value = uiState.sortKey || 'default';
  if (sortDirBtn) sortDirBtn.textContent = uiState.sortDir === 'asc' ? '↑' : '↓';
  if (autoNormalizeCheckbox) autoNormalizeCheckbox.checked = !!uiState.autoNormalize;
}
togglePlaylistBtn.onclick = ()=>{ uiState.playlistCollapsed = !uiState.playlistCollapsed; saveUIState(uiState); applyUIStateToDom(); renderPlaylist(); };
locateBtn.onclick = ()=> locateCurrentInPlaylist();
function locateCurrentInPlaylist(){ if (currentIndex === -1) return; if (uiState.playlistCollapsed) { uiState.playlistCollapsed = false; saveUIState(uiState); applyUIStateToDom(); requestAnimationFrame(()=> setTimeout(scrollToActiveItem, 180)); } else scrollToActiveItem(); }
function scrollToActiveItem(){ const selector = `.item[data-index="${currentIndex}"]`; const el = playlistEl.querySelector(selector); if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('locate-highlight'); setTimeout(()=> el.classList.remove('locate-highlight'), 2000); }

/* sort controls */
if (sortSelect) sortSelect.onchange = ()=>{ uiState.sortKey = sortSelect.value; saveUIState(uiState); renderPlaylist(); };
if (sortDirBtn) sortDirBtn.onclick = ()=>{ uiState.sortDir = (uiState.sortDir === 'asc') ? 'desc' : 'asc'; saveUIState(uiState); applyUIStateToDom(); renderPlaylist(); };

/* autoNormalize control */
if (autoNormalizeCheckbox) {
  autoNormalizeCheckbox.onchange = ()=>{
    uiState.autoNormalize = !!autoNormalizeCheckbox.checked;
    saveUIState(uiState);
    if (!uiState.autoNormalize) { try { applyGainSmooth(1.0); } catch(e){} } else { if (currentIndex !== -1) onTrackLoadedApplyNormalize(playlist[currentIndex]); }
  };
  autoNormalizeCheckbox.checked = !!uiState.autoNormalize;
}

/* initial apply */
applyUIStateToDom();
renderPlaylist();

/* Expose some internals for debugging */
window.__player = {
  playlist,
  stats,
  uiState,
  getShuffleState: () => ({isShuffle, playOrder: playOrder.slice(), orderPos}),
  getRepeatState: () => repeatOne,
  regenerateShuffle: () => { if (playlist.length) { playOrder = generateWeightedOrder(currentIndex>=0?currentIndex:0); orderPos = Math.max(0, playOrder.indexOf(currentIndex>=0?currentIndex:playOrder[0])); logDebug('Regenerated playOrder'); renderPlaylist(); } }
};