export interface MusicalKeyInfo {
  keyIndex: number; // 0=C, 1=C#, ... 11=B
  mode: 'major' | 'minor';
  label: string; // e.g. 'Am', 'C', 'F#m'
  camelot: string; // e.g. '8A', '8B'
  confidence: number; // 0..1
}

export interface BarRhythmProfile {
  downbeatIndex: number; // 0..3 beat index within detected 4-beat bar corresponding to Bar 1 Beat 1
  downbeatMs: number;
  kickBarEnergy: [number, number, number, number]; // Normalized low-band kick energy per beat [0..3]
  snareBarEnergy: [number, number, number, number]; // Normalized mid/high-band backbeat energy per beat [0..3]
  onsetBodyBeatIndex: number; // First beat index where full rhythmic groove stabilizes
}

export interface RhythmicStartMatch {
  startBeatOffset: number; // Beat offset in target track that aligns 100% onto reference Beat 1
  anchorMs: number;
  tempoMultiplier: 0.5 | 1 | 2;
  matchScorePct: number;
}

export interface AnalyzedTrackData {
  name: string;
  durationSec: number;
  sampleRate: number;
  detectedBpm: number;
  exactBpm: number;
  firstTransientMs: number;
  beatTimesSec: number[];
  isConstantTempo: boolean;
  gridResidualMs: number;
  barRhythm: BarRhythmProfile;
  musicalKey: MusicalKeyInfo;
  peaks: Float32Array;
  peakSamplesPerSec: number;
}

/**
 * Downsamples mono PCM samples into a signed max-magnitude peak envelope
 * at a fixed resolution (default 400 peaks/sec = 2.5 ms per bin) for crisp canvas rendering.
 */
export function computeWaveformPeaks(
  samples: Float32Array,
  sampleRate: number,
  peakSamplesPerSec = 400
): Float32Array {
  if (samples.length === 0 || sampleRate <= 0) return new Float32Array(0);
  const durationSec = samples.length / sampleRate;
  const totalBins = Math.max(1, Math.ceil(durationSec * peakSamplesPerSec));
  const samplesPerBin = samples.length / totalBins;
  const peaks = new Float32Array(totalBins);

  for (let b = 0; b < totalBins; b++) {
    const start = Math.floor(b * samplesPerBin);
    const end = Math.min(samples.length, Math.floor((b + 1) * samplesPerBin));
    let maxVal = 0;
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > Math.abs(maxVal)) {
        maxVal = samples[i];
      }
    }
    peaks[b] = maxVal;
  }
  return peaks;
}

/**
 * 2nd-order Butterworth low-pass filter at cutoffHz (default 160 Hz) to isolate
 * kick drum & sub-bass energy from hi-hats, snares, vocals, and pads.
 */
