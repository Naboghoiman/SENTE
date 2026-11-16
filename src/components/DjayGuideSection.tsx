import React from 'react';
import { ArrowUpRight } from 'lucide-react';

export interface GuideStep {
  id: string;
  number: string;
  title: string;
  djayPath: string;
  explanation: string;
  action: string;
  scenarioId: string;
}

const GUIDE_STEPS: GuideStep[] = [
  {
    id: 'step-sync-mode',
    number: '01',
    title: 'Set Sync Mode to Beat (Not Tempo) & Enable Quantize',
    djayPath: 'Settings → General → Sync Mode → Beat',
    explanation:
      'In Tempo Sync mode, djay matches BPM speed only—leaving any existing beat misalignment untouched. Switching to Beat Sync locks both tempo and beat phase, while Quantize snaps Hot Cues and Play triggers directly onto the master grid.',
    action: 'Engage Beat Sync and set Quantize to 1 Beat (or 1/4 Beat for live cueing).',
    scenarioId: 'tempo-only-sync',
  },
  {
    id: 'step-grid-anchor',
    number: '02',
    title: 'Anchor Downbeat 1.1.1 on the True Kick Transient',
    djayPath: 'Deck Waveform → Pencil / Beatgrid Icon → Edit Grid',
    explanation:
      'MP3 encoder padding and silent intros often trick auto-analysis into placing Beat 1 a few milliseconds early or late. When Beat Sync aligns two grids whose Beat 1 markers sit at different offsets from their transients, you hear flamming and bass cancellation.',
    action:
      'Pinch-zoom the parallel waveform to maximum magnification, place the playhead on the exact first transient peak, and tap Set Grid Start (or shift ±ms until waveforms stack pixel-for-pixel).',
    scenarioId: 'mp3-padding',
  },
  {
    id: 'step-fluid-grid',
    number: '03',
    title: 'Match Straight vs. Dynamic (Fluid) Beatgrid to the Track',
    djayPath: 'Beatgrid Menu → Straight / Dynamic',
    explanation:
      'Quantized house/techno tracks have rock-solid tempo and perform best on a Straight grid. Live-drummer tracks (disco, funk, rock, older soul) naturally drift in tempo; forcing a Straight grid causes cumulative phase drift every bar.',
    action:
      'Enable Dynamic (Fluid Beatgrid) for unquantized live recordings, and lock Straight grids for studio electronic tracks to prevent micro-tempo jitter.',
    scenarioId: 'live-drummer-drift',
  },
  {
    id: 'step-audio-latency',
    number: '04',
    title: 'Eliminate Wireless DSP & Cue-to-Master Latency',
    djayPath: 'Audio Device Setup → Wired Output / Pre-Cueing',
    explanation:
      'Bluetooth speakers and consumer soundbars introduce 30–150 ms of DSP delay on the master output while wired headphones play instantaneously. Even when djay reports 0.0 ms internal phase error, your ears hear a jarring echo between cue and room.',
    action:
      'Use wired audio connections (USB-C / RCA / XLR) for both Master and Pre-Cueing, or disable speaker room-correction DSP.',
    scenarioId: 'bluetooth-latency',
  },
  {
    id: 'step-phase-verify',
    number: '05',
    title: 'Confirm Zero-Error Lock on the Phase Meter & Stacked Waveforms',
    djayPath: '2-Deck / 4-Deck View → Center Phase Meter',
    explanation:
      'Before raising the incoming channel fader, check the central Phase Meter and stacked parallel waveforms. If the meter stays centered with zero orange/red excursion over an 8-bar loop, both tracks are sample-locked.',
    action:
      'Verify zero drift across a 16-bar phrase; if pitch bend is enabled, keep Tempo Slider Range at ±6% or ±8% for fine manual adjustments.',
    scenarioId: 'zero-locked',
  },
];

interface DjayGuideSectionProps {
  completedSteps: Record<string, boolean>;
  onToggleStep: (stepId: string) => void;
  onSimulateScenario: (scenarioId: string) => void;
}

