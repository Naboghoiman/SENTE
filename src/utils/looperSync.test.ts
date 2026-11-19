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

function buildClickLoop(
  bpm: number,
  totalBeats: number,
  sampleRate: number,
  anchorMs = 0,
  beatShift = 0
): Float32Array {
  const beatSec = 60 / bpm;
  const anchorSamples = Math.round((anchorMs / 1000) * sampleRate);
  const totalSamples = anchorSamples + Math.round(totalBeats * beatSec * sampleRate);
  const buf = new Float32Array(totalSamples);

  for (let b = 0; b < totalBeats; b++) {
    const startIdx = anchorSamples + Math.round(b * beatSec * sampleRate);
    const isDownbeat = ((b - beatShift) % 4 + 4) % 4 === 0;
    const amp = isDownbeat ? 1.0 : 0.7;
    const pulseLen = Math.min(Math.round(0.035 * sampleRate), totalSamples - startIdx);
    for (let k = 0; k < pulseLen; k++) {
      const t = k / sampleRate;
      const kick = Math.sin(2 * Math.PI * (65 + 95 * Math.exp(-t * 50)) * t) * Math.exp(-t * 40);
      const crest = Math.cos(2 * Math.PI * 1200 * t) * Math.exp(-t * 700);
      buf[startIdx + k] += amp * (kick * 0.35 + crest * 0.75);
    }
  }
  return buf;
}

function findTransientOnsets(
  samples: Float32Array,
  sampleRate: number,
  threshold = 0.25,
  minGapSec = 0.3
): number[] {
  const peaks: number[] = [];
  const minGapSamples = Math.round(minGapSec * sampleRate);
  let i = 0;
  while (i < samples.length) {
    if (Math.abs(samples[i]) >= threshold) {
      let bestIdx = i;
      let bestVal = Math.abs(samples[i]);
      const winEnd = Math.min(samples.length, i + Math.round(0.004 * sampleRate));
      for (let j = i + 1; j < winEnd; j++) {
        if (Math.abs(samples[j]) > bestVal) {
          bestVal = Math.abs(samples[j]);
          bestIdx = j;
        }
      }
      peaks.push(bestIdx);
      i = bestIdx + minGapSamples;
    } else {
      i++;
    }
  }
  return peaks;
}

function measureBeatEnvelopeOffsetMs(
  refAudio: Float32Array,
  testAudio: Float32Array,
  beatSample: number,
  sampleRate: number
): number {
  const halfSearch = Math.round(0.005 * sampleRate);
  const winPre = Math.round(0.006 * sampleRate);
  const winPost = Math.round(0.02 * sampleRate);
  const smoothR = Math.round(0.0015 * sampleRate);

  const envVal = (buf: Float32Array, idx: number) => {
    let e = 0;
    for (let s = -smoothR; s <= smoothR; s++) {
      const p = idx + s;
      if (p >= 0 && p < buf.length) e += buf[p] * buf[p];
    }
    return e;
  };

  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -halfSearch; lag <= halfSearch; lag++) {
    let corr = 0;
    for (let k = -winPre; k <= winPost; k++) {
      corr += envVal(refAudio, beatSample + k) * envVal(testAudio, beatSample + k + lag);
    }
    if (corr > bestScore) {
      bestScore = corr;
      bestLag = lag;
    }
  }
  return (bestLag * 1000) / sampleRate;
}

