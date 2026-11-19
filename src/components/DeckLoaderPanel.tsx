import React, { memo, useEffect, useRef, useState } from 'react';
import { Lock, Music, Pause, Play, Trash2, Unlock, Upload } from 'lucide-react';
import { type MusicalKeyInfo, transposeKeyInfo } from '../utils/audioAnalysis';
import { type LoadedDeckTrack } from '../utils/audioEngine';

export interface DeckUiInfo {
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
}

interface DeckLoaderPanelProps {
  deck1: DeckUiInfo;
  deck2: DeckUiInfo;
  crossfader: number;
  isSynced: boolean;
  deck1Playing: boolean;
  deck2Playing: boolean;
  elapsedBeatsRef: React.MutableRefObject<number>;
  masterBpm: number;
  deck2RateTrimPct: number;
  livePhaseErrorMs: number;
  autoNudgeEnabled: boolean;
  maxNudgeTrimPct: number;
  onToggleDeckPlay: (deck: 1 | 2) => void;
  onToggleSync: () => void;
  onToggleAutoNudge: () => void;
  onMaxNudgeTrimChange: (pct: number) => void;
  onManualPhaseNudge: (deltaMs: number) => void;
  onSnapPhaseZero: () => void;
  onLoadFile: (deck: 1 | 2, file: File) => void;
  onLoadDemo: (deck: 1 | 2) => void;
  onClearDeck: (deck: 1 | 2) => void;
  onManualBpmChange: (deck: 1 | 2, bpm: number) => void;
  onManualAnchorShift: (deck: 1 | 2, deltaMs: number) => void;
  onStartBeatSelect: (deck: 1 | 2, beatInBar: number) => void;
  onAutoMatchRhythm: (deck: 1 | 2) => void;
  onToggleKeyLock: (deck: 1 | 2) => void;
  onKeyShiftChange: (deck: 1 | 2, semitones: number) => void;
  onMatchKeyToOpposite: (deck: 1 | 2) => void;
  onCrossfaderChange: (val: number) => void;
  onApplyDetectedTransientOffset: () => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface SeratoPlatterProps {
  deckNum: 1 | 2;
  bpm: number;
  tempoMultiplier: 0.5 | 1 | 2;
  elapsedBeatsRef: React.MutableRefObject<number>;
  isPlaying: boolean;
  accentHex: string;
  trimLabel: string;
}

const SeratoPlatter: React.FC<SeratoPlatterProps> = ({
  deckNum,
  bpm,
  tempoMultiplier,
  elapsedBeatsRef,
  isPlaying,
  accentHex,
  trimLabel,
}) => {
  const needleRef = useRef<HTMLDivElement | null>(null);
  const pausedAngleRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying) {
      if (needleRef.current) {
        needleRef.current.style.transform = `rotate(${pausedAngleRef.current.toFixed(1)}deg)`;
      }
      return;
    }

    let rafId = 0;
    const updateSpin = () => {
      const angleDeg = (elapsedBeatsRef.current * tempoMultiplier * 90) % 360;
      pausedAngleRef.current = angleDeg;
      if (needleRef.current) {
        needleRef.current.style.transform = `rotate(${angleDeg.toFixed(1)}deg)`;
      }
      rafId = window.requestAnimationFrame(updateSpin);
    };
    rafId = window.requestAnimationFrame(updateSpin);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying, tempoMultiplier, elapsedBeatsRef]);

  return (
    <div className="flex items-center gap-3.5 shrink-0">
      <div
        className="relative w-20 h-20 rounded-full bg-[#090C11] border-2 flex items-center justify-center shrink-0 select-none"
        style={{ borderColor: accentHex }}
        aria-hidden="true"
      >
        <div className="absolute inset-1.5 rounded-full border border-slate-700/60" />
        <div className="absolute inset-3 rounded-full border border-slate-800/80" />

        <div
          ref={needleRef}
          className="absolute inset-0"
          style={{
            transform: `rotate(${pausedAngleRef.current.toFixed(1)}deg)`,
            transition: isPlaying ? 'none' : 'transform 120ms ease-out',
          }}
        >
          <div
            className="mx-auto w-1 h-4 rounded-b-sm"
            style={{ backgroundColor: accentHex }}
          />
        </div>

        <div className="relative z-10 w-10 h-10 rounded-full bg-[#151A24] border border-slate-700 flex flex-col items-center justify-center">
          <span className="text-[9px] font-mono font-semibold text-slate-400 leading-none">
            D{deckNum}
          </span>
          <span className="text-[11px] font-mono font-bold text-white tabular-nums leading-tight mt-0.5">
            {bpm.toFixed(1)}
          </span>
        </div>
      </div>

      <div className="min-w-0">
        <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
          {deckNum === 1 ? 'Master Tempo' : 'Synced Speed'}
        </div>
        <div className="text-xl font-bold font-mono tabular-nums text-white leading-tight">
          {bpm.toFixed(2)} <span className="text-xs font-normal text-slate-400">BPM</span>
        </div>
        <div className="text-xs font-mono tabular-nums text-slate-400 mt-0.5">{trimLabel}</div>
      </div>
    </div>
  );
};

