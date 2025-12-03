// audioGraph.js — WebAudio graph and gain application for normalization
let audioCtx = null;
let sourceNode = null;
let gainNode = null;
let analyserNode = null;
let initialized = false;

export function ensureAudioGraph(audioElement) {
  if (initialized) return true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audioElement);
    gainNode = audioCtx.createGain();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    sourceNode.connect(gainNode);
    gainNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);
    initialized = true;
    return true;
  } catch (e) {
    console.warn('ensureAudioGraph failed', e);
    return false;
  }
}

export function getAudioContext() { return audioCtx; }
export function getGainNode() { return gainNode; }

export function applyGainSmooth(targetGain, smoothTime = 0.15) {
  if (!initialized || !gainNode) return;
  try {
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value || 1.0, now);
    gainNode.gain.setTargetAtTime(targetGain, now, smoothTime);
  } catch (e) {
    try { gainNode.gain.value = targetGain; } catch (er) { /* ignore */ }
  }
}