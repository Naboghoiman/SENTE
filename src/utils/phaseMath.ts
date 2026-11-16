export type SyncMode = 'off' | 'tempo' | 'beat';
export type GridMode = 'straight' | 'dynamic';
export type PhaseStatus = 'locked' | 'micro-flam' | 'drifting';

export interface CalibrationState {
  scenarioId: string;
  masterBpm: number;
  deck2BpmOffset: number; // BPM difference when not synced or tempo-locked
  deck2TrackDriftBpm: number; // Intrinsic live-drummer tempo drift amplitude
  gridOffsetMs: number; // Beatgrid anchor offset from true transient peak (-40 to +40 ms)
  syncMode: SyncMode;
  gridMode: GridMode;
  quantize: boolean;
  audioLatencyMs: number; // Output/cue routing mismatch latency (e.g., Bluetooth speaker)
  zoomLevel: 1 | 4 | 16;
  elapsedBeats: number;
}

export interface DiagnosticScenario {
  id: string;
  title: string;
  cause: string;
  summary: string;
  fixHint: string;
  patch: Partial<CalibrationState>;
}

export interface PhaseMetrics {
  phaseErrorMs: number; // Signed instantaneous phase error (-halfBeat to +halfBeat)
  absErrorMs: number;
  phaseAngleDeg: number; // -180 to +180 degrees
  driftPerBarMs: number; // Cumulative drift rate per 4-beat bar
  effectiveDeck2Bpm: number;
  combFilterHz: number | null; // First cancellation notch f = 1 / (2 * dt)
  status: PhaseStatus;
  statusLabel: string;
  correctionNeededMs: number; // Exact delta to apply to reach 0.0 ms
}

export const DIAGNOSTIC_SCENARIOS: DiagnosticScenario[] = [
  {
    id: 'mp3-padding',
    title: 'MP3 Encoder Offset (+14.2 ms)',
    cause: 'Beatgrid Anchor Misaligned',
    summary:
      'Auto-analysis placed Downbeat 1.1.1 before the true kick transient due to MP3 encoder padding.',
    fixHint: 'Zoom to 16x and nudge the beatgrid -14.2 ms (or click Snap to Transient).',
    patch: {
      masterBpm: 124.0,
      deck2BpmOffset: 0,
      deck2TrackDriftBpm: 0,
      gridOffsetMs: 14.2,
      syncMode: 'beat',
      gridMode: 'straight',
      quantize: true,
      audioLatencyMs: 0,
      elapsedBeats: 0,
    },
  },
  {
    id: 'tempo-only-sync',
    title: 'Tempo-Only Sync (+26.0 ms)',
    cause: 'Sync Mode Set to Tempo Instead of Beat',
    summary:
      'BPMs match at 124.00, but djay Sync only locks speed without snapping beat phase.',
    fixHint: 'Switch Sync Mode to Beat Sync and enable Quantize so triggers snap to 0.0 ms.',
    patch: {
      masterBpm: 124.0,
      deck2BpmOffset: 0,
      deck2TrackDriftBpm: 0,
      gridOffsetMs: 26.0,
      syncMode: 'tempo',
      gridMode: 'straight',
      quantize: false,
      audioLatencyMs: 0,
      elapsedBeats: 0,
    },
  },
  {
    id: 'live-drummer-drift',
    title: 'Live Drummer Drift (Dynamic BPM)',
    cause: 'Straight Grid on Unquantized Track',
    summary:
      'A funk/disco track with human timing wanders away from a fixed Straight beatgrid every bar.',
    fixHint: 'Switch Grid Type to Dynamic (Fluid Beatgrid) so djay tracks micro-tempo shifts.',
    patch: {
      masterBpm: 118.0,
      deck2BpmOffset: 0,
      deck2TrackDriftBpm: 0.85,
      gridOffsetMs: 0,
      syncMode: 'beat',
      gridMode: 'straight',
      quantize: true,
      audioLatencyMs: 0,
      elapsedBeats: 8,
    },
  },
  {
    id: 'bluetooth-latency',
    title: 'Wireless Cue/Master Offset (+32.0 ms)',
    cause: 'Bluetooth / DSP Output Latency',
    summary:
      'Headphone cue is wired (0 ms) while master speakers run through wireless DSP (+32 ms).',
    fixHint: 'Use wired master audio or compensate latency to bring output delay to 0.0 ms.',
    patch: {
      masterBpm: 126.0,
      deck2BpmOffset: 0,
      deck2TrackDriftBpm: 0,
      gridOffsetMs: 0,
      syncMode: 'beat',
      gridMode: 'straight',
      quantize: true,
      audioLatencyMs: 32.0,
      elapsedBeats: 0,
    },
  },
  {
    id: 'zero-locked',
    title: 'Zero-Error Reference (0.0 ms)',
    cause: 'Calibrated Beatgrid & Beat Sync',
    summary:
      'Downbeat anchors align sample-accurately on transient peaks with Beat Sync and Quantize active.',
    fixHint: 'Zero phase correction error achieved. Transients sum cleanly with zero comb-filtering.',
    patch: {
      masterBpm: 124.0,
      deck2BpmOffset: 0,
      deck2TrackDriftBpm: 0,
      gridOffsetMs: 0,
      syncMode: 'beat',
      gridMode: 'straight',
      quantize: true,
      audioLatencyMs: 0,
      elapsedBeats: 0,
    },
  },
];

