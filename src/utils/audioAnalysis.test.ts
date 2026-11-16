import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBeatGrid,
  computeWaveformPeaks,
  detectFirstTransientMs,
  estimateBpm,
  generateTestAudioPcm,
  sampleTrackPeak,
} from './audioAnalysis';

test('detectFirstTransientMs finds kick onset within <= 0.20 ms on clean and +18 ms padded audio', () => {
  const sr = 44100;
  const clean = generateTestAudioPcm(124, 4, sr, 0, 'master');
  const cleanMs = detectFirstTransientMs(clean, sr);
  assert.ok(cleanMs >= 0 && cleanMs <= 0.2, `Expected <= 0.20 ms on clean start, got ${cleanMs} ms`);

  const padded = generateTestAudioPcm(124, 4, sr, 18.0, 'incoming');
  const paddedMs = detectFirstTransientMs(padded, sr);
  assert.ok(
    Math.abs(paddedMs - 18.0) <= 0.2,
    `Expected within <= 0.20 ms of 18.0 ms, got ${paddedMs} ms`
  );
});

test('analyzeBeatGrid recovers exact 124.0 BPM, straight tempo, and <= 0.20 ms anchor from +14.2 ms padded groove', () => {
  const sr = 44100;
  const pcm = generateTestAudioPcm(124, 16, sr, 14.2, 'incoming');
  const grid = analyzeBeatGrid(pcm, sr);
  assert.equal(grid.bpm, 124, `Expected exact 124 BPM, got ${grid.bpm}`);
  assert.equal(grid.isConstantTempo, true);
  assert.ok(grid.gridResidualMs < 0.5, `Expected tight residual, got ${grid.gridResidualMs}`);
  assert.ok(
    Math.abs(grid.firstTransientMs - 14.2) <= 0.2,
    `Expected anchor within <= 0.20 ms of 14.20 ms, got ${grid.firstTransientMs} ms`
  );
});

test('analyzeBeatGrid ignores quiet high-frequency intro pad and locks onto true kick downbeat within <= 0.20 ms', () => {
  const sr = 44100;
  const introSec = 2.0;
  const mainPcm = generateTestAudioPcm(126, 16, sr, 0, 'master');
  const full = new Float32Array(Math.floor(sr * introSec) + mainPcm.length);

  // Add loud 3500 Hz hi-hat / synth texture during the 2-second intro (no kick!)
  for (let i = 0; i < Math.floor(sr * introSec); i++) {
    const t = i / sr;
    full[i] = Math.sin(2 * Math.PI * 3500 * t) * 0.45;
  }
  full.set(mainPcm, Math.floor(sr * introSec));

  const grid = analyzeBeatGrid(full, sr);
  assert.equal(grid.bpm, 126, `Expected exact 126 BPM, got ${grid.bpm}`);
  assert.ok(
    Math.abs(grid.firstTransientMs - 2000.0) <= 0.2,
    `Expected Beat 1 anchor within <= 0.20 ms of 2000.00 ms kick entry, got ${grid.firstTransientMs} ms`
  );
});

test('estimateBpm recovers 128 BPM and 140 BPM accurately', () => {
  const sr = 22050;
  assert.equal(estimateBpm(generateTestAudioPcm(128, 12, sr, 5, 'master'), sr), 128);
  assert.equal(estimateBpm(generateTestAudioPcm(140, 12, sr, 0, 'master'), sr), 140);
});

test('computeWaveformPeaks and sampleTrackPeak preserve transient peaks', () => {
  const sr = 22050;
  const pcm = generateTestAudioPcm(120, 2, sr, 0, 'master');
  const peaks = computeWaveformPeaks(pcm, sr, 400);
  assert.equal(peaks.length, 800);
  const kickPeak = Math.abs(sampleTrackPeak(peaks, 400, 0.005));
  const quietTail = Math.abs(sampleTrackPeak(peaks, 400, 0.42));
  assert.ok(kickPeak > quietTail * 3, `Expected kick (${kickPeak}) >> tail (${quietTail})`);
});

test('analyzeBeatGrid tracks real kick peaks continuously across a 90s tempo-drifting song', () => {
  const sr = 16000;
  const durationSec = 90;
  const pcm = new Float32Array(sr * durationSec);
  // Generate kicks whose period drifts linearly from 124.0 BPM to 124.8 BPM across 90s
  const trueKickTimes: number[] = [];
  let t = 0.01;
  while (t < durationSec - 0.1) {
    trueKickTimes.push(t);
    const frac = t / durationSec;
    const instBpm = 124.0 + 0.8 * frac;
    const startSample = Math.floor(t * sr);
    const len = Math.floor(0.08 * sr);
    for (let k = 0; k < len && startSample + k < pcm.length; k++) {
      const kt = k / sr;
      pcm[startSample + k] += Math.sin(2 * Math.PI * (60 + 110 * Math.exp(-kt * 45)) * kt) * Math.exp(-kt * 30) * 0.8;
    }
    t += 60 / instBpm;
  }

  const grid = analyzeBeatGrid(pcm, sr);
  assert.ok(grid.beatTimesSec.length >= trueKickTimes.length - 2);
  // Verify the beat tracker stayed locked onto the late-song kick at ~85s within 4 ms!
  const lateIdx = trueKickTimes.length - 4;
  const errLateMs = Math.abs(grid.beatTimesSec[lateIdx] - trueKickTimes[lateIdx]) * 1000;
  assert.ok(errLateMs < 4.5, `Expected <4.5 ms error near end of 90s drifting song, got ${errLateMs.toFixed(2)} ms`);
});