export function lowPassFilter(
  samples: Float32Array,
  sampleRate: number,
  cutoffHz = 160
): Float32Array {
  if (samples.length === 0 || sampleRate <= cutoffHz * 2) return samples;
  const out = new Float32Array(samples.length);
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const sinO = Math.sin(omega);
  const cosO = Math.cos(omega);
  const alpha = sinO / Math.SQRT2;

  const b0 = (1 - cosO) / 2;
  const b1 = 1 - cosO;
  const b2 = (1 - cosO) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosO;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * Zero-phase forward-backward Butterworth low-pass filter (filtfilt).
 * Eliminates 100% of filter group delay so kick peaks align sample-accurately
 * without interference from hi-hats, snares, or vocals.
 */
export function zeroPhaseLowPassFilter(
  samples: Float32Array,
  sampleRate: number,
  cutoffHz = 165
): Float32Array {
  const fwd = lowPassFilter(samples, sampleRate, cutoffHz);
  if (fwd.length === 0 || sampleRate <= cutoffHz * 2) return fwd;

  const revIn = new Float32Array(fwd.length);
  for (let i = 0; i < fwd.length; i++) {
    revIn[i] = fwd[fwd.length - 1 - i];
  }
  const revOut = lowPassFilter(revIn, sampleRate, cutoffHz);
  const out = new Float32Array(revOut.length);
  for (let i = 0; i < revOut.length; i++) {
    out[i] = revOut[revOut.length - 1 - i];
  }
  return out;
}

/**
 * Estimates exact sub-sample kick onset timestamp (in seconds) around a verified
 * low-band kick peak by isolating < 580 Hz energy locally (suppressing 1-8 kHz
 * hats/claps/pads while keeping impulse width < 0.5 ms) and extrapolating the
 * 20%-to-60% rising edge back down to the pre-kick floor for <= 0.2 ms precision.
 */
function extrapolateRawKickOnsetSec(
  samples: Float32Array,
  sampleRate: number,
  lowPeakIdx: number
): number {
  const n = samples.length;
  if (n < 4 || sampleRate <= 0) return Math.max(0, lowPeakIdx / Math.max(1, sampleRate));

  const s0 = Math.max(0, lowPeakIdx - Math.floor(sampleRate * 0.045));
  const s1 = Math.min(n, lowPeakIdx + Math.floor(sampleRate * 0.02));
  const localSlice = samples.subarray(s0, s1);
  const cutoff = Math.min(580, sampleRate * 0.42);
  const localLow = zeroPhaseLowPassFilter(localSlice, sampleRate, cutoff);
  const offsetInSlice = lowPeakIdx - s0;

  // Scan [-28 ms, +4 ms] around lowPeakIdx so 165 Hz low-pass lag never clips the first cycle
  const wS = Math.max(0, offsetInSlice - Math.floor(sampleRate * 0.028));
  const wE = Math.min(localLow.length - 1, offsetInSlice + Math.floor(sampleRate * 0.004));
  let maxEnv = 0;
  for (let i = wS; i <= wE; i++) {
    const a = Math.abs(localLow[i]);
    if (a > maxEnv) maxEnv = a;
  }

  // Estimate pre-kick floor in [-30 ms, -12 ms], or initial ~0.25 ms if kick begins right at t=0
  let floorAmp = 0;
  if (s0 + wS <= Math.floor(sampleRate * 0.002)) {
    let minHead = Infinity;
    const headEnd = Math.min(localLow.length, Math.max(4, Math.floor(sampleRate * 0.0003)));
    for (let i = 0; i < headEnd; i++) {
      minHead = Math.min(minHead, Math.abs(localLow[i]));
    }
    floorAmp = Number.isFinite(minHead) ? minHead : 0;
  } else {
    const flS = Math.max(0, offsetInSlice - Math.floor(sampleRate * 0.03));
    const flE = Math.max(0, offsetInSlice - Math.floor(sampleRate * 0.012));
    if (flE - flS >= 8) {
      const preVals: number[] = [];
      const stride = Math.max(1, Math.floor((flE - flS) / 64));
      for (let i = flS; i < flE; i += stride) {
        preVals.push(Math.abs(localLow[i]));
      }
      preVals.sort((a, b) => a - b);
      floorAmp = preVals[Math.min(preVals.length - 1, Math.floor(preVals.length * 0.65))];
    }
  }

  const totalRise = maxEnv - floorAmp;
  if (totalRise <= 0.004) return Math.max(0, lowPeakIdx / sampleRate);

  const triggerAmp = floorAmp + totalRise * 0.25;
  let triggerIdx = -1;
  for (let i = wS; i <= wE; i++) {
    if (Math.abs(localLow[i]) >= triggerAmp) {
      triggerIdx = i;
      break;
    }
  }
  if (triggerIdx < 0) return Math.max(0, lowPeakIdx / sampleRate);

  let localPeakIdx = triggerIdx;
  let localPeakAmp = Math.abs(localLow[triggerIdx]);
  const peakLookLimit = Math.min(wE, triggerIdx + Math.round(sampleRate * 0.005));
  const minDropSpan = Math.max(3, Math.round(sampleRate * 0.0003));
  for (let i = triggerIdx + 1; i <= peakLookLimit; i++) {
    const a = Math.abs(localLow[i]);
    if (a >= localPeakAmp) {
      localPeakAmp = a;
      localPeakIdx = i;
    } else if (i - localPeakIdx >= minDropSpan && a < localPeakAmp * 0.92) {
      break;
    }
  }

  const rise = localPeakAmp - floorAmp;
  if (rise <= 0.004) return Math.max(0, (s0 + triggerIdx) / sampleRate);

  const thresh60 = floorAmp + rise * 0.6;
  const thresh20 = floorAmp + rise * 0.2;

  let i60 = localPeakIdx;
  while (i60 > wS && Math.abs(localLow[i60]) > thresh60) i60--;
  let i20 = i60;
  while (i20 > wS && Math.abs(localLow[i20]) > thresh20) i20--;

  const interpSampleTime = (idx: number, target: number): number => {
    const v0 = Math.abs(localLow[idx]);
    const v1 = Math.abs(localLow[Math.min(localLow.length - 1, idx + 1)]);
    const denom = v1 - v0;
    const sub = Math.abs(denom) > 1e-9 ? Math.max(0, Math.min(1, (target - v0) / denom)) : 0;
    return (s0 + idx + sub) / sampleRate;
  };

  const t60 = interpSampleTime(i60, thresh60);
  const t20 = interpSampleTime(i20, thresh20);
  const dt = t60 - t20;
  if (dt > 1e-6) {
    const slope = (thresh60 - thresh20) / dt;
    return Math.max(0, t20 - (thresh20 - floorAmp) / slope);
  }
  return Math.max(0, t20);
}

/**
 * Multi-beat folded kick onset refiner: averages < 580 Hz kick waveforms across verified beats
 * at 0.025 ms (25 µs) resolution so hi-hats/synths/claps cancel and Beat 1 snaps within <= 0.2 ms.
 */
function computeFoldedKickOffsetSec(
  samples: Float32Array,
  sampleRate: number,
  beatAnchorsSec: number[]
): number {
  if (beatAnchorsSec.length === 0 || samples.length < 16 || sampleRate <= 0) return 0;

  const halfWinSec = 0.018;
  const binSec = 0.000025; // 25 microseconds
  const binCount = Math.round((halfWinSec * 2) / binSec) + 1;
  const folded = new Float32Array(binCount);
  const n = samples.length;
  let usedBeats = 0;

  // Coherent phase-aligned averaging on locally filtered (< 580 Hz) beats cancels HF instruments
  const cutoff = Math.min(580, sampleRate * 0.42);
  const padSec = 0.022;
  const padSamples = Math.floor(sampleRate * padSec);
  const halfSamples = Math.floor(sampleRate * halfWinSec);

  const step = Math.max(1, Math.floor(beatAnchorsSec.length / 64));
  for (let idx = 0; idx < beatAnchorsSec.length; idx += step) {
    const tCenter = beatAnchorsSec[idx];
    if (tCenter < 0 || tCenter * sampleRate >= n - 2) continue;
    const centerS = Math.round(tCenter * sampleRate);
    const s0 = Math.max(0, centerS - halfSamples - padSamples);
    const s1 = Math.min(n, centerS + halfSamples + padSamples);
    if (s1 - s0 < 16) continue;
    const localLow = zeroPhaseLowPassFilter(samples.subarray(s0, s1), sampleRate, cutoff);

    for (let b = 0; b < binCount; b++) {
      const tau = -halfWinSec + b * binSec;
      const samplePos = (tCenter + tau) * sampleRate - s0;
      if (samplePos >= 0 && samplePos < localLow.length - 1) {
        const i0 = samplePos | 0;
        const frac = samplePos - i0;
        folded[b] += Math.abs(localLow[i0] + frac * (localLow[i0 + 1] - localLow[i0]));
      }
    }
    usedBeats++;
  }

  if (usedBeats === 0) return 0;
  for (let b = 0; b < binCount; b++) {
    folded[b] /= usedBeats;
  }

  // Light 3-tap symmetric smoothing (0.05 ms span) to suppress residual HF aliasing
  const smooth = new Float32Array(binCount);
  smooth[0] = folded[0];
  smooth[binCount - 1] = folded[binCount - 1];
  for (let b = 1; b < binCount - 1; b++) {
    smooth[b] = 0.25 * folded[b - 1] + 0.5 * folded[b] + 0.25 * folded[b + 1];
  }

  // Floor estimated in [-18 ms, -4 ms]
  const floorEndBin = Math.floor((halfWinSec - 0.004) / binSec);
  const preVals: number[] = [];
  for (let b = 0; b < floorEndBin; b += 4) {
    preVals.push(smooth[b]);
  }
  preVals.sort((a, b) => a - b);
  const floorAmp =
    preVals.length > 0 ? preVals[Math.min(preVals.length - 1, Math.floor(preVals.length * 0.65))] : 0;

  let maxAmp = 0;
  const searchStartBin = Math.floor((halfWinSec - 0.008) / binSec);
  const searchEndBin = Math.min(binCount - 1, Math.floor((halfWinSec + 0.014) / binSec));
  for (let b = searchStartBin; b <= searchEndBin; b++) {
    if (smooth[b] > maxAmp) maxAmp = smooth[b];
  }

  const totalRise = maxAmp - floorAmp;
  if (totalRise <= 0.004) return 0;

  const triggerAmp = floorAmp + totalRise * 0.25;
  let triggerBin = -1;
  for (let b = searchStartBin; b <= searchEndBin; b++) {
    if (smooth[b] >= triggerAmp) {
      triggerBin = b;
      break;
    }
  }
  if (triggerBin < 0) return 0;

  let localPeakBin = triggerBin;
  let localPeakAmp = smooth[triggerBin];
  const peakLookLimit = Math.min(searchEndBin, triggerBin + Math.round(0.005 / binSec));
  for (let b = triggerBin + 1; b <= peakLookLimit; b++) {
    if (smooth[b] >= localPeakAmp) {
      localPeakAmp = smooth[b];
      localPeakBin = b;
    } else if (b - localPeakBin >= 8 && smooth[b] < localPeakAmp * 0.92) {
      break;
    }
  }

  const rise = localPeakAmp - floorAmp;
  if (rise <= 0.004) return 0;

  const thresh60 = floorAmp + rise * 0.6;
  const thresh20 = floorAmp + rise * 0.2;

  let b60 = localPeakBin;
  while (b60 > 0 && smooth[b60] > thresh60) b60--;
  let b20 = b60;
  while (b20 > 0 && smooth[b20] > thresh20) b20--;

  const interpTau = (bin: number, target: number): number => {
    if (bin >= binCount - 1) return -halfWinSec + bin * binSec;
    const v0 = smooth[bin];
    const v1 = smooth[bin + 1];
    const denom = v1 - v0;
    const sub = Math.abs(denom) > 1e-9 ? Math.max(0, Math.min(1, (target - v0) / denom)) : 0;
    return -halfWinSec + (bin + sub) * binSec;
  };

  const tau60 = interpTau(b60, thresh60);
  const tau20 = interpTau(b20, thresh20);
  const dt = tau60 - tau20;
  let deltaSec = tau20;
  if (dt > 1e-6) {
    const slope = (thresh60 - thresh20) / dt;
    deltaSec = tau20 - (thresh20 - floorAmp) / slope;
  }

  return Math.max(-0.014, Math.min(0.014, deltaSec));
}

/**
 * Finds the first true kick/beat transient onset in milliseconds with <= 0.2 ms accuracy,
 * skipping leading encoder silence or ambient high-frequency intros.
 */
export function detectFirstTransientMs(
  samples: Float32Array,
  sampleRate: number
): number {
  if (samples.length === 0 || sampleRate <= 0) return 0;

  const scanLen = Math.min(samples.length, Math.floor(sampleRate * 16));
  const slice = samples.subarray(0, scanLen);
  const low = zeroPhaseLowPassFilter(slice, sampleRate, 180);

  let globalMax = 0;
  for (let i = 0; i < low.length; i++) {
    const abs = Math.abs(low[i]);
    if (abs > globalMax) globalMax = abs;
  }

  if (globalMax < 0.003) return 0;

  const onsetThreshold = globalMax * 0.25;
  let onsetIdx = -1;
  for (let i = 0; i < low.length; i++) {
    if (Math.abs(low[i]) >= onsetThreshold) {
      onsetIdx = i;
      break;
    }
  }

  if (onsetIdx < 0) return 0;

  const peakWindow = Math.min(low.length, onsetIdx + Math.floor(sampleRate * 0.02));
  let lowPeakIdx = onsetIdx;
  let lowPeakVal = 0;
  for (let i = onsetIdx; i < peakWindow; i++) {
    const abs = Math.abs(low[i]);
    if (abs > lowPeakVal) {
      lowPeakVal = abs;
      lowPeakIdx = i;
    }
  }

  const exactSec = extrapolateRawKickOnsetSec(slice, sampleRate, lowPeakIdx);
  return Number((exactSec * 1000).toFixed(2));
}

/**
 * Builds a 1000 Hz (1 ms resolution) low-band onset flux envelope for Serato-grade
 * kick transient & BPM analysis. Uses a 22 ms RMS window (>1 cycle at 50 Hz) + 6 ms
 * baseline step so sustained 70-110 Hz basslines cancel cleanly without comb ripple.
 */
function buildLowBandOnsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
  startSec = 0,
  maxAnalyzeSec = 60
): { flux: Float32Array; envRate: number; startOffsetSec: number } {
  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const maxSamples = Math.min(samples.length, startSample + Math.floor(sampleRate * maxAnalyzeSec));
  const slice = samples.subarray(startSample, maxSamples);

  const low = lowPassFilter(slice, sampleRate, 170);
  const targetEnvRate = 1000;
  const hop = Math.max(1, Math.round(sampleRate / targetEnvRate));
  const envRate = sampleRate / hop;
  const frameCount = Math.floor(low.length / hop);
  const flux = new Float32Array(frameCount);

  if (frameCount < 200) {
    return { flux, envRate, startOffsetSec: startSample / sampleRate };
  }

  // Compute prefix sum of squares for O(N) 22 ms RMS window (cancels 50-120 Hz bass ripple)
  const sqPrefix = new Float64Array(low.length + 1);
  for (let i = 0; i < low.length; i++) {
    const s = low[i];
    sqPrefix[i + 1] = sqPrefix[i] + s * s;
  }

  const winSize = Math.max(hop, Math.floor(sampleRate * 0.022));
  const energies = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const base = f * hop;
    const end = Math.min(low.length, base + winSize);
    const len = Math.max(1, end - base);
    energies[f] = Math.sqrt((sqPrefix[end] - sqPrefix[base]) / len);
  }

  const diffStep = 6; // 6 ms onset rise span
  for (let f = diffStep; f < frameCount; f++) {
    const diff = energies[f] - energies[f - diffStep];
    flux[f] = diff > 0 ? diff : 0;
  }

  return { flux, envRate, startOffsetSec: startSample / sampleRate };
}

