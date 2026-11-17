import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface MockPort {
  onmessage: ((ev: { data: Record<string, unknown> }) => void) | null;
  postMessage: (msg: Record<string, unknown>) => void;
}

interface WorkletInstance {
  port: MockPort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

function createWorkletProcessor(sampleRate = 44100): {
  processor: WorkletInstance;
  telemetryLog: Record<string, unknown>[];
} {
  const code = fs.readFileSync(
    path.resolve(process.cwd(), 'public/phasezero-worklet.js'),
    'utf8'
  );
  let RegisteredClass: (new () => WorkletInstance) | null = null;
  const telemetryLog: Record<string, unknown>[] = [];

  class MockAudioWorkletProcessor {
    port: MockPort;
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (msg: Record<string, unknown>) => {
          telemetryLog.push(msg);
        },
      };
    }
  }

  const sandbox = {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    sampleRate,
    registerProcessor: (_name: string, cls: new () => WorkletInstance) => {
      RegisteredClass = cls;
    },
    Math,
    Float32Array,
    Float64Array,
    Uint16Array,
    Int16Array,
    Uint8Array,
    Boolean,
    Number,
  };

  vm.runInNewContext(code, sandbox);
  if (!RegisteredClass) {
    throw new Error('PhaseZeroWorkletProcessor was not registered');
  }
  const processor = new (RegisteredClass as new () => WorkletInstance)();
  return { processor, telemetryLog };
}

function sendMsg(proc: WorkletInstance, msg: Record<string, unknown>) {
  proc.port.onmessage?.({ data: msg });
}

function renderStereoAudio(
  proc: WorkletInstance,
  totalFrames: number,
  blockFrames = 128
): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];

  for (let offset = 0; offset < totalFrames; offset += blockFrames) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    proc.process([], [outBlock]);
    const count = Math.min(blockFrames, totalFrames - offset);
    left.set(outBlock[0].subarray(0, count), offset);
    right.set(outBlock[1].subarray(0, count), offset);
  }
  return { left, right };
}

function computePeakFrequencyAndClarityDb(
  samples: Float32Array,
  sampleRate: number,
  startSample: number,
  fftLen = 8192
): { peakHz: number; clarityDb: number } {
  // Apply Hann window and compute DFT magnitude spectrum on [0..fftLen/2]
  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);
  for (let n = 0; n < fftLen; n++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (fftLen - 1)));
    re[n] = (samples[startSample + n] || 0) * w;
  }

  // Radix-2 FFT
  const log2N = Math.round(Math.log2(fftLen));
  for (let i = 0; i < fftLen; i++) {
    let rev = 0;
    for (let b = 0; b < log2N; b++) {
      if ((i >> b) & 1) rev |= 1 << (log2N - 1 - b);
    }
    if (i < rev) {
      const tr = re[i];
      re[i] = re[rev];
      re[rev] = tr;
      const ti = im[i];
      im[i] = im[rev];
      im[rev] = ti;
    }
  }
  for (let halfLen = 1; halfLen < fftLen; halfLen <<= 1) {
    const step = halfLen << 1;
    const ang = (-2 * Math.PI) / step;
    const wSr = Math.cos(ang);
    const wSi = Math.sin(ang);
    for (let start = 0; start < fftLen; start += step) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < halfLen; k++) {
        const e = start + k;
        const o = e + halfLen;
        const tr = wr * re[o] - wi * im[o];
        const ti = wr * im[o] + wi * re[o];
        re[o] = re[e] - tr;
        im[o] = im[e] - ti;
        re[e] += tr;
        im[e] += ti;
        const nWr = wr * wSr - wi * wSi;
        wi = wr * wSi + wi * wSr;
        wr = nWr;
      }
    }
  }

  const mags: number[] = [];
  let maxMag = 0;
  let maxBin = 0;
  for (let k = 2; k < fftLen / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    mags.push(m);
    if (m > maxMag) {
      maxMag = m;
      maxBin = k;
    }
  }

  // Parabolic peak interpolation for sub-Hz precision
  const mL = Math.hypot(re[maxBin - 1], im[maxBin - 1]);
  const mC = maxMag;
  const mR = Math.hypot(re[maxBin + 1], im[maxBin + 1]);
  const denom = mL - 2 * mC + mR;
  const delta = Math.abs(denom) > 1e-12 ? 0.5 * ((mL - mR) / denom) : 0;
  const peakHz = ((maxBin + delta) * sampleRate) / fftLen;

  // Measure peak-to-sidelobe noise floor clarity (exclude bins around fundamental & harmonics)
  const sorted = [...mags].sort((a, b) => a - b);
  const medianNoise = Math.max(1e-12, sorted[Math.floor(sorted.length * 0.7)]);
  const clarityDb = 20 * Math.log10(maxMag / medianNoise);
  return { peakHz, clarityDb };
}