export function wrapPhaseErrorMs(rawMs: number, beatDurationMs: number): number {
  if (beatDurationMs <= 0) return 0;
  const half = beatDurationMs / 2;
  let wrapped = ((rawMs + half) % beatDurationMs + beatDurationMs) % beatDurationMs - half;
  // Avoid -0
  if (Math.abs(wrapped) < 0.0001) wrapped = 0;
  return Number(wrapped.toFixed(2));
}

export function computePhaseMetrics(state: CalibrationState): PhaseMetrics {
  const beatDurationMs = 60000 / Math.max(40, state.masterBpm);

  // Determine effective BPM difference
  const syncLocksTempo = state.syncMode === 'tempo' || state.syncMode === 'beat';
  const baseBpmError = syncLocksTempo ? 0 : state.deck2BpmOffset;

  // Dynamic (Fluid) beatgrid absorbs human drummer drift; Straight grid leaves it uncorrected
  const uncompensatedTrackDriftBpm =
    state.gridMode === 'dynamic' ? 0 : state.deck2TrackDriftBpm;

  const effectiveDeck2Bpm = Number(
    (state.masterBpm + baseBpmError + uncompensatedTrackDriftBpm).toFixed(2)
  );

  // Drift per beat in ms when Deck 2 speed differs from Master
  const deck2BeatDurationMs = 60000 / Math.max(40, effectiveDeck2Bpm);
  const driftPerBeatMs = beatDurationMs - deck2BeatDurationMs;
  const driftPerBarMs = Number((driftPerBeatMs * 4).toFixed(2));

  // If Beat Sync + Quantize are on and there is no uncompensated track drift,
  // djay locks the grid markers together, leaving only mis-anchored beatgrid offset + hardware audio latency.
  const cumulativeSpeedDriftMs =
    state.syncMode === 'beat' && state.gridMode === 'dynamic'
      ? 0
      : driftPerBeatMs * state.elapsedBeats;

  // When Sync Mode is 'off' or 'tempo', any initial phase/grid offset plus speed drift persists.
  // Even in 'beat' sync, if the track's Beatgrid Anchor itself is shifted by gridOffsetMs,
  // djay aligns the wrong grid marker to Master's right grid marker, producing gridOffsetMs error!
  const rawPhaseError = state.gridOffsetMs + state.audioLatencyMs + cumulativeSpeedDriftMs;
  const phaseErrorMs = wrapPhaseErrorMs(rawPhaseError, beatDurationMs);
  const absErrorMs = Number(Math.abs(phaseErrorMs).toFixed(2));

  const phaseAngleDeg = Number(((phaseErrorMs / beatDurationMs) * 360).toFixed(1));

  // Comb-filtering first cancellation notch f = 1 / (2 * delta_t)
  const combFilterHz =
    absErrorMs >= 0.05 ? Math.round(1000 / (2 * absErrorMs)) : null;

  let status: PhaseStatus = 'locked';
  let statusLabel = 'Phase Locked (0.0 ms)';
  if (absErrorMs >= 12 || Math.abs(driftPerBarMs) >= 4) {
    status = 'drifting';
    statusLabel = Math.abs(driftPerBarMs) >= 4 ? 'Phase Drifting' : 'Severe Phase Offset';
  } else if (absErrorMs >= 0.5) {
    status = 'micro-flam';
    statusLabel = 'Micro-Flamming';
  }

  return {
    phaseErrorMs,
    absErrorMs,
    phaseAngleDeg,
    driftPerBarMs,
    effectiveDeck2Bpm,
    combFilterHz,
    status,
    statusLabel,
    correctionNeededMs: Number((-phaseErrorMs).toFixed(2)),
  };
}

/**
 * Generates deterministic synthetic kick + hi-hat waveform amplitude at a given beat phase [0, 1).
 * Used for both Canvas stacked waveform rendering and inspection tests.
 */
