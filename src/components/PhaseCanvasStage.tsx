import React, { useEffect, useRef } from 'react';
import { Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import {
  type CalibrationState,
  type PhaseMetrics,
  type PllTelemetry,
  computePhaseMetrics,
  sampleDeckTransient,
} from '../utils/phaseMath';
import { sampleTrackPeak } from '../utils/audioAnalysis';
import { type LoadedDeckTrack } from '../utils/audioEngine';

export interface LoadedTracksRefPayload {
  deck1: LoadedDeckTrack | null;
  deck2: LoadedDeckTrack | null;
  looper?: LoadedDeckTrack | null;
  deck1Bpm: number;
  deck2Bpm: number;
  looperBpm?: number;
  deck1AnchorMs: number;
  deck2AnchorMs: number;
  looperAnchorMs?: number;
  deck1BeatTimes: number[];
  deck2BeatTimes: number[];
  deck1StartBeat?: number;
  deck2StartBeat?: number;
  looperStartBeat?: number;
  deck1TempoMult?: 0.5 | 1 | 2;
  deck2TempoMult?: 0.5 | 1 | 2;
  looperTempoMult?: 0.5 | 1 | 2;
  looperLoopBeats?: number;
  looperActive?: boolean;
}

interface PhaseCanvasStageProps {
  stateRef: React.MutableRefObject<CalibrationState>;
  tracksRef: React.MutableRefObject<LoadedTracksRefPayload>;
  pllTelemetryRef: React.MutableRefObject<PllTelemetry>;
  pllTelemetry: PllTelemetry;
  isPlaying: boolean;
  audioEnabled: boolean;
  isSynced: boolean;
  hasDualTracksPlaying: boolean;
  zoomLevel: 1 | 4 | 16;
  metrics: PhaseMetrics;
  barBeatDisplay: string;
  onTogglePlay: () => void;
  onToggleSync: () => void;
  onToggleAudio: () => void;
  onResetTransport: () => void;
  onZoomChange: (zoom: 1 | 4 | 16) => void;
}

export const PhaseCanvasStage: React.FC<PhaseCanvasStageProps> = ({
  stateRef,
  tracksRef,
  pllTelemetryRef,
  pllTelemetry,
  isPlaying,
  audioEnabled,
  isSynced,
  hasDualTracksPlaying,
  zoomLevel,
  metrics,
  barBeatDisplay,
  onTogglePlay,
  onToggleSync,
  onToggleAudio,
  onResetTransport,
  onZoomChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let rafId = 0;
    let disposed = false;

    const drawFrame = () => {
      if (disposed) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(290, Math.floor(rect.height));

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      const st = stateRef.current;
      const tracks = tracksRef.current;
      const livePll = pllTelemetryRef.current;
      const currentMetrics = computePhaseMetrics(st);
      const beatDurationMs = 60000 / Math.max(40, st.masterBpm);

      const liveHardwareActive =
        isPlaying && audioEnabled && Boolean(tracks.deck1 && tracks.deck2);
      const activePhaseErrorMs = liveHardwareActive
        ? livePll.livePhaseErrorMs
        : currentMetrics.phaseErrorMs;
      const activeAbsErrorMs = Math.abs(activePhaseErrorMs);
      const activeStatus =
        activeAbsErrorMs >= 12 || (!liveHardwareActive && Math.abs(currentMetrics.driftPerBarMs) >= 4)
          ? 'drifting'
          : activeAbsErrorMs > 0.1
            ? 'micro-flam'
            : 'locked';

      // Deep Serato DJ Pro studio slate
      ctx.fillStyle = '#090C12';
      ctx.fillRect(0, 0, width, height);

      // 1. Top Serato Beatmatch Phase Bar + Error Meter
      const meterHeight = 68;
      const waveTop = meterHeight + 10;
      const waveHeight = height - waveTop - 16;
      const hasLooperLane = Boolean(tracks.looper && tracks.looper.peaks.length > 0);
      const deck1CenterY = hasLooperLane
        ? waveTop + waveHeight * 0.21
        : waveTop + waveHeight * 0.28;
      const deck2CenterY = hasLooperLane
        ? waveTop + waveHeight * 0.51
        : waveTop + waveHeight * 0.72;
      const looperCenterY = waveTop + waveHeight * 0.82;
      const waveAmp = hasLooperLane
        ? Math.max(17, waveHeight * 0.125)
        : Math.max(26, waveHeight * 0.19);
      const playheadX = Math.floor(width * 0.35);

      ctx.fillStyle = '#0E121B';
      ctx.fillRect(0, 0, width, meterHeight);
      ctx.strokeStyle = '#1E2636';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, meterHeight);
      ctx.lineTo(width, meterHeight);
      ctx.stroke();

      const meterPadX = 24;
      const meterW = width - meterPadX * 2;
      const meterCenterX = meterPadX + meterW / 2;

      // Serato Dual Beatmatch Transient Ticks (scrolling horizontally toward center reticle)
      const seratoSpanBeats = 4;
      const tickPxPerBeat = (meterW * 0.45) / seratoSpanBeats;
      const phaseShiftBeats = activePhaseErrorMs / beatDurationMs;
      const baseBeat = Math.floor(st.elapsedBeats);

      // Center zero alignment reticle for Serato ticks
      ctx.fillStyle = activeStatus === 'locked' ? '#10B981' : '#94A3B8';
      ctx.fillRect(meterCenterX - 1, 18, 2, 24);

      for (let b = baseBeat - 5; b <= baseBeat + 5; b++) {
        const d1TickX = meterCenterX + (b - st.elapsedBeats) * tickPxPerBeat;
        if (d1TickX >= meterPadX && d1TickX <= width - meterPadX) {
          ctx.fillStyle = b % 4 === 0 ? '#38BDF8' : 'rgba(56, 189, 248, 0.55)';
          ctx.fillRect(d1TickX - 1.5, 20, 3, 9);
        }

        const d2TickX = meterCenterX + (b - st.elapsedBeats + phaseShiftBeats) * tickPxPerBeat;
        if (d2TickX >= meterPadX && d2TickX <= width - meterPadX) {
          ctx.fillStyle =
            activeStatus === 'locked'
              ? b % 4 === 0
                ? '#34D399'
                : 'rgba(52, 211, 153, 0.55)'
              : b % 4 === 0
                ? '#F59E0B'
                : 'rgba(245, 158, 11, 0.6)';
          ctx.fillRect(d2TickX - 1.5, 31, 3, 9);
        }
      }

      // Fine Phase Error Bar below ticks
      const trackY = 50;
      ctx.fillStyle = '#18202E';
      ctx.fillRect(meterPadX, trackY - 2, meterW, 4);
      ctx.fillStyle = '#E2E8F0';
      ctx.fillRect(meterCenterX - 0.5, trackY - 5, 1, 10);

      const barColor =
        activeStatus === 'locked'
          ? '#10B981'
          : activeStatus === 'micro-flam'
            ? '#F59E0B'
            : '#EF4444';

      const clampedMs = Math.max(-45, Math.min(45, activePhaseErrorMs));
      const needleX = meterCenterX + (clampedMs / 45) * (meterW / 2);
      ctx.fillStyle = barColor;
      ctx.fillRect(Math.min(meterCenterX, needleX), trackY - 3, Math.max(3, Math.abs(needleX - meterCenterX)), 6);

      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      [-40, -20, 0, 20, 40].forEach((msMark) => {
        const x = meterCenterX + (msMark / 45) * (meterW / 2);
        ctx.fillStyle = msMark === 0 ? '#E2E8F0' : '#64748B';
        ctx.fillText(msMark === 0 ? '0.0 ms' : `${msMark > 0 ? '+' : ''}${msMark}`, x, 64);
      });

      // Header labels inside meter bar
      ctx.textAlign = 'left';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(
        width < 520 ? 'SERATO PHASE BAR' : 'SERATO BEATMATCH BAR (D1 CYAN / D2 LOCK)',
        meterPadX,
        13
      );
      ctx.textAlign = 'right';
      ctx.fillStyle = barColor;
      const errSign = activePhaseErrorMs > 0 ? '+' : '';
      const trimSign = livePll.rateTrimPct > 0 ? '+' : '';
      const trimSuffix =
        liveHardwareActive && st.syncMode === 'beat'
          ? ` · TRIM ${trimSign}${livePll.rateTrimPct.toFixed(2)}%`
          : '';
      ctx.fillText(
        `${errSign}${activePhaseErrorMs.toFixed(2)} ms${trimSuffix}`,
        width - meterPadX,
        13
      );

      // 2. Stacked Parallel Serato Waveforms
      const beatsSpan = st.zoomLevel === 1 ? 4.0 : st.zoomLevel === 4 ? 1.0 : 0.35;
      const pxPerBeat = width / beatsSpan;
      const startBeat = st.elapsedBeats - (playheadX / width) * beatsSpan;

      const subDiv = st.zoomLevel === 16 ? 16 : st.zoomLevel === 4 ? 4 : 1;
      const firstSub = Math.floor(startBeat * subDiv);
      const lastSub = Math.ceil((startBeat + beatsSpan) * subDiv);

      for (let s = firstSub; s <= lastSub; s++) {
        const beatPos = s / subDiv;
        const x = (beatPos - startBeat) * pxPerBeat;
        const isWholeBeat = s % subDiv === 0;
        const isDownbeat = isWholeBeat && Math.round(beatPos) % 4 === 0;

        ctx.strokeStyle = isDownbeat
          ? 'rgba(248, 250, 252, 0.28)'
          : isWholeBeat
            ? 'rgba(148, 163, 184, 0.16)'
            : 'rgba(51, 65, 85, 0.28)';
        ctx.lineWidth = isDownbeat ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x, height - 12);
        ctx.stroke();

        if (isWholeBeat) {
          const beatNum = Math.round(beatPos);
          const barNum = Math.floor(beatNum / 4) + 1;
          const beatInBar = (((beatNum % 4) + 4) % 4) + 1;
          ctx.fillStyle = isDownbeat ? '#E2E8F0' : '#64748B';
          ctx.textAlign = 'left';
          ctx.font = '500 10px "IBM Plex Mono", monospace';
          ctx.fillText(`${barNum}.${beatInBar}`, x + 4, height - 4);
        }
      }

      // Deck baselines
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      const baselines = hasLooperLane
        ? [deck1CenterY, deck2CenterY, looperCenterY]
        : [deck1CenterY, deck2CenterY];
      baselines.forEach((cy) => {
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(width, cy);
        ctx.stroke();
      });

      // Deck Labels
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#38BDF8';
      const d1Label = tracks.deck1 ? tracks.deck1.name.slice(0, 28) : 'MASTER';
      ctx.fillText(
        `DECK 1 · ${d1Label} (${st.masterBpm.toFixed(2)} BPM)`,
        14,
        deck1CenterY - waveAmp - 5
      );

      const deck2Color =
        activeStatus === 'locked'
          ? '#34D399'
          : activeStatus === 'micro-flam'
            ? '#FBBF24'
            : '#F87171';
      ctx.fillStyle = deck2Color;
      const d2Label = tracks.deck2 ? tracks.deck2.name.slice(0, 28) : 'INCOMING';
      ctx.fillText(
        `DECK 2 · ${d2Label} (${currentMetrics.effectiveDeck2Bpm.toFixed(2)} BPM)`,
        14,
        deck2CenterY - waveAmp - 5
      );

      if (hasLooperLane && tracks.looper) {
        const lpActive = tracks.looperActive !== false;
        ctx.fillStyle = lpActive ? '#A78BFA' : '#64748B';
        const lpLabel = tracks.looper.name.slice(0, 28);
        const lpStatus = lpActive ? '0.00 ms LOCK' : 'MUTED';
        ctx.fillText(
          `LOOPER · ${lpLabel} (${(st.masterBpm * (tracks.looperTempoMult ?? 1)).toFixed(2)} BPM · ${lpStatus})`,
          14,
          looperCenterY - waveAmp - 5
        );
      }

      // Draw Deck 1 Waveform
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      for (let x = 0; x < width; x += 2) {
        const beatAtX = startBeat + x / pxPerBeat;
        let sample: number;
        if (tracks.deck1 && tracks.deck1.peaks.length > 0) {
          const d1BeatSec = 60 / Math.max(40, tracks.deck1Bpm);
          const d1Beat =
            beatAtX * (tracks.deck1TempoMult ?? 1) + (tracks.deck1StartBeat ?? 0);
          const trackTimeSec =
            (((d1Beat * d1BeatSec + tracks.deck1AnchorMs / 1000) % tracks.deck1.durationSec) +
              tracks.deck1.durationSec) %
            tracks.deck1.durationSec;
          sample = sampleTrackPeak(
            tracks.deck1.peaks,
            tracks.deck1.peakSamplesPerSec,
            trackTimeSec
          );
        } else {
          sample = sampleDeckTransient(beatAtX);
        }
        const y = deck1CenterY - sample * waveAmp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Deck 1 Beatgrid markers
      const firstWholeBeat = Math.floor(startBeat);
      const lastWholeBeat = Math.ceil(startBeat + beatsSpan);
      for (let b = firstWholeBeat; b <= lastWholeBeat; b++) {
        const gx = (b - startBeat) * pxPerBeat;
        ctx.fillStyle = '#38BDF8';
        ctx.fillRect(gx - 1, deck1CenterY - waveAmp, 2, waveAmp * 2);
      }

      // Draw Deck 2 Waveform shifted by activePhaseErrorMs
      ctx.strokeStyle = deck2Color;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      for (let x = 0; x < width; x += 2) {
        const beatAtX = startBeat + x / pxPerBeat - phaseShiftBeats;
        let sample: number;
        if (tracks.deck2 && tracks.deck2.peaks.length > 0) {
          const d2BeatSec = 60 / Math.max(40, tracks.deck2Bpm);
          const d2Beat =
            beatAtX * (tracks.deck2TempoMult ?? 1) + (tracks.deck2StartBeat ?? 0);
          const trackTimeSec =
            (((d2Beat * d2BeatSec + tracks.deck2AnchorMs / 1000) % tracks.deck2.durationSec) +
              tracks.deck2.durationSec) %
            tracks.deck2.durationSec;
          sample = sampleTrackPeak(
            tracks.deck2.peaks,
            tracks.deck2.peakSamplesPerSec,
            trackTimeSec
          );
        } else {
          sample = sampleDeckTransient(beatAtX);
        }
        const y = deck2CenterY - sample * waveAmp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Deck 2 Beatgrid marker
      const gridMarkerOffsetBeats = st.audioLatencyMs / beatDurationMs;
      for (let b = firstWholeBeat; b <= lastWholeBeat; b++) {
        const gx = (b + gridMarkerOffsetBeats - startBeat) * pxPerBeat;
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(gx, deck2CenterY - waveAmp);
        ctx.lineTo(gx, deck2CenterY + waveAmp);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Looper Slot Waveform (strictly phase-locked 0.00 ms to Deck 1 Master Clock)
      if (hasLooperLane && tracks.looper) {
        const lp = tracks.looper;
        const lpActive = tracks.looperActive !== false;
        const lpBeatSec = 60 / Math.max(40, tracks.looperBpm ?? st.masterBpm);
        const lpLoopBeats = Math.max(0.25, tracks.looperLoopBeats ?? 16);
        const lpAnchorSec = (tracks.looperAnchorMs ?? 0) / 1000;

        ctx.strokeStyle = lpActive ? '#A78BFA' : '#475569';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let x = 0; x < width; x += 2) {
          const beatAtX = startBeat + x / pxPerBeat;
          const lpRawBeat =
            beatAtX * (tracks.looperTempoMult ?? 1) + (tracks.looperStartBeat ?? 0);
          const lpWrappedBeat = ((lpRawBeat % lpLoopBeats) + lpLoopBeats) % lpLoopBeats;
          const lpTimeSec = lpAnchorSec + lpWrappedBeat * lpBeatSec;
          const sample =
            lpTimeSec <= lp.durationSec
              ? sampleTrackPeak(lp.peaks, lp.peakSamplesPerSec, lpTimeSec)
              : 0;
          const y = looperCenterY - sample * waveAmp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        for (let b = firstWholeBeat; b <= lastWholeBeat; b++) {
          const gx = (b - startBeat) * pxPerBeat;
          ctx.fillStyle = lpActive ? '#A78BFA' : '#64748B';
          ctx.fillRect(gx - 1, looperCenterY - waveAmp, 2, waveAmp * 2);
        }
      }

      // Playhead Needle
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, waveTop);
      ctx.lineTo(playheadX, height - 10);
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, waveTop);
      ctx.lineTo(playheadX + 5, waveTop);
      ctx.lineTo(playheadX, waveTop + 7);
      ctx.closePath();
      ctx.fill();

      ctx.restore();

      if (isPlaying) {
        rafId = window.requestAnimationFrame(drawFrame);
      }
    };

    drawFrame();

    const canvasEl = canvasRef.current;
    let observer: ResizeObserver | null = null;
    if (canvasEl && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (!isPlaying) drawFrame();
      });
      observer.observe(canvasEl);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (observer) observer.disconnect();
    };
  }, [stateRef, tracksRef, pllTelemetryRef, isPlaying, audioEnabled, zoomLevel, metrics]);

  const displayedErrorMs = hasDualTracksPlaying
    ? pllTelemetry.livePhaseErrorMs
    : metrics.phaseErrorMs;
  const displayedAbsErrorMs = Math.abs(displayedErrorMs);
  const beatDurationMs = 60000 / Math.max(40, stateRef.current.masterBpm);
  const displayedAngleDeg = Number(((displayedErrorMs / beatDurationMs) * 360).toFixed(1));
  const displayedCorrectionMs = Number((-displayedErrorMs).toFixed(1));

  const effectiveStatus =
    displayedAbsErrorMs >= 12 || (!hasDualTracksPlaying && Math.abs(metrics.driftPerBarMs) >= 4)
      ? 'drifting'
      : displayedAbsErrorMs > 0.1
        ? 'micro-flam'
        : 'locked';

  const statusTone =
    effectiveStatus === 'locked'
      ? 'text-emerald-400'
      : effectiveStatus === 'micro-flam'
        ? 'text-amber-400'
        : 'text-rose-400';

  const statusGlyph =
    effectiveStatus === 'locked' ? '●' : effectiveStatus === 'micro-flam' ? '▲' : '✖';

  const statusText =
    effectiveStatus === 'locked'
      ? 'Phase Locked (< 0.10 ms)'
      : effectiveStatus === 'micro-flam'
        ? 'Micro-Nudging'
        : metrics.statusLabel;

  const correctionIndicator =
    pllTelemetry.correctionState === 'off'
      ? { glyph: '✖', text: 'Off (Manual)', tone: 'text-rose-400' }
      : pllTelemetry.correctionState === 'snapped'
        ? { glyph: '▲', text: 'Beat-Snapped to 0.00 ms', tone: 'text-sky-400' }
        : pllTelemetry.correctionState === 'steering'
          ? {
              glyph: '▲',
              text: `Micro-Nudging (≤±${pllTelemetry.maxTrimPct.toFixed(2)}%)`,
              tone: 'text-amber-400',
            }
          : { glyph: '●', text: 'Holding < 0.10 ms Lock', tone: 'text-emerald-400' };

  const steerDirection =
    pllTelemetry.correctionState === 'off'
      ? '✖ Auto-Nudge Disengaged'
      : Math.abs(pllTelemetry.rateTrimPct) < 0.04 && displayedAbsErrorMs <= 0.1
        ? '● Centered (< 0.10 ms Lock)'
        : pllTelemetry.rateTrimPct > 0 || displayedErrorMs < 0
          ? '▶ Nudging Deck 2 Forward'
          : '◀ Nudging Deck 2 Back';

  const clampedLockPct = Math.max(-1, Math.min(1, displayedErrorMs)) / 1;
  const lockMarkerLeftPct = 50 + clampedLockPct * 48;

  return (
    <section aria-label="Dual-deck phase alignment oscilloscope" className="flex flex-col">
      <div className="bg-[#12161F] border border-[#232A38] rounded-xl overflow-hidden">
        {/* Canvas Header Strip */}
        <div className="px-4 py-2.5 border-b border-[#1E2432] flex flex-wrap items-center justify-between gap-2.5 bg-[#151A25]">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400">
            <span className="font-semibold text-white whitespace-nowrap">
              Serato Parallel Waveforms
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums whitespace-nowrap">Zoom {zoomLevel}x</span>
            <span aria-hidden="true">·</span>
            <span
              className={`font-semibold whitespace-nowrap ${statusTone}`}
              data-testid="phase-status-label"
            >
              {statusGlyph} {statusText}
            </span>
          </div>

          <div
            className="inline-flex items-center gap-1 p-1 bg-[#0B0E14] border border-[#222938] rounded-lg"
            role="group"
            aria-label="Waveform zoom level"
          >
            {([1, 4, 16] as const).map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => onZoomChange(z)}
                className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  zoomLevel === z
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {z}x
              </button>
            ))}
          </div>
        </div>

        {/* High-DPI Serato Waveform & Phase Bar Canvas */}
        <div className="relative w-full h-[320px] sm:h-[350px] bg-[#090C12]">
          <canvas
            ref={canvasRef}
            data-testid="phase-oscilloscope-canvas"
            className="w-full h-full block cursor-crosshair"
            aria-label="Dual deck parallel waveform and phase alignment meter"
          />
        </div>

        {/* Transport & Live Telemetry Bar */}
        <div className="px-4 py-3 border-t border-[#1E2432] bg-[#12161F] flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isPlaying ? 'Pause Decks' : 'Play Decks'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleSync}
              aria-pressed={isSynced}
              data-testid="transport-sync-button"
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-mono font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isSynced
                  ? 'border-emerald-500/60 bg-emerald-600 text-white hover:bg-emerald-500'
                  : 'border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
              }`}
            >
              <span>{isSynced ? 'SYNCED (0.0 ms)' : 'SYNC'}</span>
            </button>

            <button
              type="button"
              onClick={onResetTransport}
              aria-label="Reset playhead to bar 1 beat 1"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#2A3346] bg-[#181E2B] text-slate-200 hover:bg-[#212838] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Cue 1.1</span>
            </button>

            <button
              type="button"
              onClick={onToggleAudio}
              aria-pressed={audioEnabled}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                audioEnabled
                  ? 'border-sky-500/50 bg-sky-500/20 text-sky-300'
                  : 'border-[#2A3346] bg-[#181E2B] text-slate-300 hover:bg-[#212838]'
              }`}
            >
              {audioEnabled ? (
                <Volume2 className="w-3.5 h-3.5" />
              ) : (
                <VolumeX className="w-3.5 h-3.5" />
              )}
              <span>{audioEnabled ? 'Audio On' : 'Hear Mix'}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 font-mono tabular-nums">
            <div
              className={`font-semibold whitespace-nowrap ${correctionIndicator.tone}`}
              data-testid="pll-status"
            >
              {correctionIndicator.glyph} {pllTelemetry.activeLoopMode}
            </div>
            <div>
              <span className="text-slate-500 mr-1.5">POS</span>
              <span className="font-semibold text-white">{barBeatDisplay}</span>
            </div>
            <div>
              <span className="text-slate-500 mr-1.5">NOTCH</span>
              <span className="font-semibold text-white">
                {metrics.combFilterHz ? `${metrics.combFilterHz} Hz` : 'None'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 4-Column Primary Phase Metrics */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#12161F] border border-[#232A38] rounded-xl px-4 py-3">
          <div className="text-xs font-medium text-slate-400">Phase Error</div>
          <div
            className="mt-1 text-xl font-semibold font-mono tabular-nums text-white"
            data-testid="metric-phase-error"
          >
            {displayedErrorMs > 0 ? '+' : ''}
            {displayedErrorMs.toFixed(2)}
            <span className="text-xs font-normal text-slate-400 ml-1">ms</span>
          </div>
        </div>

        <div className="bg-[#12161F] border border-[#232A38] rounded-xl px-4 py-3">
          <div className="text-xs font-medium text-slate-400">Phase Angle</div>
          <div
            className="mt-1 text-xl font-semibold font-mono tabular-nums text-white"
            data-testid="metric-phase-angle"
          >
            {displayedAngleDeg > 0 ? '+' : ''}
            {displayedAngleDeg.toFixed(1)}
            <span className="text-xs font-normal text-slate-400 ml-0.5">°</span>
          </div>
        </div>

        <div className="bg-[#12161F] border border-[#232A38] rounded-xl px-4 py-3">
          <div className="text-xs font-medium text-slate-400">Drift Rate</div>
          <div
            className="mt-1 text-xl font-semibold font-mono tabular-nums text-white"
            data-testid="metric-drift-rate"
          >
            {metrics.driftPerBarMs > 0 ? '+' : ''}
            {metrics.driftPerBarMs.toFixed(1)}
            <span className="text-xs font-normal text-slate-400 ml-1">ms/bar</span>
          </div>
        </div>

        <div className="bg-[#12161F] border border-[#232A38] rounded-xl px-4 py-3">
          <div className="text-xs font-medium text-slate-400">Correction Needed</div>
          <div
            className="mt-1 text-xl font-semibold font-mono tabular-nums text-sky-400"
            data-testid="metric-correction"
          >
            {displayedCorrectionMs > 0 ? '+' : ''}
            {(-displayedErrorMs).toFixed(2)}
            <span className="text-xs font-normal text-slate-400 ml-1">ms</span>
          </div>
        </div>
      </div>

      {/* Phase Correction & Continuous Auto-Nudge Monitor */}
      <div
        className="mt-3 bg-[#12161F] border border-[#232A38] rounded-xl p-4"
        aria-label="Live phase correction indicators"
        data-testid="phase-correction-monitor"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1E2432]">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-white">Continuous Auto-Nudge Monitor</span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span className="font-mono text-slate-400">
              Cap ±{pllTelemetry.maxTrimPct.toFixed(2)}%
            </span>
          </div>
          <div className={`text-xs font-mono font-semibold whitespace-nowrap ${correctionIndicator.tone}`}>
            {steerDirection}
          </div>
        </div>

        {/* High-Precision Zero-Centered Lock Gauge (±1.00 ms window, ±0.10 ms green target zone) */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums mb-1.5">
            <span>-1.00 ms (Early)</span>
            <span className="font-semibold text-emerald-400">±0.10 ms Target Zone</span>
            <span>+1.00 ms (Late)</span>
          </div>
          <div className="relative h-2.5 w-full rounded-full bg-[#090C12] border border-[#232A38] overflow-hidden">
            <div
              className="absolute top-0 bottom-0 bg-emerald-500/20 border-x border-emerald-400/50"
              style={{ left: '45%', width: '10%' }}
              aria-hidden="true"
            />
            <div
              className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-slate-400"
              aria-hidden="true"
            />
            <div
              className={`absolute top-0 bottom-0 w-2 -translate-x-1/2 rounded-full transition-[left] duration-75 ${
                effectiveStatus === 'locked'
                  ? 'bg-emerald-400'
                  : effectiveStatus === 'micro-flam'
                    ? 'bg-amber-400'
                    : 'bg-rose-500'
              }`}
              style={{ left: `${lockMarkerLeftPct}%` }}
              data-testid="lock-gauge-needle"
            />
          </div>
        </div>

        <div className="mt-3.5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-[#0D1017] border border-[#202736] rounded-lg px-3 py-2.5">
            <div className="text-[11px] font-medium text-slate-400">Nudge Engine</div>
            <div
              className={`mt-1 text-xs font-semibold whitespace-nowrap ${correctionIndicator.tone}`}
              data-testid="phase-correction-indicator"
            >
              {correctionIndicator.glyph} {correctionIndicator.text}
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg px-3 py-2.5">
            <div className="text-[11px] font-medium text-slate-400">Live Rate Trim</div>
            <div
              className="mt-1 text-sm font-semibold font-mono tabular-nums text-white"
              data-testid="metric-rate-trim"
            >
              {pllTelemetry.rateTrimPct > 0 ? '+' : ''}
              {pllTelemetry.rateTrimPct.toFixed(2)}%
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg px-3 py-2.5">
            <div className="text-[11px] font-medium text-slate-400">Peak Drift Observed</div>
            <div
              className="mt-1 text-sm font-semibold font-mono tabular-nums text-white"
              data-testid="metric-peak-drift"
            >
              {pllTelemetry.peakDriftMs.toFixed(2)}
              <span className="text-xs font-normal text-slate-400 ml-1">ms</span>
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg px-3 py-2.5">
            <div className="text-[11px] font-medium text-slate-400">Auto-Snaps (&gt;15 ms)</div>
            <div
              className="mt-1 text-sm font-semibold font-mono tabular-nums text-white"
              data-testid="metric-snap-count"
            >
              {pllTelemetry.hardSnapCount}
              <span className="text-xs font-normal text-slate-400 ml-1">
                {pllTelemetry.hardSnapCount === 1 ? 'snap' : 'snaps'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
