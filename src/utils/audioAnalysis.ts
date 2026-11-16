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
 * Finds the first true kick/beat transient peak in milliseconds on zero-phase low-band audio,
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
  let peakIdx = onsetIdx;
  let peakVal = 0;
  for (let i = Math.max(0, onsetIdx - Math.floor(sampleRate * 0.005)); i < peakWindow; i++) {
    const abs = Math.abs(slice[i]);
    if (abs > peakVal) {
      peakVal = abs;
      peakIdx = i;
    }
  }

  return Number(((peakIdx / sampleRate) * 1000).toFixed(2));
}

/**
 * Builds a 1000 Hz (1 ms resolution) low-band onset flux envelope for Serato-grade
 * kick transient & BPM analysis.
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

  const winSize = Math.max(hop, Math.floor(sampleRate * 0.006));
  let prevEnergy = 0;
  for (let f = 0; f < frameCount; f++) {
    const base = f * hop;
    const end = Math.min(low.length, base + winSize);
    let sumSq = 0;
    for (let i = base; i < end; i++) {
      const s = low[i];
      sumSq += s * s;
    }
    const energy = Math.sqrt(sumSq / Math.max(1, end - base));
    const diff = energy - prevEnergy;
    flux[f] = diff > 0 ? diff : 0;
    prevEnergy = energy;
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
 * 3. Finds exact beat period via 1 ms harmonic comb autocorrelation (70-175 BPM).
 * 4. Uses global phase folding + raw-PCM peak refinement (zero filter group delay).
 * 5. Tracks every kick beat across the ENTIRE song duration (handling slight tempo
 *    variations and beatless breakdowns) for continuous 0.0 ms lock from start to finish.
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
} {
  const durationSec = sampleRate > 0 ? samples.length / sampleRate : 0;
  const fallbackTransientMs = detectFirstTransientMs(samples, sampleRate);

  if (samples.length < sampleRate * 2 || sampleRate <= 0) {
    return {
      bpm: 120.0,
      exactBpm: 120.0,
      firstTransientMs: fallbackTransientMs,
      beatTimesSec: [fallbackTransientMs / 1000],
      isConstantTempo: true,
      gridResidualMs: 0,
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
    };
  }

  // 1. Harmonic comb autocorrelation across 70-175 BPM
  const minLag = Math.max(100, Math.floor((60 / 175) * envRate));
  const maxLag = Math.min(Math.floor(frameCount / 3), Math.ceil((60 / 70) * envRate));

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

  let coarseBestLag = Math.round((60 / 120) * envRate);
  let coarseBestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag += 2) {
    const s1 = acfScore(lag);
    const s2 = lag * 2 < frameCount ? acfScore(lag * 2) * 0.75 : 0;
    const s4 = lag * 4 < frameCount ? acfScore(lag * 4) * 0.5 : 0;
    const candidateBpm = (60 * envRate) / lag;
    const octaveBias = candidateBpm >= 90 && candidateBpm <= 155 ? 1.12 : 0.94;
    const total = (s1 + s2 + s4) * octaveBias;
    if (total > coarseBestScore) {
      coarseBestScore = total;
      coarseBestLag = lag;
    }
  }

  let bestLag = coarseBestLag;
  let bestScore = -1;
  for (
    let lag = Math.max(minLag, coarseBestLag - 8);
    lag <= Math.min(maxLag, coarseBestLag + 8);
    lag++
  ) {
    const s1 = acfScore(lag);
    const s2 = lag * 2 < frameCount ? acfScore(lag * 2) * 0.75 : 0;
    const total = s1 + s2;
    if (total > bestScore) {
      bestScore = total;
      bestLag = lag;
    }
  }

  if (bestScore <= 0) {
    return {
      bpm: 120.0,
      exactBpm: 120.0,
      firstTransientMs: fallbackTransientMs,
      beatTimesSec: [fallbackTransientMs / 1000],
      isConstantTempo: true,
      gridResidualMs: 0,
    };
  }

  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acfScore(bestLag - 1);
    const y1 = acfScore(bestLag);
    const y2 = acfScore(bestLag + 1);
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-12) {
      const delta = (y0 - y2) / denom;
      if (Math.abs(delta) < 1) refinedLag = bestLag + delta;
    }
  }

  // Octave promotion: prevent half-time locks (e.g. 70 BPM on a 140 BPM track)
  if ((60 * envRate) / refinedLag < 95) {
    const halfLag = Math.round(refinedLag / 2);
    if (halfLag >= minLag && acfScore(halfLag) >= acfScore(Math.round(refinedLag)) * 0.5) {
      let bestHalf = halfLag;
      let bestHalfScore = -1;
      for (let l = Math.max(minLag, halfLag - 4); l <= Math.min(maxLag, halfLag + 4); l++) {
        const sc = acfScore(l);
        if (sc > bestHalfScore) {
          bestHalfScore = sc;
          bestHalf = l;
        }
      }
      refinedLag = bestHalf;
      if (bestHalf > minLag && bestHalf < maxLag) {
        const y0 = acfScore(bestHalf - 1);
        const y1 = acfScore(bestHalf);
        const y2 = acfScore(bestHalf + 1);
        const denom = 2 * (y0 - 2 * y1 + y2);
        if (Math.abs(denom) > 1e-12) {
          const delta = (y0 - y2) / denom;
          if (Math.abs(delta) < 1) refinedLag = bestHalf + delta;
        }
      }
    }
  }

  let refinedBpm = (60 * envRate) / refinedLag;

  // 2. Global Phase Folding across flux envelope
  const periodFrames = (60 / refinedBpm) * envRate;
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

  const phaseOffsetInPeriodSec = (bestBin / numPhaseBins) * (60 / refinedBpm);
  const beatPeriodSec = 60 / refinedBpm;
  const rawPhaseAtStartSec =
    (((startOffsetSec + phaseOffsetInPeriodSec) % beatPeriodSec) + beatPeriodSec) % beatPeriodSec;

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

  // Pass A: collect kick peaks across full track using coarse beatPeriodSec
  const runLinearRegression = (
    peaks: { beatIdx: number; timeSec: number }[]
  ): { slope: number; intercept: number; residualMs: number } | null => {
    if (peaks.length < 6) return null;
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

  // Helper: locate the sharp 45% rising-edge kick attack just ahead of a verified low-band peak
  const findKickOnsetSample = (lowPeakIdx: number, lowPeakAmp: number): number => {
    const kneeAmp = lowPeakAmp * 0.45;
    const lookBackStart = Math.max(0, lowPeakIdx - Math.floor(sampleRate * 0.018));
    for (let i = lookBackStart; i <= lowPeakIdx; i++) {
      if (Math.abs(lowFull[i]) >= kneeAmp) {
        return i;
      }
    }
    return lowPeakIdx;
  };

  // Scan kick peaks on zero-phase signal (anchored at rising-edge attack for <2 ms precision)
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
        const onsetIdx = findKickOnsetSample(lowPeakIdx, lowPeakAmp);
        peaks.push({ beatIdx: b, timeSec: onsetIdx / sampleRate });
      }
    }
    return peaks;
  };

  // First pass: first 90s for initial slope & anchor
  const initEndSample = Math.min(lowFull.length, Math.floor(sampleRate * 90));
  const pass1Peaks = scanKickPeaks(rawPhaseAtStartSec, beatPeriodSec, initEndSample);
  let reg = runLinearRegression(pass1Peaks);

  let anchorSec = rawPhaseAtStartSec;
  if (reg) {
    const firstIdx = pass1Peaks[0].beatIdx;
    anchorSec = Math.max(0, reg.intercept + firstIdx * reg.slope);
    refinedBpm = 60 / reg.slope;

    // Second pass across ENTIRE track (up to 600s) using outlier rejection (<= 12 ms)
    const pass2Raw = scanKickPeaks(anchorSec, reg.slope, lowFull.length);
    const inliers = pass2Raw.filter((p) => {
      const pred = anchorSec + p.beatIdx * reg!.slope;
      return Math.abs(p.timeSec - pred) <= 0.012;
    });
    const reg2 = runLinearRegression(inliers);
    if (reg2 && reg2.residualMs < 5.0) {
      reg = reg2;
      refinedBpm = 60 / reg2.slope;
      anchorSec = Math.max(0, reg2.intercept + inliers[0].beatIdx * reg2.slope);
    }
  }

  // Snap exact integer BPMs only if within 0.005 BPM (prevents >5 ms drift across long songs)
  const nearestInt = Math.round(refinedBpm);
  if (Math.abs(refinedBpm - nearestInt) <= 0.005) {
    refinedBpm = nearestInt;
  }

  const exactBpm = Number(Math.max(70, Math.min(180, refinedBpm)).toFixed(4));
  const displayBpm = Number(exactBpm.toFixed(2));
  const exactBeatSec = 60 / exactBpm;

  // 4. Continuous full-song beatgrid: zero-jitter straight grid for studio tracks,
  //    or Gaussian-smoothed adaptive tracker for genuinely drifting live recordings
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
        const onsetIdx = findKickOnsetSample(lowPeakIdx, lowPeakAmp);
        const measuredSec = onsetIdx / sampleRate;
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
          // Measure deviation against the global STRAIGHT grid to detect real tempo drift
          const straightErrMs = (measuredSec - straightPredSec) * 1000;
          sumSqStraightErrMs += straightErrMs * straightErrMs;
          straightAbsErrsMs.push(Math.abs(straightErrMs));
          trackedKickCount++;
        }
      }
    }

    if (!foundKick) {
      missedBeats++;
      // Prevent localPeriodSec jitter from accumulating during long beatless breakdowns
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

  // Check if first-half vs second-half tempo actually drifts (prevents false-dynamic mode on studio tracks)
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
    (medianStraightErrMs < 4.5 && halfDriftBpm < 0.15) || gridResidualMs < 4.5;

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

  return {
    bpm: displayBpm,
    exactBpm,
    firstTransientMs: Number((anchorSec * 1000).toFixed(2)),
    beatTimesSec,
    isConstantTempo,
    gridResidualMs,
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
  variant: 'master' | 'incoming' = 'master'
): Float32Array {
  const totalSamples = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(totalSamples);
  const beatSec = 60 / bpm;
  const offsetSec = initialOffsetMs / 1000;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate - offsetSec;
    if (t < 0) continue;

    const beatPos = t / beatSec;
    const frac = beatPos - Math.floor(beatPos);
    const beatInBar = Math.floor(beatPos) % 4;
    let val = 0;

    // Kick drum on every quarter beat
    const kickTime = frac * beatSec;
    if (kickTime < 0.14) {
      const env = Math.exp(-kickTime * 28);
      const pitchSweep =
        variant === 'master'
          ? 54 + 130 * Math.exp(-kickTime * 45)
          : 58 + 145 * Math.exp(-kickTime * 48);
      val += Math.sin(2 * Math.PI * pitchSweep * kickTime) * env * 0.72;
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