test('Audio Looper Slot sample-accurate phase lock stays <= 0.05 ms continuously across 33+ beats (8+ loop wraps) and mid-playback BPM jump', () => {
  const sr = 44100;
  const songBpm = 126;
  const loopBpm = 122;
  const loopBeats = 4;
  const songBeats = 40;

  const songPcm = buildClickLoop(songBpm, songBeats, sr, 0, 0);
  const loopPcm = buildClickLoop(loopBpm, loopBeats, sr, 12.5, 2);

  const runSolo = (playLooperOnly: boolean) => {
    const { processor, telemetryLog } = createWorkletProcessor(sr);
    if (!playLooperOnly) {
      sendMsg(processor, {
        type: 'loadTrack',
        deck: 1,
        channels: [songPcm],
        length: songPcm.length,
        trackSampleRate: sr,
        durationSec: songPcm.length / sr,
        bpm: songBpm,
        anchorMs: 0,
        keyLock: false,
        keyShiftSemitones: 0,
      });
    } else {
      sendMsg(processor, {
        type: 'loadLooperTrack',
        channels: [loopPcm],
        length: loopPcm.length,
        trackSampleRate: sr,
        durationSec: loopPcm.length / sr,
        bpm: loopBpm,
        anchorMs: 12.5,
        startBeatOffset: 2,
        tempoMultiplier: 1,
        keyLock: false,
        keyShiftSemitones: 0,
        active: true,
        gain: 0.85,
        loopBeatsOverride: 4,
      });
    }

    sendMsg(processor, {
      type: 'setParams',
      masterBpm: songBpm,
      syncMode: 'beat',
      crossfader: -1,
    });
    sendMsg(processor, { type: 'start', elapsedBeats: 0, initialPhaseErrorMs: 0 });

    const blockFrames = 128;
    const totalSec = 16.5;
    const totalBlocks = Math.ceil((totalSec * sr) / blockFrames);
    const changeBpmBlock = Math.floor(totalBlocks * 0.45);
    const out = new Float32Array(totalBlocks * blockFrames);
    const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];
    const expectedBeatSamples: number[] = [0];
    let beatClock = 0;
    let activeMasterBpm = songBpm;

    for (let b = 0; b < totalBlocks; b++) {
      if (b === changeBpmBlock) {
        activeMasterBpm = 131;
        sendMsg(processor, { type: 'setParams', masterBpm: activeMasterBpm });
      }
      const prevBeat = beatClock;
      const stepBeats = (blockFrames / sr) * (activeMasterBpm / 60);
      beatClock += stepBeats;
      if (Math.floor(beatClock) > Math.floor(prevBeat)) {
        const fracWithinBlock = (Math.floor(beatClock) - prevBeat) / stepBeats;
        expectedBeatSamples.push(Math.round(b * blockFrames + fracWithinBlock * blockFrames));
      }
      outBlock[0].fill(0);
      outBlock[1].fill(0);
      processor.process([], [outBlock]);
      out.set(outBlock[0], b * blockFrames);
    }
    return { out, telemetryLog, expectedBeatSamples };
  };

  const d1Run = runSolo(false);
  const lpRun = runSolo(true);

  assert.ok(lpRun.telemetryLog.length > 20);
  for (const tel of lpRun.telemetryLog) {
    assert.equal(tel.looperPhaseErrorMs, 0);
    const pos = Number(tel.looperBeatPos);
    assert.ok(pos >= 0 && pos < 4);
  }

  let maxErrMs = 0;
  for (let b = 1; b < lpRun.expectedBeatSamples.length - 1; b++) {
    const offMs = Math.abs(
      measureBeatEnvelopeOffsetMs(d1Run.out, lpRun.out, lpRun.expectedBeatSamples[b], sr)
    );
    if (offMs > maxErrMs) maxErrMs = offMs;
  }

  assert.ok(
    maxErrMs <= 0.05,
    `Expected exact <= 0.05 ms continuous Looper phase lock to Deck 1 across 8+ loop wraps and BPM jump, got ${maxErrMs.toFixed(3)} ms`
  );
});