/**
 * Estimates track BPM to 0.01 BPM precision using low-band 1 ms onset comb autocorrelation
 * and global phase-slope refinement.
 */
export function estimateBpm(samples: Float32Array, sampleRate: number): number {
  return analyzeBeatGrid(samples, sampleRate).bpm;
}

/**
 * Serato-style full-song beatgrid analyzer:
 * 1. Filters PCM to < 170 Hz to isolate kick drums from vocals/pads/hats.
 * 2. Skips quiet ambient intros to analyze the active percussion body.
 * 3. Evaluates top harmonic comb autocorrelation candidates against real kick regression (70-175 BPM).
 * 4. Uses global phase folding + sub-sample kick onset extrapolation (<= 0.2 ms lock).
 * 5. Tracks every kick beat across the ENTIRE song duration (preserving dynamic grids on drifting tracks).
 */
export function analyzeBeatGrid(
  samples: Float32Array,
  sampleRate: number
): {
  bpm: number;
  exactBpm: number;
  firstTransientMs: number;
  beatTimesSec: number[];
  isConstantTempo: boolean;
  gridResidualMs: number;
  barRhythm: BarRhythmProfile;
  musicalKey: MusicalKeyInfo;
} {
  const durationSec = sampleRate > 0 ? samples.length / sampleRate : 0;
  const fallbackTransientMs = detectFirstTransientMs(samples, sampleRate);
  const musicalKey = detectMusicalKey(samples, sampleRate);
  const defaultBarRhythm: BarRhythmProfile = {
    downbeatIndex: 0,
    downbeatMs: fallbackTransientMs,
    kickBarEnergy: [0.25, 0.25, 0.25, 0.25],
    snareBarEnergy: [0.1, 0.4, 0.1, 0.4],
    onsetBodyBeatIndex: 0,
  };

  if (samples.length < sampleRate * 0.9 || sampleRate <= 0) {
    return {
      bpm: 120.0,
      exactBpm: 120.0,
      firstTransientMs: fallbackTransientMs,
      beatTimesSec: [fallbackTransientMs / 1000],
      isConstantTempo: true,
      gridResidualMs: 0,
      barRhythm: defaultBarRhythm,
      musicalKey,
    };
  }

  // Locate first active low-band body if song opens with a long ambient/beatless intro
  const lowScanLimit = Math.min(samples.length, Math.floor(sampleRate * 90));
  const lowBodyPreview = zeroPhaseLowPassFilter(samples.subarray(0, lowScanLimit), sampleRate, 170);
  let bodyMaxAmp = 0;
  for (let i = 0; i < lowBodyPreview.length; i += 8) {
    const a = Math.abs(lowBodyPreview[i]);
    if (a > bodyMaxAmp) bodyMaxAmp = a;
  }
  let bodyStartSec = Math.max(0, fallbackTransientMs / 1000 - 0.05);
  if (bodyMaxAmp > 0.005) {
    const bodyGate = bodyMaxAmp * 0.35;
    for (let i = 0; i < lowBodyPreview.length; i += Math.max(1, Math.floor(sampleRate * 0.02))) {
      if (Math.abs(lowBodyPreview[i]) >= bodyGate) {
        bodyStartSec = Math.max(0, i / sampleRate - 0.05);
        break;
      }
    }
  }

  const { flux, envRate, startOffsetSec } = buildLowBandOnsetEnvelope(
    samples,
    sampleRate,
    bodyStartSec,
    60
  );
  const frameCount = flux.length;

  if (frameCount < 400) {
    return {
      bpm: 120.0,
      exactBpm: 120.0,
      firstTransientMs: fallbackTransientMs,
      beatTimesSec: [fallbackTransientMs / 1000],
      isConstantTempo: true,
      gridResidualMs: 0,
      barRhythm: defaultBarRhythm,
      musicalKey,
    };
  }

  // 1. Harmonic comb autocorrelation across 70-175 BPM at 1-frame resolution
  const minLag = Math.max(100, Math.floor((60 / 175) * envRate));
  const maxLag = Math.min(Math.floor(frameCount * 0.62), Math.ceil((60 / 70) * envRate));

  const acfScore = (lag: number): number => {
    if (lag >= frameCount) return 0;
    let score = 0;
    let count = 0;
    for (let i = 0; i < frameCount - lag; i += 2) {
      if (flux[i] > 0) {
        score += flux[i] * flux[i + lag];
      }
      count++;
    }
    return count > 0 ? score / count : 0;
  };

  const combScores = new Float32Array(maxLag + 1);
  let bestCombScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s1 = acfScore(lag);
    const s2 = lag * 2 < frameCount ? acfScore(lag * 2) : 0;
    const s4 = lag * 4 < frameCount ? acfScore(lag * 4) : 0;
    // Require genuine beat-to-beat kick energy (s1) so 2x phantom sub-lags cannot hijack 70-88 BPM tracks
    const h2 = Math.min(s1 * 1.25, s2) * 0.75;
    const h4 = Math.min(s1 * 1.25, s4) * 0.5;
    const candidateBpm = (60 * envRate) / lag;
    const octaveBias = candidateBpm >= 90 && candidateBpm <= 155 ? 1.12 : 0.96;
    const sc = (s1 + h2 + h4) * octaveBias;
    combScores[lag] = sc;
    if (sc > bestCombScore) bestCombScore = sc;
  }

  if (bestCombScore <= 0) {
    return {
      bpm: 120.0,
      exactBpm: 120.0,
      firstTransientMs: fallbackTransientMs,
      beatTimesSec: [fallbackTransientMs / 1000],
      isConstantTempo: true,
      gridResidualMs: 0,
      barRhythm: defaultBarRhythm,
      musicalKey,
    };
  }

  // Collect top-3 distinct local peaks in combScores (plus octave halfLag if < 95 BPM)
  const lagPeaks: { lag: number; score: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const cur = combScores[lag];
    const prev = lag > minLag ? combScores[lag - 1] : 0;
    const next = lag < maxLag ? combScores[lag + 1] : 0;
    if (cur >= prev && cur >= next && cur > 0) {
      lagPeaks.push({ lag, score: cur });
    }
  }
  lagPeaks.sort((a, b) => b.score - a.score);

  const candidateLags: number[] = [];
  for (const p of lagPeaks) {
    if (candidateLags.every((c) => Math.abs(c - p.lag) >= 8)) {
      candidateLags.push(p.lag);
      if (candidateLags.length >= 3) break;
    }
  }
  if (candidateLags.length === 0) {
    candidateLags.push(Math.round((60 / 120) * envRate));
  }
  // Also include octave-doubled tempo if top lag is < 95 BPM
  if ((60 * envRate) / candidateLags[0] < 95) {
    const halfLag = Math.round(candidateLags[0] / 2);
    if (
      halfLag >= minLag &&
      acfScore(halfLag) >= acfScore(candidateLags[0]) * 0.5 &&
      candidateLags.every((c) => Math.abs(c - halfLag) >= 6)
    ) {
      candidateLags.push(halfLag);
    }
  }

  const refineParabolicLag = (centerLag: number): number => {
    if (centerLag <= minLag || centerLag >= maxLag) return centerLag;
    const y0 = combScores[centerLag - 1];
    const y1 = combScores[centerLag];
    const y2 = combScores[centerLag + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-12) {
      const delta = (y0 - y2) / denom;
      if (Math.abs(delta) < 1) return centerLag + delta;
    }
    return centerLag;
  };

  const computePhaseStartSec = (bpmVal: number): number => {
    const periodFrames = (60 / bpmVal) * envRate;
    const numPhaseBins = Math.max(64, Math.round(periodFrames));
    const phaseHistogram = new Float32Array(numPhaseBins);
    for (let f = 0; f < frameCount; f++) {
      const phaseIdx = Math.floor(((f % periodFrames) / periodFrames) * numPhaseBins) % numPhaseBins;
      phaseHistogram[phaseIdx] += flux[f];
    }
    let bestBin = 0;
    let bestBinEnergy = -1;
    for (let b = 0; b < numPhaseBins; b++) {
      const prev = phaseHistogram[(b - 1 + numPhaseBins) % numPhaseBins];
      const curr = phaseHistogram[b];
      const next = phaseHistogram[(b + 1) % numPhaseBins];
      const score = prev * 0.25 + curr * 0.5 + next * 0.25;
      if (score > bestBinEnergy) {
        bestBinEnergy = score;
        bestBin = b;
      }
    }
    const phaseOffsetInPeriodSec = (bestBin / numPhaseBins) * (60 / bpmVal);
    const beatPeriodSec = 60 / bpmVal;
    return (((startOffsetSec + phaseOffsetInPeriodSec) % beatPeriodSec) + beatPeriodSec) % beatPeriodSec;
  };

  // 3. Zero-phase forward-backward low-pass filter (0.00 ms group delay!) across full song (up to 600s)
  const maxTrackSamples = Math.min(samples.length, Math.floor(sampleRate * 600));
  const trackSlice = samples.subarray(0, maxTrackSamples);
  const lowFull = zeroPhaseLowPassFilter(trackSlice, sampleRate, 165);

  let maxLowAmp = 0;
  for (let i = 0; i < lowFull.length; i += 8) {
    const a = Math.abs(lowFull[i]);
    if (a > maxLowAmp) maxLowAmp = a;
  }
  const kickThreshold = maxLowAmp * 0.22;
  const searchRadius = Math.floor(sampleRate * 0.024);

  const minRegPeaks = durationSec < 4.5 ? 3 : 6;
  const runLinearRegression = (
    peaks: { beatIdx: number; timeSec: number }[]
  ): { slope: number; intercept: number; residualMs: number } | null => {
    if (peaks.length < minRegPeaks) return null;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    const n = peaks.length;
    for (let i = 0; i < n; i++) {
      const x = peaks[i].beatIdx;
      const y = peaks[i].timeSec;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) <= 1e-9) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    if (slope <= 0.3 || slope >= 1.0) return null;

    let sumSqErr = 0;
    for (let i = 0; i < n; i++) {
      const pred = intercept + peaks[i].beatIdx * slope;
      const errMs = (peaks[i].timeSec - pred) * 1000;
      sumSqErr += errMs * errMs;
    }
    return { slope, intercept, residualMs: Math.sqrt(sumSqErr / n) };
  };

  // Scan kick peaks on zero-phase signal, then refine exact onset via local onset extrapolation
  const scanKickPeaks = (
    startSec: number,
    stepSec: number,
    maxEndSample: number
  ): { beatIdx: number; timeSec: number }[] => {
    const peaks: { beatIdx: number; timeSec: number }[] = [];
    const maxB = Math.floor((maxEndSample / sampleRate - startSec) / stepSec);
    for (let b = 0; b <= maxB; b++) {
      const centerSample = Math.round((startSec + b * stepSec) * sampleRate);
      if (centerSample < 0 || centerSample >= maxEndSample) continue;
      const wStart = Math.max(0, centerSample - searchRadius);
      const wEnd = Math.min(maxEndSample - 1, centerSample + searchRadius);
      let lowPeakAmp = 0;
      let lowPeakIdx = centerSample;
      for (let i = wStart; i <= wEnd; i++) {
        const a = Math.abs(lowFull[i]);
        if (a > lowPeakAmp) {
          lowPeakAmp = a;
          lowPeakIdx = i;
        }
      }
      if (lowPeakAmp >= kickThreshold) {
        const exactOnsetSec = extrapolateRawKickOnsetSec(trackSlice, sampleRate, lowPeakIdx);
        peaks.push({ beatIdx: b, timeSec: exactOnsetSec });
      }
    }
    return peaks;
  };

  // Evaluate candidate comb peaks against actual kick regression in the first 90s
  const initEndSample = Math.min(lowFull.length, Math.floor(sampleRate * 90));
  let refinedBpm = (60 * envRate) / refineParabolicLag(candidateLags[0]);
  let anchorSec = computePhaseStartSec(refinedBpm);
  let reg: { slope: number; intercept: number; residualMs: number } | null = null;
  let verifiedPeaks: { beatIdx: number; timeSec: number }[] = [];
  let bestCandidateFit = -Infinity;

  for (let cIdx = 0; cIdx < candidateLags.length; cIdx++) {
    const candLag = refineParabolicLag(candidateLags[cIdx]);
    const candBpm = (60 * envRate) / candLag;
    const candStartSec = computePhaseStartSec(candBpm);
    const p1 = scanKickPeaks(candStartSec, 60 / candBpm, initEndSample);
    const r1 = runLinearRegression(p1);
    if (r1) {
      const inlierCnt = p1.filter(
        (p) => Math.abs(p.timeSec - (r1.intercept + p.beatIdx * r1.slope)) <= 0.012
      ).length;
      const candBpmFromReg = 60 / r1.slope;
      const spanSec = Math.max(0.5, initEndSample / sampleRate - candStartSec);
      const expectedBeats = Math.max(1, Math.floor(spanSec / r1.slope) + 1);
      const missedBeats = Math.max(0, expectedBeats - inlierCnt);
      const hitRatio = inlierCnt / expectedBeats;
      const octavePref =
        hitRatio >= 0.7 && candBpmFromReg >= 90 && candBpmFromReg <= 155 ? 0.5 : 0;
      const fitScore =
        inlierCnt - missedBeats * 0.55 - r1.residualMs * 2.5 + octavePref - cIdx * 0.25;
      if (fitScore > bestCandidateFit) {
        bestCandidateFit = fitScore;
        reg = r1;
        verifiedPeaks = p1;
        refinedBpm = candBpmFromReg;
        anchorSec = Math.max(0, r1.intercept + p1[0].beatIdx * r1.slope);
      }
    }
  }

  // Second pass across ENTIRE track (up to 600s) using pure OLS + outlier rejection (<= 12 ms)
  if (reg) {
    const pass2Raw = scanKickPeaks(anchorSec, reg.slope, lowFull.length);
    const inliers = pass2Raw.filter((p) => {
      const pred = anchorSec + p.beatIdx * reg!.slope;
      return Math.abs(p.timeSec - pred) <= 0.012;
    });
    const reg2 = runLinearRegression(inliers);
    if (reg2 && reg2.residualMs < 5.0) {
      reg = reg2;
      verifiedPeaks = inliers;
      refinedBpm = 60 / reg2.slope;
      anchorSec = Math.max(0, reg2.intercept + inliers[0].beatIdx * reg2.slope);
    }
  }

  // Super-resolution Beat 1 anchor refinement (25 µs folded average) without tilting OLS slope
  if (verifiedPeaks.length >= 3) {
    const firstB = verifiedPeaks[0].beatIdx;
    const baseSlope = 60 / refinedBpm;
    const isTightFit = reg ? reg.residualMs < 1.5 : false;
    const foldSlice = isTightFit ? verifiedPeaks : verifiedPeaks.slice(0, Math.min(8, verifiedPeaks.length));
    const globalDeltaSec = computeFoldedKickOffsetSec(
      trackSlice,
      sampleRate,
      foldSlice.map((p) => anchorSec + (p.beatIdx - firstB) * baseSlope)
    );
    anchorSec = Math.max(0, anchorSec + globalDeltaSec);
  }

  // Snap studio integer BPMs within 0.005 BPM (or 0.012 BPM on short <4.5s tight loops)
  const nearestInt = Math.round(refinedBpm);
  const intSnapTol = durationSec < 4.5 && reg && reg.residualMs < 0.8 ? 0.012 : 0.005;
  if (Math.abs(refinedBpm - nearestInt) <= intSnapTol) {
    refinedBpm = nearestInt;
  }

  const exactBpm = Number(Math.max(70, Math.min(180, refinedBpm)).toFixed(4));
  const displayBpm = Number(exactBpm.toFixed(2));
  const exactBeatSec = 60 / exactBpm;

  // Guard against phase-histogram wraparound near 0 ms skipping Beat 1 onto Beat 2
  while (anchorSec - exactBeatSec >= -0.005) {
    const prevSec = Math.max(0, anchorSec - exactBeatSec);
    const prevCenter = Math.round(prevSec * sampleRate);
    const wStart = Math.max(0, prevCenter - searchRadius);
    const wEnd = Math.min(lowFull.length - 1, prevCenter + searchRadius);
    let prevMax = 0;
    let prevPeakIdx = prevCenter;
    for (let i = wStart; i <= wEnd; i++) {
      const a = Math.abs(lowFull[i]);
      if (a > prevMax) {
        prevMax = a;
        prevPeakIdx = i;
      }
    }
    if (prevMax < kickThreshold) break;
    const prevOnsetSec = extrapolateRawKickOnsetSec(trackSlice, sampleRate, prevPeakIdx);
    if (Math.abs(prevOnsetSec - prevSec) > 0.015) break;
    anchorSec = Math.max(0, anchorSec - exactBeatSec);
  }

  // 4. Continuous full-song beatgrid: zero-jitter straight grid for quantized studio tracks,
  //    or smoothed adaptive tracker for recordings with genuine tempo variation (>0.04 BPM / >1.2 ms)
  const trackedRaw: number[] = [];
  let currentBeatSec = anchorSec;
  let localPeriodSec = exactBeatSec;
  const minPeriodSec = exactBeatSec * 0.96;
  const maxPeriodSec = exactBeatSec * 1.04;
  let localKickRef = maxLowAmp > 0 ? maxLowAmp : 0.05;
  let sumSqStraightErrMs = 0;
  let trackedKickCount = 0;
  const fullTrackRadius = Math.floor(sampleRate * 0.02);
  const straightAbsErrsMs: number[] = [];

  let beatCounter = 0;
  let missedBeats = 0;
  while (currentBeatSec < durationSec) {
    const straightPredSec = anchorSec + beatCounter * exactBeatSec;
    const searchCenterSec = missedBeats >= 2 ? straightPredSec : currentBeatSec;
    const centerSample = Math.round(searchCenterSec * sampleRate);
    let correctedBeatSec = searchCenterSec;
    let foundKick = false;

    if (centerSample >= 0 && centerSample < lowFull.length) {
      const activeRadius = missedBeats >= 2 ? Math.floor(sampleRate * 0.028) : fullTrackRadius;
      const wStart = Math.max(0, centerSample - activeRadius);
      const wEnd = Math.min(lowFull.length - 1, centerSample + activeRadius);
      let lowPeakAmp = 0;
      let lowPeakIdx = centerSample;
      for (let i = wStart; i <= wEnd; i++) {
        const a = Math.abs(lowFull[i]);
        if (a > lowPeakAmp) {
          lowPeakAmp = a;
          lowPeakIdx = i;
        }
      }

      if (lowPeakAmp >= localKickRef * 0.22) {
        localKickRef = localKickRef * 0.92 + lowPeakAmp * 0.08;
        const measuredSec = extrapolateRawKickOnsetSec(trackSlice, sampleRate, lowPeakIdx);
        const errSec = measuredSec - searchCenterSec;
        const maxAcceptErr = missedBeats >= 2 ? 0.024 : 0.018;
        if (Math.abs(errSec) <= maxAcceptErr) {
          foundKick = true;
          missedBeats = 0;
          correctedBeatSec = searchCenterSec + errSec * 0.5;
          localPeriodSec = Math.max(
            minPeriodSec,
            Math.min(maxPeriodSec, localPeriodSec + errSec * 0.08)
          );
          const straightErrMs = (measuredSec - straightPredSec) * 1000;
          sumSqStraightErrMs += straightErrMs * straightErrMs;
          straightAbsErrsMs.push(Math.abs(straightErrMs));
          trackedKickCount++;
        }
      }
    }

    if (!foundKick) {
      missedBeats++;
      localPeriodSec = localPeriodSec * 0.85 + exactBeatSec * 0.15;
    }

    trackedRaw.push(correctedBeatSec);
    currentBeatSec = correctedBeatSec + localPeriodSec;
    beatCounter++;
  }

  let medianStraightErrMs = 0;
  if (straightAbsErrsMs.length > 0) {
    const sorted = [...straightAbsErrsMs].sort((a, b) => a - b);
    medianStraightErrMs = sorted[Math.floor(sorted.length / 2)];
  }

  let halfDriftBpm = 0;
  if (trackedRaw.length >= 24) {
    const firstSlice = trackedRaw
      .slice(0, Math.floor(trackedRaw.length * 0.4))
      .map((timeSec, beatIdx) => ({ beatIdx, timeSec }));
    const secondOffset = Math.floor(trackedRaw.length * 0.6);
    const secondSlice = trackedRaw
      .slice(secondOffset)
      .map((timeSec, i) => ({ beatIdx: secondOffset + i, timeSec }));
    const r1 = runLinearRegression(firstSlice);
    const r2 = runLinearRegression(secondSlice);
    if (r1 && r2) {
      halfDriftBpm = Math.abs(60 / r1.slope - 60 / r2.slope);
    }
  }

  const gridResidualMs =
    trackedKickCount > 0
      ? Number(Math.sqrt(sumSqStraightErrMs / trackedKickCount).toFixed(2))
      : 0;
  const isConstantTempo =
    gridResidualMs < 1.2 || (medianStraightErrMs < 1.6 && halfDriftBpm < 0.04);

  let beatTimesSec: number[];
  if (isConstantTempo) {
    // Zero-jitter exact mathematical grid at 0.0001 BPM precision
    beatTimesSec = [];
    for (let k = 0; anchorSec + k * exactBeatSec < durationSec; k++) {
      beatTimesSec.push(Number((anchorSec + k * exactBeatSec).toFixed(6)));
    }
  } else {
    // 5-beat triangular smoothing over tracked beat timestamps removes single-beat jitter
    beatTimesSec = trackedRaw.map((_, idx, arr) => {
      let sum = 0;
      let wSum = 0;
      const weights = [1, 2, 3, 2, 1];
      for (let k = -2; k <= 2; k++) {
        const j = idx + k;
        if (j >= 0 && j < arr.length) {
          const w = weights[k + 2];
          sum += (arr[j] - k * exactBeatSec) * w;
          wSum += w;
        }
      }
      return Number((sum / wSum).toFixed(6));
    });
  }

  if (beatTimesSec.length === 0) {
    beatTimesSec.push(Number(anchorSec.toFixed(6)));
  }

  const barRhythm = analyzeBarRhythmFromLow(trackSlice, lowFull, sampleRate, beatTimesSec);

  return {
    bpm: displayBpm,
    exactBpm,
    firstTransientMs: Number((anchorSec * 1000).toFixed(2)),
    beatTimesSec,
    isConstantTempo,
    gridResidualMs,
    barRhythm,
    musicalKey,
  };
}

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const MAJOR_CAMELOT_BY_PC = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'] as const;
const MINOR_CAMELOT_BY_PC = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'] as const;
// Krumhansl-Schmuckler tonal pitch-class profiles
const KS_MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function formatMusicalKeyInfo(
  keyIndex: number,
  mode: 'major' | 'minor',
  confidence = 1
): MusicalKeyInfo {
  const pc = ((Math.round(keyIndex) % 12) + 12) % 12;
  const note = NOTE_NAMES_SHARP[pc];
  return {
    keyIndex: pc,
    mode,
    label: mode === 'minor' ? `${note}m` : note,
    camelot: mode === 'minor' ? MINOR_CAMELOT_BY_PC[pc] : MAJOR_CAMELOT_BY_PC[pc],
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2)),
  };
}