export const DjayGuideSection: React.FC<DjayGuideSectionProps> = ({
  completedSteps,
  onToggleStep,
  onSimulateScenario,
}) => {
  const completedCount = GUIDE_STEPS.filter((s) => completedSteps[s.id]).length;

  return (
    <section id="djay-guide" className="pt-12 border-t border-[#222938]">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Five-Step Protocol for Zero Phase Error in djay &amp; Serato
          </h2>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            Follow these exact calibrations to eliminate transient flamming, comb-filtering, and
            bar-to-bar drift. Load any step directly into the dual-deck simulator above to inspect
            the acoustic behavior.
          </p>
        </div>

        <div
          id="checklist"
          className="text-xs font-mono tabular-nums font-medium text-slate-300 bg-[#12161F] border border-[#232A38] rounded-lg px-3.5 py-2"
        >
          Calibration Checklist: {completedCount} / {GUIDE_STEPS.length} verified
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {GUIDE_STEPS.map((step) => {
          const checked = Boolean(completedSteps[step.id]);
          return (
            <article
              key={step.id}
              className="bg-[#12161F] border border-[#232A38] rounded-xl p-5 flex flex-col justify-between gap-4"
            >
              <div>
                <div className="flex items-center gap-2 text-xs text-slate-400 min-w-0">
                  <span className="font-mono font-semibold text-sky-400 whitespace-nowrap shrink-0">
                    Step {step.number}
                  </span>
                  <span aria-hidden="true" className="shrink-0">
                    ·
                  </span>
                  <span className="min-w-0 truncate font-mono">{step.djayPath}</span>
                </div>

                <h3 className="mt-2.5 text-base font-semibold text-white leading-snug">
                  {step.title}
                </h3>

                <p className="mt-2 text-sm text-slate-400 leading-relaxed">{step.explanation}</p>

                <p className="mt-3 text-xs font-medium text-slate-200 bg-[#0D1017] border border-[#202736] rounded-lg p-3 leading-relaxed">
                  {step.action}
                </p>
              </div>

              <div className="pt-3 border-t border-[#1E2432] flex items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleStep(step.id)}
                    className="w-4 h-4 rounded border-slate-600 text-sky-500 accent-sky-500 cursor-pointer"
                  />
                  <span>{checked ? 'Verified' : 'Mark verified'}</span>
                </label>

                <button
                  type="button"
                  onClick={() => onSimulateScenario(step.scenarioId)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-sky-400 hover:text-sky-300 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>Simulate</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </article>
          );
        })}

        {/* 6th Reference Matrix Card to complete the 3x2 grid */}
        <article className="bg-[#0E131D] text-slate-100 border border-[#2A3346] rounded-xl p-5 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-mono font-semibold text-sky-400 whitespace-nowrap shrink-0">
                Quick Reference
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate font-mono">Symptom → Root Fix</span>
            </div>

            <h3 className="mt-2.5 text-base font-semibold text-white leading-snug">
              Rapid Phase Error Triage
            </h3>

            <dl className="mt-3 space-y-2.5 text-xs">
              <div className="border-b border-[#1E2432] pb-2">
                <dt className="font-semibold text-amber-300">Constant double-kick / flam</dt>
                <dd className="mt-0.5 text-slate-300">
                  Beatgrid anchor offset. Zoom in and shift Downbeat 1.1.1 to the kick peak.
                </dd>
              </div>
              <div className="border-b border-[#1E2432] pb-2">
                <dt className="font-semibold text-amber-300">Starts tight, drifts after 8 bars</dt>
                <dd className="mt-0.5 text-slate-300">
                  Live-drummer tempo drift. Switch Beatgrid Type from Straight to Dynamic.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-amber-300">Tight on screen, echo in room</dt>
                <dd className="mt-0.5 text-slate-300">
                  Bluetooth/DSP output delay. Switch master speaker to wired RCA/XLR/USB.
                </dd>
              </div>
            </dl>
          </div>

          <div className="pt-3 border-t border-[#1E2432] flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">Target: 0.00 ms phase error</span>
            <button
              type="button"
              onClick={() => onSimulateScenario('zero-locked')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-sky-400 hover:text-sky-300 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>Load 0.0 ms Ref</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </article>
      </div>
    </section>
  );
};
