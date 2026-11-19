import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { DeckLoaderPanel, type DeckUiInfo } from './components/DeckLoaderPanel';
import { AudioLooperSlot, type LooperUiInfo } from './components/AudioLooperSlot';
import { PhaseCanvasStage, type LoadedTracksRefPayload } from './components/PhaseCanvasStage';
import { CalibrationControls } from './components/CalibrationControls';
import { DjayGuideSection } from './components/DjayGuideSection';
import { DriftCalculatorSection } from './components/DriftCalculatorSection';
import {
  findOptimalSemitoneMatch,
  matchRhythmicStartingPoint,
  transposeKeyInfo,
} from './utils/audioAnalysis';
import {
  audioEngine,
  computeDetectedLoopBeats,
  type LoadedDeckTrack,
  type LooperBlendMode,
  type WorkletParamsPayload,
} from './utils/audioEngine';
import {
  type CalibrationState,
  computePhaseMetrics,
  computePllCorrection,
  DIAGNOSTIC_SCENARIOS,
  getBeatPositionAtTime,
  getTimeAtBeatPosition,
  type GridMode,
  type PllTelemetry,
  type SyncMode,
  wrapPhaseErrorMs,
} from './utils/phaseMath';

const INITIAL_SCENARIO = DIAGNOSTIC_SCENARIOS[0];

const INITIAL_STATE: CalibrationState = {
  scenarioId: INITIAL_SCENARIO.id,
  masterBpm: 124.0,
  deck2BpmOffset: 0,
  deck2TrackDriftBpm: 0,
  gridOffsetMs: 14.2,
  syncMode: 'beat',
  gridMode: 'straight',
  quantize: true,
  audioLatencyMs: 0,
  zoomLevel: 4,
  elapsedBeats: 0,
  ...INITIAL_SCENARIO.patch,
};

const EMPTY_DECK: DeckUiInfo = {
  track: null,
  loading: false,
  error: null,
  manualBpm: null,
  manualAnchorMs: null,
  startBeatOffset: 0,
  tempoMultiplier: 1,
  rhythmMatchPct: null,
  keyLock: true,
  keyShiftSemitones: 0,
};

const EMPTY_LOOPER: LooperUiInfo = {
  ...EMPTY_DECK,
  active: true,
  gain: 0.85,
  loopBeatsOverride: 0,
  blendMode: 'auto',
};

function computeSoloStartBeat(track: LoadedDeckTrack): number {
  let start = track.barRhythm.downbeatIndex;
  while (
    start + 4 <= track.barRhythm.onsetBodyBeatIndex &&
    start + 4 < track.beatTimesSec.length
  ) {
    start += 4;
  }
  return start;
}

const INITIAL_TELEMETRY: PllTelemetry = {
  livePhaseErrorMs: 14.2,
  rateTrimPct: 0,
  peakDriftMs: 14.2,
  hardSnapCount: 0,
  correctionState: 'steering',
  activeLoopMode: 'Static Grid',
  maxTrimPct: 0.25,
};

function formatBarBeat(elapsedBeats: number): string {
  const wholeBeat = Math.floor(elapsedBeats);
  const bar = Math.floor(wholeBeat / 4) + 1;
  const beat = (wholeBeat % 4) + 1;
  const sub = Math.floor((elapsedBeats - wholeBeat) * 4) + 1;
  return `${String(bar).padStart(2, '0')}.${beat}.${sub}`;
}

function getAdjustedBeatTimes(
  track: LoadedDeckTrack | null,
  activeBpm: number,
  activeAnchorMs: number
): number[] {
  if (!track || track.beatTimesSec.length < 2) return [];
  // If user overrode BPM (e.g. x2 / /2 / Tap), use straight grid at manual BPM
  if (Math.abs(activeBpm - track.detectedBpm) > 0.01) return [];
  const deltaSec = (activeAnchorMs - track.firstTransientMs) / 1000;
  if (Math.abs(deltaSec) < 0.0001) return track.beatTimesSec;
  return track.beatTimesSec.map((t) => Math.max(0, t + deltaSec));
}

function deriveStaticTelemetry(
  cur: CalibrationState,
  curMetrics: ReturnType<typeof computePhaseMetrics>,
  prevPeakMs: number,
  snapCount: number,
  maxTrimPct: number,
  autoNudgeEnabled: boolean
): PllTelemetry {
  const rateTrimPct =
    cur.syncMode === 'beat' && cur.gridMode === 'dynamic' && cur.deck2TrackDriftBpm !== 0
      ? Number(
          Math.max(
            -maxTrimPct,
            Math.min(maxTrimPct, (-cur.deck2TrackDriftBpm / Math.max(40, cur.masterBpm)) * 100)
          ).toFixed(2)
        )
      : 0;
  const correctionState =
    cur.syncMode !== 'beat' || !autoNudgeEnabled
      ? 'off'
      : curMetrics.absErrorMs >= 0.5
        ? 'steering'
        : 'locked';
  const activeLoopMode =
    cur.syncMode !== 'beat' || !autoNudgeEnabled
      ? 'Uncorrected'
      : cur.gridMode === 'dynamic'
        ? 'Dynamic Grid Lock'
        : 'Static Grid';

  return {
    livePhaseErrorMs: curMetrics.phaseErrorMs,
    rateTrimPct,
    peakDriftMs: Number(Math.max(prevPeakMs, curMetrics.absErrorMs).toFixed(2)),
    hardSnapCount: snapCount,
    correctionState,
    activeLoopMode,
    maxTrimPct,
  };
}

function telemetryEquals(a: PllTelemetry, b: PllTelemetry): boolean {
  return (
    a.livePhaseErrorMs === b.livePhaseErrorMs &&
    a.rateTrimPct === b.rateTrimPct &&
    a.peakDriftMs === b.peakDriftMs &&
    a.hardSnapCount === b.hardSnapCount &&
    a.correctionState === b.correctionState &&
    a.activeLoopMode === b.activeLoopMode &&
    a.maxTrimPct === b.maxTrimPct
  );
}