interface SingleDeckCardProps {
  deckNum: 1 | 2;
  roleLabel: string;
  accentHex: string;
  accentText: string;
  info: DeckUiInfo;
  oppositeKey: MusicalKeyInfo | null;
  hasOppositeTrack: boolean;
  isSynced?: boolean;
  isPlaying: boolean;
  elapsedBeatsRef: React.MutableRefObject<number>;
  displayedBpm: number;
  trimLabel: string;
  onTogglePlay: () => void;
  onToggleSync?: () => void;
  onManualPhaseNudge?: (deltaMs: number) => void;
  onSnapPhaseZero?: () => void;
  onLoadFile: (file: File) => void;
  onLoadDemo: () => void;
  onClear: () => void;
  onBpmChange: (bpm: number) => void;
  onAnchorShift: (deltaMs: number) => void;
  onStartBeatSelect: (beatInBar: number) => void;
  onAutoMatchRhythm: () => void;
  onToggleKeyLock: () => void;
  onKeyShiftChange: (semitones: number) => void;
  onMatchKeyToOpposite: () => void;
  onApplyDetectedTransient?: () => void;
}

const SingleDeckCard: React.FC<SingleDeckCardProps> = ({
  deckNum,
  roleLabel,
  accentHex,
  accentText,
  info,
  oppositeKey,
  hasOppositeTrack,
  isSynced,
  isPlaying,
  elapsedBeatsRef,
  displayedBpm,
  trimLabel,
  onTogglePlay,
  onToggleSync,
  onManualPhaseNudge,
  onSnapPhaseZero,
  onLoadFile,
  onLoadDemo,
  onClear,
  onBpmChange,
  onAnchorShift,
  onStartBeatSelect,
  onAutoMatchRhythm,
  onToggleKeyLock,
  onKeyShiftChange,
  onMatchKeyToOpposite,
  onApplyDetectedTransient,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tapTimesRef = useRef<number[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const activeBpm = info.manualBpm ?? info.track?.detectedBpm ?? 124;
  const activeAnchorMs = info.manualAnchorMs ?? info.track?.firstTransientMs ?? 0;
  const effectiveKey = info.track
    ? transposeKeyInfo(info.track.musicalKey, info.keyShiftSemitones)
    : null;
  const selectedBeatInBar = ((info.startBeatOffset % 4) + 4) % 4;
  const isKeyMatchedToOpposite =
    effectiveKey &&
    oppositeKey &&
    Number.parseInt(effectiveKey.camelot, 10) === Number.parseInt(oppositeKey.camelot, 10);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onLoadFile(files[0]);
  };

  const handleTapTempo = () => {
    const now = performance.now();
    const prev = tapTimesRef.current;
    if (prev.length > 0 && now - prev[prev.length - 1] > 2000) {
      tapTimesRef.current = [now];
      return;
    }
    const next = [...prev, now].slice(-8);
    tapTimesRef.current = next;
    if (next.length >= 3) {
      const avgIntervalMs = (next[next.length - 1] - next[0]) / (next.length - 1);
      const tappedBpm = Number((60000 / avgIntervalMs).toFixed(2));
      if (tappedBpm >= 60 && tappedBpm <= 200) {
        onBpmChange(tappedBpm);
      }
    }
  };

  return (
    <div
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
      className={`bg-[#12161F] border rounded-xl p-4 transition-colors ${
        dragOver ? 'border-sky-400 bg-[#172030]' : 'border-[#232A38]'
      }`}
    >
      {/* Deck Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1E2432]">
        <div className="flex items-center gap-1.5 text-xs whitespace-nowrap">
          <span className={`font-mono font-bold whitespace-nowrap ${accentText}`}>
            Deck {deckNum}
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="font-medium text-slate-300 whitespace-nowrap">{roleLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-pressed={isPlaying}
            data-testid={`deck-${deckNum}-play-toggle`}
            className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono font-bold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isPlaying
                ? deckNum === 1
                  ? 'bg-sky-600 border-sky-400/70 text-white hover:bg-sky-500'
                  : 'bg-emerald-600 border-emerald-400/70 text-white hover:bg-emerald-500'
                : 'bg-[#1B212E] border-slate-600 text-slate-200 hover:bg-[#242C3D]'
            }`}
          >
            {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            <span>{isPlaying ? `Pause D${deckNum}` : `Play D${deckNum}`}</span>
          </button>

          {deckNum === 2 && onToggleSync && (
            <button
              type="button"
              onClick={onToggleSync}
              aria-pressed={isSynced}
              data-testid="deck2-sync-button"
              className={`px-3 py-1 text-xs font-mono font-bold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isSynced
                  ? 'bg-emerald-600 border-emerald-400/60 text-white hover:bg-emerald-500'
                  : 'bg-[#1B212E] border-slate-600 text-slate-200 hover:bg-[#242C3D]'
              }`}
            >
              {isSynced ? 'SYNCED' : 'SYNC'}
            </button>
          )}

          <button
            type="button"
            onClick={onLoadDemo}
            disabled={info.loading}
            className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#1B212E] hover:bg-[#252D3D] border border-[#2B3446] rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            Load Demo Beat
          </button>

          {info.track && (
            <button
              type="button"
              onClick={onClear}
              aria-label={`Unload Deck ${deckNum} track`}
              className="p-1.5 text-slate-400 hover:text-rose-400 rounded hover:bg-[#1B212E] transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Serato Virtual Vinyl Platter + BPM Readout */}
      <div className="py-3.5 flex flex-wrap items-center justify-between gap-3">
        <SeratoPlatter
          deckNum={deckNum}
          bpm={displayedBpm}
          tempoMultiplier={info.tempoMultiplier}
          elapsedBeatsRef={elapsedBeatsRef}
          isPlaying={isPlaying}
          accentHex={accentHex}
          trimLabel={trimLabel}
        />

        {deckNum === 2 && onManualPhaseNudge && onSnapPhaseZero && (
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
              Serato Platter Nudge
            </span>
            <div className="inline-flex items-center gap-1 bg-[#0B0E14] p-1 rounded-lg border border-[#222938]">
              <button
                type="button"
                onClick={() => onManualPhaseNudge(-1)}
                data-testid="nudge-minus-1"
                title="Nudge Deck 2 backward -1.0 ms"
                className="px-2 py-1 text-[11px] font-mono font-medium text-slate-300 hover:text-white hover:bg-[#1C2230] rounded cursor-pointer"
              >
                ◀◀ -1ms
              </button>
              <button
                type="button"
                onClick={() => onManualPhaseNudge(-0.1)}
                data-testid="nudge-minus-01"
                title="Nudge Deck 2 backward -0.1 ms"
                className="px-2 py-1 text-[11px] font-mono font-medium text-slate-300 hover:text-white hover:bg-[#1C2230] rounded cursor-pointer"
              >
                ◀ -0.1
              </button>
              <button
                type="button"
                onClick={onSnapPhaseZero}
                data-testid="nudge-snap-0"
                title="Snap phase immediately to 0.00 ms"
                className="px-2 py-1 text-[11px] font-mono font-semibold text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 rounded cursor-pointer"
              >
                0.00
              </button>
              <button
                type="button"
                onClick={() => onManualPhaseNudge(0.1)}
                data-testid="nudge-plus-01"
                title="Nudge Deck 2 forward +0.1 ms"
                className="px-2 py-1 text-[11px] font-mono font-medium text-slate-300 hover:text-white hover:bg-[#1C2230] rounded cursor-pointer"
              >
                +0.1 ▶
              </button>
              <button
                type="button"
                onClick={() => onManualPhaseNudge(1)}
                data-testid="nudge-plus-1"
                title="Nudge Deck 2 forward +1.0 ms"
                className="px-2 py-1 text-[11px] font-mono font-medium text-slate-300 hover:text-white hover:bg-[#1C2230] rounded cursor-pointer"
              >
                +1ms ▶▶
              </button>
            </div>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        id={`deck-${deckNum}-file-input`}
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
        className="sr-only"
      />

      {!info.track && !info.loading && (
        <label
          htmlFor={`deck-${deckNum}-file-input`}
          className="flex flex-col sm:flex-row items-center justify-between gap-3 border border-dashed border-[#2E3749] hover:border-sky-500 rounded-lg px-4 py-3 bg-[#0D1017] hover:bg-[#131A26] cursor-pointer transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <Upload className="w-4 h-4 text-slate-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-200">
                Drop MP3, WAV, FLAC, or M4A here
              </div>
              <div className="text-xs text-slate-400">
                Or click to browse local audio for Deck {deckNum}
              </div>
            </div>
          </div>
          <span className="px-3 py-1.5 text-xs font-semibold text-sky-300 bg-[#171E2B] border border-[#2C364A] rounded-md whitespace-nowrap shrink-0">
            Choose Song
          </span>
        </label>
      )}

      {info.loading && (
        <div className="border border-[#262E3F] rounded-lg px-4 py-3.5 text-xs font-medium text-slate-300 bg-[#0D1017]">
          Analyzing beatgrid, bar downbeat, &amp; musical key...
        </div>
      )}

      {info.track && !info.loading && (
        <div className="border border-[#232A38] rounded-lg p-3 bg-[#0D1017] flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Music className={`w-3.5 h-3.5 shrink-0 ${accentText}`} />
              <span
                className="text-xs font-semibold text-white truncate"
                title={info.track.name}
                data-testid={`deck-${deckNum}-track-name`}
              >
                {info.track.name}
              </span>
            </div>
            <label
              htmlFor={`deck-${deckNum}-file-input`}
              className="text-xs font-medium text-sky-400 hover:text-sky-300 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Replace
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 pt-1.5 border-t border-[#1D2330]">
            <div className="flex items-center gap-2 font-mono tabular-nums">
              <span className="text-slate-300">{formatDuration(info.track.durationSec)}</span>
              <span aria-hidden="true">·</span>
              <span>
                {info.track.isConstantTempo ? 'Straight' : 'Dynamic'} (±
                {info.track.gridResidualMs.toFixed(1)} ms)
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onBpmChange(Number((activeBpm / 2).toFixed(2)))}
                title="Halve BPM"
                className="px-1.5 py-1 text-xs font-mono font-medium bg-[#181E2A] border border-[#2B3446] text-slate-200 hover:bg-[#222A3A] rounded cursor-pointer"
              >
                ÷2
              </button>
              <button
                type="button"
                onClick={() => onBpmChange(Number((activeBpm * 2).toFixed(2)))}
                title="Double BPM"
                className="px-1.5 py-1 text-xs font-mono font-medium bg-[#181E2A] border border-[#2B3446] text-slate-200 hover:bg-[#222A3A] rounded cursor-pointer"
              >
                ×2
              </button>
              <button
                type="button"
                onClick={handleTapTempo}
                title="Tap 4 beats to set exact BPM"
                className="px-2 py-1 text-xs font-mono font-medium bg-[#181E2A] border border-[#2B3446] text-slate-200 hover:bg-[#222A3A] rounded cursor-pointer"
              >
                Tap
              </button>
              <label htmlFor={`deck-${deckNum}-bpm`} className="sr-only">
                Deck {deckNum} BPM
              </label>
              <input
                id={`deck-${deckNum}-bpm`}
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
                className="w-20 px-2 py-1 text-xs font-mono tabular-nums font-semibold text-white bg-[#141923] border border-[#2C3548] rounded-md"
              />
            </div>
          </div>

          {/* Serato Beatgrid Anchor Edit Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[#1D2330] text-xs">
            <span className="font-mono tabular-nums text-slate-400">
              Beat 1 Anchor:{' '}
              <strong className="text-white" data-testid={`deck-${deckNum}-anchor-ms`}>
                {activeAnchorMs.toFixed(2)} ms
              </strong>
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onAnchorShift(-5)}
                className="px-2 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer"
              >
                -5ms
              </button>
              <button
                type="button"
                onClick={() => onAnchorShift(-1)}
                className="px-2 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer"
              >
                -1ms
              </button>
              <button
                type="button"
                onClick={() => onAnchorShift(1)}
                className="px-2 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer"
              >
                +1ms
              </button>
              <button
                type="button"
                onClick={() => onAnchorShift(5)}
                className="px-2 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer"
              >
                +5ms
              </button>
              {deckNum === 2 && info.track.firstTransientMs > 0.5 && onApplyDetectedTransient && (
                <button
                  type="button"
                  onClick={onApplyDetectedTransient}
                  className="ml-1 px-2.5 py-0.5 font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Align Beat 1
                </button>
              )}
            </div>
          </div>

          {/* Rhythmic Starting Point & Bar Downbeat Alignment Strip */}
          <div
            className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[#1D2330] text-xs"
            data-testid={`deck-${deckNum}-rhythm-strip`}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-slate-400">Bar Start:</span>
              <div
                className="inline-flex items-center gap-0.5 bg-[#12161F] p-0.5 rounded border border-[#242C3D]"
                role="group"
                aria-label={`Deck ${deckNum} bar starting beat`}
              >
                {[0, 1, 2, 3].map((bIdx) => (
                  <button
                    key={bIdx}
                    type="button"
                    onClick={() => onStartBeatSelect(bIdx)}
                    aria-pressed={selectedBeatInBar === bIdx}
                    data-testid={`deck-${deckNum}-start-b${bIdx + 1}`}
                    className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded transition-colors cursor-pointer ${
                      selectedBeatInBar === bIdx
                        ? 'bg-sky-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    B{bIdx + 1}
                  </button>
                ))}
              </div>
              {info.tempoMultiplier !== 1 && (
                <span
                  className="px-1.5 py-0.5 text-[11px] font-mono font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded"
                  data-testid={`deck-${deckNum}-tempo-family`}
                >
                  {info.tempoMultiplier === 0.5 ? '0.5× Half' : '2× Double'}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {hasOppositeTrack && info.rhythmMatchPct !== null && (
                <span
                  className={`font-mono font-semibold ${
                    info.rhythmMatchPct >= 95 ? 'text-emerald-400' : 'text-amber-300'
                  }`}
                  data-testid={`deck-${deckNum}-match-pct`}
                >
                  {info.rhythmMatchPct}% Bar Match
                </span>
              )}
              {hasOppositeTrack && (
                <button
                  type="button"
                  onClick={onAutoMatchRhythm}
                  data-testid={`deck-${deckNum}-auto-match-rhythm`}
                  className="px-2 py-0.5 text-[11px] font-semibold bg-[#181E2A] hover:bg-[#232B3B] border border-[#2B3446] text-sky-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Auto Start
                </button>
              )}
            </div>
          </div>

          {/* Musical Key Lock & Semitone Key Adjuster Strip */}
          <div
            className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[#1D2330] text-xs"
            data-testid={`deck-${deckNum}-key-strip`}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggleKeyLock}
                aria-pressed={info.keyLock}
                data-testid={`deck-${deckNum}-keylock`}
                title="Toggle Phase-Locked Key Lock (preserves musical key cleanly across BPM changes)"
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  info.keyLock
                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-600/30'
                    : 'bg-[#181E2A] border-[#2B3446] text-slate-400 hover:text-white'
                }`}
              >
                {info.keyLock ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                <span>{info.keyLock ? 'KEY LOCK' : 'KEY FREE'}</span>
              </button>

              {effectiveKey && (
                <span
                  className="font-mono tabular-nums font-semibold text-white whitespace-nowrap"
                  data-testid={`deck-${deckNum}-key-display`}
                >
                  {effectiveKey.label} · {effectiveKey.camelot}
                  {info.keyShiftSemitones !== 0 && (
                    <span className="ml-1 text-sky-400">
                      ({info.keyShiftSemitones > 0 ? '+' : ''}
                      {info.keyShiftSemitones} st)
                    </span>
                  )}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onKeyShiftChange(Math.max(-12, info.keyShiftSemitones - 1))}
                disabled={info.keyShiftSemitones <= -12}
                data-testid={`deck-${deckNum}-key-down`}
                title="Transpose key down 1 semitone"
                className="px-2 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer disabled:opacity-40"
              >
                -1 st
              </button>
              <button
                type="button"
                onClick={() => onKeyShiftChange(0)}
                disabled={info.keyShiftSemitones === 0}
                data-testid={`deck-${deckNum}-key-reset`}
                title="Reset key shift to original 0 semitones"
                className="px-1.5 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-300 cursor-pointer disabled:opacity-40"
              >
                0
              </button>
              <button
                type="button"
                onClick={() => onKeyShiftChange(Math.min(12, info.keyShiftSemitones + 1))}
                disabled={info.keyShiftSemitones >= 12}
                data-testid={`deck-${deckNum}-key-up`}
                title="Transpose key up 1 semitone"
                className="px-2 py-0.5 font-mono bg-[#181E2A] border border-[#2B3446] hover:bg-[#222A3A] rounded text-slate-200 cursor-pointer disabled:opacity-40"
              >
                +1 st
              </button>

              {oppositeKey && (
                <button
                  type="button"
                  onClick={onMatchKeyToOpposite}
                  data-testid={`deck-${deckNum}-key-match`}
                  title={`Harmonically transpose Deck ${deckNum} to match ${oppositeKey.label} (${oppositeKey.camelot})`}
                  className={`ml-1 px-2 py-0.5 text-[11px] font-semibold rounded border whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    isKeyMatchedToOpposite
                      ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300'
                      : 'bg-sky-600 hover:bg-sky-500 border-sky-500 text-white'
                  }`}
                >
                  {isKeyMatchedToOpposite ? 'Key Matched' : 'Match Key'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {info.error && (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-400">
          {info.error}
        </p>
      )}
    </div>
  );
};

export const DeckLoaderPanel: React.FC<DeckLoaderPanelProps> = memo(({
  deck1,
  deck2,
  crossfader,
  isSynced,
  deck1Playing,
  deck2Playing,
  elapsedBeatsRef,
  masterBpm,
  deck2RateTrimPct,
  livePhaseErrorMs,
  autoNudgeEnabled,
  maxNudgeTrimPct,
  onToggleDeckPlay,
  onToggleSync,
  onToggleAutoNudge,
  onMaxNudgeTrimChange,
  onManualPhaseNudge,
  onSnapPhaseZero,
  onLoadFile,
  onLoadDemo,
  onClearDeck,
  onManualBpmChange,
  onManualAnchorShift,
  onStartBeatSelect,
  onAutoMatchRhythm,
  onToggleKeyLock,
  onKeyShiftChange,
  onMatchKeyToOpposite,
  onCrossfaderChange,
  onApplyDetectedTransientOffset,
}) => {
  const deck1TrimLabel = deck1.track
    ? `Native ${deck1.track.exactBpm.toFixed(2)} BPM · ${
        transposeKeyInfo(deck1.track.musicalKey, deck1.keyShiftSemitones).label
      }`
    : 'Reference Clock';
  const trimSign = deck2RateTrimPct > 0 ? '+' : '';
  const deck2TrimLabel = `Trim ${trimSign}${deck2RateTrimPct.toFixed(2)}% · Err ${
    livePhaseErrorMs > 0 ? '+' : ''
  }${livePhaseErrorMs.toFixed(2)} ms`;

  const d1EffectiveKey = deck1.track
    ? transposeKeyInfo(deck1.track.musicalKey, deck1.keyShiftSemitones)
    : null;
  const d2EffectiveKey = deck2.track
    ? transposeKeyInfo(deck2.track.musicalKey, deck2.keyShiftSemitones)
    : null;

  return (
    <section aria-label="Serato-style dual virtual decks and mixer" className="mb-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SingleDeckCard
          deckNum={1}
          roleLabel="Master Deck"
          accentHex="#38BDF8"
          accentText="text-sky-400"
          info={deck1}
          oppositeKey={d2EffectiveKey}
          hasOppositeTrack={Boolean(deck2.track)}
          isPlaying={deck1Playing}
          elapsedBeatsRef={elapsedBeatsRef}
          displayedBpm={masterBpm * deck1.tempoMultiplier}
          trimLabel={deck1TrimLabel}
          onTogglePlay={() => onToggleDeckPlay(1)}
          onLoadFile={(file) => onLoadFile(1, file)}
          onLoadDemo={() => onLoadDemo(1)}
          onClear={() => onClearDeck(1)}
          onBpmChange={(bpm) => onManualBpmChange(1, bpm)}
          onAnchorShift={(delta) => onManualAnchorShift(1, delta)}
          onStartBeatSelect={(beatIdx) => onStartBeatSelect(1, beatIdx)}
          onAutoMatchRhythm={() => onAutoMatchRhythm(1)}
          onToggleKeyLock={() => onToggleKeyLock(1)}
          onKeyShiftChange={(st) => onKeyShiftChange(1, st)}
          onMatchKeyToOpposite={() => onMatchKeyToOpposite(1)}
        />

        <SingleDeckCard
          deckNum={2}
          roleLabel="Incoming Deck"
          accentHex={isSynced ? '#10B981' : '#F59E0B'}
          accentText={isSynced ? 'text-emerald-400' : 'text-amber-400'}
          info={deck2}
          oppositeKey={d1EffectiveKey}
          hasOppositeTrack={Boolean(deck1.track)}
          isSynced={isSynced}
          isPlaying={deck2Playing}
          elapsedBeatsRef={elapsedBeatsRef}
          displayedBpm={masterBpm * deck2.tempoMultiplier * (1 + deck2RateTrimPct / 100)}
          trimLabel={deck2TrimLabel}
          onTogglePlay={() => onToggleDeckPlay(2)}
          onToggleSync={onToggleSync}
          onManualPhaseNudge={onManualPhaseNudge}
          onSnapPhaseZero={onSnapPhaseZero}
          onLoadFile={(file) => onLoadFile(2, file)}
          onLoadDemo={() => onLoadDemo(2)}
          onClear={() => onClearDeck(2)}
          onBpmChange={(bpm) => onManualBpmChange(2, bpm)}
          onAnchorShift={(delta) => onManualAnchorShift(2, delta)}
          onStartBeatSelect={(beatIdx) => onStartBeatSelect(2, beatIdx)}
          onAutoMatchRhythm={() => onAutoMatchRhythm(2)}
          onToggleKeyLock={() => onToggleKeyLock(2)}
          onKeyShiftChange={(st) => onKeyShiftChange(2, st)}
          onMatchKeyToOpposite={() => onMatchKeyToOpposite(2)}
          onApplyDetectedTransient={onApplyDetectedTransientOffset}
        />
      </div>

      {/* Serato Mixer Strip: Crossfader + Continuous Auto-Nudge Cap */}
      <div className="mt-3 bg-[#12161F] border border-[#232A38] rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            onClick={onToggleAutoNudge}
            aria-pressed={autoNudgeEnabled}
            data-testid="auto-nudge-toggle"
            className={`px-3 py-1.5 rounded-md font-mono font-semibold border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              autoNudgeEnabled
                ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-600/30'
                : 'bg-[#181E2A] border-slate-600 text-slate-400 hover:text-white'
            }`}
          >
            {autoNudgeEnabled ? '● Auto-Nudge ON' : '○ Auto-Nudge OFF'}
          </button>

          <div
            className="inline-flex items-center gap-1 p-1 bg-[#0B0E14] border border-[#222938] rounded-lg"
            role="group"
            aria-label="Maximum micro-nudge rate trim cap"
            data-testid="max-trim-select"
          >
            <span className="px-2 text-[11px] font-mono text-slate-400 whitespace-nowrap">
              Max Trim
            </span>
            {[0.15, 0.25, 0.5].map((cap) => (
              <button
                key={cap}
                type="button"
                onClick={() => onMaxNudgeTrimChange(cap)}
                className={`px-2 py-1 text-[11px] font-mono font-semibold rounded transition-colors whitespace-nowrap cursor-pointer ${
                  Math.abs(maxNudgeTrimPct - cap) < 0.01
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                ±{cap.toFixed(2)}%
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-1 min-w-[240px] max-w-md">
          <span className="text-xs font-semibold text-slate-400 whitespace-nowrap">Crossfader</span>
          <button
            type="button"
            onClick={() => onCrossfaderChange(-1)}
            className="text-xs font-mono font-semibold text-sky-400 hover:text-sky-300 cursor-pointer"
          >
            D1
          </button>
          <input
            aria-label="Deck 1 to Deck 2 crossfader"
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={crossfader}
            onChange={(e) => onCrossfaderChange(Number(e.target.value))}
            className="flex-1 accent-sky-500 cursor-pointer"
          />
          <button
            type="button"
            onClick={() => onCrossfaderChange(1)}
            className="text-xs font-mono font-semibold text-emerald-400 hover:text-emerald-300 cursor-pointer"
          >
            D2
          </button>
          <button
            type="button"
            onClick={() => onCrossfaderChange(0)}
            className="px-2 py-1 text-xs font-mono font-medium bg-[#181E2A] hover:bg-[#232B3B] border border-[#2B3446] text-slate-200 rounded cursor-pointer"
          >
            50/50
          </button>
        </div>
      </div>
    </section>
  );
});