export function sampleDeckTransient(beatPhase: number): number {
  // Normalize phase to [0, 1)
  const p = ((beatPhase % 1) + 1) % 1;

  // Sharp kick drum transient at beat start (0.00 to 0.18 of beat)
  if (p < 0.18) {
    const t = p / 0.18;
    const envelope = Math.exp(-t * 5.2);
    const carrier = Math.sin(t * Math.PI * 5.5);
    return envelope * carrier;
  }

  // Subtle 16th perc transient at 0.25
  if (p >= 0.25 && p < 0.32) {
    const t = (p - 0.25) / 0.07;
    return Math.exp(-t * 6.5) * 0.26 * Math.sin(t * Math.PI * 11.0);
  }

  // Crisp off-beat hi-hat at 0.50 to 0.60
  if (p >= 0.5 && p < 0.6) {
    const t = (p - 0.5) / 0.1;
    const envelope = Math.exp(-t * 7.0) * 0.48;
    const carrier = Math.sin(t * Math.PI * 19.0);
    return envelope * carrier;
  }

  // Subtle 16th perc transient at 0.75
  if (p >= 0.75 && p < 0.82) {
    const t = (p - 0.75) / 0.07;
    return Math.exp(-t * 6.5) * 0.28 * Math.sin(t * Math.PI * 13.0);
  }

  // Quiet sub tail
  return Math.sin(p * Math.PI * 4) * 0.05;
}

export function calculateDriftMath(bpm: number, bpmDelta: number, bars: number) {
  const safeBpm = Math.max(40, bpm);
  const beatMs = 60000 / safeBpm;
  const barMs = beatMs * 4;
  const thirtySecondMs = beatMs / 8;

  const deck2BeatMs = 60000 / Math.max(40, safeBpm + bpmDelta);
  const driftPerBeatMs = beatMs - deck2BeatMs;
  const totalDriftMs = driftPerBeatMs * bars * 4;
  const absDriftMs = Math.abs(totalDriftMs);
  const firstNotchHz = absDriftMs >= 0.1 ? Math.round(1000 / (2 * absDriftMs)) : null;

  return {
    beatMs: Number(beatMs.toFixed(2)),
    barMs: Number(barMs.toFixed(2)),
    thirtySecondMs: Number(thirtySecondMs.toFixed(2)),
    driftPerBeatMs: Number(driftPerBeatMs.toFixed(3)),
    totalDriftMs: Number(totalDriftMs.toFixed(2)),
    firstNotchHz,
  };
}

/**
 * Maps a continuous beat index onto an exact track timestamp in seconds using
 * piecewise-linear interpolation across real detected beat transients (eliminating
 * drift on tracks with imperfect BPM or live drummers).
 */
export function getTimeAtBeatPosition(
  beatPos: number,
  beatTimesSec: number[],
  fallbackBpm: number,
  anchorMs = 0
): number {
  const beatSec = 60 / Math.max(40, fallbackBpm);
  if (beatTimesSec.length >= 2) {
    const maxIdx = beatTimesSec.length - 1;
    if (beatPos <= 0) {
      return beatTimesSec[0] + beatPos * beatSec;
    }
    if (beatPos >= maxIdx) {
      const localBeat = beatTimesSec[maxIdx] - beatTimesSec[maxIdx - 1];
      return beatTimesSec[maxIdx] + (beatPos - maxIdx) * (localBeat > 0.25 ? localBeat : beatSec);
    }
    const lo = Math.floor(beatPos);
    const frac = beatPos - lo;
    return beatTimesSec[lo] + frac * (beatTimesSec[lo + 1] - beatTimesSec[lo]);
  }
  return anchorMs / 1000 + beatPos * beatSec;
}

/**
 * Inverse mapping: converts an actual playback timestamp in seconds into a
 * continuous beat position using detected beat timestamps.
 */
export function getBeatPositionAtTime(
  timeSec: number,
  beatTimesSec: number[],
  fallbackBpm: number,
  anchorMs = 0
): number {
  const beatSec = 60 / Math.max(40, fallbackBpm);
  if (beatTimesSec.length >= 2) {
    if (timeSec <= beatTimesSec[0]) {
      return (timeSec - beatTimesSec[0]) / beatSec;
    }
    const lastIdx = beatTimesSec.length - 1;
    if (timeSec >= beatTimesSec[lastIdx]) {
      const localBeat = beatTimesSec[lastIdx] - beatTimesSec[lastIdx - 1];
      return lastIdx + (timeSec - beatTimesSec[lastIdx]) / (localBeat > 0.25 ? localBeat : beatSec);
    }
    // Binary search for enclosing beat interval
    let lo = 0;
    let hi = lastIdx;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (beatTimesSec[mid] <= timeSec) lo = mid;
      else hi = mid;
    }
    const span = beatTimesSec[lo + 1] - beatTimesSec[lo];
    return lo + (span > 1e-6 ? (timeSec - beatTimesSec[lo]) / span : 0);
  }
  return (timeSec - anchorMs / 1000) / beatSec;
}

export type CorrectionState = 'locked' | 'steering' | 'snapped' | 'off';

