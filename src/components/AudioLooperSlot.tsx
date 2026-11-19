import React, { memo, useEffect, useRef, useState } from 'react';
import { Lock, Repeat, Trash2, Unlock, Upload, Volume2, VolumeX } from 'lucide-react';
import { type MusicalKeyInfo, sampleTrackPeak, transposeKeyInfo } from '../utils/audioAnalysis';
import {
  audioEngine,
  computeDetectedLoopBeats,
  type LoadedDeckTrack,
  type LooperBlendMode,
} from '../utils/audioEngine';

export interface LooperUiInfo {
  track: LoadedDeckTrack | null;
  loading: boolean;
  error: string | null;
  manualBpm: number | null;
  manualAnchorMs: number | null;
  startBeatOffset: number;
  tempoMultiplier: 0.5 | 1 | 2;
  rhythmMatchPct: number | null;
  keyLock: boolean;
  keyShiftSemitones: number;
  active: boolean;
  gain: number;
  loopBeatsOverride: number; // 0 = Auto (detected bars)
  blendMode: LooperBlendMode;
}

interface AudioLooperSlotProps {
  looper: LooperUiInfo;
  masterBpm: number;
  masterDeckLabel: string | null;
  masterKey: MusicalKeyInfo | null;
  isPlaying: boolean;
  audioEnabled: boolean;
  elapsedBeatsRef: React.MutableRefObject<number>;
  onLoadFile: (file: File) => void;
  onLoadDemo: () => void;
  onClear: () => void;
  onToggleActive: () => void;
  onGainChange: (gain: number) => void;
  onBlendModeChange: (mode: LooperBlendMode) => void;
  onBpmChange: (bpm: number) => void;
  onAnchorShift: (deltaMs: number) => void;
  onLoopBeatsChange: (beats: number) => void;
  onStartBeatSelect: (beatInBar: number) => void;
  onAutoMatchRhythm: () => void;
  onToggleKeyLock: () => void;
  onKeyShiftChange: (semitones: number) => void;
  onMatchKeyToMaster: () => void;
}

const LOOP_LENGTH_OPTIONS: Array<{ beats: number; label: string }> = [
  { beats: 0, label: 'Auto' },
  { beats: 4, label: '4b' },
  { beats: 8, label: '8b' },
  { beats: 16, label: '16b' },
  { beats: 32, label: '32b' },
];

const BLEND_MODE_OPTIONS: Array<{ mode: LooperBlendMode; label: string; title: string }> = [
  {
    mode: 'auto',
    label: 'Auto Blend',
    title: 'Auto-clears sub-bass clash (<135 Hz) when mixing with a song; full range solo',
  },
  {
    mode: 'blend-140',
    label: 'Bass Swap',
    title: '140 Hz DJ bass-swap high-pass filter so the song kick stays punchy',
  },
  {
    mode: 'top-260',
    label: 'Tops 260Hz',
    title: '260 Hz high-pass isolates tops, hats, claps & vocal chops cleanly',
  },
  {
    mode: 'full',
    label: 'Full',
    title: 'Full-frequency loop playback (no low-cut filter)',
  },
];

