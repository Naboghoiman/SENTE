import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { DeckLoaderPanel, type DeckUiInfo } from './components/DeckLoaderPanel';
import { PhaseCanvasStage, type LoadedTracksRefPayload } from './components/PhaseCanvasStage';
import { CalibrationControls } from './components/CalibrationControls';
import { DjayGuideSection } from './components/DjayGuideSection';
import { DriftCalculatorSection } from './components/DriftCalculatorSection';
import { audioEngine, type LoadedDeckTrack, type WorkletParamsPayload } from './utils/audioEngine';
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
};

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

export default function App() {
  const [state, setState] = useState<CalibrationState>(INITIAL_STATE);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const [barBeatDisplay, setBarBeatDisplay] = useState<string>('01.1.1');
  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>({});
  const [pllTelemetry, setPllTelemetry] = useState<PllTelemetry>(INITIAL_TELEMETRY);
  const [autoNudgeEnabled, setAutoNudgeEnabled] = useState<boolean>(true);
  const [maxNudgeTrimPct, setMaxNudgeTrimPct] = useState<number>(0.25);

  const [deck1, setDeck1] = useState<DeckUiInfo>(EMPTY_DECK);
  const [deck2, setDeck2] = useState<DeckUiInfo>(EMPTY_DECK);
  const [crossfader, setCrossfader] = useState<number>(0);

  const stateRef = useRef<CalibrationState>(INITIAL_STATE);
  stateRef.current = state;

  const autoNudgeRef = useRef<boolean>(true);
  autoNudgeRef.current = autoNudgeEnabled;
  const maxTrimPctRef = useRef<number>(0.25);
  maxTrimPctRef.current = maxNudgeTrimPct;

  const integralErrRef = useRef<number>(0);
  const lastSnapAtRef = useRef<number>(-10000);
  const pllTelemetryRef = useRef<PllTelemetry>(INITIAL_TELEMETRY);

  const deck1Bpm = deck1.manualBpm ?? deck1.track?.exactBpm ?? state.masterBpm;
  const deck2Bpm = deck2.manualBpm ?? deck2.track?.exactBpm ?? state.masterBpm;
  const deck1AnchorMs = deck1.manualAnchorMs ?? deck1.track?.firstTransientMs ?? 0;
  const deck2AnchorMs = deck2.manualAnchorMs ?? deck2.track?.firstTransientMs ?? 0;

  const deck1BeatTimes = useMemo(
    () => getAdjustedBeatTimes(deck1.track, deck1Bpm, deck1AnchorMs),
    [deck1.track, deck1Bpm, deck1AnchorMs]
  );
  const deck2BeatTimes = useMemo(
    () => getAdjustedBeatTimes(deck2.track, deck2Bpm, deck2AnchorMs),
    [deck2.track, deck2Bpm, deck2AnchorMs]
  );

  const tracksRef = useRef<LoadedTracksRefPayload>({
    deck1: null,
    deck2: null,
    deck1Bpm,
    deck2Bpm,
    deck1AnchorMs,
    deck2AnchorMs,
    deck1BeatTimes,
    deck2BeatTimes,
  });

  tracksRef.current = {
    deck1: deck1.track,
    deck2: deck2.track,
    deck1Bpm,
    deck2Bpm,
    deck1AnchorMs,
    deck2AnchorMs,
    deck1BeatTimes,
    deck2BeatTimes,
  };

  const metrics = useMemo(() => computePhaseMetrics(state), [state]);
  const isSynced = state.syncMode === 'beat' && metrics.absErrorMs === 0;
  const hasDualTracksPlaying =
    isPlaying && audioEnabled && Boolean(deck1.track && deck2.track);

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
            }
          : undefined,
        deck2Grid: t.deck2
          ? {
              bpm: t.deck2Bpm,
              anchorMs: t.deck2AnchorMs,
              useBeatTimes: useTracked2,
              beatTimesSec: t.deck2BeatTimes,
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
        });
        return;
      }

      const d1Bpm = Math.max(40, t.deck1Bpm);
      const d2Bpm = Math.max(40, t.deck2Bpm);

      // Straight constant-tempo studio tracks use zero-jitter exact linear grids;
      // Dynamic/drifting recordings use smoothed beat-tracked timestamps
      const useTracked1 = Boolean(t.deck1 && (!t.deck1.isConstantTempo || curState.gridMode === 'dynamic'));
      const useTracked2 = Boolean(t.deck2 && (!t.deck2.isConstantTempo || curState.gridMode === 'dynamic'));

      const deck1OffsetSec = t.deck1
        ? getTimeAtBeatPosition(
            curState.elapsedBeats,
            useTracked1 ? t.deck1BeatTimes : [],
            d1Bpm,
            t.deck1AnchorMs
          )
        : 0;

      const deck2OffsetSec = t.deck2
        ? getTimeAtBeatPosition(
            curState.elapsedBeats,
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

      const deck1Rate = curState.masterBpm / d1Bpm;
      const deck2Rate = unroundedDeck2MasterBpm / d2Bpm;

      integralErrRef.current = 0;

      audioEngine.startTrackSources({
        deck1OffsetSec,
        deck2OffsetSec,
        deck1Rate,
        deck2Rate,
      });
    },
    [buildWorkletParams, crossfader]
  );

  // Transport clock + single-owner audio telemetry sync (with fallback AudioBufferSourceNode PLL)
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
    let lastWholeBeat = Math.floor(stateRef.current.elapsedBeats);

    if (audioEngine.isEnabled() && audioEngine.hasAnyLoadedTrack()) {
      syncLiveAudioSources(stateRef.current, computePhaseMetrics(stateRef.current));
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
      let nextBeats = cur.elapsedBeats + wallDtSec * (cur.masterBpm / 60);

      if (audioEngine.isUsingWorklet() && (t.deck1 || t.deck2)) {
        // Single-transport-owner: AudioWorklet advances masterBeatPos & regulates Deck 2 in the audio thread
        const wt = audioEngine.getWorkletTelemetry();
        if (wt) {
          const dtSinceTelemetrySec = Math.min(0.08, Math.max(0, (now - wt.receivedAtPerfMs) / 1000));
          nextBeats = wt.masterBeatPos + dtSinceTelemetrySec * (cur.masterBpm / 60);

          if (t.deck1 && t.deck2) {
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

      stateRef.current = { ...cur, elapsedBeats: nextBeats };

      const wholeBeat = Math.floor(nextBeats);
      if (wholeBeat > lastWholeBeat) {
        lastWholeBeat = wholeBeat;
        const m = computePhaseMetrics(stateRef.current);
        audioEngine.triggerBeatPair(m.phaseErrorMs, wholeBeat % 4 === 0);
      }

      if (now - lastUiSync >= 100) {
        lastUiSync = now;
        setBarBeatDisplay(formatBarBeat(nextBeats));
        setPllTelemetry(pllTelemetryRef.current);
        setState((prev) => ({ ...prev, elapsedBeats: nextBeats }));
      }
    };

    const tick = (now: number) => {
      stepControlLoop(now);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    // Keep PI-PLL running smoothly at 25 Hz even if tab is backgrounded / RAF throttled
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
    autoNudgeEnabled,
    maxNudgeTrimPct,
    crossfader,
    audioEnabled,
  ]);

  const handleLoadLocalFile = useCallback(async (deck: 1 | 2, file: File) => {
    const setter = deck === 1 ? setDeck1 : setDeck2;
    setter((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const track = await audioEngine.loadLocalFile(deck, file);
      setter({
        track,
        loading: false,
        error: null,
        manualBpm: null,
        manualAnchorMs: track.firstTransientMs,
      });

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
  }, []);

  const handleLoadDemoTrack = useCallback((deck: 1 | 2) => {
    const setter = deck === 1 ? setDeck1 : setDeck2;
    const offsetMs = deck === 1 ? 0 : 14.2;
    const track = audioEngine.loadDemoTrack(
      deck,
      124,
      offsetMs,
      deck === 1 ? 'Demo House Kick (124 BPM)' : 'Demo Groove Loop (+14.2 ms Pad)'
    );
    setter({
      track,
      loading: false,
      error: null,
      manualBpm: null,
      manualAnchorMs: track.firstTransientMs,
    });

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
  }, []);

  const handleClearDeck = useCallback((deck: 1 | 2) => {
    audioEngine.clearDeck(deck);
    if (deck === 1) setDeck1(EMPTY_DECK);
    else setDeck2(EMPTY_DECK);
    setIsPlaying(false);
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
      const nextAnchor = Math.max(0, Number((cur + deltaMs).toFixed(1)));
      return { ...prev, manualAnchorMs: nextAnchor };
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

  const handleTogglePlay = useCallback(async () => {
    if (!isPlaying) {
      resetTelemetryCounters(computePhaseMetrics(stateRef.current).phaseErrorMs);
      if (audioEngine.hasAnyLoadedTrack() && !audioEnabled) {
        const active = await audioEngine.setEnabled(true);
        setAudioEnabled(active);
      }
    }
    setIsPlaying((p) => !p);
  }, [isPlaying, audioEnabled, resetTelemetryCounters]);

  const handleResetTransport = useCallback(() => {
    const initialErrMs = computePhaseMetrics(stateRef.current).phaseErrorMs;
    resetTelemetryCounters(initialErrMs);
    setState((prev) => {
      const next = { ...prev, elapsedBeats: 0 };
      stateRef.current = next;
      if (isPlaying && audioEnabled && audioEngine.hasAnyLoadedTrack()) {
        if (audioEngine.isUsingWorklet()) {
          audioEngine.seekWorkletTransport(0, initialErrMs);
        } else {
          syncLiveAudioSources(next, computePhaseMetrics(next));
        }
      }
      return next;
    });
    setBarBeatDisplay('01.1.1');
  }, [isPlaying, audioEnabled, syncLiveAudioSources, resetTelemetryCounters]);

  const handleToggleAudio = useCallback(async () => {
    const nextOn = !audioEnabled;
    const active = await audioEngine.setEnabled(nextOn);
    setAudioEnabled(active);
    if (active && isPlaying && audioEngine.hasAnyLoadedTrack()) {
      syncLiveAudioSources(stateRef.current, computePhaseMetrics(stateRef.current));
    }
  }, [audioEnabled, isPlaying, syncLiveAudioSources]);

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
            isPlaying={isPlaying}
            elapsedBeats={state.elapsedBeats}
            masterBpm={state.masterBpm}
            deck2RateTrimPct={pllTelemetry.rateTrimPct}
            livePhaseErrorMs={hasDualTracksPlaying ? pllTelemetry.livePhaseErrorMs : metrics.phaseErrorMs}
            autoNudgeEnabled={autoNudgeEnabled}
            maxNudgeTrimPct={maxNudgeTrimPct}
            onToggleSync={handleToggleSync}
            onToggleAutoNudge={() => setAutoNudgeEnabled((p) => !p)}
            onMaxNudgeTrimChange={(pct) => setMaxNudgeTrimPct(pct)}
            onManualPhaseNudge={handleManualPhaseNudge}
            onSnapPhaseZero={handleSnapToZero}
            onLoadFile={handleLoadLocalFile}
            onLoadDemo={handleLoadDemoTrack}
            onClearDeck={handleClearDeck}
            onManualBpmChange={handleManualBpmChange}
            onManualAnchorShift={handleManualAnchorShift}
            onCrossfaderChange={handleCrossfaderChange}
            onApplyDetectedTransientOffset={handleSnapToZero}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
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
                onZoomChange={(zoom) => setState((p) => ({ ...p, zoomLevel: zoom }))}
              />
            </div>

            <div className="lg:col-span-5 xl:col-span-4">
              <CalibrationControls
                state={state}
                metrics={metrics}
                onSelectScenario={handleSelectScenario}
                onSyncModeChange={(mode: SyncMode) =>
                  setState((p) => ({ ...p, syncMode: mode }))
                }
                onGridModeChange={(mode: GridMode) =>
                  setState((p) => ({ ...p, gridMode: mode }))
                }
                onToggleQuantize={() => setState((p) => ({ ...p, quantize: !p.quantize }))}
                onNudgeGridMs={handleNudgeGridMs}
                onSetGridOffsetMs={(ms) => setState((p) => ({ ...p, gridOffsetMs: ms }))}
                onSetLatencyMs={(ms) => setState((p) => ({ ...p, audioLatencyMs: ms }))}
                onSetBpmOffset={(bpmDelta) =>
                  setState((p) => ({ ...p, deck2BpmOffset: bpmDelta }))
                }
                onSnapToZero={handleSnapToZero}
              />
            </div>
          </div>
        </section>

        <DjayGuideSection
          completedSteps={completedSteps}
          onToggleStep={(id) =>
            setCompletedSteps((prev) => ({ ...prev, [id]: !prev[id] }))
          }
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