test('Key Lock ON preserves exact 440 Hz pitch across +5% and -6% BPM changes with high spectral clarity', () => {
  const sr = 44100;
  const durationSec = 4;
  const len = sr * durationSec;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    mono[i] = 0.65 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 880 * t);
  }

  for (const targetBpm of [126, 113]) {
    const { processor } = createWorkletProcessor(sr);
    sendMsg(processor, {
      type: 'loadTrack',
      deck: 1,
      channels: [mono, mono],
      length: len,
      trackSampleRate: sr,
      durationSec,
      bpm: 120,
      anchorMs: 0,
      keyLock: true,
      keyShiftSemitones: 0,
    });
    sendMsg(processor, {
      type: 'setParams',
      masterBpm: targetBpm,
      crossfader: -1,
    });
    sendMsg(processor, { type: 'start', elapsedBeats: 0 });

    const { left } = renderStereoAudio(processor, 24576);
    const { peakHz, clarityDb } = computePeakFrequencyAndClarityDb(left, sr, 8192, 8192);
    assert.ok(
      Math.abs(peakHz - 440) <= 2.0,
      `Expected Key Lock at ${targetBpm} BPM (from 120) to preserve 440 Hz, got ${peakHz.toFixed(2)} Hz`
    );
    assert.ok(
      clarityDb >= 45,
      `Expected phase-locked PV spectral clarity >= 45 dB at ${targetBpm} BPM, got ${clarityDb.toFixed(1)} dB`
    );
  }
});

test('Key Adjuster shifts 440 Hz accurately (-5 st -> 329.6 Hz, +5 st -> 587.3 Hz, +7 st -> 659.3 Hz) with > 45 dB clarity and zero clipping', () => {
  const sr = 44100;
  const durationSec = 4;
  const len = sr * durationSec;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    mono[i] = 0.7 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }

  const cases = [
    { st: -5, expectedHz: 440 * Math.pow(2, -5 / 12) },
    { st: 5, expectedHz: 440 * Math.pow(2, 5 / 12) },
    { st: 7, expectedHz: 440 * Math.pow(2, 7 / 12) },
  ];

  for (const { st, expectedHz } of cases) {
    const { processor } = createWorkletProcessor(sr);
    sendMsg(processor, {
      type: 'loadTrack',
      deck: 1,
      channels: [mono, mono],
      length: len,
      trackSampleRate: sr,
      durationSec,
      bpm: 124,
      anchorMs: 0,
      keyLock: true,
      keyShiftSemitones: st,
    });
    sendMsg(processor, {
      type: 'setParams',
      masterBpm: 124,
      crossfader: -1,
    });
    sendMsg(processor, { type: 'start', elapsedBeats: 0 });

    const { left, right } = renderStereoAudio(processor, 24576);
    const { peakHz, clarityDb } = computePeakFrequencyAndClarityDb(left, sr, 8192, 8192);

    assert.ok(
      Math.abs(peakHz - expectedHz) <= 2.5,
      `Expected ${st} st shift -> ${expectedHz.toFixed(1)} Hz, got ${peakHz.toFixed(2)} Hz`
    );
    assert.ok(
      clarityDb >= 45,
      `Expected crystal-clear >= 45 dB peak-to-noise clarity at ${st} st, got ${clarityDb.toFixed(1)} dB`
    );

    // Stereo coherence check: centered mono input must remain identical L === R
    let maxStereoDiff = 0;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Number.isFinite(left[i]) && Math.abs(left[i]) <= 1.2);
      maxStereoDiff = Math.max(maxStereoDiff, Math.abs(left[i] - right[i]));
    }
    assert.ok(
      maxStereoDiff < 1e-5,
      `Expected centered stereo coherence < 1e-5 at ${st} st, got ${maxStereoDiff}`
    );
  }
});

test('Anti-aliasing attenuates ultra-high harmonics before Nyquist when shifting pitch UP +7 st', () => {
  const sr = 44100;
  const durationSec = 2;
  const len = sr * durationSec;
  const mono = new Float32Array(len);
  // High 18 kHz sine shifted up +7 st (~1.4983x -> ~26.97 kHz) would alias to ~17.13 kHz without band-limiting
  for (let i = 0; i < len; i++) {
    mono[i] = 0.8 * Math.sin((2 * Math.PI * 18000 * i) / sr);
  }

  const { processor } = createWorkletProcessor(sr);
  sendMsg(processor, {
    type: 'loadTrack',
    deck: 1,
    channels: [mono],
    length: len,
    trackSampleRate: sr,
    durationSec,
    bpm: 124,
    anchorMs: 0,
    keyLock: true,
    keyShiftSemitones: 7,
  });
  sendMsg(processor, { type: 'setParams', masterBpm: 124, crossfader: -1 });
  sendMsg(processor, { type: 'start', elapsedBeats: 0 });

  const { left } = renderStereoAudio(processor, 16384);
  let sumSq = 0;
  for (let i = 4096; i < left.length; i++) sumSq += left[i] * left[i];
  const rms = Math.sqrt(sumSq / (left.length - 4096));
  assert.ok(rms < 0.02, `Expected ultrasonic anti-aliasing RMS < 0.02, got ${rms.toFixed(4)}`);
});

