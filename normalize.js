// normalize.js — analyze audio loudness (RMS) and compute normalize gain; caches to stats object
import { getAudioContext } from './audioGraph.js';

const TARGET_DB = -20;
const MIN_GAIN = 0.5;
const MAX_GAIN = 2.5;

function computeRmsDbFromAudioBuffer(audioBuffer){
  const channelCount = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const maxSamples = 300000;
  const step = Math.max(1, Math.floor(length / maxSamples));
  let sumSquares = 0;
  let count = 0;
  for (let ch = 0; ch < channelCount; ch++){
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += step){
      const v = data[i];
      sumSquares += v * v;
      count++;
    }
  }
  const meanSquare = count ? (sumSquares / count) : 0;
  const rms = Math.sqrt(meanSquare);
  const db = rms > 0 ? (20 * Math.log10(rms)) : -Infinity;
  return { rms, db };
}

export async function analyzeAndCacheNormalize(track, stats) {
  const id = track.id || `${track.name}::${track.size || 0}`;
  if (stats[id] && stats[id].normalizeGain != null && stats[id].loudnessDb != null) return stats[id];
  try {
    let arrayBuffer = null;
    if (track.fileHandle) {
      const file = await track.fileHandle.getFile();
      arrayBuffer = await file.arrayBuffer();
    } else if (track.url) {
      const resp = await fetch(track.url);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      return null;
    }
    // Use OfflineAudioContext if available for decoding
    const OfflineCtx = window.OfflineAudioContext || window.AudioContext;
    const decodeCtx = new OfflineCtx(1, 1, 44100);
    let audioBuffer = null;
    try {
      audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (e) {
      const ac = getAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
      audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
    }
    const { rms, db } = computeRmsDbFromAudioBuffer(audioBuffer);
    const measuredDb = isFinite(db) ? db : -100;
    let gainDb = TARGET_DB - measuredDb;
    const maxGainDb = 12;
    const minGainDb = -12;
    gainDb = Math.max(minGainDb, Math.min(maxGainDb, gainDb));
    let gainLinear = Math.pow(10, gainDb / 20);
    gainLinear = Math.max(MIN_GAIN, Math.min(MAX_GAIN, gainLinear));
    if (!stats[id]) stats[id] = { playCount:0, skipCount:0, sessionCount:0, completionSum:0 };
    stats[id].normalizeGain = gainLinear;
    stats[id].loudnessDb = measuredDb;
    return stats[id];
  } catch (e) {
    console.warn('analyzeAndCacheNormalize failed', track.name, e);
    return null;
  }
}