export interface PllTelemetry {
  livePhaseErrorMs: number;
  rateTrimPct: number;
  peakDriftMs: number;
  hardSnapCount: number;
  correctionState: CorrectionState;
  activeLoopMode: 'Serato Auto-Nudge' | 'Dynamic Grid Lock' | 'Static Grid' | 'Uncorrected';
  maxTrimPct: number;
}

export interface PllCorrectionResult {
  phaseErrorMs: number;
  correctedRate: number;
  requiresHardSnap: boolean;
  targetTimeSec: number;
  nextIntegralErrSec: number;
}

/**
 * Serato-style Continuous Micro-Nudge (PI-PLL) controller for Deck 2 vs Master Deck 1.
 * Pulls phase continuously to 0.00 ms without audible pitch warble:
 * - Proportional micro-nudge is capped at ±0.20% (never jumping to 2.5%!)
 * - Total rate trim is strictly bounded by maxTrimPct (default ±0.50% max, ±0.25% in UI)
 * - Errors > 15 ms trigger a click-free sample-accurate beat snap instead of big pitch swings.
 */
export function computePllCorrection(params: {
  masterBeatPos: number;
  deck2ActualTimeSec: number;
  deck2BaseRate: number;
  deck2BeatTimesSec: number[];
  deck2FallbackBpm: number;
  deck2AnchorMs: number;
  deck2DurationSec: number;
  desiredOffsetMs: number;
  pllEnabled: boolean;
  integralErrSec?: number;
  dtSec?: number;
  maxTrimPct?: number;
}): PllCorrectionResult {
  const {
    masterBeatPos,
    deck2ActualTimeSec,
    deck2BaseRate,
    deck2BeatTimesSec,
    deck2FallbackBpm,
    deck2AnchorMs,
    deck2DurationSec,
    desiredOffsetMs,
    pllEnabled,
    integralErrSec = 0,
    dtSec = 0.05,
    maxTrimPct = 0.5,
  } = params;

  const rawTargetSec =
    getTimeAtBeatPosition(masterBeatPos, deck2BeatTimesSec, deck2FallbackBpm, deck2AnchorMs) -
    desiredOffsetMs / 1000;

  const safeDur = Math.max(0.1, deck2DurationSec);
  const targetTimeSec = ((rawTargetSec % safeDur) + safeDur) % safeDur;
  const actualWrapped = ((deck2ActualTimeSec % safeDur) + safeDur) % safeDur;

  // Shortest signed wrap error across track loop boundary
  let errSec = targetTimeSec - actualWrapped;
  if (errSec > safeDur / 2) errSec -= safeDur;
  if (errSec < -safeDur / 2) errSec += safeDur;

  const beatDurationMs = 60000 / Math.max(40, deck2FallbackBpm);
  const rawPhaseErrorMs = wrapPhaseErrorMs(-errSec * 1000, beatDurationMs);
  const phaseErrorMs = Math.abs(rawPhaseErrorMs) < 0.005 ? 0 : rawPhaseErrorMs;

  if (!pllEnabled) {
    return {
      phaseErrorMs,
      correctedRate: deck2BaseRate,
      requiresHardSnap: false,
      targetTimeSec,
      nextIntegralErrSec: 0,
    };
  }

  const absErrMs = Math.abs(errSec * 1000);
  if (absErrMs > 15) {
    return {
      phaseErrorMs: 0,
      correctedRate: deck2BaseRate,
      requiresHardSnap: true,
      targetTimeSec,
      nextIntegralErrSec: 0,
    };
  }

  // Pitch-transparent Serato micro-nudge: Kp = 8.5, Ki = 20.0
  // Strictly bounded by ±maxTrimPct (default UI ceiling ±0.25%, max ±0.50% — never 2.5%!)
  const maxTrimFrac = Math.max(0.0005, Math.min(0.01, maxTrimPct / 100));
  const maxPropFrac = maxTrimFrac;
  const kp = 8.5;
  const ki = 20.0;
  const maxIntSec = maxTrimFrac / ki;

  const clampedDt = Math.min(0.1, Math.max(0.002, dtSec));
  const nextIntegralErrSec = Math.max(
    -maxIntSec,
    Math.min(maxIntSec, integralErrSec + errSec * clampedDt)
  );
  const propAdjust = Math.max(-maxPropFrac, Math.min(maxPropFrac, errSec * kp));
  const integAdjust = nextIntegralErrSec * ki;
  const rateAdjust = Math.max(-maxTrimFrac, Math.min(maxTrimFrac, propAdjust + integAdjust));

  return {
    phaseErrorMs,
    correctedRate: Number((deck2BaseRate * (1 + rateAdjust)).toFixed(7)),
    requiresHardSnap: false,
    targetTimeSec,
    nextIntegralErrSec,
  };
}
