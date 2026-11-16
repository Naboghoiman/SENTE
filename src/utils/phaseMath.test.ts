import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePhaseMetrics,
  computePllCorrection,
  calculateDriftMath,
  DIAGNOSTIC_SCENARIOS,
  getBeatPositionAtTime,
  getTimeAtBeatPosition,
  sampleDeckTransient,
  wrapPhaseErrorMs,
  type CalibrationState,
} from './phaseMath';

const baseState: CalibrationState = {
  scenarioId: 'zero-locked',
  masterBpm: 124.0,
  deck2BpmOffset: 0,
  deck2TrackDriftBpm: 0,
  gridOffsetMs: 0,
  syncMode: 'beat',
  gridMode: 'straight',
  quantize: true,
  audioLatencyMs: 0,
  zoomLevel: 4,
  elapsedBeats: 0,
};

test('zero-error reference produces 0.0 ms error and locked status', () => {
  const metrics = computePhaseMetrics(baseState);
  assert.equal(metrics.phaseErrorMs, 0);
  assert.equal(metrics.absErrorMs, 0);
  assert.equal(metrics.phaseAngleDeg, 0);
  assert.equal(metrics.status, 'locked');
  assert.equal(metrics.combFilterHz, null);
});

test('MP3 padding grid offset produces exact micro-flamming error and comb-filter notch', () => {
  const mp3Scenario = DIAGNOSTIC_SCENARIOS.find((s) => s.id === 'mp3-padding')!;
  const state: CalibrationState = { ...baseState, ...mp3Scenario.patch };
  const metrics = computePhaseMetrics(state);
  assert.equal(metrics.phaseErrorMs, 14.2);
  assert.equal(metrics.status, 'drifting');
  assert.equal(metrics.combFilterHz, 35);
  assert.equal(metrics.correctionNeededMs, -14.2);
});

test('dynamic (fluid) beatgrid eliminates live drummer drift', () => {
  const straightDrift = computePhaseMetrics({
    ...baseState,
    masterBpm: 118,
    deck2TrackDriftBpm: 0.85,
    gridMode: 'straight',
    elapsedBeats: 16,
  });
  assert.ok(Math.abs(straightDrift.driftPerBarMs) > 10);
  assert.equal(straightDrift.status, 'drifting');

  const fluidLocked = computePhaseMetrics({
    ...baseState,
    masterBpm: 118,
    deck2TrackDriftBpm: 0.85,
    gridMode: 'dynamic',
    elapsedBeats: 16,
  });
  assert.equal(fluidLocked.driftPerBarMs, 0);
  assert.equal(fluidLocked.phaseErrorMs, 0);
  assert.equal(fluidLocked.status, 'locked');
});

test('tempo sync matches BPM without resolving existing beatgrid offset', () => {
  const metrics = computePhaseMetrics({
    ...baseState,
    deck2BpmOffset: 1.5,
    gridOffsetMs: 18,
    syncMode: 'tempo',
  });
  assert.equal(metrics.effectiveDeck2Bpm, 124);
  assert.equal(metrics.phaseErrorMs, 18);
  assert.equal(metrics.driftPerBarMs, 0);
});

test('wrapPhaseErrorMs wraps errors beyond half-beat cleanly', () => {
  assert.equal(wrapPhaseErrorMs(490, 500), -10);
  assert.equal(wrapPhaseErrorMs(-260, 500), 240);
});

test('calculateDriftMath computes accurate 124 BPM timings and drift', () => {
  const res = calculateDriftMath(124, 0.25, 16);
  assert.equal(res.beatMs, 483.87);
  assert.equal(res.barMs, 1935.48);
  assert.ok(res.totalDriftMs > 60);
});

test('sampleDeckTransient produces strong attack near beat 0 and quiet tail', () => {
  const attack = Math.abs(sampleDeckTransient(0.02));
  const tail = Math.abs(sampleDeckTransient(0.85));
  assert.ok(attack > tail * 5);
});

test('piecewise beatgrid interpolation maps beat <-> time cleanly', () => {
  const beatTimes = [0.015, 0.515, 1.015, 1.515]; // 120 BPM with 15 ms start
  const t = getTimeAtBeatPosition(1.5, beatTimes, 120, 15);
  assert.ok(Math.abs(t - 0.765) < 1e-6);
  const b = getBeatPositionAtTime(0.765, beatTimes, 120, 15);
  assert.ok(Math.abs(b - 1.5) < 1e-6);
});