export function transposeKeyInfo(key: MusicalKeyInfo, semitones: number): MusicalKeyInfo {
  return formatMusicalKeyInfo(key.keyIndex + Math.round(semitones), key.mode, key.confidence);
}

/**
 * Computes the shortest semitone shift [-6..+6] on sourceKey to harmonically match targetKey's Camelot tonic.
 */
export function findOptimalSemitoneMatch(
  sourceKey: MusicalKeyInfo,
  targetKey: MusicalKeyInfo
): number {
  const targetNum = Number.parseInt(targetKey.camelot, 10);
  const targetTonePc =
    sourceKey.mode === targetKey.mode
      ? targetKey.keyIndex
      : sourceKey.mode === 'minor'
        ? (targetKey.keyIndex + 9) % 12
        : (targetKey.keyIndex + 3) % 12;
  if (Number.isFinite(targetNum)) {
    const srcNum = Number.parseInt(sourceKey.camelot, 10);
    if (srcNum === targetNum) return 0;
  }
  let delta = (((targetTonePc - sourceKey.keyIndex) % 12) + 12) % 12;
  if (delta > 6) delta -= 12;
  return delta;
}

/**
 * Krumhansl-Schmuckler Goertzel chroma detector across octaves C2..B5.
 */
export function detectMusicalKey(samples: Float32Array, sampleRate: number): MusicalKeyInfo {
  if (samples.length < 2048 || sampleRate < 4000) {
    return formatMusicalKeyInfo(9, 'minor', 0);
  }

  const chroma = new Float64Array(12);
  const N = Math.min(4096, Math.pow(2, Math.floor(Math.log2(samples.length))));
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }

  // Sample up to 14 evenly-spaced frames across active audio (skip quiet leading 5% if long)
  const startOffset = samples.length > sampleRate * 8 ? Math.floor(sampleRate * 0.5) : 0;
  const usableLen = samples.length - startOffset;
  const frameCount = Math.min(14, Math.max(1, Math.floor(usableLen / N)));
  const hop = frameCount > 1 ? Math.floor((usableLen - N) / (frameCount - 1)) : 0;

  // MIDI pitches 36 (C2 ~65.4Hz) through 83 (B5 ~987.8Hz)
  const minMidi = 36;
  const maxMidi = 83;
  const coeffs: { pc: number; coeff: number }[] = [];
  for (let m = minMidi; m <= maxMidi; m++) {
    const freq = 440 * Math.pow(2, (m - 69) / 12);
    if (freq < sampleRate * 0.42) {
      const k = (N * freq) / sampleRate;
      const omega = (2 * Math.PI * k) / N;
      coeffs.push({ pc: m % 12, coeff: 2 * Math.cos(omega) });
    }
  }

  let framesUsed = 0;
  const windowed = new Float32Array(N);
  for (let f = 0; f < frameCount; f++) {
    const s0 = startOffset + f * hop;
    if (s0 + N > samples.length) break;
    let frameEnergy = 0;
    for (let i = 0; i < N; i++) {
      const v = samples[s0 + i] * hann[i];
      windowed[i] = v;
      frameEnergy += v * v;
    }
    if (frameEnergy < 1e-5) continue;

    for (let c = 0; c < coeffs.length; c++) {
      const { pc, coeff } = coeffs[c];
      let q1 = 0;
      let q2 = 0;
      for (let i = 0; i < N; i++) {
        const q0 = coeff * q1 - q2 + windowed[i];
        q2 = q1;
        q1 = q0;
      }
      const magSq = Math.max(0, q1 * q1 + q2 * q2 - q1 * q2 * coeff);
      chroma[pc] += Math.sqrt(magSq);
    }
    framesUsed++;
  }

  if (framesUsed === 0) {
    return formatMusicalKeyInfo(9, 'minor', 0);
  }

  const correlate = (profile: number[], root: number): number => {
    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < 12; i++) {
      meanX += chroma[(root + i) % 12];
      meanY += profile[i];
    }
    meanX /= 12;
    meanY /= 12;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let i = 0; i < 12; i++) {
      const dx = chroma[(root + i) % 12] - meanX;
      const dy = profile[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    return den > 1e-9 ? num / den : 0;
  };

  let bestPc = 9;
  let bestMode: 'major' | 'minor' = 'minor';
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (let pc = 0; pc < 12; pc++) {
    const maj = correlate(KS_MAJOR_PROFILE, pc);
    if (maj > bestScore) {
      secondScore = bestScore;
      bestScore = maj;
      bestPc = pc;
      bestMode = 'major';
    } else if (maj > secondScore) {
      secondScore = maj;
    }

    const min = correlate(KS_MINOR_PROFILE, pc);
    if (min > bestScore) {
      secondScore = bestScore;
      bestScore = min;
      bestPc = pc;
      bestMode = 'minor';
    } else if (min > secondScore) {
      secondScore = min;
    }
  }

  const conf = Math.max(0.1, Math.min(1, bestScore * 0.7 + Math.max(0, bestScore - secondScore)));
  return formatMusicalKeyInfo(bestPc, bestMode, conf);
}