test('Audio Looper Slot with Key Lock ON + Key Shift (-3 st) keeps zero cumulative drift across 33+ beats & BPM jump', () => {
  const sr = 44100;
  const songBpm = 126;
  const loopBpm = 122;
  const songPcm = buildClickLoop(songBpm, 40, sr, 0, 0);
  const loopPcm = buildClickLoop(loopBpm, 4, sr, 12.5, 2);

  const runSolo = (playLooperOnly: boolean) => {
    const { processor, telemetryLog } = createWorkletProcessor(sr);
    if (!playLooperOnly) {
      sendMsg(processor, {
        type: 'loadTrack',
        deck: 1,
        channels: [songPcm],
        length: songPcm.length,
        trackSampleRate: sr,
        durationSec: songPcm.length / sr,
        bpm: songBpm,
        anchorMs: 0,
        keyLock: true,
        keyShiftSemitones: 0,
      });
    } else {
      sendMsg(processor, {
        type: 'loadLooperTrack',
        channels: [loopPcm],
        length: loopPcm.length,
        trackSampleRate: sr,
        durationSec: loopPcm.length / sr,
        bpm: loopBpm,
        anchorMs: 12.5,
        startBeatOffset: 2,
        tempoMultiplier: 1,
        keyLock: true,
        keyShiftSemitones: -3,
        active: true,
        gain: 0.85,
        loopBeatsOverride: 4,
      });
    }
    sendMsg(processor, { type: 'setParams', masterBpm: songBpm, syncMode: 'beat', crossfader: -1 });
    sendMsg(processor, { type: 'start', elapsedBeats: 0, initialPhaseErrorMs: 0 });

    const blockFrames = 128;
    const totalSec = 16.5;
    const totalBlocks = Math.ceil((totalSec * sr) / blockFrames);
    const changeBpmBlock = Math.floor(totalBlocks * 0.45);
    const out = new Float32Array(totalBlocks * blockFrames);
    const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];
    const expectedBeatSamples: number[] = [0];
    let beatClock = 0;
    let activeMasterBpm = songBpm;

    for (let b = 0; b < totalBlocks; b++) {
      if (b === changeBpmBlock) {
        activeMasterBpm = 131;
        sendMsg(processor, { type: 'setParams', masterBpm: activeMasterBpm });
      }
      const prevBeat = beatClock;
      const stepBeats = (blockFrames / sr) * (activeMasterBpm / 60);
      beatClock += stepBeats;
      if (Math.floor(beatClock) > Math.floor(prevBeat)) {
        const fracWithinBlock = (Math.floor(beatClock) - prevBeat) / stepBeats;
        expectedBeatSamples.push(Math.round(b * blockFrames + fracWithinBlock * blockFrames));
      }
      outBlock[0].fill(0);
      outBlock[1].fill(0);
      processor.process([], [outBlock]);
      out.set(outBlock[0], b * blockFrames);
    }
    return { out, telemetryLog, expectedBeatSamples };
  };

  const d1Run = runSolo(false);
  const lpRun = runSolo(true);

  let maxErrMs = 0;
  for (let b = 1; b < lpRun.expectedBeatSamples.length - 1; b++) {
    const offMs = Math.abs(
      measureBeatEnvelopeOffsetMs(d1Run.out, lpRun.out, lpRun.expectedBeatSamples[b], sr)
    );
    if (offMs > maxErrMs) maxErrMs = offMs;
  }

  assert.ok(
    maxErrMs <= 4.5,
    `Expected bounded zero-drift PV Looper lock across 34 beats & BPM change, got ${maxErrMs.toFixed(2)} ms`
  );
  assert.equal(lpRun.telemetryLog[lpRun.telemetryLog.length - 1]?.looperPhaseErrorMs, 0);
});

test('Audio Looper Slot mute/unmute stays completely silent when muted and resumes in exact 0.00 ms beat lock', () => {
  const sr = 44100;
  const loopPcm = buildClickLoop(124, 8, sr, 0, 0);
  const { processor } = createWorkletProcessor(sr);

  sendMsg(processor, {
    type: 'loadLooperTrack',
    channels: [loopPcm],
    length: loopPcm.length,
    trackSampleRate: sr,
    durationSec: loopPcm.length / sr,
    bpm: 124,
    anchorMs: 0,
    keyLock: true,
    keyShiftSemitones: 0,
    active: false, // Initially muted
    gain: 0.9,
  });
  sendMsg(processor, { type: 'setParams', masterBpm: 124 });
  sendMsg(processor, { type: 'start', elapsedBeats: 0 });

  const blockFrames = 128;
  const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];

  let maxMuted = 0;
  for (let b = 0; b < 500; b++) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    processor.process([], [outBlock]);
    for (let i = 0; i < blockFrames; i++) {
      maxMuted = Math.max(maxMuted, Math.abs(outBlock[0][i]));
    }
  }
  assert.equal(maxMuted, 0, 'Muted Looper must produce exact digital silence');

  sendMsg(processor, { type: 'setParams', looperGrid: { bpm: 124, anchorMs: 0, useBeatTimes: false, active: true } });

  const unmutedOut = new Float32Array(700 * blockFrames);
  for (let b = 0; b < 700; b++) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    processor.process([], [outBlock]);
    unmutedOut.set(outBlock[0], b * blockFrames);
  }

  const beatSamples = (60 / 124) * sr;
  const offsetSamples = 500 * blockFrames;
  const peaks = findTransientOnsets(unmutedOut, sr, 0.25, 0.3);
  assert.ok(peaks.length >= 3, `Expected >= 3 beats after unmuting, got ${peaks.length}`);

  for (const peak of peaks) {
    const globalSample = offsetSamples + peak;
    const beatFloat = globalSample / beatSamples;
    const errMs = Math.abs(beatFloat - Math.round(beatFloat)) * (60000 / 124);
    assert.ok(
      errMs <= 0.1,
      `Expected resumed unmuted beat peak within <= 0.10 ms of exact master beat, got ${errMs.toFixed(2)} ms`
    );
  }
});