test('computePllCorrection prevents long-term separation even with 0.4% clock/BPM mismatch', () => {
  // Simulate 120 seconds (248 beats at 124 BPM) where Deck 2 naturally runs 0.4% too slow
  const beatSec = 60 / 124;
  let deck2TimeSec = 0.006; // 6 ms initial offset
  let masterBeat = 0;
  let integralErrSec = 0;
  const dt = 0.05; // 20 Hz PLL loop
  let maxAbsErrAfterSettle = 0;

  for (let step = 0; step < 2400; step++) {
    const pll = computePllCorrection({
      masterBeatPos: masterBeat,
      deck2ActualTimeSec: deck2TimeSec,
      deck2BaseRate: 0.996, // deliberately wrong by 0.4%!
      deck2BeatTimesSec: [],
      deck2FallbackBpm: 124,
      deck2AnchorMs: 0,
      deck2DurationSec: 180,
      desiredOffsetMs: 0,
      pllEnabled: true,
      integralErrSec,
      dtSec: dt,
    });
    assert.equal(pll.requiresHardSnap, false);
    integralErrSec = pll.nextIntegralErrSec;
    masterBeat += dt / beatSec;
    deck2TimeSec += dt * pll.correctedRate;
    if (step > 40) {
      maxAbsErrAfterSettle = Math.max(maxAbsErrAfterSettle, Math.abs(pll.phaseErrorMs));
    }
  }

  assert.ok(
    maxAbsErrAfterSettle < 0.1,
    `Expected PI-PLL to hold <0.1 ms steady-state error over 120s, got ${maxAbsErrAfterSettle} ms`
  );
});

test('computePllCorrection requests hard snap for large (>15 ms) initial phase offsets', () => {
  const pll = computePllCorrection({
    masterBeatPos: 4.0,
    deck2ActualTimeSec: 1.9, // ~100 ms off
    deck2BaseRate: 1.0,
    deck2BeatTimesSec: [],
    deck2FallbackBpm: 120,
    deck2AnchorMs: 0,
    deck2DurationSec: 180,
    desiredOffsetMs: 0,
    pllEnabled: true,
  });
  assert.equal(pll.requiresHardSnap, true);
  assert.equal(pll.phaseErrorMs, 0);
});

test('continuous micro-nudge system caps rate trim within ±0.25% while pulling phase to 0.0 ms', () => {
  const beatSec = 60 / 126;
  let deck2TimeSec = 0.004; // +4 ms initial offset
  let masterBeat = 0;
  let integralErrSec = 0;
  const dt = 0.04; // 25 Hz nudge loop
  let maxObservedTrimPct = 0;
  let finalErrMs = 999;

  for (let step = 0; step < 150; step++) {
    const pll = computePllCorrection({
      masterBeatPos: masterBeat,
      deck2ActualTimeSec: deck2TimeSec,
      deck2BaseRate: 1.0,
      deck2BeatTimesSec: [],
      deck2FallbackBpm: 126,
      deck2AnchorMs: 0,
      deck2DurationSec: 180,
      desiredOffsetMs: 0,
      pllEnabled: true,
      integralErrSec,
      dtSec: dt,
      maxTrimPct: 0.25,
    });
    const trimPct = Math.abs((pll.correctedRate - 1.0) * 100);
    maxObservedTrimPct = Math.max(maxObservedTrimPct, trimPct);
    integralErrSec = pll.nextIntegralErrSec;
    masterBeat += dt / beatSec;
    deck2TimeSec += dt * pll.correctedRate;
    finalErrMs = Math.abs(pll.phaseErrorMs);
  }

  assert.ok(
    maxObservedTrimPct <= 0.251,
    `Expected nudge trim to never exceed 0.25%, got ${maxObservedTrimPct.toFixed(3)}%`
  );
  assert.ok(
    finalErrMs < 0.05,
    `Expected continuous micro-nudge to pull phase error to <0.05 ms, got ${finalErrMs.toFixed(3)} ms`
  );
});
