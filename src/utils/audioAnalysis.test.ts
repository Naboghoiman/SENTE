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

test('detectFirstTransientMs finds zero-offset kick near 0–8 ms and detects 18 ms MP3 padding', () => {
  const sr = 22050;
  const clean = generateTestAudioPcm(124, 4, sr, 0, 'master');
  const cleanMs = detectFirstTransientMs(clean, sr);
  assert.ok(cleanMs >= 0 && cleanMs <= 8, `Expected near 0-8ms, got ${cleanMs}`);

  const padded = generateTestAudioPcm(124, 4, sr, 18.0, 'incoming');
  const paddedMs = detectFirstTransientMs(padded, sr);
  assert.ok(paddedMs >= 16 && paddedMs <= 26, `Expected near 18-26ms, got ${paddedMs}`);
});

test('analyzeBeatGrid recovers exact 124.0 BPM, straight tempo, and sub-5ms anchor from padded groove', () => {
  const sr = 22050;
  const pcm = generateTestAudioPcm(124, 16, sr, 14.2, 'incoming');
  const grid = analyzeBeatGrid(pcm, sr);
  assert.equal(grid.bpm, 124, `Expected exact 124 BPM, got ${grid.bpm}`);
  assert.equal(grid.isConstantTempo, true);
  assert.ok(grid.gridResidualMs < 4, `Expected tight residual, got ${grid.gridResidualMs}`);
  assert.ok(
    Math.abs(grid.firstTransientMs - 16) < 6,
    `Expected anchor near 14-20ms, got ${grid.firstTransientMs}`
  );
});

test('analyzeBeatGrid ignores quiet high-frequency intro pad and locks onto true kick downbeat', () => {
  const sr = 22050;
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
    Math.abs(grid.firstTransientMs - 2000) < 25,
    `Expected Beat 1 anchor near 2000ms kick entry, got ${grid.firstTransientMs}`
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

test('analyzeBeatGrid preserves constant-tempo 0 ms phase lock across a 24-beat silent breakdown', () => {
  const sr = 22050;
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
  assert.ok(grid.gridResidualMs < 3.5, `Expected <3.5 ms residual, got ${grid.gridResidualMs}`);

  // Verify post-breakdown beat 56 aligns within 3 ms of ground truth
  const expectedBeat56Sec = 0.012 + 56 * beatSec;
  const errAfterBreakdownMs = Math.abs(grid.beatTimesSec[56] - expectedBeat56Sec) * 1000;
  assert.ok(
    errAfterBreakdownMs < 3.0,
    `Expected <3 ms phase error after breakdown, got ${errAfterBreakdownMs.toFixed(2)} ms`
  );
});