export const AudioLooperSlot: React.FC<AudioLooperSlotProps> = memo(({
  looper,
  masterBpm,
  masterDeckLabel,
  masterKey,
  isPlaying,
  audioEnabled,
  elapsedBeatsRef,
  onLoadFile,
  onLoadDemo,
  onClear,
  onToggleActive,
  onGainChange,
  onBlendModeChange,
  onBpmChange,
  onAnchorShift,
  onLoopBeatsChange,
  onStartBeatSelect,
  onAutoMatchRhythm,
  onToggleKeyLock,
  onKeyShiftChange,
  onMatchKeyToMaster,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasSizeRef = useRef<{ width: number; height: number }>({ width: 640, height: 56 });
  const beatCounterRef = useRef<HTMLSpanElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const activeBpm = looper.manualBpm ?? looper.track?.exactBpm ?? 124;
  const activeAnchorMs = looper.manualAnchorMs ?? looper.track?.firstTransientMs ?? 0;
  const detectedLoopBeats = looper.track
    ? computeDetectedLoopBeats(looper.track.durationSec, activeBpm, activeAnchorMs)
    : 16;
  const activeLoopBeats =
    looper.loopBeatsOverride > 0 ? looper.loopBeatsOverride : detectedLoopBeats;

  const effectiveKey = looper.track
    ? transposeKeyInfo(looper.track.musicalKey, looper.keyShiftSemitones)
    : null;
  const isKeyMatched =
    effectiveKey &&
    masterKey &&
    Number.parseInt(effectiveKey.camelot, 10) === Number.parseInt(masterKey.camelot, 10);
  const selectedBeatInBar = ((looper.startBeatOffset % 4) + 4) % 4;
  const hasMasterRef = Boolean(masterDeckLabel && masterKey);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onLoadFile(files[0]);
  };

  // High-DPI live loop waveform + continuous beat playhead animation
  useEffect(() => {
    if (!looper.track) return;
    let rafId = 0;
    let disposed = false;

    const el = canvasRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvasSizeRef.current = {
          width: Math.max(240, Math.floor(rect.width)),
          height: Math.max(52, Math.floor(rect.height)),
        };
      }
    }

    const drawLoopWave = () => {
      if (disposed) return;
      const canvas = canvasRef.current;
      const track = looper.track;
      if (!canvas || !track) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvasSizeRef.current.width;
      const height = canvasSizeRef.current.height;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#090C12';
      ctx.fillRect(0, 0, width, height);

      const safeLoopBeats = Math.max(0.25, activeLoopBeats);
      const beatSec = 60 / Math.max(40, activeBpm);
      const anchorSec = activeAnchorMs / 1000;
      const centerY = height * 0.56;
      const amp = height * 0.34;

      // Compute continuous phase-locked beat inside [0, safeLoopBeats)
      const wt = audioEngine.getWorkletTelemetry();
      let currentLoopBeat: number;
      if (isPlaying && audioEnabled && audioEngine.isUsingWorklet() && wt) {
        currentLoopBeat = wt.looperBeatPos;
      } else {
        const masterBeats = elapsedBeatsRef.current;
        const raw = masterBeats * looper.tempoMultiplier + looper.startBeatOffset;
        currentLoopBeat = ((raw % safeLoopBeats) + safeLoopBeats) % safeLoopBeats;
      }

      if (beatCounterRef.current) {
        const beatWhole = Math.floor(currentLoopBeat) + 1;
        const sub = Math.floor((currentLoopBeat - Math.floor(currentLoopBeat)) * 4) + 1;
        const dispLoop = Number.isInteger(safeLoopBeats)
          ? String(safeLoopBeats)
          : safeLoopBeats.toFixed(1);
        beatCounterRef.current.textContent = `Beat ${String(beatWhole).padStart(2, '0')}.${sub} / ${dispLoop}`;
      }

      // Draw beat & bar grid ticks across loop span
      const wholeBeatsCount = Math.max(1, Math.ceil(safeLoopBeats));
      for (let b = 0; b <= wholeBeatsCount; b++) {
        const x = (b / safeLoopBeats) * width;
        const isDownbeat = b % 4 === 0;
        ctx.strokeStyle = isDownbeat ? 'rgba(226, 232, 240, 0.25)' : 'rgba(100, 116, 139, 0.22)';
        ctx.lineWidth = isDownbeat ? 1.25 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        if (isDownbeat && b < wholeBeatsCount) {
          ctx.fillStyle = '#94A3B8';
          ctx.font = '600 9px "IBM Plex Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`B${b / 4 + 1}`, x + 3, 10);
        }
      }

      // Center baseline
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      // Waveform peaks across loop length starting at Beat 1 anchor
      const waveColor = looper.active ? '#A78BFA' : '#64748B';
      const fillTint = looper.active ? 'rgba(167, 139, 250, 0.14)' : 'rgba(100, 116, 139, 0.08)';
      ctx.strokeStyle = waveColor;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let x = 0; x < width; x += 2) {
        const beatAtX = (x / width) * safeLoopBeats;
        const trackTimeSec = anchorSec + beatAtX * beatSec;
        const s =
          trackTimeSec <= track.durationSec
            ? sampleTrackPeak(track.peaks, track.peakSamplesPerSec, trackTimeSec)
            : 0;
        const y = centerY - s * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Progress tint + scrolling loop playhead needle
      const playX = Math.max(0, Math.min(width, (currentLoopBeat / safeLoopBeats) * width));
      ctx.fillStyle = fillTint;
      ctx.fillRect(0, 0, playX, height);

      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();

      ctx.restore();

      if (isPlaying) {
        rafId = window.requestAnimationFrame(drawLoopWave);
      }
    };

    drawLoopWave();
    let observer: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          canvasSizeRef.current = {
            width: Math.max(240, Math.floor(entry.contentRect.width)),
            height: Math.max(52, Math.floor(entry.contentRect.height)),
          };
        }
        if (!isPlaying) drawLoopWave();
      });
      observer.observe(el);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (observer) observer.disconnect();
    };
  }, [
    looper.track,
    looper.active,
    looper.startBeatOffset,
    looper.tempoMultiplier,
    activeBpm,
    activeAnchorMs,
    activeLoopBeats,
    isPlaying,
    audioEnabled,
    elapsedBeatsRef,
  ]);

  return (
    <section
      aria-label="Continuous Audio Looper Slot"
      data-testid="audio-looper-slot"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`mt-3 bg-[#12161F] border rounded-xl p-4 transition-colors ${
        dragOver ? 'border-violet-400 bg-[#181729]' : 'border-[#232A38]'
      }`}
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#1E2432]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Repeat className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <span className="font-mono font-bold text-violet-300 whitespace-nowrap">
            Audio Looper Slot
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="text-slate-400 whitespace-nowrap">
            Locked to Master Clock ({masterBpm.toFixed(2)} BPM)
          </span>
          {looper.track && (
            <>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span
                className={`font-mono font-semibold tabular-nums whitespace-nowrap ${
                  looper.active ? 'text-emerald-400' : 'text-slate-400'
                }`}
                data-testid="looper-phase-lock"
              >
                {looper.active ? '● 0.00 ms LOCKED' : '○ MUTED (Phase Tracked)'}
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {looper.track && (
            <>
              <button
                type="button"
                onClick={onToggleActive}
                aria-pressed={looper.active}
                data-testid="looper-active-toggle"
                className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  looper.active
                    ? 'bg-violet-600 border-violet-400/60 text-white hover:bg-violet-500'
                    : 'bg-[#1B212E] border-slate-600 text-slate-300 hover:bg-[#242C3D]'
                }`}
              >
                {looper.active ? (
                  <Volume2 className="w-3.5 h-3.5" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
                <span>{looper.active ? 'LOOP ON' : 'MUTED'}</span>
              </button>

              <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#0D1017] border border-[#232A38] rounded">
                <label
                  htmlFor="looper-gain-slider"
                  className="text-[11px] font-mono text-slate-400 whitespace-nowrap"
                >
                  Level
                </label>
                <input
                  id="looper-gain-slider"
                  data-testid="looper-gain-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={looper.gain}
                  onChange={(e) => onGainChange(Number(e.target.value))}
                  className="w-20 accent-violet-500 cursor-pointer"
                />
                <span className="text-[11px] font-mono tabular-nums text-white w-8 text-right">
                  {Math.round(looper.gain * 100)}%
                </span>
              </div>
            </>
          )}

          <button
            type="button"
            onClick={onLoadDemo}
            disabled={looper.loading}
            data-testid="looper-load-demo"
            className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#1B212E] hover:bg-[#252D3D] border border-[#2B3446] rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            Load Demo Loop
          </button>

          {looper.track && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Unload audio loop"
              data-testid="looper-clear"
              className="p-1.5 text-slate-400 hover:text-rose-400 rounded hover:bg-[#1B212E] transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        id="looper-file-input"
        data-testid="looper-upload-input"
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
        className="sr-only"
      />

      {/* Empty Drop Zone */}
      {!looper.track && !looper.loading && (
        <label
          htmlFor="looper-file-input"
          className="mt-3 flex flex-col sm:flex-row items-center justify-between gap-3 border border-dashed border-[#2E3749] hover:border-violet-400 rounded-lg px-4 py-3 bg-[#0D1017] hover:bg-[#151524] cursor-pointer transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <Upload className="w-4 h-4 text-violet-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-200">
                Upload an audio loop (WAV, MP3, FLAC, OGG, M4A)
              </div>
              <div className="text-xs text-slate-400">
                Auto-detects BPM, Beat 1 anchor (&le;0.2 ms), bars, &amp; key—then locks continuously to the song at 0.00 ms forever
              </div>
            </div>
          </div>
          <span className="px-3 py-1.5 text-xs font-semibold text-violet-300 bg-[#191B2B] border border-[#2F334F] rounded-md whitespace-nowrap shrink-0">
            Choose Loop
          </span>
        </label>
      )}

      {looper.loading && (
        <div className="mt-3 border border-[#262E3F] rounded-lg px-4 py-3.5 text-xs font-medium text-slate-300 bg-[#0D1017]">
          Analyzing audio loop beatgrid, bar count, &amp; musical key...
        </div>
      )}

      {/* Loaded Loop Workspace */}
      {looper.track && !looper.loading && (
        <div className="mt-3 border border-[#232A38] rounded-lg p-3 bg-[#0D1017] flex flex-col gap-2.5">
          {/* File info & live beat counter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0 max-w-full">
                <Repeat className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                <span
                  className="text-xs font-semibold text-white truncate max-w-[230px] sm:max-w-[340px]"
                  title={looper.track.name}
                  data-testid="looper-track-name"
                >
                  {looper.track.name}
                </span>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                · {looper.track.durationSec.toFixed(2)}s · Native {looper.track.exactBpm.toFixed(2)} BPM
                (±{looper.track.gridResidualMs.toFixed(2)} ms)
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span
                ref={beatCounterRef}
                data-testid="looper-beat-counter"
                className="text-xs font-mono font-semibold tabular-nums text-violet-300 whitespace-nowrap"
              >
                Beat 01.1 / {activeLoopBeats}
              </span>
              <label
                htmlFor="looper-file-input"
                className="text-xs font-medium text-violet-400 hover:text-violet-300 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Replace Loop
              </label>
            </div>
          </div>

          {/* Live Synchronized Loop Waveform */}
          <div className="w-full h-14 rounded-md overflow-hidden border border-[#202736] bg-[#090C12]">
            <canvas
              ref={canvasRef}
              data-testid="looper-waveform-canvas"
              className="w-full h-full block"
              aria-label="Loop beat waveform and live playhead"
            />
          </div>

          {/* BPM, Anchor & Loop Bar Length Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1.5 border-t border-[#1D2330] text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-slate-400">Loop BPM:</span>
              <button
                type="button"
                onClick={() => onBpmChange(Number((activeBpm / 2).toFixed(2)))}
                className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] text-slate-200 hover:bg-[#222A3A] rounded cursor-pointer"
              >
                ÷2
              </button>
              <button
                type="button"
                onClick={() => onBpmChange(Number((activeBpm * 2).toFixed(2)))}
                className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] text-slate-200 hover:bg-[#222A3A] rounded cursor-pointer"
              >
                ×2
              </button>
              <label htmlFor="looper-bpm-input" className="sr-only">
                Looper BPM
              </label>
              <input
                id="looper-bpm-input"
                type="number"
                min={60}
                max={200}
                step={0.01}
                value={activeBpm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v) && v >= 60 && v <= 200) {
                    onBpmChange(v);
                  }
                }}
                className="w-20 px-2 py-0.5 font-mono tabular-nums font-semibold text-white bg-[#141923] border border-[#2C3548] rounded"
              />

              <span className="ml-2 font-mono tabular-nums text-slate-400">
                Anchor:{' '}
                <strong className="text-white" data-testid="looper-anchor-ms">
                  {activeAnchorMs.toFixed(2)} ms
                </strong>
              </span>
              <div className="flex items-center gap-1">
                {[-5, -1, 1, 5].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    onClick={() => onAnchorShift(delta)}
                    className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer"
                  >
                    {delta > 0 ? `+${delta}` : delta}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="font-mono text-slate-400">Cycle:</span>
              <div
                className="inline-flex items-center gap-0.5 bg-[#12161F] p-0.5 rounded border border-[#242C3D]"
                role="group"
                aria-label="Loop cycle length in beats"
                data-testid="looper-beat-length"
              >
                {LOOP_LENGTH_OPTIONS.map((opt) => {
                  const selected = looper.loopBeatsOverride === opt.beats;
                  return (
                    <button
                      key={opt.beats}
                      type="button"
                      onClick={() => onLoopBeatsChange(opt.beats)}
                      aria-pressed={selected}
                      className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                        selected
                          ? 'bg-violet-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {opt.beats === 0 ? `Auto (${detectedLoopBeats}b)` : opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bar Start Match & Harmonic Key Lock Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1.5 border-t border-[#1D2330] text-xs">
            {/* Bar Start & Rhythm Match */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-slate-400">Bar Start:</span>
              <div
                className="inline-flex items-center gap-0.5 bg-[#12161F] p-0.5 rounded border border-[#242C3D]"
                role="group"
                aria-label="Looper bar starting beat"
              >
                {[0, 1, 2, 3].map((bIdx) => (
                  <button
                    key={bIdx}
                    type="button"
                    onClick={() => onStartBeatSelect(bIdx)}
                    aria-pressed={selectedBeatInBar === bIdx}
                    data-testid={`looper-start-b${bIdx + 1}`}
                    className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded transition-colors cursor-pointer ${
                      selectedBeatInBar === bIdx
                        ? 'bg-violet-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    B{bIdx + 1}
                  </button>
                ))}
              </div>
              {looper.tempoMultiplier !== 1 && (
                <span className="px-1.5 py-0.5 text-[11px] font-mono font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded">
                  {looper.tempoMultiplier === 0.5 ? '0.5× Half' : '2× Double'}
                </span>
              )}
              {hasMasterRef && looper.rhythmMatchPct !== null && (
                <span
                  className={`ml-1 font-mono font-semibold ${
                    looper.rhythmMatchPct >= 95 ? 'text-emerald-400' : 'text-amber-300'
                  }`}
                  data-testid="looper-match-pct"
                >
                  {looper.rhythmMatchPct}% Match
                </span>
              )}
              {hasMasterRef && (
                <button
                  type="button"
                  onClick={onAutoMatchRhythm}
                  data-testid="looper-auto-match"
                  className="ml-1 px-2 py-0.5 text-[11px] font-semibold bg-[#181E2A] hover:bg-[#232B3B] border border-[#2B3446] text-violet-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Auto Match ({masterDeckLabel})
                </button>
              )}
            </div>

            {/* Key Lock & Key Adjuster */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={onToggleKeyLock}
                aria-pressed={looper.keyLock}
                data-testid="looper-keylock"
                title="Toggle Phase-Locked Key Lock on Loop Slot"
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  looper.keyLock
                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-600/30'
                    : 'bg-[#181E2A] border-[#2B3446] text-slate-400 hover:text-white'
                }`}
              >
                {looper.keyLock ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                <span>{looper.keyLock ? 'KEY LOCK' : 'KEY FREE'}</span>
              </button>

              {effectiveKey && (
                <span
                  className="font-mono tabular-nums font-semibold text-white whitespace-nowrap px-1"
                  data-testid="looper-key-display"
                >
                  {effectiveKey.label} · {effectiveKey.camelot}
                  {looper.keyShiftSemitones !== 0 && (
                    <span className="ml-1 text-violet-400">
                      ({looper.keyShiftSemitones > 0 ? '+' : ''}
                      {looper.keyShiftSemitones} st)
                    </span>
                  )}
                </span>
              )}

              <button
                type="button"
                onClick={() => onKeyShiftChange(Math.max(-12, looper.keyShiftSemitones - 1))}
                disabled={looper.keyShiftSemitones <= -12}
                data-testid="looper-key-down"
                className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer disabled:opacity-40"
              >
                -1 st
              </button>
              <button
                type="button"
                onClick={() => onKeyShiftChange(0)}
                disabled={looper.keyShiftSemitones === 0}
                data-testid="looper-key-reset"
                className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-300 cursor-pointer disabled:opacity-40"
              >
                0
              </button>
              <button
                type="button"
                onClick={() => onKeyShiftChange(Math.min(12, looper.keyShiftSemitones + 1))}
                disabled={looper.keyShiftSemitones >= 12}
                data-testid="looper-key-up"
                className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer disabled:opacity-40"
              >
                +1 st
              </button>

              {masterKey && (
                <button
                  type="button"
                  onClick={onMatchKeyToMaster}
                  data-testid="looper-key-match"
                  className={`ml-1 px-2 py-0.5 text-[11px] font-semibold rounded border whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    isKeyMatched
                      ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300'
                      : 'bg-violet-600 hover:bg-violet-500 border-violet-500 text-white'
                  }`}
                >
                  {isKeyMatched ? 'Key Matched' : 'Match Key'}
                </button>
              )}
            </div>
          </div>

          {/* Acoustic Song Blend EQ Strip */}
          <div
            className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[#1D2330] text-xs"
            data-testid="looper-blend-strip"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-slate-400">Song Blend EQ:</span>
              <div
                className="inline-flex items-center gap-0.5 bg-[#12161F] p-0.5 rounded border border-[#242C3D]"
                role="group"
                aria-label="Looper acoustic blend EQ mode"
                data-testid="looper-blend-mode"
              >
                {BLEND_MODE_OPTIONS.map((opt) => {
                  const selected = looper.blendMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      type="button"
                      title={opt.title}
                      onClick={() => onBlendModeChange(opt.mode)}
                      aria-pressed={selected}
                      data-testid={`looper-blend-${opt.mode}`}
                      className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                        selected
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <span className="text-[11px] font-mono text-slate-400">
              {looper.blendMode === 'auto'
                ? 'Auto sub-bass crossover + soft limiter prevents mud & clipping'
                : looper.blendMode === 'blend-140'
                  ? '140 Hz Bass-Swap active (song kick leads)'
                  : looper.blendMode === 'top-260'
                    ? '260 Hz Tops/Percussion Blend active'
                    : 'Full-range output (no low-cut)'}
            </span>
          </div>
        </div>
      )}

      {looper.error && (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-400">
          {looper.error}
        </p>
      )}
    </section>
  );
});