test('Audio Looper Slot supports 0.5x half-time continuous synchronization across loop wraps', () => {
  const sr = 44100;
  const masterBpm = 140;
  const loopBpm = 70;
  const loopPcm = buildClickLoop(loopBpm, 4, sr, 0, 0);
  const { processor } = createWorkletProcessor(sr);

  sendMsg(processor, {
    type: 'loadLooperTrack',
    channels: [loopPcm],
    length: loopPcm.length,
    trackSampleRate: sr,
    durationSec: loopPcm.length / sr,
    bpm: loopBpm,
    anchorMs: 0,
    tempoMultiplier: 0.5,
    keyLock: true,
    keyShiftSemitones: 0,
    active: true,
    gain: 1.0,
  });
  sendMsg(processor, { type: 'setParams', masterBpm });
  sendMsg(processor, { type: 'start', elapsedBeats: 0 });

  const blockFrames = 128;
  const totalSec = 7.5;
  const totalBlocks = Math.ceil((totalSec * sr) / blockFrames);
  const out = new Float32Array(totalBlocks * blockFrames);
  const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];

  for (let b = 0; b < totalBlocks; b++) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    processor.process([], [outBlock]);
    out.set(outBlock[0], b * blockFrames);
  }

  const peaks = findTransientOnsets(out, sr, 0.25, 0.5);
  assert.ok(peaks.length >= 7, `Expected >= 7 half-time beats over 7.5s, got ${peaks.length}`);

  const loopBeatSamples = (60 / loopBpm) * sr;
  for (const peak of peaks) {
    const beatFloat = peak / loopBeatSamples;
    const errMs = Math.abs(beatFloat - Math.round(beatFloat)) * (60000 / loopBpm);
    assert.ok(
      errMs <= 0.1,
      `Expected 0.5x half-time loop beat locked within <= 0.10 ms, got ${errMs.toFixed(2)} ms`
    );
  }
});

test('Separate Deck 1 / Deck 2 play & pause drops incoming deck at 0.00 ms sync without interrupting the active deck', () => {
  const sr = 44100;
  const bpm = 124;
  const song1 = buildClickLoop(bpm, 24, sr, 0, 0);
  const song2 = buildClickLoop(bpm, 24, sr, 15.0, 0);
  const { processor, telemetryLog } = createWorkletProcessor(sr);

  sendMsg(processor, {
    type: 'loadTrack',
    deck: 1,
    channels: [song1],
    length: song1.length,
    trackSampleRate: sr,
    durationSec: song1.length / sr,
    bpm,
    anchorMs: 0,
    keyLock: false,
    keyShiftSemitones: 0,
  });
  sendMsg(processor, {
    type: 'loadTrack',
    deck: 2,
    channels: [song2],
    length: song2.length,
    trackSampleRate: sr,
    durationSec: song2.length / sr,
    bpm,
    anchorMs: 15.0,
    keyLock: false,
    keyShiftSemitones: 0,
  });
  sendMsg(processor, {
    type: 'setParams',
    masterBpm: bpm,
    syncMode: 'beat',
    desiredOffsetMs: 0,
    crossfader: 1, // Monitor Deck 2 solo initially to verify silence while Deck 1 plays solo
  });

  // Start ONLY Deck 1
  sendMsg(processor, {
    type: 'setDeckPlaying',
    deck: 1,
    playing: true,
    elapsedBeats: 0,
  });

  const blockFrames = 128;
  const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];
  let maxDeck2WhilePaused = 0;
  for (let b = 0; b < 500; b++) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    processor.process([], [outBlock]);
    for (let i = 0; i < blockFrames; i++) {
      maxDeck2WhilePaused = Math.max(maxDeck2WhilePaused, Math.abs(outBlock[0][i]));
    }
  }
  assert.equal(maxDeck2WhilePaused, 0, 'Deck 2 must remain digitally silent while only Deck 1 plays');
  assert.equal(telemetryLog[telemetryLog.length - 1]?.deck1Playing, true);
  assert.equal(telemetryLog[telemetryLog.length - 1]?.deck2Playing, false);

  // Drop Deck 2 IN mid-song -> must align at 0.00 ms with Deck 1
  sendMsg(processor, { type: 'setDeckPlaying', deck: 2, playing: true });
  const afterDropTel = telemetryLog[telemetryLog.length - 1];
  assert.equal(afterDropTel?.deck1Playing, true);
  assert.equal(afterDropTel?.deck2Playing, true);
  assert.equal(afterDropTel?.livePhaseErrorMs, 0);

  // Render 2 seconds with crossfader = 0 (both decks blended) and verify Deck 2 beats land on exact master beats
  sendMsg(processor, { type: 'setParams', crossfader: 0 });
  const offsetFrames = 500 * blockFrames;
  const blended = new Float32Array(700 * blockFrames);
  for (let b = 0; b < 700; b++) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    processor.process([], [outBlock]);
    blended.set(outBlock[0], b * blockFrames);
  }
  const blendedPeaks = findTransientOnsets(blended, sr, 0.35, 0.3);
  assert.ok(blendedPeaks.length >= 3, `Expected >= 3 blended beats, got ${blendedPeaks.length}`);
  const beatSamples = (60 / bpm) * sr;
  for (const peak of blendedPeaks) {
    const beatFloat = (offsetFrames + peak) / beatSamples;
    const errMs = Math.abs(beatFloat - Math.round(beatFloat)) * (60000 / bpm);
    assert.ok(errMs <= 0.1, `Expected mid-mix Deck 2 drop-in aligned <= 0.10 ms, got ${errMs.toFixed(2)} ms`);
  }

  // Pause Deck 1 while Deck 2 stays playing; crossfade to Deck 1 (-1) must be digitally silent
  sendMsg(processor, { type: 'setDeckPlaying', deck: 1, playing: false });
  sendMsg(processor, { type: 'setParams', crossfader: -1 });
  let maxDeck1AfterPause = 0;
  for (let b = 0; b < 100; b++) {
    outBlock[0].fill(0);
    outBlock[1].fill(0);
    processor.process([], [outBlock]);
    for (let i = 0; i < blockFrames; i++) {
      maxDeck1AfterPause = Math.max(maxDeck1AfterPause, Math.abs(outBlock[0][i]));
    }
  }
  assert.equal(maxDeck1AfterPause, 0, 'Deck 1 must be silent after Pause D1 while Deck 2 runs');
  assert.equal(telemetryLog[telemetryLog.length - 1]?.deck1Playing, false);
  assert.equal(telemetryLog[telemetryLog.length - 1]?.deck2Playing, true);
});