test('analyzeBeatGrid preserves constant-tempo <= 0.20 ms phase lock across a 24-beat silent breakdown', () => {
  const sr = 44100;
  const bpm = 126;
  const beatSec = 60 / bpm;
  const durationSec = 45;
  const full = generateTestAudioPcm(bpm, durationSec, sr, 12.0, 'master');

  // Zero out beats 24..47 (24-beat beatless breakdown, ~11.4 seconds of breakdown silence)
  const dropStartSample = Math.floor((0.012 + 24 * beatSec) * sr);
  const dropEndSample = Math.floor((0.012 + 48 * beatSec) * sr);
  for (let i = dropStartSample; i < dropEndSample && i < full.length; i++) {
    full[i] = 0;
  }

  const grid = analyzeBeatGrid(full, sr);
  assert.equal(grid.bpm, 126, `Expected 126 BPM, got ${grid.bpm}`);
  assert.equal(grid.isConstantTempo, true, 'Expected constant-tempo lock across breakdown');
  assert.ok(
    Math.abs(grid.firstTransientMs - 12.0) <= 0.2,
    `Expected <= 0.20 ms anchor lock, got ${grid.firstTransientMs} ms`
  );

  // Verify post-breakdown beat 56 aligns within <= 0.20 ms of ground truth
  const expectedBeat56Sec = 0.012 + 56 * beatSec;
  const errAfterBreakdownMs = Math.abs(grid.beatTimesSec[56] - expectedBeat56Sec) * 1000;
  assert.ok(
    errAfterBreakdownMs <= 0.2,
    `Expected <= 0.20 ms phase error after breakdown, got ${errAfterBreakdownMs.toFixed(3)} ms`
  );
});

test('analyzeBeatGrid handles short 1-bar DJ loops (< 2.0s) with <= 0.20 ms anchor accuracy', () => {
  const sr = 44100;
  const bpm = 124;
  // Exact 1-bar loop (1.935s) + 16.75 ms encoder pad
  const oneBarDuration = (4 * 60) / bpm + 0.03;
  const loopPcm = generateTestAudioPcm(bpm, oneBarDuration, sr, 16.75, 'incoming');
  const grid = analyzeBeatGrid(loopPcm, sr);
  assert.equal(grid.bpm, 124, `Expected 124 BPM on 1-bar loop, got ${grid.bpm}`);
  assert.ok(
    Math.abs(grid.firstTransientMs - 16.75) <= 0.2,
    `Expected <= 0.20 ms on 1-bar loop, got ${grid.firstTransientMs} ms`
  );
});

test('analyzeBeatGrid eliminates sub-bass comb BPM drift on club tracks with 95 Hz bassline & 240 Hz snare', () => {
  const sr = 44100;
  for (const bpm of [126, 128, 132]) {
    const dur = 48;
    const n = sr * dur;
    const pcm = new Float32Array(n);
    const beatSec = 60 / bpm;
    for (let i = 0; i < n; i++) {
      const t = i / sr - 0.0185;
      if (t < 0) continue;
      const bp = t / beatSec;
      const bIdx = Math.floor(bp);
      const kt = (bp - bIdx) * beatSec;
      let v = 0;
      if (bIdx >= 16) {
        const bassEnv = 0.3 + 0.7 * Math.min(1, kt / 0.08);
        v += Math.sin(2 * Math.PI * 95 * t) * 0.35 * bassEnv;
      }
      if (kt < 0.14) {
        const kg = bIdx < 16 ? 0.45 : 0.85;
        v += Math.sin(2 * Math.PI * (50 + 140 * Math.exp(-kt * 48)) * kt) * Math.exp(-kt * 25) * kg;
      }
      if (bIdx % 2 === 1 && kt < 0.09) {
        v += Math.sin(2 * Math.PI * 240 * kt) * Math.exp(-kt * 35) * 0.4;
      }
      pcm[i] = Math.max(-0.98, Math.min(0.98, v));
    }
    const grid = analyzeBeatGrid(pcm, sr);
    assert.equal(grid.exactBpm, bpm, `Expected exact ${bpm} BPM, got ${grid.exactBpm}`);
    assert.equal(grid.isConstantTempo, true);
    assert.ok(
      Math.abs(grid.firstTransientMs - 18.5) <= 0.2,
      `Expected <= 0.20 ms anchor on ${bpm} BPM club track, got ${grid.firstTransientMs} ms`
    );
  }
});

test('analyzeBeatGrid switches to dynamic beat tracking for subtle 0.12 BPM drift', () => {
  const sr = 22050;
  const dur = 45;
  const n = sr * dur;
  const pcm = new Float32Array(n);
  let t = 0.01;
  while (t < dur - 0.1) {
    const instBpm = 124.0 + 0.12 * (t / dur);
    const s0 = Math.floor(t * sr);
    for (let k = 0; k < Math.floor(0.1 * sr) && s0 + k < n; k++) {
      const kt = k / sr;
      pcm[s0 + k] += Math.sin(2 * Math.PI * (54 + 120 * Math.exp(-kt * 45)) * kt) * Math.exp(-kt * 28) * 0.8;
    }
    t += 60 / instBpm;
  }
  const grid = analyzeBeatGrid(pcm, sr);
  assert.equal(grid.isConstantTempo, false, 'Expected dynamic beatgrid mode for 0.12 BPM drift');
});