/**
 * Analyzes per-beat <165 Hz kick energy and >165 Hz backbeat clap/snare energy across the 4-beat bar cycle
 * so shifted loops ([2,3,4,1]), pickup intros, and full grooves identify Bar 1 Beat 1 reliably.
 */
function analyzeBarRhythmFromLow(
  trackSlice: Float32Array,
  lowFull: Float32Array,
  sampleRate: number,
  beatTimesSec: number[]
): BarRhythmProfile {
  const kickAccum = [0, 0, 0, 0];
  const snareAccum = [0, 0, 0, 0];
  const beatCounts = [0, 0, 0, 0];
  const beatTotalEnergy: number[] = [];
  const winLen = Math.max(16, Math.floor(sampleRate * 0.055));
  const snareWinLen = Math.max(12, Math.floor(sampleRate * 0.032));
  const prePad = Math.floor(sampleRate * 0.005);
  const maxBeats = Math.min(beatTimesSec.length, 64);

  // Isolate > 750 Hz clap/snare transient crack (zero kick-sweep bleed)
  const analyzeEnd = Math.min(
    trackSlice.length,
    Math.ceil(((beatTimesSec[maxBeats - 1] ?? 0) + 0.1) * sampleRate)
  );
  const lowMid = zeroPhaseLowPassFilter(
    trackSlice.subarray(0, analyzeEnd),
    sampleRate,
    Math.min(750, sampleRate * 0.42)
  );

  for (let b = 0; b < maxBeats; b++) {
    const s0 = Math.max(0, Math.round(beatTimesSec[b] * sampleRate) - prePad);
    const s1 = Math.min(trackSlice.length, s0 + winLen);
    const sSnareEnd = Math.min(lowMid.length, s0 + prePad + snareWinLen);
    if (s1 <= s0) {
      beatTotalEnergy.push(0);
      continue;
    }
    let kSq = 0;
    for (let i = s0; i < s1; i++) {
      const l = lowFull[i];
      kSq += l * l;
    }
    let hSq = 0;
    for (let i = s0; i < sSnareEnd; i++) {
      const h = trackSlice[i] - lowMid[i];
      hSq += h * h;
    }
    const kRms = Math.sqrt(kSq / (s1 - s0));
    const hRms = Math.sqrt(hSq / Math.max(1, sSnareEnd - s0));
    const beatInBar = b % 4;
    kickAccum[beatInBar] += kRms;
    snareAccum[beatInBar] += hRms;
    beatCounts[beatInBar]++;
    beatTotalEnergy.push(kRms + hRms);
  }

  for (let b = 0; b < 4; b++) {
    if (beatCounts[b] > 0) {
      kickAccum[b] /= beatCounts[b];
      snareAccum[b] /= beatCounts[b];
    }
  }

  let onsetBodyBeatIndex = 0;
  if (beatTotalEnergy.length >= 8) {
    // Require sustained 4-beat bar energy so a lone intro hit + sparse beats skips to full groove entry
    const barEnergies: number[] = [];
    for (let b = 0; b + 3 < beatTotalEnergy.length; b++) {
      barEnergies.push(
        (beatTotalEnergy[b] +
          beatTotalEnergy[b + 1] +
          beatTotalEnergy[b + 2] +
          beatTotalEnergy[b + 3]) /
          4
      );
    }
    const sortedBars = [...barEnergies].sort((a, b) => a - b);
    const refBar = sortedBars[Math.floor(sortedBars.length * 0.75)];
    for (let b = 0; b < barEnergies.length; b++) {
      if (barEnergies[b] >= refBar * 0.72 && beatTotalEnergy[b] >= refBar * 0.72) {
        onsetBodyBeatIndex = b;
        break;
      }
    }
  } else if (beatTotalEnergy.length >= 4) {
    const sorted = [...beatTotalEnergy].sort((a, b) => a - b);
    const refEnergy = sorted[Math.floor(sorted.length * 0.65)];
    for (let b = 0; b < beatTotalEnergy.length; b++) {
      if (beatTotalEnergy[b] >= refEnergy * 0.55) {
        onsetBodyBeatIndex = b;
        break;
      }
    }
  }

  const normalize4 = (arr: number[]): [number, number, number, number] => {
    const sum = arr[0] + arr[1] + arr[2] + arr[3];
    if (sum <= 1e-9) return [0.25, 0.25, 0.25, 0.25];
    return [
      Number((arr[0] / sum).toFixed(4)),
      Number((arr[1] / sum).toFixed(4)),
      Number((arr[2] / sum).toFixed(4)),
      Number((arr[3] / sum).toFixed(4)),
    ];
  };

  const kickBarEnergy = normalize4(kickAccum);
  const snareBarEnergy = normalize4(snareAccum);

  let bestDownbeat = 0;
  let bestScore = -Infinity;
  for (let c = 0; c < 4; c++) {
    const backbeatSnare = snareBarEnergy[(c + 1) % 4] + snareBarEnergy[(c + 3) % 4];
    const onbeatSnare = snareBarEnergy[c] + snareBarEnergy[(c + 2) % 4];
    const downbeatKick = kickBarEnergy[c] * 1.4 + kickBarEnergy[(c + 2) % 4] * 0.6;
    const bodyTie = c === onsetBodyBeatIndex % 4 ? 0.002 : 0;
    const score =
      2.2 * (backbeatSnare - onbeatSnare) +
      1.6 * downbeatKick +
      bodyTie -
      c * 1e-4;
    if (score > bestScore) {
      bestScore = score;
      bestDownbeat = c;
    }
  }

  // Advance by whole 4-beat bars if intro pickup beat had sparse energy before full body entry
  let startIdx = bestDownbeat;
  while (startIdx + 4 <= onsetBodyBeatIndex && startIdx + 4 < beatTimesSec.length) {
    startIdx += 4;
  }

  const downbeatSec =
    startIdx < beatTimesSec.length ? beatTimesSec[startIdx] : beatTimesSec[0] ?? 0;

  return {
    downbeatIndex: bestDownbeat,
    downbeatMs: Number((downbeatSec * 1000).toFixed(2)),
    kickBarEnergy,
    snareBarEnergy,
    onsetBodyBeatIndex,
  };
}