export default function App() {
  const [state, setState] = useState<CalibrationState>(INITIAL_STATE);
  const [deck1Playing, setDeck1Playing] = useState<boolean>(false);
  const [deck2Playing, setDeck2Playing] = useState<boolean>(false);
  const [looperPlaying, setLooperPlaying] = useState<boolean>(false);
  const isPlaying = deck1Playing || deck2Playing || looperPlaying;

  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const [barBeatDisplay, setBarBeatDisplay] = useState<string>('01.1.1');
  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>({});
  const [pllTelemetry, setPllTelemetry] = useState<PllTelemetry>(INITIAL_TELEMETRY);
  const [autoNudgeEnabled, setAutoNudgeEnabled] = useState<boolean>(true);
  const [maxNudgeTrimPct, setMaxNudgeTrimPct] = useState<number>(0.25);

  const [deck1, setDeck1] = useState<DeckUiInfo>(EMPTY_DECK);
  const [deck2, setDeck2] = useState<DeckUiInfo>(EMPTY_DECK);
  const [looper, setLooper] = useState<LooperUiInfo>(EMPTY_LOOPER);
  const [crossfader, setCrossfader] = useState<number>(0);

  const stateRef = useRef<CalibrationState>(INITIAL_STATE);
  stateRef.current = state;
  const elapsedBeatsRef = useRef<number>(INITIAL_STATE.elapsedBeats);
  if (!isPlaying) {
    elapsedBeatsRef.current = state.elapsedBeats;
  }

  const deck1PlayingRef = useRef<boolean>(false);
  deck1PlayingRef.current = deck1Playing;
  const deck2PlayingRef = useRef<boolean>(false);
  deck2PlayingRef.current = deck2Playing;
  const looperPlayingRef = useRef<boolean>(false);
  looperPlayingRef.current = looperPlaying;
  const isPlayingRef = useRef<boolean>(false);
  isPlayingRef.current = isPlaying;
  const audioEnabledRef = useRef<boolean>(false);
  audioEnabledRef.current = audioEnabled;

  const autoNudgeRef = useRef<boolean>(true);
  autoNudgeRef.current = autoNudgeEnabled;
  const maxTrimPctRef = useRef<number>(0.25);
  maxTrimPctRef.current = maxNudgeTrimPct;

  const integralErrRef = useRef<number>(0);
  const lastSnapAtRef = useRef<number>(-10000);
  const pllTelemetryRef = useRef<PllTelemetry>(INITIAL_TELEMETRY);

  const deck1Bpm = deck1.manualBpm ?? deck1.track?.exactBpm ?? state.masterBpm;
  const deck2Bpm = deck2.manualBpm ?? deck2.track?.exactBpm ?? state.masterBpm;
  const looperBpm = looper.manualBpm ?? looper.track?.exactBpm ?? state.masterBpm;
  const deck1AnchorMs = deck1.manualAnchorMs ?? deck1.track?.firstTransientMs ?? 0;
  const deck2AnchorMs = deck2.manualAnchorMs ?? deck2.track?.firstTransientMs ?? 0;
  const looperAnchorMs = looper.manualAnchorMs ?? looper.track?.firstTransientMs ?? 0;

  const deck1BeatTimes = useMemo(
    () => getAdjustedBeatTimes(deck1.track, deck1Bpm, deck1AnchorMs),
    [deck1.track, deck1Bpm, deck1AnchorMs]
  );
  const deck2BeatTimes = useMemo(
    () => getAdjustedBeatTimes(deck2.track, deck2Bpm, deck2AnchorMs),
    [deck2.track, deck2Bpm, deck2AnchorMs]
  );
  const looperBeatTimes = useMemo(
    () => getAdjustedBeatTimes(looper.track, looperBpm, looperAnchorMs),
    [looper.track, looperBpm, looperAnchorMs]
  );

  const looperEffectiveLoopBeats = useMemo(() => {
    if (!looper.track) return 16;
    if (looper.loopBeatsOverride > 0) return looper.loopBeatsOverride;
    return computeDetectedLoopBeats(looper.track.durationSec, looperBpm, looperAnchorMs);
  }, [looper.track, looper.loopBeatsOverride, looperBpm, looperAnchorMs]);

  const deck1Ref = useRef<DeckUiInfo>(deck1);
  deck1Ref.current = deck1;
  const deck2Ref = useRef<DeckUiInfo>(deck2);
  deck2Ref.current = deck2;
  const looperRef = useRef<LooperUiInfo>(looper);
  looperRef.current = looper;

  const tracksRef = useRef<LoadedTracksRefPayload>({
    deck1: null,
    deck2: null,
    looper: null,
    deck1Bpm,
    deck2Bpm,
    looperBpm,
    deck1AnchorMs,
    deck2AnchorMs,
    looperAnchorMs,
    deck1BeatTimes,
    deck2BeatTimes,
    deck1StartBeat: 0,
    deck2StartBeat: 0,
    looperStartBeat: 0,
    deck1TempoMult: 1,
    deck2TempoMult: 1,
    looperTempoMult: 1,
    looperLoopBeats: 16,
    looperActive: true,
    deck1Playing: false,
    deck2Playing: false,
  });

  tracksRef.current = {
    deck1: deck1.track,
    deck2: deck2.track,
    looper: looper.track,
    deck1Bpm,
    deck2Bpm,
    looperBpm,
    deck1AnchorMs,
    deck2AnchorMs,
    looperAnchorMs,
    deck1BeatTimes,
    deck2BeatTimes,
    deck1StartBeat: deck1.startBeatOffset,
    deck2StartBeat: deck2.startBeatOffset,
    looperStartBeat: looper.startBeatOffset,
    deck1TempoMult: deck1.tempoMultiplier,
    deck2TempoMult: deck2.tempoMultiplier,
    looperTempoMult: looper.tempoMultiplier,
    looperLoopBeats: looperEffectiveLoopBeats,
    looperActive: looper.active,
    deck1Playing,
    deck2Playing,
  };

  const metrics = useMemo(() => computePhaseMetrics(state), [state]);
  const isSynced = state.syncMode === 'beat' && metrics.absErrorMs === 0;
  const hasDualTracksPlaying =
    deck1Playing && deck2Playing && audioEnabled && Boolean(deck1.track && deck2.track);

  // Keep telemetry in sync when paused or when calibration sliders change
  useEffect(() => {
    if (hasDualTracksPlaying) return;
    const nextTel = deriveStaticTelemetry(
      state,
      metrics,
      isPlaying ? pllTelemetryRef.current.peakDriftMs : metrics.absErrorMs,
      isPlaying ? pllTelemetryRef.current.hardSnapCount : 0,
      maxNudgeTrimPct,
      autoNudgeEnabled
    );
    pllTelemetryRef.current = nextTel;
    setPllTelemetry(nextTel);
  }, [state, metrics, isPlaying, hasDualTracksPlaying, maxNudgeTrimPct, autoNudgeEnabled]);

  const buildWorkletParams = useCallback(
    (
      curState: CalibrationState,
      t: LoadedTracksRefPayload,
      autoNudge: boolean,
      maxTrim: number,
      xfade: number
    ): WorkletParamsPayload => {
      const useTracked1 = Boolean(
        t.deck1 && (!t.deck1.isConstantTempo || curState.gridMode === 'dynamic')
      );
      const useTracked2 = Boolean(
        t.deck2 && (!t.deck2.isConstantTempo || curState.gridMode === 'dynamic')
      );
      const lpCur = looperRef.current;
      const lpBpm = lpCur.manualBpm ?? lpCur.track?.exactBpm ?? curState.masterBpm;
      const lpAnchorMs = lpCur.manualAnchorMs ?? lpCur.track?.firstTransientMs ?? 0;
      const lpBeatTimes = getAdjustedBeatTimes(lpCur.track, lpBpm, lpAnchorMs);
      const useTrackedLooper = Boolean(
        lpCur.track && (!lpCur.track.isConstantTempo || curState.gridMode === 'dynamic')
      );
      const deck2TargetBpm =
        curState.syncMode !== 'off'
          ? curState.masterBpm
          : curState.masterBpm +
            curState.deck2BpmOffset +
            (curState.gridMode === 'dynamic' ? 0 : curState.deck2TrackDriftBpm);

      return {
        masterBpm: curState.masterBpm,
        deck2TargetBpm,
        syncMode: curState.syncMode,
        gridMode: curState.gridMode,
        autoNudgeEnabled: autoNudge,
        maxTrimPct: maxTrim,
        desiredOffsetMs: curState.gridOffsetMs + curState.audioLatencyMs,
        crossfader: xfade,
        deck1Grid: t.deck1
          ? {
              bpm: t.deck1Bpm,
              anchorMs: t.deck1AnchorMs,
              useBeatTimes: useTracked1,
              beatTimesSec: t.deck1BeatTimes,
              startBeatOffset: deck1Ref.current.startBeatOffset,
              tempoMultiplier: deck1Ref.current.tempoMultiplier,
              keyLock: deck1Ref.current.keyLock,
              keyShiftSemitones: deck1Ref.current.keyShiftSemitones,
            }
          : undefined,
        deck2Grid: t.deck2
          ? {
              bpm: t.deck2Bpm,
              anchorMs: t.deck2AnchorMs,
              useBeatTimes: useTracked2,
              beatTimesSec: t.deck2BeatTimes,
              startBeatOffset: deck2Ref.current.startBeatOffset,
              tempoMultiplier: deck2Ref.current.tempoMultiplier,
              keyLock: deck2Ref.current.keyLock,
              keyShiftSemitones: deck2Ref.current.keyShiftSemitones,
            }
          : undefined,
        looperGrid: lpCur.track
          ? {
              bpm: lpBpm,
              anchorMs: lpAnchorMs,
              useBeatTimes: useTrackedLooper,
              beatTimesSec: lpBeatTimes,
              startBeatOffset: lpCur.startBeatOffset,
              tempoMultiplier: lpCur.tempoMultiplier,
              keyLock: lpCur.keyLock,
              keyShiftSemitones: lpCur.keyShiftSemitones,
              active: lpCur.active,
              gain: lpCur.gain,
              loopBeatsOverride: lpCur.loopBeatsOverride,
              blendMode: lpCur.blendMode,
            }
          : undefined,
      };
    },
    []
  );

  // Helper to start/re-sync real loaded AudioBuffers cleanly
  const syncLiveAudioSources = useCallback(
    (curState: CalibrationState, curMetrics: ReturnType<typeof computePhaseMetrics>) => {
      if (!audioEngine.isEnabled() || !audioEngine.hasAnyLoadedTrack()) return;

      const t = tracksRef.current;

      if (audioEngine.isUsingWorklet()) {
        audioEngine.updateWorkletParams(
          buildWorkletParams(
            curState,
            t,
            autoNudgeRef.current,
            maxTrimPctRef.current,
            crossfader
          )
        );
        audioEngine.startWorkletTransport({
          elapsedBeats: curState.elapsedBeats,
          initialPhaseErrorMs: curMetrics.phaseErrorMs,
          resetCounters: true,
          deck1Playing: deck1PlayingRef.current,
          deck2Playing: deck2PlayingRef.current,
          looperPlaying: looperPlayingRef.current,
        });
        return;
      }

      const d1Bpm = Math.max(40, t.deck1Bpm);
      const d2Bpm = Math.max(40, t.deck2Bpm);

      // Straight constant-tempo studio tracks use zero-jitter exact linear grids;
      // Dynamic/drifting recordings use smoothed beat-tracked timestamps
      const useTracked1 = Boolean(t.deck1 && (!t.deck1.isConstantTempo || curState.gridMode === 'dynamic'));
      const useTracked2 = Boolean(t.deck2 && (!t.deck2.isConstantTempo || curState.gridMode === 'dynamic'));

      const deck1Start = deck1Ref.current.startBeatOffset;
      const deck2Start = deck2Ref.current.startBeatOffset;
      const deck1Mult = deck1Ref.current.tempoMultiplier;
      const deck2Mult = deck2Ref.current.tempoMultiplier;

      const deck1OffsetSec = t.deck1
        ? getTimeAtBeatPosition(
            curState.elapsedBeats * deck1Mult + deck1Start,
            useTracked1 ? t.deck1BeatTimes : [],
            d1Bpm,
            t.deck1AnchorMs
          )
        : 0;

      const deck2OffsetSec = t.deck2
        ? getTimeAtBeatPosition(
            curState.elapsedBeats * deck2Mult + deck2Start,
            useTracked2 ? t.deck2BeatTimes : [],
            d2Bpm,
            t.deck2AnchorMs
          ) -
          curMetrics.phaseErrorMs / 1000
        : 0;

      const unroundedDeck2MasterBpm =
        curState.syncMode !== 'off'
          ? curState.masterBpm
          : curState.masterBpm +
            curState.deck2BpmOffset +
            (curState.gridMode === 'dynamic' ? 0 : curState.deck2TrackDriftBpm);

      const deck1Rate = (curState.masterBpm * deck1Mult) / d1Bpm;
      const deck2Rate = (unroundedDeck2MasterBpm * deck2Mult) / d2Bpm;
      const deck1DetuneCents =
        deck1Ref.current.keyShiftSemitones * 100 -
        (deck1Ref.current.keyLock ? 1200 * Math.log2(Math.max(0.25, deck1Rate)) : 0);
      const deck2DetuneCents =
        deck2Ref.current.keyShiftSemitones * 100 -
        (deck2Ref.current.keyLock ? 1200 * Math.log2(Math.max(0.25, deck2Rate)) : 0);

      const lpCur = looperRef.current;
      const lpBpm = Math.max(40, lpCur.manualBpm ?? lpCur.track?.exactBpm ?? curState.masterBpm);
      const lpAnchorMs = lpCur.manualAnchorMs ?? lpCur.track?.firstTransientMs ?? 0;
      const lpBeatTimes = getAdjustedBeatTimes(lpCur.track, lpBpm, lpAnchorMs);
      const useTrackedLooper = Boolean(
        lpCur.track && (!lpCur.track.isConstantTempo || curState.gridMode === 'dynamic')
      );
      const lpRate = (curState.masterBpm * lpCur.tempoMultiplier) / lpBpm;
      const lpDetuneCents =
        lpCur.keyShiftSemitones * 100 -
        (lpCur.keyLock ? 1200 * Math.log2(Math.max(0.25, lpRate)) : 0);
      const lpLoopBeats = lpCur.track
        ? lpCur.loopBeatsOverride > 0
          ? lpCur.loopBeatsOverride
          : computeDetectedLoopBeats(lpCur.track.durationSec, lpBpm, lpAnchorMs)
        : 16;
      const lpOffsetSec = lpCur.track
        ? getTimeAtBeatPosition(
            ((curState.elapsedBeats * lpCur.tempoMultiplier + lpCur.startBeatOffset) %
              lpLoopBeats +
              lpLoopBeats) %
              lpLoopBeats,
            useTrackedLooper ? lpBeatTimes : [],
            lpBpm,
            lpAnchorMs
          )
        : 0;

      integralErrRef.current = 0;

      audioEngine.startTrackSources({
        deck1OffsetSec,
        deck2OffsetSec,
        deck1Rate,
        deck2Rate,
        deck1Playing: deck1PlayingRef.current,
        deck2Playing: deck2PlayingRef.current,
        deck1DetuneCents,
        deck2DetuneCents,
        looperOffsetSec: lpOffsetSec,
        looperRate: lpRate,
        looperDetuneCents: lpDetuneCents,
        looperLoopDurationSec: (lpLoopBeats * 60) / lpBpm,
        looperGain: lpCur.gain,
        looperActive: lpCur.active,
      });
    },
    [buildWorkletParams, crossfader]
  );

  // Transport clock + single-owner audio telemetry sync (zero 10 Hz root React re-renders)
  useEffect(() => {
    if (!isPlaying) {
      audioEngine.stopTrackSources();
      integralErrRef.current = 0;
      return;
    }

    let rafId = 0;
    let lastTime = performance.now();
    let lastCtxTime = audioEngine.getContextTimeSec() ?? 0;
    let lastUiSync = lastTime;
    let lastWholeBeat = Math.floor(elapsedBeatsRef.current);

    if (audioEngine.isEnabled() && audioEngine.hasAnyLoadedTrack()) {
      syncLiveAudioSources(
        { ...stateRef.current, elapsedBeats: elapsedBeatsRef.current },
        computePhaseMetrics(stateRef.current)
      );
      lastCtxTime = audioEngine.getContextTimeSec() ?? lastCtxTime;
    }

    const stepControlLoop = (now: number) => {
      const wallDtSec = Math.min(0.1, Math.max(0.004, (now - lastTime) / 1000));
      lastTime = now;

      const ctxNow = audioEngine.getContextTimeSec();
      let audioDtSec = wallDtSec;
      if (ctxNow !== null && lastCtxTime > 0 && ctxNow >= lastCtxTime) {
        audioDtSec = Math.min(0.1, ctxNow - lastCtxTime);
        lastCtxTime = ctxNow;
      } else if (ctxNow !== null) {
        lastCtxTime = ctxNow;
      }

      const cur = stateRef.current;
      const t = tracksRef.current;
      const curBeats = elapsedBeatsRef.current;
      let nextBeats = curBeats + wallDtSec * (cur.masterBpm / 60);

      if (audioEngine.isUsingWorklet() && (t.deck1 || t.deck2 || t.looper)) {
        // Single-transport-owner: AudioWorklet advances masterBeatPos & locks Deck 2 + Looper in the audio thread
        const wt = audioEngine.getWorkletTelemetry();
        if (wt) {
          const dtSinceTelemetrySec = Math.min(0.08, Math.max(0, (now - wt.receivedAtPerfMs) / 1000));
          nextBeats = wt.masterBeatPos + dtSinceTelemetrySec * (cur.masterBpm / 60);

          if (deck1PlayingRef.current && deck2PlayingRef.current && t.deck1 && t.deck2) {
            const nudgeActive = cur.syncMode === 'beat' && autoNudgeRef.current;
            const activeTrimCap = maxTrimPctRef.current;
            const prevTel = pllTelemetryRef.current;
            const absLiveErr = Math.abs(wt.livePhaseErrorMs);
            const nextPeak = Math.max(prevTel.peakDriftMs, absLiveErr);

            pllTelemetryRef.current = {
              livePhaseErrorMs: wt.livePhaseErrorMs,
              rateTrimPct: wt.rateTrimPct,
              peakDriftMs: Number(nextPeak.toFixed(2)),
              hardSnapCount: wt.hardSnapCount,
              correctionState: !nudgeActive
                ? 'off'
                : wt.justSnapped
                  ? 'snapped'
                  : absLiveErr >= 0.1 || Math.abs(wt.rateTrimPct) >= 0.02
                    ? 'steering'
                    : 'locked',
              activeLoopMode: nudgeActive ? 'Serato Auto-Nudge' : 'Uncorrected',
              maxTrimPct: activeTrimCap,
            };
          } else {
            const curMetrics = computePhaseMetrics({ ...cur, elapsedBeats: nextBeats });
            pllTelemetryRef.current = deriveStaticTelemetry(
              cur,
              curMetrics,
              pllTelemetryRef.current.peakDriftMs,
              pllTelemetryRef.current.hardSnapCount,
              maxTrimPctRef.current,
              autoNudgeRef.current
            );
          }
        }
      } else if (audioEngine.isEnabled() && t.deck1) {
        // Fallback hardware-clock BufferSource loop
        const d1Time = audioEngine.getDeckTimeSec(1, ctxNow ?? undefined);
        if (d1Time !== null) {
          const useTracked1 = !t.deck1.isConstantTempo || cur.gridMode === 'dynamic';
          nextBeats = getBeatPositionAtTime(
            d1Time,
            useTracked1 ? t.deck1BeatTimes : [],
            t.deck1Bpm,
            t.deck1AnchorMs
          );
        }

        if (t.deck2) {
          const d2Time = audioEngine.getDeckTimeSec(2, ctxNow ?? undefined);
          if (d2Time !== null) {
            const unroundedDeck2MasterBpm =
              cur.syncMode !== 'off'
                ? cur.masterBpm
                : cur.masterBpm +
                  cur.deck2BpmOffset +
                  (cur.gridMode === 'dynamic' ? 0 : cur.deck2TrackDriftBpm);
            const deck2BaseRate = unroundedDeck2MasterBpm / Math.max(40, t.deck2Bpm);
            const useTracked2 = !t.deck2.isConstantTempo || cur.gridMode === 'dynamic';
            const nudgeActive = cur.syncMode === 'beat' && autoNudgeRef.current;
            const activeTrimCap = maxTrimPctRef.current;
            const desiredOffMs = cur.gridOffsetMs + cur.audioLatencyMs;
            const pll = computePllCorrection({
              masterBeatPos: nextBeats,
              deck2ActualTimeSec: d2Time,
              deck2BaseRate,
              deck2BeatTimesSec: useTracked2 ? t.deck2BeatTimes : [],
              deck2FallbackBpm: t.deck2Bpm,
              deck2AnchorMs: t.deck2AnchorMs,
              deck2DurationSec: t.deck2.durationSec,
              desiredOffsetMs: desiredOffMs,
              pllEnabled: nudgeActive,
              integralErrSec: integralErrRef.current,
              dtSec: Math.max(0.002, audioDtSec),
              maxTrimPct: activeTrimCap,
            });
            integralErrRef.current = pll.nextIntegralErrSec;

            let snapped = false;
            if (nudgeActive) {
              if (pll.requiresHardSnap) {
                snapped = audioEngine.resyncDeck2ToTime(pll.targetTimeSec, pll.correctedRate);
                if (snapped) lastSnapAtRef.current = now;
              } else {
                audioEngine.steerDeck2Rate(pll.correctedRate);
              }
            } else {
              audioEngine.steerDeck2Rate(deck2BaseRate);
            }

            const beatDurationMs = 60000 / Math.max(40, cur.masterBpm);
            const audibleErrMs = wrapPhaseErrorMs(
              pll.phaseErrorMs + desiredOffMs,
              beatDurationMs
            );
            const rateTrimPct =
              deck2BaseRate > 0 ? ((pll.correctedRate / deck2BaseRate) - 1) * 100 : 0;
            const prevTel = pllTelemetryRef.current;
            const nextSnapCount = prevTel.hardSnapCount + (snapped ? 1 : 0);
            const absLiveErr = Math.abs(audibleErrMs);
            const nextPeak = Math.max(prevTel.peakDriftMs, absLiveErr);
            const justSnapped = now - lastSnapAtRef.current < 650;

            pllTelemetryRef.current = {
              livePhaseErrorMs: audibleErrMs,
              rateTrimPct: Number(rateTrimPct.toFixed(3)),
              peakDriftMs: Number(nextPeak.toFixed(2)),
              hardSnapCount: nextSnapCount,
              correctionState: !nudgeActive
                ? 'off'
                : justSnapped
                  ? 'snapped'
                  : absLiveErr >= 0.1 || Math.abs(rateTrimPct) >= 0.02
                    ? 'steering'
                    : 'locked',
              activeLoopMode: nudgeActive ? 'Serato Auto-Nudge' : 'Uncorrected',
              maxTrimPct: activeTrimCap,
            };
          }
        }
      } else {
        const curMetrics = computePhaseMetrics({ ...cur, elapsedBeats: nextBeats });
        pllTelemetryRef.current = deriveStaticTelemetry(
          cur,
          curMetrics,
          pllTelemetryRef.current.peakDriftMs,
          pllTelemetryRef.current.hardSnapCount,
          maxTrimPctRef.current,
          autoNudgeRef.current
        );
      }

      // Update mutable refs in place without triggering 10 Hz full-React tree re-renders
      stateRef.current.elapsedBeats = nextBeats;
      elapsedBeatsRef.current = nextBeats;

      const wholeBeat = Math.floor(nextBeats);
      if (wholeBeat > lastWholeBeat) {
        lastWholeBeat = wholeBeat;
        const m = computePhaseMetrics(stateRef.current);
        audioEngine.triggerBeatPair(m.phaseErrorMs, wholeBeat % 4 === 0);
      }

      if (now - lastUiSync >= 100) {
        lastUiSync = now;
        const nextTel = pllTelemetryRef.current;
        setPllTelemetry((prevTel) => (telemetryEquals(prevTel, nextTel) ? prevTel : nextTel));
      }
    };

    const tick = (now: number) => {
      stepControlLoop(now);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    // Keep fallback PI-PLL running cleanly at 25 Hz if tab is backgrounded / RAF throttled
    const bgInterval = window.setInterval(() => {
      const now = performance.now();
      if (now - lastTime >= 35) {
        stepControlLoop(now);
      }
    }, 40);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearInterval(bgInterval);
      audioEngine.stopTrackSources();
      setBarBeatDisplay(formatBarBeat(elapsedBeatsRef.current));
      setState((prev) => ({ ...prev, elapsedBeats: elapsedBeatsRef.current }));
    };
  }, [isPlaying, syncLiveAudioSources]);

  useEffect(() => {
    return () => {
      audioEngine.dispose();
    };
  }, []);

  // Update audio parameters cleanly in real time without restarting or clicking AudioWorklet playback
  useEffect(() => {
    if (audioEngine.isUsingWorklet()) {
      audioEngine.updateWorkletParams(
        buildWorkletParams(
          state,
          tracksRef.current,
          autoNudgeEnabled,
          maxNudgeTrimPct,
          crossfader
        )
      );
      return;
    }
    if (!isPlaying || !audioEnabled || !audioEngine.hasAnyLoadedTrack()) return;
    syncLiveAudioSources(state, metrics);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.gridOffsetMs,
    state.audioLatencyMs,
    state.syncMode,
    state.gridMode,
    state.deck2BpmOffset,
    state.deck2TrackDriftBpm,
    state.masterBpm,
    deck1Bpm,
    deck2Bpm,
    deck1AnchorMs,
    deck2AnchorMs,
    deck1.startBeatOffset,
    deck1.tempoMultiplier,
    deck1.keyLock,
    deck1.keyShiftSemitones,
    deck2.startBeatOffset,
    deck2.tempoMultiplier,
    deck2.keyLock,
    deck2.keyShiftSemitones,
    looper.track,
    looperBpm,
    looperAnchorMs,
    looperBeatTimes,
    looper.startBeatOffset,
    looper.tempoMultiplier,
    looper.keyLock,
    looper.keyShiftSemitones,
    looper.active,
    looper.gain,
    looper.loopBeatsOverride,
    looper.blendMode,
    autoNudgeEnabled,
    maxNudgeTrimPct,
    crossfader,
    audioEnabled,
  ]);

  const applyTrackWithAutoRhythmMatch = useCallback(
    (deck: 1 | 2, track: LoadedDeckTrack) => {
      const soloStart = computeSoloStartBeat(track);
      const otherDeck = deck === 1 ? deck2Ref.current : deck1Ref.current;

      if (deck === 2 && otherDeck.track) {
        const match = matchRhythmicStartingPoint(
          otherDeck.track,
          track,
          otherDeck.startBeatOffset
        );
        const nextD2: DeckUiInfo = {
          track,
          loading: false,
          error: null,
          manualBpm: null,
          manualAnchorMs: track.firstTransientMs,
          startBeatOffset: match.startBeatOffset,
          tempoMultiplier: match.tempoMultiplier,
          rhythmMatchPct: match.matchScorePct,
          keyLock: deck2Ref.current.keyLock,
          keyShiftSemitones: 0,
        };
        deck2Ref.current = nextD2;
        setDeck2(nextD2);
        setDeck1((prev) => {
          const nextD1 = { ...prev, rhythmMatchPct: match.matchScorePct };
          deck1Ref.current = nextD1;
          return nextD1;
        });
      } else if (deck === 1 && otherDeck.track) {
        const match = matchRhythmicStartingPoint(track, otherDeck.track, soloStart);
        const nextD1: DeckUiInfo = {
          track,
          loading: false,
          error: null,
          manualBpm: null,
          manualAnchorMs: track.firstTransientMs,
          startBeatOffset: soloStart,
          tempoMultiplier: 1,
          rhythmMatchPct: match.matchScorePct,
          keyLock: deck1Ref.current.keyLock,
          keyShiftSemitones: 0,
        };
        deck1Ref.current = nextD1;
        setDeck1(nextD1);
        setDeck2((prev) => {
          const nextD2: DeckUiInfo = {
            ...prev,
            startBeatOffset: match.startBeatOffset,
            tempoMultiplier: match.tempoMultiplier,
            rhythmMatchPct: match.matchScorePct,
          };
          deck2Ref.current = nextD2;
          return nextD2;
        });
      } else {
        const setter = deck === 1 ? setDeck1 : setDeck2;
        const ref = deck === 1 ? deck1Ref : deck2Ref;
        const nextDeck: DeckUiInfo = {
          track,
          loading: false,
          error: null,
          manualBpm: null,
          manualAnchorMs: track.firstTransientMs,
          startBeatOffset: soloStart,
          tempoMultiplier: 1,
          rhythmMatchPct: null,
          keyLock: ref.current.keyLock,
          keyShiftSemitones: 0,
        };
        ref.current = nextDeck;
        setter(nextDeck);
      }

      // Also keep Audio Looper Slot rhythmically + harmonically aligned if a loop is loaded
      const curLooper = looperRef.current;
      if (curLooper.track) {
        const refDeckInfo =
          deck === 1
            ? {
                track,
                startBeatOffset: deck1Ref.current.startBeatOffset,
                keyShiftSemitones: deck1Ref.current.keyShiftSemitones,
              }
            : deck1Ref.current.track
              ? deck1Ref.current
              : {
                  track,
                  startBeatOffset: deck2Ref.current.startBeatOffset,
                  keyShiftSemitones: deck2Ref.current.keyShiftSemitones,
                };
        if (refDeckInfo.track) {
          const lpMatch = matchRhythmicStartingPoint(
            refDeckInfo.track,
            curLooper.track,
            refDeckInfo.startBeatOffset
          );
          const masterKey = transposeKeyInfo(
            refDeckInfo.track.musicalKey,
            refDeckInfo.keyShiftSemitones
          );
          const autoKeyShift = findOptimalSemitoneMatch(
            curLooper.track.musicalKey,
            masterKey
          );
          setLooper((prev) => {
            const nextLp: LooperUiInfo = {
              ...prev,
              startBeatOffset: lpMatch.startBeatOffset,
              tempoMultiplier: lpMatch.tempoMultiplier,
              rhythmMatchPct: lpMatch.matchScorePct,
              keyLock: true,
              keyShiftSemitones: autoKeyShift,
            };
            looperRef.current = nextLp;
            return nextLp;
          });
        }
      }
    },
    []
  );

  const handleLoadLocalFile = useCallback(
    async (deck: 1 | 2, file: File) => {
      const setter = deck === 1 ? setDeck1 : setDeck2;
      setter((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const track = await audioEngine.loadLocalFile(deck, file);
        applyTrackWithAutoRhythmMatch(deck, track);

        setState((prev) => {
          const bothConstant =
            (deck === 1 ? track.isConstantTempo : prev.gridMode === 'straight') &&
            (deck === 2 ? track.isConstantTempo : prev.gridMode === 'straight');
          const next: CalibrationState = {
            ...prev,
            masterBpm: deck === 1 ? track.exactBpm : prev.masterBpm,
            gridOffsetMs: 0,
            syncMode: 'beat',
            quantize: true,
            // Serato standard: Straight grid for quantized studio tracks, Dynamic only if live drift detected
            gridMode: bothConstant ? 'straight' : 'dynamic',
            elapsedBeats: 0,
          };
          stateRef.current = next;
          return next;
        });
        setBarBeatDisplay('01.1.1');
      } catch (err) {
        setter((prev) => ({
          ...prev,
          loading: false,
          error:
            err instanceof Error
              ? `Could not decode audio file: ${err.message}`
              : 'Unsupported or corrupted audio file.',
        }));
      }
    },
    [applyTrackWithAutoRhythmMatch]
  );

  const handleLoadDemoTrack = useCallback(
    (deck: 1 | 2) => {
      const offsetMs = deck === 1 ? 0 : 14.2;
      const track = audioEngine.loadDemoTrack(
        deck,
        124,
        offsetMs,
        deck === 1 ? 'Demo House Kick (124 BPM)' : 'Demo Groove Loop (+14.2 ms Pad)'
      );
      applyTrackWithAutoRhythmMatch(deck, track);

      setState((prev) => {
        const next: CalibrationState = {
          ...prev,
          masterBpm: deck === 1 ? track.exactBpm : prev.masterBpm,
          gridOffsetMs: deck === 2 ? 14.2 : prev.gridOffsetMs,
          gridMode: 'straight',
          elapsedBeats: 0,
        };
        stateRef.current = next;
        return next;
      });
      setBarBeatDisplay('01.1.1');
    },
    [applyTrackWithAutoRhythmMatch]
  );

  const handleClearDeck = useCallback((deck: 1 | 2) => {
    audioEngine.clearDeck(deck);
    if (deck === 1) {
      deck1Ref.current = EMPTY_DECK;
      setDeck1(EMPTY_DECK);
      setDeck2((prev) => ({ ...prev, rhythmMatchPct: null }));
      deck1PlayingRef.current = false;
      setDeck1Playing(false);
    } else {
      deck2Ref.current = EMPTY_DECK;
      setDeck2(EMPTY_DECK);
      setDeck1((prev) => ({ ...prev, rhythmMatchPct: null }));
      deck2PlayingRef.current = false;
      setDeck2Playing(false);
    }
    if ((deck === 1 && !deck2PlayingRef.current) || (deck === 2 && !deck1PlayingRef.current)) {
      looperPlayingRef.current = false;
      setLooperPlaying(false);
    }
  }, []);

  const handleManualBpmChange = useCallback((deck: 1 | 2, bpm: number) => {
    if (deck === 1) {
      setDeck1((prev) => ({ ...prev, manualBpm: bpm }));
      setState((prev) => {
        const next = { ...prev, masterBpm: bpm };
        stateRef.current = next;
        return next;
      });
    } else {
      setDeck2((prev) => ({ ...prev, manualBpm: bpm }));
    }
  }, []);

  const handleManualAnchorShift = useCallback((deck: 1 | 2, deltaMs: number) => {
    const setter = deck === 1 ? setDeck1 : setDeck2;
    setter((prev) => {
      const cur = prev.manualAnchorMs ?? prev.track?.firstTransientMs ?? 0;
      const nextAnchor = Math.max(0, Number((cur + deltaMs).toFixed(2)));
      return { ...prev, manualAnchorMs: nextAnchor };
    });
  }, []);

  const handleStartBeatSelect = useCallback((deck: 1 | 2, beatInBar: number) => {
    const clampedBeat = ((Math.round(beatInBar) % 4) + 4) % 4;
    const setter = deck === 1 ? setDeck1 : setDeck2;
    const ref = deck === 1 ? deck1Ref : deck2Ref;
    setter((prev) => {
      if (!prev.track) return prev;
      const baseBarOffset = Math.floor(prev.startBeatOffset / 4) * 4;
      const candidate = baseBarOffset + clampedBeat;
      const nextStart = candidate < prev.track.beatTimesSec.length ? candidate : clampedBeat;
      const next = { ...prev, startBeatOffset: nextStart };
      ref.current = next;
      return next;
    });
  }, []);

  const handleAutoMatchRhythm = useCallback((deck: 1 | 2) => {
    const self = deck === 1 ? deck1Ref.current : deck2Ref.current;
    const opp = deck === 1 ? deck2Ref.current : deck1Ref.current;
    if (!self.track || !opp.track) return;
    const match = matchRhythmicStartingPoint(opp.track, self.track, opp.startBeatOffset);
    const setter = deck === 1 ? setDeck1 : setDeck2;
    const selfRef = deck === 1 ? deck1Ref : deck2Ref;
    setter((prev) => {
      const next: DeckUiInfo = {
        ...prev,
        startBeatOffset: match.startBeatOffset,
        tempoMultiplier: match.tempoMultiplier,
        rhythmMatchPct: match.matchScorePct,
      };
      selfRef.current = next;
      return next;
    });
    const oppSetter = deck === 1 ? setDeck2 : setDeck1;
    const oppRef = deck === 1 ? deck2Ref : deck1Ref;
    oppSetter((prev) => {
      const next = { ...prev, rhythmMatchPct: match.matchScorePct };
      oppRef.current = next;
      return next;
    });
  }, []);

  const handleToggleKeyLock = useCallback((deck: 1 | 2) => {
    const setter = deck === 1 ? setDeck1 : setDeck2;
    const ref = deck === 1 ? deck1Ref : deck2Ref;
    setter((prev) => {
      const next = { ...prev, keyLock: !prev.keyLock };
      ref.current = next;
      return next;
    });
  }, []);

  const handleKeyShiftChange = useCallback((deck: 1 | 2, semitones: number) => {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)));
    const setter = deck === 1 ? setDeck1 : setDeck2;
    const ref = deck === 1 ? deck1Ref : deck2Ref;
    setter((prev) => {
      const next = { ...prev, keyShiftSemitones: clamped };
      ref.current = next;
      return next;
    });
  }, []);

  const handleMatchKeyToOpposite = useCallback((deck: 1 | 2) => {
    const self = deck === 1 ? deck1Ref.current : deck2Ref.current;
    const opp = deck === 1 ? deck2Ref.current : deck1Ref.current;
    if (!self.track || !opp.track) return;
    const oppSoundingKey = transposeKeyInfo(opp.track.musicalKey, opp.keyShiftSemitones);
    const shift = findOptimalSemitoneMatch(self.track.musicalKey, oppSoundingKey);
    const setter = deck === 1 ? setDeck1 : setDeck2;
    const ref = deck === 1 ? deck1Ref : deck2Ref;
    setter((prev) => {
      const next = { ...prev, keyShiftSemitones: shift };
      ref.current = next;
      return next;
    });
  }, []);

  // --- Audio Looper Slot Handlers ---
  const applyLooperTrackWithSync = useCallback((track: LoadedDeckTrack) => {
    const refDeck = deck1Ref.current.track
      ? deck1Ref.current
      : deck2Ref.current.track
        ? deck2Ref.current
        : null;
    const match = refDeck?.track
      ? matchRhythmicStartingPoint(refDeck.track, track, refDeck.startBeatOffset)
      : null;
    const autoKeyShift = refDeck?.track
      ? findOptimalSemitoneMatch(
          track.musicalKey,
          transposeKeyInfo(refDeck.track.musicalKey, refDeck.keyShiftSemitones)
        )
      : 0;
    const soloStart = computeSoloStartBeat(track);

    const nextLooper: LooperUiInfo = {
      ...looperRef.current,
      track,
      loading: false,
      error: null,
      manualBpm: null,
      manualAnchorMs: track.firstTransientMs,
      startBeatOffset: match ? match.startBeatOffset : soloStart,
      tempoMultiplier: match ? match.tempoMultiplier : 1,
      rhythmMatchPct: match ? match.matchScorePct : null,
      keyLock: true,
      keyShiftSemitones: autoKeyShift,
      active: true,
      loopBeatsOverride: 0,
    };
    looperRef.current = nextLooper;
    setLooper(nextLooper);

    if (!deck1Ref.current.track && !deck2Ref.current.track) {
      setState((prev) => {
        const next: CalibrationState = {
          ...prev,
          masterBpm: track.exactBpm,
          gridOffsetMs: 0,
          syncMode: 'beat',
          quantize: true,
          gridMode: track.isConstantTempo ? 'straight' : 'dynamic',
          elapsedBeats: 0,
        };
        stateRef.current = next;
        elapsedBeatsRef.current = 0;
        return next;
      });
      setBarBeatDisplay('01.1.1');
    }
  }, []);

  const handleLoadLooperFile = useCallback(
    async (file: File) => {
      setLooper((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const track = await audioEngine.loadLooperFile(file);
        applyLooperTrackWithSync(track);
      } catch (err) {
        setLooper((prev) => ({
          ...prev,
          loading: false,
          error:
            err instanceof Error
              ? `Could not decode loop file: ${err.message}`
              : 'Unsupported or corrupted audio loop file.',
        }));
      }
    },
    [applyLooperTrackWithSync]
  );

  const handleLoadDemoLooper = useCallback(() => {
    const targetBpm = Math.round(stateRef.current.masterBpm) || 124;
    const track = audioEngine.loadDemoLooper(
      targetBpm,
      0,
      `Demo Top & Bass Loop (${targetBpm} BPM · 16b)`
    );
    applyLooperTrackWithSync(track);
  }, [applyLooperTrackWithSync]);

  const handleClearLooper = useCallback(() => {
    audioEngine.clearLooper();
    looperRef.current = EMPTY_LOOPER;
    setLooper(EMPTY_LOOPER);
    looperPlayingRef.current = false;
    setLooperPlaying(false);
  }, []);

  const handleLooperToggleActive = useCallback(() => {
    setLooper((prev) => {
      const next = { ...prev, active: !prev.active };
      looperRef.current = next;
      audioEngine.setLooperGain(next.gain, next.active);
      return next;
    });
  }, []);

  const handleLooperGainChange = useCallback((gain: number) => {
    setLooper((prev) => {
      const next = { ...prev, gain };
      looperRef.current = next;
      audioEngine.setLooperGain(next.gain, next.active);
      return next;
    });
  }, []);

  const handleLooperBlendModeChange = useCallback((blendMode: LooperBlendMode) => {
    setLooper((prev) => {
      const next = { ...prev, blendMode };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperBpmChange = useCallback((bpm: number) => {
    setLooper((prev) => {
      const next = { ...prev, manualBpm: bpm };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperAnchorShift = useCallback((deltaMs: number) => {
    setLooper((prev) => {
      const cur = prev.manualAnchorMs ?? prev.track?.firstTransientMs ?? 0;
      const nextAnchor = Math.max(0, Number((cur + deltaMs).toFixed(2)));
      const next = { ...prev, manualAnchorMs: nextAnchor };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperLoopBeatsChange = useCallback((beats: number) => {
    setLooper((prev) => {
      const next = { ...prev, loopBeatsOverride: beats };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperStartBeatSelect = useCallback((beatInBar: number) => {
    const clampedBeat = ((Math.round(beatInBar) % 4) + 4) % 4;
    setLooper((prev) => {
      if (!prev.track) return prev;
      const baseBarOffset = Math.floor(prev.startBeatOffset / 4) * 4;
      const candidate = baseBarOffset + clampedBeat;
      const nextStart = candidate < prev.track.beatTimesSec.length ? candidate : clampedBeat;
      const next = { ...prev, startBeatOffset: nextStart };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperAutoMatchRhythm = useCallback(() => {
    const lp = looperRef.current;
    const refDeck = deck1Ref.current.track
      ? deck1Ref.current
      : deck2Ref.current.track
        ? deck2Ref.current
        : null;
    if (!lp.track || !refDeck?.track) return;
    const match = matchRhythmicStartingPoint(refDeck.track, lp.track, refDeck.startBeatOffset);
    setLooper((prev) => {
      const next: LooperUiInfo = {
        ...prev,
        startBeatOffset: match.startBeatOffset,
        tempoMultiplier: match.tempoMultiplier,
        rhythmMatchPct: match.matchScorePct,
      };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperToggleKeyLock = useCallback(() => {
    setLooper((prev) => {
      const next = { ...prev, keyLock: !prev.keyLock };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperKeyShiftChange = useCallback((semitones: number) => {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)));
    setLooper((prev) => {
      const next = { ...prev, keyShiftSemitones: clamped };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleLooperMatchKeyToMaster = useCallback(() => {
    const lp = looperRef.current;
    const refDeck = deck1Ref.current.track
      ? deck1Ref.current
      : deck2Ref.current.track
        ? deck2Ref.current
        : null;
    if (!lp.track || !refDeck?.track) return;
    const masterSoundingKey = transposeKeyInfo(
      refDeck.track.musicalKey,
      refDeck.keyShiftSemitones
    );
    const shift = findOptimalSemitoneMatch(lp.track.musicalKey, masterSoundingKey);
    setLooper((prev) => {
      const next = { ...prev, keyShiftSemitones: shift };
      looperRef.current = next;
      return next;
    });
  }, []);

  const handleCrossfaderChange = useCallback((val: number) => {
    setCrossfader(val);
    audioEngine.setCrossfader(val);
  }, []);

  const handleSelectScenario = useCallback((scenarioId: string) => {
    const found = DIAGNOSTIC_SCENARIOS.find((s) => s.id === scenarioId);
    if (!found) return;
    setState((prev) => {
      const next: CalibrationState = {
        ...prev,
        scenarioId: found.id,
        ...found.patch,
      };
      stateRef.current = next;
      setBarBeatDisplay(formatBarBeat(next.elapsedBeats));
      return next;
    });
  }, []);

  const resetTelemetryCounters = useCallback((initialErrMs = 0) => {
    const nextTel: PllTelemetry = {
      ...pllTelemetryRef.current,
      livePhaseErrorMs: initialErrMs,
      peakDriftMs: Number(Math.abs(initialErrMs).toFixed(1)),
      hardSnapCount: 0,
    };
    pllTelemetryRef.current = nextTel;
    setPllTelemetry(nextTel);
  }, []);

  const handleSnapToZero = useCallback(() => {
    resetTelemetryCounters(0);
    setState((prev) => {
      const next: CalibrationState = {
        ...prev,
        gridOffsetMs: 0,
        deck2BpmOffset: 0,
        audioLatencyMs: 0,
        syncMode: 'beat',
        quantize: true,
        gridMode: prev.deck2TrackDriftBpm > 0 ? 'dynamic' : prev.gridMode,
      };
      stateRef.current = next;
      if (audioEngine.isUsingWorklet()) {
        audioEngine.updateWorkletParams(
          buildWorkletParams(
            next,
            tracksRef.current,
            autoNudgeRef.current,
            maxTrimPctRef.current,
            crossfader
          )
        );
        audioEngine.snapWorkletZero();
      }
      return next;
    });
  }, [resetTelemetryCounters, buildWorkletParams, crossfader]);

  const handleToggleSync = useCallback(() => {
    const prev = stateRef.current;
    const currentlySynced =
      prev.syncMode === 'beat' &&
      Math.abs(prev.gridOffsetMs) < 0.05 &&
      Math.abs(prev.audioLatencyMs) < 0.05 &&
      (prev.deck2TrackDriftBpm === 0 || prev.gridMode === 'dynamic');

    if (currentlySynced) {
      setState((p) => {
        const next: CalibrationState = { ...p, syncMode: 'off' };
        stateRef.current = next;
        return next;
      });
      return;
    }

    resetTelemetryCounters(0);
    setState((p) => {
      const next: CalibrationState = {
        ...p,
        syncMode: 'beat',
        quantize: true,
        gridOffsetMs: 0,
        deck2BpmOffset: 0,
        audioLatencyMs: 0,
        gridMode: p.deck2TrackDriftBpm > 0 ? 'dynamic' : p.gridMode,
      };
      stateRef.current = next;
      if (audioEngine.isUsingWorklet()) {
        audioEngine.updateWorkletParams(
          buildWorkletParams(
            next,
            tracksRef.current,
            autoNudgeRef.current,
            maxTrimPctRef.current,
            crossfader
          )
        );
        audioEngine.snapWorkletZero();
      }
      return next;
    });
  }, [resetTelemetryCounters, buildWorkletParams, crossfader]);

  const handleNudgeGridMs = useCallback((deltaMs: number) => {
    setState((prev) => {
      const nextVal = Math.max(-40, Math.min(40, Number((prev.gridOffsetMs + deltaMs).toFixed(1))));
      const next = { ...prev, gridOffsetMs: nextVal };
      stateRef.current = next;
      return next;
    });
  }, []);

  const handleManualPhaseNudge = useCallback(
    (deltaMs: number) => {
      if (isPlaying && audioEnabled && deck2.track) {
        audioEngine.nudgeDeck2PhaseMs(deltaMs);
        return;
      }
      handleNudgeGridMs(deltaMs);
    },
    [isPlaying, audioEnabled, deck2.track, handleNudgeGridMs]
  );

  const handleToggleDeckPlay = useCallback(
    async (deck: 1 | 2) => {
      const currentlyDeckPlaying =
        deck === 1 ? deck1PlayingRef.current : deck2PlayingRef.current;
      const wantPlay = !currentlyDeckPlaying;
      const wasAnyPlaying = isPlayingRef.current;

      if (wantPlay && audioEngine.hasAnyLoadedTrack() && !audioEnabledRef.current) {
        const active = await audioEngine.setEnabled(true);
        audioEnabledRef.current = active;
        setAudioEnabled(active);
      }

      if (wantPlay && !wasAnyPlaying) {
        resetTelemetryCounters(computePhaseMetrics(stateRef.current).phaseErrorMs);
      }

      const nextD1 = deck === 1 ? wantPlay : deck1PlayingRef.current;
      const nextD2 = deck === 2 ? wantPlay : deck2PlayingRef.current;
      const nextLp =
        nextD1 || nextD2
          ? Boolean(looperRef.current.track)
          : false;

      deck1PlayingRef.current = nextD1;
      deck2PlayingRef.current = nextD2;
      looperPlayingRef.current = nextLp;

      setDeck1Playing(nextD1);
      setDeck2Playing(nextD2);
      setLooperPlaying(nextLp);

      // If transport is ALREADY running and another deck joins or leaves, switch cleanly without interrupting active deck
      if (wasAnyPlaying && (nextD1 || nextD2 || nextLp)) {
        if (audioEngine.isUsingWorklet()) {
          audioEngine.setWorkletDeckPlaying(deck, wantPlay, elapsedBeatsRef.current);
        } else if (audioEngine.isEnabled() && audioEngine.hasAnyLoadedTrack()) {
          syncLiveAudioSources(
            { ...stateRef.current, elapsedBeats: elapsedBeatsRef.current },
            computePhaseMetrics(stateRef.current)
          );
        }
      }
    },
    [resetTelemetryCounters, syncLiveAudioSources]
  );

  const handleTogglePlay = useCallback(async () => {
    if (!isPlayingRef.current) {
      resetTelemetryCounters(computePhaseMetrics(stateRef.current).phaseErrorMs);
      if (audioEngine.hasAnyLoadedTrack() && !audioEnabledRef.current) {
        const active = await audioEngine.setEnabled(true);
        audioEnabledRef.current = active;
        setAudioEnabled(active);
      }
      const hasD1 = Boolean(deck1Ref.current.track);
      const hasD2 = Boolean(deck2Ref.current.track);
      const hasLp = Boolean(looperRef.current.track);
      const playD1 = hasD1 || (!hasD2 && !hasLp);
      const playD2 = hasD2 || (!hasD1 && !hasLp);
      const playLp = hasLp;

      deck1PlayingRef.current = playD1;
      deck2PlayingRef.current = playD2;
      looperPlayingRef.current = playLp;
      setDeck1Playing(playD1);
      setDeck2Playing(playD2);
      setLooperPlaying(playLp);
    } else {
      deck1PlayingRef.current = false;
      deck2PlayingRef.current = false;
      looperPlayingRef.current = false;
      setDeck1Playing(false);
      setDeck2Playing(false);
      setLooperPlaying(false);
    }
  }, [resetTelemetryCounters]);

  const handleResetTransport = useCallback(() => {
    const initialErrMs = computePhaseMetrics(stateRef.current).phaseErrorMs;
    resetTelemetryCounters(initialErrMs);
    elapsedBeatsRef.current = 0;
    setState((prev) => {
      const next = { ...prev, elapsedBeats: 0 };
      stateRef.current = next;
      if (isPlayingRef.current && audioEnabledRef.current && audioEngine.hasAnyLoadedTrack()) {
        if (audioEngine.isUsingWorklet()) {
          audioEngine.seekWorkletTransport(0, initialErrMs);
        } else {
          syncLiveAudioSources(next, computePhaseMetrics(next));
        }
      }
      return next;
    });
    setBarBeatDisplay('01.1.1');
  }, [syncLiveAudioSources, resetTelemetryCounters]);

  const handleToggleAudio = useCallback(async () => {
    const nextOn = !audioEnabledRef.current;
    const active = await audioEngine.setEnabled(nextOn);
    audioEnabledRef.current = active;
    setAudioEnabled(active);
    if (active && isPlayingRef.current && audioEngine.hasAnyLoadedTrack()) {
      syncLiveAudioSources(
        { ...stateRef.current, elapsedBeats: elapsedBeatsRef.current },
        computePhaseMetrics(stateRef.current)
      );
    }
  }, [syncLiveAudioSources]);

  const handleToggleAutoNudge = useCallback(() => {
    setAutoNudgeEnabled((p) => !p);
  }, []);

  const handleMaxNudgeTrimChange = useCallback((pct: number) => {
    setMaxNudgeTrimPct(pct);
  }, []);

  const handleZoomChange = useCallback((zoom: 1 | 4 | 16) => {
    setState((p) => ({ ...p, zoomLevel: zoom }));
  }, []);

  const handleSyncModeChange = useCallback((mode: SyncMode) => {
    setState((p) => ({ ...p, syncMode: mode }));
  }, []);

  const handleGridModeChange = useCallback((mode: GridMode) => {
    setState((p) => ({ ...p, gridMode: mode }));
  }, []);

  const handleToggleQuantize = useCallback(() => {
    setState((p) => ({ ...p, quantize: !p.quantize }));
  }, []);

  const handleSetGridOffsetMs = useCallback((ms: number) => {
    setState((p) => ({ ...p, gridOffsetMs: ms }));
  }, []);

  const handleSetLatencyMs = useCallback((ms: number) => {
    setState((p) => ({ ...p, audioLatencyMs: ms }));
  }, []);

  const handleSetBpmOffset = useCallback((bpmDelta: number) => {
    setState((p) => ({ ...p, deck2BpmOffset: bpmDelta }));
  }, []);

  const handleToggleGuideStep = useCallback((id: string) => {
    setCompletedSteps((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleSimulateFromGuide = useCallback(
    (scenarioId: string) => {
      handleSelectScenario(scenarioId);
      const simEl = document.getElementById('simulator');
      if (simEl) {
        simEl.scrollIntoView({ behavior: 'smooth' });
      }
    },
    [handleSelectScenario]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        handleNudgeGridMs(-1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        handleNudgeGridMs(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay, handleNudgeGridMs]);

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0E14] text-slate-100">
      <TopBar onSnapToZero={handleSnapToZero} />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 pt-6">
        <section id="simulator" className="pb-12">
          <div className="max-w-3xl mb-5">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono font-medium text-slate-400">
              <span className="text-sky-400">Serato-Style Dual-Deck Engine</span>
              <span aria-hidden="true">·</span>
              <span>Continuous Auto-Nudge (≤ ±{maxNudgeTrimPct.toFixed(2)}% Cap)</span>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-400">&lt; ±0.10 ms Target</span>
            </div>
            <h1 className="mt-1.5 text-2xl sm:text-3xl font-bold tracking-tight text-white text-balance">
              Serato-Grade Dual-Deck Beatgrid &amp; Continuous Phase Lock
            </h1>
            <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
              Load local songs onto Deck 1 and Deck 2, press{' '}
              <strong className="font-semibold text-white">SYNC</strong>, and let the continuous
              micro-nudge system hold phase at{' '}
              <strong className="text-emerald-400 whitespace-nowrap">0.00 ms</strong> without big
              pitch swings.
            </p>
          </div>

          <DeckLoaderPanel
            deck1={deck1}
            deck2={deck2}
            crossfader={crossfader}
            isSynced={isSynced}
            deck1Playing={deck1Playing}
            deck2Playing={deck2Playing}
            elapsedBeatsRef={elapsedBeatsRef}
            masterBpm={state.masterBpm}
            deck2RateTrimPct={pllTelemetry.rateTrimPct}
            livePhaseErrorMs={hasDualTracksPlaying ? pllTelemetry.livePhaseErrorMs : metrics.phaseErrorMs}
            autoNudgeEnabled={autoNudgeEnabled}
            maxNudgeTrimPct={maxNudgeTrimPct}
            onToggleDeckPlay={handleToggleDeckPlay}
            onToggleSync={handleToggleSync}
            onToggleAutoNudge={handleToggleAutoNudge}
            onMaxNudgeTrimChange={handleMaxNudgeTrimChange}
            onManualPhaseNudge={handleManualPhaseNudge}
            onSnapPhaseZero={handleSnapToZero}
            onLoadFile={handleLoadLocalFile}
            onLoadDemo={handleLoadDemoTrack}
            onClearDeck={handleClearDeck}
            onManualBpmChange={handleManualBpmChange}
            onManualAnchorShift={handleManualAnchorShift}
            onStartBeatSelect={handleStartBeatSelect}
            onAutoMatchRhythm={handleAutoMatchRhythm}
            onToggleKeyLock={handleToggleKeyLock}
            onKeyShiftChange={handleKeyShiftChange}
            onMatchKeyToOpposite={handleMatchKeyToOpposite}
            onCrossfaderChange={handleCrossfaderChange}
            onApplyDetectedTransientOffset={handleSnapToZero}
          />

          <AudioLooperSlot
            looper={looper}
            masterBpm={state.masterBpm}
            masterDeckLabel={
              deck1.track ? 'Deck 1' : deck2.track ? 'Deck 2' : null
            }
            masterKey={
              deck1.track
                ? transposeKeyInfo(deck1.track.musicalKey, deck1.keyShiftSemitones)
                : deck2.track
                  ? transposeKeyInfo(deck2.track.musicalKey, deck2.keyShiftSemitones)
                  : null
            }
            isPlaying={isPlaying}
            audioEnabled={audioEnabled}
            elapsedBeatsRef={elapsedBeatsRef}
            onLoadFile={handleLoadLooperFile}
            onLoadDemo={handleLoadDemoLooper}
            onClear={handleClearLooper}
            onToggleActive={handleLooperToggleActive}
            onGainChange={handleLooperGainChange}
            onBlendModeChange={handleLooperBlendModeChange}
            onBpmChange={handleLooperBpmChange}
            onAnchorShift={handleLooperAnchorShift}
            onLoopBeatsChange={handleLooperLoopBeatsChange}
            onStartBeatSelect={handleLooperStartBeatSelect}
            onAutoMatchRhythm={handleLooperAutoMatchRhythm}
            onToggleKeyLock={handleLooperToggleKeyLock}
            onKeyShiftChange={handleLooperKeyShiftChange}
            onMatchKeyToMaster={handleLooperMatchKeyToMaster}
          />

          <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 xl:col-span-8">
              <PhaseCanvasStage
                stateRef={stateRef}
                tracksRef={tracksRef}
                pllTelemetryRef={pllTelemetryRef}
                pllTelemetry={pllTelemetry}
                isPlaying={isPlaying}
                audioEnabled={audioEnabled}
                isSynced={isSynced}
                hasDualTracksPlaying={hasDualTracksPlaying}
                zoomLevel={state.zoomLevel}
                metrics={metrics}
                barBeatDisplay={barBeatDisplay}
                onTogglePlay={handleTogglePlay}
                onToggleSync={handleToggleSync}
                onToggleAudio={handleToggleAudio}
                onResetTransport={handleResetTransport}
                onZoomChange={handleZoomChange}
              />
            </div>

            <div className="lg:col-span-5 xl:col-span-4">
              <CalibrationControls
                state={state}
                metrics={metrics}
                onSelectScenario={handleSelectScenario}
                onSyncModeChange={handleSyncModeChange}
                onGridModeChange={handleGridModeChange}
                onToggleQuantize={handleToggleQuantize}
                onNudgeGridMs={handleNudgeGridMs}
                onSetGridOffsetMs={handleSetGridOffsetMs}
                onSetLatencyMs={handleSetLatencyMs}
                onSetBpmOffset={handleSetBpmOffset}
                onSnapToZero={handleSnapToZero}
              />
            </div>
          </div>
        </section>

        <DjayGuideSection
          completedSteps={completedSteps}
          onToggleStep={handleToggleGuideStep}
          onSimulateScenario={handleSimulateFromGuide}
        />

        <DriftCalculatorSection />
      </main>

      <footer className="border-t border-[#222938] bg-[#0D1017] py-6">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
          <span>PhaseZero · Serato-Style Dual-Deck Beatgrid &amp; Phase Alignment Studio</span>
          <span>Shortcuts: Space (Play/Pause) · Left/Right Arrow (±1.0 ms Nudge)</span>
        </div>
      </footer>
    </div>
  );
}
