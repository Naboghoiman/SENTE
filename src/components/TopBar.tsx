import React from 'react';

interface TopBarProps {
  onSnapToZero: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ onSnapToZero }) => {
  return (
    <header className="sticky top-0 z-30 bg-[#0D1017]/95 backdrop-blur-sm border-b border-[#222938]">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-6">
        <a
          href="#simulator"
          className="flex items-center gap-2.5 text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-sky-500/20 border border-sky-400/50 text-sky-400 font-mono text-xs">
            PZ
          </span>
          <span>PhaseZero</span>
          <span className="hidden sm:inline text-xs font-mono font-medium text-slate-400">
            · Serato-Style Dual-Deck Studio
          </span>
        </a>

        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 text-xs font-semibold uppercase tracking-wider text-slate-400"
        >
          <a
            href="#simulator"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Decks &amp; Waveforms
          </a>
          <a
            href="#calibration-rack"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Calibration
          </a>
          <a
            href="#djay-guide"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Sync Protocol
          </a>
          <a
            href="#drift-math"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Drift Math
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onSnapToZero}
            className="px-3.5 py-1.5 text-xs font-mono font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded-md border border-sky-400/40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Snap 0.00 ms
          </button>
        </div>
      </div>
    </header>
  );
};
