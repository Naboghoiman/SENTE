import React from 'react';
import {
  type CalibrationState,
  DIAGNOSTIC_SCENARIOS,
  type GridMode,
  type PhaseMetrics,
  type SyncMode,
} from '../utils/phaseMath';

interface CalibrationControlsProps {
  state: CalibrationState;
  metrics: PhaseMetrics;
  onSelectScenario: (scenarioId: string) => void;
  onSyncModeChange: (mode: SyncMode) => void;
  onGridModeChange: (mode: GridMode) => void;
  onToggleQuantize: () => void;
  onNudgeGridMs: (deltaMs: number) => void;
  onSetGridOffsetMs: (ms: number) => void;
  onSetLatencyMs: (ms: number) => void;
  onSetBpmOffset: (bpmDelta: number) => void;
  onSnapToZero: () => void;
}

export const CalibrationControls: React.FC<CalibrationControlsProps> = ({
  state,
  metrics,
  onSelectScenario,
  onSyncModeChange,
  onGridModeChange,
  onToggleQuantize,
  onNudgeGridMs,
  onSetGridOffsetMs,
  onSetLatencyMs,
  onSetBpmOffset,
  onSnapToZero,
}) => {
  const activeScenario =
    DIAGNOSTIC_SCENARIOS.find((s) => s.id === state.scenarioId) ?? DIAGNOSTIC_SCENARIOS[0];

  const syncLocksSpeed = state.syncMode === 'tempo' || state.syncMode === 'beat';

  return (
    <aside
      id="calibration-rack"
      aria-label="djay Beatgrid and Sync Calibration Controls"
      className="bg-[#12161F] border border-[#232A38] rounded-xl p-4 flex flex-col gap-4"
    >
      {/* Scenario Selector */}
      <div>
        <label
          htmlFor="scenario-select"
          className="block text-xs font-semibold text-slate-300 mb-2"
        >
          Diagnostic Scenario
        </label>
        <select
          id="scenario-select"
          value={state.scenarioId}
          onChange={(e) => onSelectScenario(e.target.value)}
          className="w-full px-3 py-2 text-sm font-medium text-white bg-[#0B0E14] border border-[#2A3346] rounded-lg"
        >
          {DIAGNOSTIC_SCENARIOS.map((sc) => (
            <option key={sc.id} value={sc.id}>
              {sc.title}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-slate-400 leading-relaxed">{activeScenario.summary}</p>
        <p className="mt-1.5 text-xs font-medium text-sky-400 leading-relaxed">
          Fix: {activeScenario.fixHint}
        </p>
      </div>

      <div className="border-t border-[#1E2432]" />

      {/* Sync Mode & Grid Type */}
      <div className="grid grid-cols-1 gap-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-slate-300">Sync Mode</span>
            <span className="text-xs font-mono text-slate-400">
              {state.syncMode === 'beat'
                ? 'Tempo + Phase'
                : state.syncMode === 'tempo'
                  ? 'Tempo Only'
                  : 'Manual'}
            </span>
          </div>
          <div
            className="grid grid-cols-3 gap-1 p-1 bg-[#0B0E14] border border-[#222938] rounded-lg"
            role="group"
            aria-label="Sync Mode"
          >
            {(['off', 'tempo', 'beat'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onSyncModeChange(mode)}
                className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  state.syncMode === mode
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {mode === 'off' ? 'Off' : mode === 'tempo' ? 'Tempo' : 'Beat Sync'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="block text-xs font-semibold text-slate-300 mb-1.5">
              Beatgrid Type
            </span>
            <div
              className="grid grid-cols-2 gap-1 p-1 bg-[#0B0E14] border border-[#222938] rounded-lg"
              role="group"
              aria-label="Beatgrid Type"
            >
              {(['straight', 'dynamic'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => onGridModeChange(g)}
                  className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    state.gridMode === g
                      ? 'bg-[#1D2536] text-white border border-[#303B52]'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {g === 'straight' ? 'Straight' : 'Dynamic'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="block text-xs font-semibold text-slate-300 mb-1.5">Quantize</span>
            <button
              type="button"
              aria-pressed={state.quantize}
              onClick={onToggleQuantize}
              className={`w-full py-2 px-3 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                state.quantize
                  ? 'border-sky-500/50 bg-sky-500/20 text-sky-300'
                  : 'border-[#2A3346] bg-[#0B0E14] text-slate-400 hover:text-white'
              }`}
            >
              {state.quantize ? 'Quantize On (1 Beat)' : 'Quantize Off'}
            </button>
          </div>
        </div>
      </div>

      <div className="border-t border-[#1E2432]" />

      {/* Beatgrid Anchor Offset Calibration */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="grid-offset-slider" className="text-xs font-semibold text-slate-300">
            Deck 2 Beatgrid Anchor Offset
          </label>
          <span className="text-xs font-mono tabular-nums font-semibold text-white">
            {state.gridOffsetMs > 0 ? '+' : ''}
            {state.gridOffsetMs.toFixed(1)} ms
          </span>
        </div>
        <input
          id="grid-offset-slider"
          type="range"
          min={-40}
          max={40}
          step={0.1}
          value={state.gridOffsetMs}
          onChange={(e) => onSetGridOffsetMs(Number(e.target.value))}
          className="w-full accent-sky-500 cursor-pointer"
        />

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onNudgeGridMs(-5)}
            className="px-2.5 py-1.5 text-xs font-mono font-medium border border-[#2B3446] bg-[#181E2B] rounded-md text-slate-200 hover:bg-[#222A3A] cursor-pointer"
          >
            -5 ms
          </button>
          <button
            type="button"
            onClick={() => onNudgeGridMs(-1)}
            className="px-2.5 py-1.5 text-xs font-mono font-medium border border-[#2B3446] bg-[#181E2B] rounded-md text-slate-200 hover:bg-[#222A3A] cursor-pointer"
          >
            -1 ms
          </button>
          <button
            type="button"
            onClick={onSnapToZero}
            className="flex-1 px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Snap to Transient
          </button>
          <button
            type="button"
            onClick={() => onNudgeGridMs(1)}
            className="px-2.5 py-1.5 text-xs font-mono font-medium border border-[#2B3446] bg-[#181E2B] rounded-md text-slate-200 hover:bg-[#222A3A] cursor-pointer"
          >
            +1 ms
          </button>
          <button
            type="button"
            onClick={() => onNudgeGridMs(5)}
            className="px-2.5 py-1.5 text-xs font-mono font-medium border border-[#2B3446] bg-[#181E2B] rounded-md text-slate-200 hover:bg-[#222A3A] cursor-pointer"
          >
            +5 ms
          </button>
        </div>
      </div>

      {/* Output Latency & Pitch Trim */}
      <div className="grid grid-cols-1 gap-3.5">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="audio-latency-slider" className="text-xs font-semibold text-slate-300">
              Output Routing / Bluetooth Latency
            </label>
            <span className="text-xs font-mono tabular-nums text-white">
              {state.audioLatencyMs.toFixed(1)} ms
            </span>
          </div>
          <input
            id="audio-latency-slider"
            type="range"
            min={0}
            max={50}
            step={0.5}
            value={state.audioLatencyMs}
            onChange={(e) => onSetLatencyMs(Number(e.target.value))}
            className="w-full accent-sky-500 cursor-pointer"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="bpm-trim-slider" className="text-xs font-semibold text-slate-300">
              Manual Deck 2 Pitch Offset
            </label>
            <span className="text-xs font-mono tabular-nums text-white">
              {syncLocksSpeed
                ? 'Locked by Sync'
                : `${state.deck2BpmOffset > 0 ? '+' : ''}${state.deck2BpmOffset.toFixed(2)} BPM`}
            </span>
          </div>
          <input
            id="bpm-trim-slider"
            type="range"
            min={-2}
            max={2}
            step={0.05}
            disabled={syncLocksSpeed}
            value={state.deck2BpmOffset}
            onChange={(e) => onSetBpmOffset(Number(e.target.value))}
            className="w-full accent-sky-500 disabled:opacity-45 cursor-pointer"
          />
        </div>
      </div>

      {metrics.absErrorMs === 0 && (
        <div className="px-3 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/35 text-xs font-medium text-emerald-300">
          ● Zero phase correction error verified at 0.00 ms.
        </div>
      )}
    </aside>
  );
};