test('Looper Acoustic Blend EQ clears sub-bass clash when layered with a song, bypasses solo, and soft-knee limiter prevents clipping', () => {
  const sr = 44100;
  const bpm = 124;
  const beatSec = 60 / bpm;
  const loopLen = Math.round(4 * beatSec * sr);
  const loopSubAndHat = new Float32Array(loopLen);
  for (let i = 0; i < loopLen; i++) {
    const t = i / sr;
    // Heavy 60 Hz sub-bass + crisp 2.2 kHz hi-hat harmonic
    loopSubAndHat[i] = 0.72 * Math.sin(2 * Math.PI * 60 * t) + 0.25 * Math.sin(2 * Math.PI * 2200 * t);
  }

  // Silent-ish 1kHz low-level carrier on Deck 1 (only to mark songDeckAudible without masking 60Hz measurement)
  const songQuiet = new Float32Array(loopLen);
  for (let i = 0; i < loopLen; i++) {
    songQuiet[i] = 0.001 * Math.sin((2 * Math.PI * 1000 * i) / sr);
  }

  const measure60HzRms = (blendMode: string, deck1Playing: boolean) => {
    const { processor } = createWorkletProcessor(sr);
    sendMsg(processor, {
      type: 'loadTrack',
      deck: 1,
      channels: [songQuiet],
      length: songQuiet.length,
      trackSampleRate: sr,
      durationSec: songQuiet.length / sr,
      bpm,
      anchorMs: 0,
      keyLock: false,
      keyShiftSemitones: 0,
    });
    sendMsg(processor, {
      type: 'loadLooperTrack',
      channels: [loopSubAndHat],
      length: loopSubAndHat.length,
      trackSampleRate: sr,
      durationSec: loopSubAndHat.length / sr,
      bpm,
      anchorMs: 0,
      keyLock: false,
      keyShiftSemitones: 0,
      active: true,
      gain: 0.9,
      blendMode,
    });
    sendMsg(processor, { type: 'setParams', masterBpm: bpm, crossfader: -1 });
    sendMsg(processor, {
      type: 'start',
      elapsedBeats: 0,
      deck1Playing,
      deck2Playing: false,
      looperPlaying: true,
    });

    const blockFrames = 128;
    const totalBlocks = 140;
    const out = new Float32Array(totalBlocks * blockFrames);
    const outBlock = [new Float32Array(blockFrames), new Float32Array(blockFrames)];
    for (let b = 0; b < totalBlocks; b++) {
      outBlock[0].fill(0);
      outBlock[1].fill(0);
      processor.process([], [outBlock]);
      out.set(outBlock[0], b * blockFrames);
    }

    // Measure 60 Hz & 2200 Hz DFT bin magnitudes over steady-state window [4096..12288)
    let re60 = 0;
    let im60 = 0;
    let re2200 = 0;
    let im2200 = 0;
    const nWin = 8192;
    for (let n = 0; n < nWin; n++) {
      const s = out[4096 + n];
      const a60 = (2 * Math.PI * 60 * n) / sr;
      re60 += s * Math.cos(a60);
      im60 -= s * Math.sin(a60);
      const a2200 = (2 * Math.PI * 2200 * n) / sr;
      re2200 += s * Math.cos(a2200);
      im2200 -= s * Math.sin(a2200);
    }
    return {
      mag60: Math.hypot(re60, im60) / nWin,
      mag2200: Math.hypot(re2200, im2200) / nWin,
    };
  };

  const fullStats = measure60HzRms('full', true);
  const autoBlendStats = measure60HzRms('auto', true);
  const autoSoloStats = measure60HzRms('auto', false);
  const topStats = measure60HzRms('top-260', true);

  const autoSubDropDb = 20 * Math.log10(fullStats.mag60 / Math.max(1e-9, autoBlendStats.mag60));
  const topSubDropDb = 20 * Math.log10(fullStats.mag60 / Math.max(1e-9, topStats.mag60));
  assert.ok(
    autoSubDropDb >= 10,
    `Expected Auto Blend EQ to attenuate 60 Hz sub-bass by >= 10 dB when layered with song, got ${autoSubDropDb.toFixed(1)} dB`
  );
  assert.ok(
    topSubDropDb >= 20,
    `Expected Tops 260Hz EQ to attenuate 60 Hz sub-bass by >= 20 dB, got ${topSubDropDb.toFixed(1)} dB`
  );
  assert.ok(
    autoSoloStats.mag60 > fullStats.mag60 * 0.9,
    'Expected Auto Blend EQ to preserve full 60 Hz sub-bass when Looper plays solo'
  );
  assert.ok(
    autoBlendStats.mag2200 > fullStats.mag2200 * 0.9,
    'Expected Auto Blend EQ to preserve >= 90% upper-mid/high shimmer'
  );

  // Anti-clipping soft-knee master limiter check with hot Deck 1 + Deck 2 + Looper sum
  const { processor: hotProc } = createWorkletProcessor(sr);
  const hotWave = new Float32Array(sr * 2);
  hotWave.fill(0.95);
  sendMsg(hotProc, {
    type: 'loadTrack',
    deck: 1,
    channels: [hotWave],
    length: hotWave.length,
    trackSampleRate: sr,
    durationSec: 2,
    bpm: 124,
    anchorMs: 0,
    keyLock: false,
  });
  sendMsg(hotProc, {
    type: 'loadTrack',
    deck: 2,
    channels: [hotWave],
    length: hotWave.length,
    trackSampleRate: sr,
    durationSec: 2,
    bpm: 124,
    anchorMs: 0,
    keyLock: false,
  });
  sendMsg(hotProc, {
    type: 'loadLooperTrack',
    channels: [hotWave],
    length: hotWave.length,
    trackSampleRate: sr,
    durationSec: 2,
    bpm: 124,
    anchorMs: 0,
    keyLock: false,
    active: true,
    gain: 1.2,
    blendMode: 'full',
  });
  sendMsg(hotProc, { type: 'setParams', masterBpm: 124, crossfader: 0 });
  sendMsg(hotProc, { type: 'start', elapsedBeats: 0 });
  const hotOut = [new Float32Array(128), new Float32Array(128)];
  let maxPeak = 0;
  for (let b = 0; b < 50; b++) {
    hotOut[0].fill(0);
    hotOut[1].fill(0);
    hotProc.process([], [hotOut]);
    for (let i = 0; i < 128; i++) {
      maxPeak = Math.max(maxPeak, Math.abs(hotOut[0][i]));
    }
  }
  assert.ok(maxPeak <= 1.0, `Expected soft-knee limiter output <= 1.0, got ${maxPeak}`);
});