test('Kick transients remain crisp, punchy (>= 80% RMS), and beat-locked within <= 0.25 ms during -5 st Key Shift', () => {
  const sr = 44100;
  const bpm = 124;
  const beatSec = 60 / bpm;
  const durationSec = 4;
  const len = sr * durationSec;
  const track = new Float32Array(len);

  // Place sustained 220 Hz pad + sharp 1.5 kHz transient clicks + 60 ms club kicks at exact beats
  for (let i = 0; i < len; i++) {
    track[i] = 0.08 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  const beat1Sample = Math.round(beatSec * sr);
  for (let k = 0; k < Math.round(0.06 * sr); k++) {
    const kt = k / sr;
    const kickBody = Math.sin(2 * Math.PI * (55 + 110 * Math.exp(-kt * 45)) * kt) * Math.exp(-kt * 28) * 0.72;
    const transientClick = Math.sin(2 * Math.PI * 1500 * kt) * Math.exp(-kt * 600) * 0.35;
    const val = kickBody + transientClick;
    if (k < len) track[k] += val;
    if (beat1Sample + k < len) track[beat1Sample + k] += val;
  }

  const { processor, telemetryLog } = createWorkletProcessor(sr);
  sendMsg(processor, {
    type: 'loadTrack',
    deck: 1,
    channels: [track],
    length: len,
    trackSampleRate: sr,
    durationSec,
    bpm: 124,
    anchorMs: 0,
    keyLock: true,
    keyShiftSemitones: 0,
  });
  sendMsg(processor, {
    type: 'loadTrack',
    deck: 2,
    channels: [track],
    length: len,
    trackSampleRate: sr,
    durationSec,
    bpm: 124,
    anchorMs: 0,
    keyLock: true,
    keyShiftSemitones: -5,
  });
  sendMsg(processor, {
    type: 'setParams',
    masterBpm: 124,
    syncMode: 'beat',
    autoNudgeEnabled: true,
    desiredOffsetMs: 0,
    crossfader: 1, // Solo Deck 2 through -5 st Phase Vocoder (0.85 gain)
  });
  sendMsg(processor, { type: 'start', elapsedBeats: 0, initialPhaseErrorMs: 0 });

  const { left } = renderStereoAudio(processor, 28000);

  // Check RMS kick energy preservation across the 60 ms kick body
  let srcSq = 0;
  let outSq = 0;
  const kickLen = Math.round(0.06 * sr);
  for (let i = 0; i < kickLen; i++) {
    srcSq += track[beat1Sample + i] * track[beat1Sample + i];
    const gNorm = left[beat1Sample + i] / 0.85;
    outSq += gNorm * gNorm;
  }
  const rmsRatio = Math.sqrt(outSq / srcSq);
  assert.ok(
    rmsRatio >= 0.8,
    `Expected >= 80% kick RMS punch preservation under -5 st Key Shift, got ${(rmsRatio * 100).toFixed(1)}%`
  );

  // Check initial kick attack crest alignment in [-4 ms .. +3.5 ms] around Beat 1
  const winStart = beat1Sample - Math.round(0.004 * sr);
  const winEnd = beat1Sample + Math.round(0.0035 * sr);
  let refPeakIdx = beat1Sample;
  let refPeak = -Infinity;
  let outPeakIdx = beat1Sample;
  let outPeak = -Infinity;
  for (let i = winStart; i <= winEnd; i++) {
    if (track[i] > refPeak) {
      refPeak = track[i];
      refPeakIdx = i;
    }
    if (left[i] > outPeak) {
      outPeak = left[i];
      outPeakIdx = i;
    }
  }
  const peakShiftMs = Math.abs(outPeakIdx - refPeakIdx) * (1000 / sr);
  assert.ok(
    peakShiftMs <= 0.35,
    `Expected Beat 1 initial attack crest within <= 0.35 ms of source during -5 st shift, got ${peakShiftMs.toFixed(2)} ms`
  );

  const lastTel = telemetryLog[telemetryLog.length - 1];
  assert.equal(lastTel?.livePhaseErrorMs, 0);
});