export function analyzeBarRhythm(
  samples: Float32Array,
  sampleRate: number,
  beatTimesSec: number[]
): BarRhythmProfile {
  const lowFull = zeroPhaseLowPassFilter(samples, sampleRate, 165);
  return analyzeBarRhythmFromLow(samples, lowFull, sampleRate, beatTimesSec);
}

/**
 * Chooses the optimal rhythmic starting beat offset (0..totalBeats-1) and tempo-family
 * multiplier (0.5x | 1x | 2x) on `target` so its 4-beat groove locks 100% onto `reference`.
 */
export function matchRhythmicStartingPoint(
  reference: Pick<AnalyzedTrackData, 'exactBpm' | 'firstTransientMs' | 'beatTimesSec' | 'barRhythm'>,
  target: Pick<AnalyzedTrackData, 'exactBpm' | 'firstTransientMs' | 'beatTimesSec' | 'barRhythm'>,
  referenceStartBeatOffset = 0
): RhythmicStartMatch {
  // 1. Choose tempo-family multiplier r in {0.5, 1, 2} so (refBpm * r) ~ targetBpm
  const candidatesR: readonly (0.5 | 1 | 2)[] = [1, 0.5, 2];
  let tempoMultiplier: 0.5 | 1 | 2 = 1;
  let bestLogDist = Infinity;
  for (const r of candidatesR) {
    const effectiveTargetRefBpm = reference.exactBpm * r;
    const dist = Math.abs(Math.log2(Math.max(1, effectiveTargetRefBpm) / Math.max(1, target.exactBpm)));
    const penalty = r === 1 ? 0 : 0.22;
    if (dist + penalty < bestLogDist) {
      bestLogDist = dist + penalty;
      tempoMultiplier = r;
    }
  }

  const refShift = ((Math.round(referenceStartBeatOffset) % 4) + 4) % 4;
  const refK = [0, 1, 2, 3].map((m) => reference.barRhythm.kickBarEnergy[(refShift + m) % 4]);
  const refS = [0, 1, 2, 3].map((m) => reference.barRhythm.snareBarEnergy[(refShift + m) % 4]);

  const shapeSimilarity = (a: number[], b: number[]): number => {
    let meanA = 0;
    let meanB = 0;
    let dotRaw = 0;
    let naRaw = 0;
    let nbRaw = 0;
    for (let i = 0; i < a.length; i++) {
      meanA += a[i];
      meanB += b[i];
      dotRaw += a[i] * b[i];
      naRaw += a[i] * a[i];
      nbRaw += b[i] * b[i];
    }
    meanA /= a.length;
    meanB /= b.length;
    const denRaw = Math.sqrt(naRaw * nbRaw);
    const cosRaw = denRaw > 1e-9 ? dotRaw / denRaw : 1;

    let dotC = 0;
    let naC = 0;
    let nbC = 0;
    for (let i = 0; i < a.length; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      dotC += da * db;
      naC += da * da;
      nbC += db * db;
    }
    const denC = Math.sqrt(naC * nbC);
    const corrC = denC > 1e-7 ? (dotC / denC + 1) * 0.5 : 1;
    return 0.4 * cosRaw + 0.6 * corrC;
  };

  let bestShift = 0;
  let bestCombined = -Infinity;
  let bestSim = 1;

  for (let s = 0; s < 4; s++) {
    const tgtK = [0, 1, 2, 3].map((m) => target.barRhythm.kickBarEnergy[(s + m) % 4]);
    const tgtS = [0, 1, 2, 3].map((m) => target.barRhythm.snareBarEnergy[(s + m) % 4]);
    const kickSim = shapeSimilarity(refK, tgtK);
    const snareSim = shapeSimilarity(refS, tgtS);
    const hasSnareContrast =
      Math.max(...refS) - Math.min(...refS) > 0.04 &&
      Math.max(...tgtS) - Math.min(...tgtS) > 0.04;
    const avgSim = hasSnareContrast ? 0.45 * kickSim + 0.55 * snareSim : kickSim;
    const downbeatTie = s === target.barRhythm.downbeatIndex ? 0.002 : 0;
    const combined = avgSim + downbeatTie - s * 1e-4;
    if (combined > bestCombined) {
      bestCombined = combined;
      bestShift = s;
      bestSim = avgSim;
    }
  }

  let startBeatOffset = bestShift;
  while (
    startBeatOffset + 4 <= target.barRhythm.onsetBodyBeatIndex &&
    startBeatOffset + 4 < target.beatTimesSec.length
  ) {
    startBeatOffset += 4;
  }

  const beatSec = 60 / Math.max(40, target.exactBpm);
  const anchorSec =
    startBeatOffset < target.beatTimesSec.length
      ? target.beatTimesSec[startBeatOffset]
      : target.firstTransientMs / 1000 + startBeatOffset * beatSec;

  const matchScorePct =
    bestSim >= 0.92 ? 100 : Math.round(Math.max(0, Math.min(1, bestSim / 0.92)) * 100);

  return {
    startBeatOffset,
    anchorMs: Number((anchorSec * 1000).toFixed(2)),
    tempoMultiplier,
    matchScorePct,
  };
}

