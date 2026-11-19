import React, { memo, useState } from 'react';
import { calculateDriftMath } from '../utils/phaseMath';

export const DriftCalculatorSection: React.FC = memo(() => {
  const [bpm, setBpm] = useState<number>(124);
  const [bpmDelta, setBpmDelta] = useState<number>(0.15);
  const [bars, setBars] = useState<number>(16);

  const math = calculateDriftMath(bpm, bpmDelta, bars);

  return (
    <section id="drift-math" className="pt-12 pb-16 border-t border-[#222938]">
      <div className="max-w-2xl mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-white">
          BPM Drift &amp; Comb-Filtering Calculator
        </h2>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed">
          Even a tiny 0.15 BPM speed mismatch or a 10 ms beatgrid offset creates audible bass
          cancellation (comb-filtering) at predictable frequencies. Calculate exact millisecond
          tolerances for your track tempo below.
        </p>
      </div>

      <div className="bg-[#12161F] border border-[#232A38] rounded-xl p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 grid grid-cols-1 gap-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="calc-bpm" className="text-xs font-semibold text-slate-300">
                Master Track Tempo (BPM)
              </label>
              <span className="text-xs font-mono tabular-nums font-semibold text-white">
                {bpm.toFixed(1)} BPM
              </span>
            </div>
            <input
              id="calc-bpm"
              type="range"
              min={70}
              max={175}
              step={0.5}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
              className="w-full accent-sky-500 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="calc-delta" className="text-xs font-semibold text-slate-300">
                Uncompensated BPM Mismatch
              </label>
              <span className="text-xs font-mono tabular-nums font-semibold text-white">
                {bpmDelta > 0 ? '+' : ''}
                {bpmDelta.toFixed(2)} BPM
              </span>
            </div>
            <input
              id="calc-delta"
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={bpmDelta}
              onChange={(e) => setBpmDelta(Number(e.target.value))}
              className="w-full accent-sky-500 cursor-pointer"
            />
          </div>

          <div>
            <span className="block text-xs font-semibold text-slate-300 mb-1.5">
              Transition Length (Bars)
            </span>
            <div className="grid grid-cols-4 gap-1 p-1 bg-[#0B0E14] border border-[#222938] rounded-lg">
              {[4, 8, 16, 32].map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBars(b)}
                  className={`py-1.5 text-xs font-mono font-medium rounded transition-colors cursor-pointer ${
                    bars === b
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {b} Bars
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-[#0D1017] border border-[#202736] rounded-lg p-4">
            <div className="text-xs text-slate-400">1 Beat Duration</div>
            <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-white">
              {math.beatMs.toFixed(2)} ms
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg p-4">
            <div className="text-xs text-slate-400">1/32 Grid Step</div>
            <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-white">
              {math.thirtySecondMs.toFixed(2)} ms
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg p-4">
            <div className="text-xs text-slate-400">Drift Per Beat</div>
            <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-white">
              {math.driftPerBeatMs > 0 ? '+' : ''}
              {math.driftPerBeatMs.toFixed(3)} ms
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg p-4">
            <div className="text-xs text-slate-400">Drift After {bars} Bars</div>
            <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-amber-400">
              {math.totalDriftMs > 0 ? '+' : ''}
              {math.totalDriftMs.toFixed(2)} ms
            </div>
          </div>

          <div className="bg-[#0D1017] border border-[#202736] rounded-lg p-4 sm:col-span-2">
            <div className="text-xs text-slate-400">First Comb-Filter Cancellation Notch</div>
            <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-white">
              {math.firstNotchHz ? `${math.firstNotchHz} Hz` : 'Zero Cancellation'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});