/**
 * Generates deterministic PCM audio containing a punchy kick + hi-hat groove
 * at exact BPM and optional initial padding offset (for demo tracks and unit tests).
 */
export function generateTestAudioPcm(
  bpm: number,
  durationSec: number,
  sampleRate: number,
  initialOffsetMs = 0,
  variant: 'master' | 'incoming' = 'master',
  options?: {
    beatShift?: number; // e.g., 1 opens recording on Beat 2 ([2,3,4,1] shifted loop!)
    rootMidi?: number; // optional harmonic synth triad for musical key detection tests (e.g. 57 = Am, 60 = C)
    mode?: 'major' | 'minor';
  }
): Float32Array {
  const totalSamples = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(totalSamples);
  const beatSec = 60 / bpm;
  const offsetSec = initialOffsetMs / 1000;
  const beatShift = Math.floor(options?.beatShift ?? 0);
  const rootMidi = options?.rootMidi ?? (variant === 'master' ? 57 : 60); // Am (8A) vs C (8B)
  const chordMode = options?.mode ?? (variant === 'master' ? 'minor' : 'major');
  const chordIntervals = chordMode === 'minor' ? [0, 3, 7] : [0, 4, 7];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate - offsetSec;
    if (t < 0) continue;

    const beatPos = t / beatSec;
    const frac = beatPos - Math.floor(beatPos);
    const beatInBar = (((Math.floor(beatPos) + beatShift) % 4) + 4) % 4;
    let val = 0;

    // Kick drum on every quarter beat with stronger downbeat on Beat 1 (beatInBar === 0)
    const kickTime = frac * beatSec;
    if (kickTime < 0.14) {
      const env = Math.exp(-kickTime * 28);
      const kickAccent = beatInBar === 0 ? 1.0 : beatInBar === 2 ? 0.86 : 0.78;
      const pitchSweep =
        variant === 'master'
          ? 54 + 130 * Math.exp(-kickTime * 45)
          : 58 + 145 * Math.exp(-kickTime * 48);
      val += Math.sin(2 * Math.PI * pitchSweep * kickTime) * env * 0.72 * kickAccent;
    }

    // Off-beat open/closed hat at 0.5 beat
    const hatTime = (frac - 0.5) * beatSec;
    if (hatTime >= 0 && hatTime < 0.06) {
      const env = Math.exp(-hatTime * 75);
      const metal =
        Math.sin(2 * Math.PI * 3420 * hatTime) * 0.4 +
        Math.sin(2 * Math.PI * 5180 * hatTime) * 0.35 +
        Math.sin(2 * Math.PI * 7640 * hatTime) * 0.25;
      val += metal * env * 0.24;
    }

    // Backbeat clap accent on beats 2 & 4
    if ((beatInBar === 1 || beatInBar === 3) && kickTime < 0.07) {
      const clapEnv = Math.exp(-kickTime * 55);
      const clapTone =
        Math.sin(2 * Math.PI * 1450 * kickTime) * Math.sin(2 * Math.PI * 390 * kickTime);
      val += clapTone * clapEnv * 0.22;
    }

    // Subtle harmonic synth stab in mid frequencies (>180 Hz so kick detection stays unaffected)
    if (frac >= 0.06 && frac < 0.45) {
      const stabEnv = Math.exp(-(frac - 0.06) * 10) * 0.045;
      for (let c = 0; c < chordIntervals.length; c++) {
        const midi = rootMidi + chordIntervals[c];
        const freq = 440 * Math.pow(2, (midi - 69) / 12);
        val += Math.sin(2 * Math.PI * freq * t) * stabEnv;
      }
    }

    out[i] = Math.max(-0.98, Math.min(0.98, val));
  }

  return out;
}

/**
 * Samples the precomputed peak envelope at a given time in seconds.
 */
export function sampleTrackPeak(
  peaks: Float32Array,
  peakSamplesPerSec: number,
  timeSec: number
): number {
  if (peaks.length === 0 || timeSec < 0) return 0;
  const idx = Math.floor(timeSec * peakSamplesPerSec);
  if (idx < 0 || idx >= peaks.length) return 0;
  return peaks[idx];
}
