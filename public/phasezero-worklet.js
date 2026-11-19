/**
 * PhaseZeroWorkletProcessor
 *
 * Single-transport-owner Web Audio render engine modeled after djay / VirtualDJ
 * timing & Master Tempo (Key Lock) DSP architecture:
 *  - One authoritative audio-render clock (`masterBeatPos`) advances inside process().
 *  - Supports per-deck rhythmic bar start alignment (`startBeatOffset`) and tempo-family
 *    multipliers (`0.5 | 1 | 2`) so any uploaded track matches the opposite deck Beat 1 -> Beat 1.
 *  - Zero-latency centered 2048-pt Phase-Locked STFT Phase Vocoder (Laroche-Dolson peak
 *    phase locking + spectral-flux transient phase reset + linked-stereo phase coherence +
 *    frequency-domain anti-aliasing + 4-point Cubic Hermite resampling) provides crystal-clear
 *    Key Lock (Master Tempo) and ±12 semitone Key Adjuster with 0.000 ms latency offset.
 *  - Click-free 4 ms cosine crossfade on explicit snaps (>15 ms) or manual platter nudges.
 */

const PV_N = 2048;
const PV_HALF_N = 1024;
const PV_NUM_BINS = 1025;
const PV_HS = 256;
const PV_RING_SIZE = 8192;
const PV_RING_MASK = PV_RING_SIZE - 1;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const TRIG_LUT_SIZE = 4096;
const TRIG_LUT_MASK = TRIG_LUT_SIZE - 1;
const TRIG_SCALE = TRIG_LUT_SIZE / TWO_PI;

function fastAtan2(y, x) {
  if (x === 0) {
    if (y > 0) return HALF_PI;
    if (y < 0) return -HALF_PI;
    return 0;
  }
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const mn = ax < ay ? ax : ay;
  const mx = ax > ay ? ax : ay;
  const a = mn / mx;
  const s = a * a;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = HALF_PI - r;
  if (x < 0) r = Math.PI - r;
  return y < 0 ? -r : r;
}

class PhaseZeroWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playing = false;
    this.deck1Playing = false;
    this.deck2Playing = false;
    this.looperPlaying = false;
    this.masterBpm = 124.0;
    this.deck2TargetBpm = 124.0;
    this.syncMode = 'beat'; // 'off' | 'tempo' | 'beat'
    this.gridMode = 'straight'; // 'straight' | 'dynamic'
    this.autoNudgeEnabled = true;
    this.maxTrimPct = 0.25;
    this.desiredOffsetMs = 0;
    this.crossfader = 0; // -1..+1

    this.masterBeatPos = 0;
    this.deck2BeatPos = 0;
    this.integralErrSec = 0;
    this.currentRateTrimFrac = 0;
    this.hardSnapCount = 0;
    this.snappedRecentlyBlocks = 0;
    this.telemetryAccum = 0;

    // Preallocated stereo sample scratch buffers (zero heap allocation inside process)
    this.stereoBuf1 = [0, 0];
    this.stereoBuf2 = [0, 0];
    this.stereoBufLooper = [0, 0];
    this.stereoBufOld = [0, 0];

    // Precomputed LUTs for N=2048 FFT, root-Hann window, and bin frequencies
    this.fftBitRev = new Uint16Array(PV_N);
    const log2N = 11;
    for (let i = 0; i < PV_N; i++) {
      let rev = 0;
      for (let b = 0; b < log2N; b++) {
        if ((i >> b) & 1) rev |= 1 << (log2N - 1 - b);
      }
      this.fftBitRev[i] = rev;
    }

    this.fftCosFwd = new Float64Array(PV_HALF_N);
    this.fftSinFwd = new Float64Array(PV_HALF_N);
    for (let k = 0; k < PV_HALF_N; k++) {
      const ang = (-TWO_PI * k) / PV_N;
      this.fftCosFwd[k] = Math.cos(ang);
      this.fftSinFwd[k] = Math.sin(ang);
    }

    this.pvWindow = new Float32Array(PV_N);
    for (let n = 0; n < PV_N; n++) {
      this.pvWindow[n] = Math.sin((Math.PI * (n + 0.5)) / PV_N);
    }

    this.binOmega = new Float64Array(PV_NUM_BINS);
    for (let k = 0; k < PV_NUM_BINS; k++) {
      this.binOmega[k] = (TWO_PI * k) / PV_N;
    }

    this.trigCosLut = new Float64Array(TRIG_LUT_SIZE);
    this.trigSinLut = new Float64Array(TRIG_LUT_SIZE);
    for (let i = 0; i < TRIG_LUT_SIZE; i++) {
      const ang = (TWO_PI * i) / TRIG_LUT_SIZE;
      this.trigCosLut[i] = Math.cos(ang);
      this.trigSinLut[i] = Math.sin(ang);
    }

    // Looper DJ Blend HPF biquad state (prevents sub-bass/kick clash when layered with a song)
    this.looperHpCutoffHz = -1;
    this.lpHpB0 = 1;
    this.lpHpB1 = 0;
    this.lpHpB2 = 0;
    this.lpHpA1 = 0;
    this.lpHpA2 = 0;
    this.lpHpX1L = 0;
    this.lpHpX2L = 0;
    this.lpHpY1L = 0;
    this.lpHpY2L = 0;
    this.lpHpX1R = 0;
    this.lpHpX2R = 0;
    this.lpHpY1R = 0;
    this.lpHpY2R = 0;

    // 4 ms cosine crossfade for click-free Deck 2 beat snap / manual nudge
    this.xfadeTotalSamples = Math.max(32, Math.round(sampleRate * 0.004));
    this.xfadeRemaining = 0;
    this.xfadeOldBeatPos = 0;

    this.decks = {
      1: this.createEmptyDeck(0),
      2: this.createEmptyDeck(0),
    };
    this.looper = this.createEmptyLooper(170);

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'loadTrack': {
          const deckNum = msg.deck === 2 ? 2 : 1;
          const prev = this.decks[deckNum];
          const pv = prev ? prev.pv : this.createPvState();
          this.resetPvState(pv);
          this.decks[deckNum] = {
            channels: msg.channels || null,
            length: msg.length || 0,
            sampleRate: msg.trackSampleRate || sampleRate,
            durationSec: msg.durationSec || 0,
            bpm: Math.max(40, msg.bpm || 124),
            anchorSec: Math.max(0, (msg.anchorMs || 0) / 1000),
            beatTimesSec: msg.beatTimesSec ? new Float64Array(msg.beatTimesSec) : null,
            useBeatTimes: Boolean(msg.useBeatTimes),
            startBeatOffset:
              typeof msg.startBeatOffset === 'number' ? Math.max(0, msg.startBeatOffset) : 0,
            tempoMultiplier:
              msg.tempoMultiplier === 0.5 || msg.tempoMultiplier === 2 ? msg.tempoMultiplier : 1,
            keyLock: typeof msg.keyLock === 'boolean' ? msg.keyLock : prev ? prev.keyLock : true,
            keyShiftSemitones:
              typeof msg.keyShiftSemitones === 'number'
                ? Math.max(-12, Math.min(12, msg.keyShiftSemitones))
                : 0,
            pv,
          };
          break;
        }
        case 'clearDeck': {
          const deckNum = msg.deck === 2 ? 2 : 1;
          this.decks[deckNum] = this.createEmptyDeck(0);
          break;
        }
        case 'loadLooperTrack': {
          const prev = this.looper;
          const pv = prev ? prev.pv : this.createPvState();
          this.resetPvState(pv);
          this.looper = {
            channels: msg.channels || null,
            length: msg.length || 0,
            sampleRate: msg.trackSampleRate || sampleRate,
            durationSec: msg.durationSec || 0,
            bpm: Math.max(40, msg.bpm || 124),
            anchorSec: Math.max(0, (msg.anchorMs || 0) / 1000),
            beatTimesSec: msg.beatTimesSec ? new Float64Array(msg.beatTimesSec) : null,
            useBeatTimes: Boolean(msg.useBeatTimes),
            startBeatOffset:
              typeof msg.startBeatOffset === 'number' ? Math.max(0, msg.startBeatOffset) : 0,
            tempoMultiplier:
              msg.tempoMultiplier === 0.5 || msg.tempoMultiplier === 2 ? msg.tempoMultiplier : 1,
            keyLock: typeof msg.keyLock === 'boolean' ? msg.keyLock : prev ? prev.keyLock : true,
            keyShiftSemitones:
              typeof msg.keyShiftSemitones === 'number'
                ? Math.max(-12, Math.min(12, msg.keyShiftSemitones))
                : 0,
            active: typeof msg.active === 'boolean' ? msg.active : prev ? prev.active : true,
            gain:
              typeof msg.gain === 'number'
                ? Math.max(0, Math.min(1.5, msg.gain))
                : prev
                  ? prev.gain
                  : 0.85,
            loopBeatsOverride:
              typeof msg.loopBeatsOverride === 'number' ? Math.max(0, msg.loopBeatsOverride) : 0,
            blendMode:
              typeof msg.blendMode === 'string'
                ? msg.blendMode
                : prev
                  ? prev.blendMode
                  : 'auto',
            pv,
          };
          this.resetLooperFilterState();
          break;
        }
        case 'clearLooper': {
          this.looper = this.createEmptyLooper(170);
          this.resetLooperFilterState();
          break;
        }
        case 'setParams': {
          if (typeof msg.masterBpm === 'number') this.masterBpm = Math.max(40, msg.masterBpm);
          if (typeof msg.deck2TargetBpm === 'number') {
            this.deck2TargetBpm = Math.max(40, msg.deck2TargetBpm);
          }
          if (typeof msg.syncMode === 'string') this.syncMode = msg.syncMode;
          if (typeof msg.gridMode === 'string') this.gridMode = msg.gridMode;
          if (typeof msg.autoNudgeEnabled === 'boolean') {
            this.autoNudgeEnabled = msg.autoNudgeEnabled;
          }
          if (typeof msg.maxTrimPct === 'number') {
            this.maxTrimPct = Math.max(0.05, Math.min(1.0, msg.maxTrimPct));
          }
          if (typeof msg.desiredOffsetMs === 'number') {
            this.desiredOffsetMs = msg.desiredOffsetMs;
          }
          if (typeof msg.crossfader === 'number') {
            this.crossfader = Math.max(-1, Math.min(1, msg.crossfader));
          }
          for (const d of [1, 2]) {
            const patch = msg[`deck${d}Grid`];
            const deck = this.decks[d];
            if (patch && deck) {
              let needsPvReset = false;
              if (typeof patch.bpm === 'number') deck.bpm = Math.max(40, patch.bpm);
              if (typeof patch.anchorMs === 'number') {
                const nextAnchor = Math.max(0, patch.anchorMs / 1000);
                if (Math.abs(nextAnchor - deck.anchorSec) > 0.0005) needsPvReset = true;
                deck.anchorSec = nextAnchor;
              }
              if (typeof patch.useBeatTimes === 'boolean') {
                deck.useBeatTimes = patch.useBeatTimes;
              }
              if (patch.beatTimesSec) {
                deck.beatTimesSec = new Float64Array(patch.beatTimesSec);
              }
              if (typeof patch.startBeatOffset === 'number') {
                const nextOff = Math.max(0, patch.startBeatOffset);
                if (nextOff !== deck.startBeatOffset) needsPvReset = true;
                deck.startBeatOffset = nextOff;
              }
              if (
                patch.tempoMultiplier === 0.5 ||
                patch.tempoMultiplier === 1 ||
                patch.tempoMultiplier === 2
              ) {
                if (patch.tempoMultiplier !== deck.tempoMultiplier) needsPvReset = true;
                deck.tempoMultiplier = patch.tempoMultiplier;
              }
              if (typeof patch.keyLock === 'boolean') {
                if (patch.keyLock !== deck.keyLock) needsPvReset = true;
                deck.keyLock = patch.keyLock;
              }
              if (typeof patch.keyShiftSemitones === 'number') {
                deck.keyShiftSemitones = Math.max(
                  -12,
                  Math.min(12, patch.keyShiftSemitones)
                );
              }
              if (needsPvReset) {
                this.resetPvState(deck.pv);
              }
            }
          }
          if (msg.looperGrid && this.looper) {
            const patch = msg.looperGrid;
            const lp = this.looper;
            let needsPvReset = false;
            if (typeof patch.bpm === 'number') lp.bpm = Math.max(40, patch.bpm);
            if (typeof patch.anchorMs === 'number') {
              const nextAnchor = Math.max(0, patch.anchorMs / 1000);
              if (Math.abs(nextAnchor - lp.anchorSec) > 0.0005) needsPvReset = true;
              lp.anchorSec = nextAnchor;
            }
            if (typeof patch.useBeatTimes === 'boolean') {
              lp.useBeatTimes = patch.useBeatTimes;
            }
            if (patch.beatTimesSec) {
              lp.beatTimesSec = new Float64Array(patch.beatTimesSec);
            }
            if (typeof patch.startBeatOffset === 'number') {
              const nextOff = Math.max(0, patch.startBeatOffset);
              if (nextOff !== lp.startBeatOffset) needsPvReset = true;
              lp.startBeatOffset = nextOff;
            }
            if (
              patch.tempoMultiplier === 0.5 ||
              patch.tempoMultiplier === 1 ||
              patch.tempoMultiplier === 2
            ) {
              if (patch.tempoMultiplier !== lp.tempoMultiplier) needsPvReset = true;
              lp.tempoMultiplier = patch.tempoMultiplier;
            }
            if (typeof patch.keyLock === 'boolean') {
              if (patch.keyLock !== lp.keyLock) needsPvReset = true;
              lp.keyLock = patch.keyLock;
            }
            if (typeof patch.keyShiftSemitones === 'number') {
              lp.keyShiftSemitones = Math.max(-12, Math.min(12, patch.keyShiftSemitones));
            }
            if (typeof patch.active === 'boolean') {
              if (patch.active && !lp.active) needsPvReset = true;
              lp.active = patch.active;
            }
            if (typeof patch.gain === 'number') {
              lp.gain = Math.max(0, Math.min(1.5, patch.gain));
            }
            if (typeof patch.loopBeatsOverride === 'number') {
              const nextOv = Math.max(0, patch.loopBeatsOverride);
              if (nextOv !== lp.loopBeatsOverride) needsPvReset = true;
              lp.loopBeatsOverride = nextOv;
            }
            if (typeof patch.blendMode === 'string') {
              lp.blendMode = patch.blendMode;
            }
            if (needsPvReset) {
              this.resetPvState(lp.pv);
            }
          }
          break;
        }
        case 'start': {
          const beat0 = typeof msg.elapsedBeats === 'number' ? msg.elapsedBeats : 0;
          const initOffsetMs = typeof msg.initialPhaseErrorMs === 'number' ? msg.initialPhaseErrorMs : 0;
          const d1Play = typeof msg.deck1Playing === 'boolean' ? msg.deck1Playing : true;
          const d2Play = typeof msg.deck2Playing === 'boolean' ? msg.deck2Playing : true;
          const lpPlay = typeof msg.looperPlaying === 'boolean' ? msg.looperPlaying : d1Play || d2Play;
          this.masterBeatPos = beat0;
          this.deck2BeatPos = beat0 - (initOffsetMs / 1000) * (this.masterBpm / 60);
          this.integralErrSec = 0;
          this.currentRateTrimFrac = 0;
          this.xfadeRemaining = 0;
          this.resetPvState(this.decks[1].pv);
          this.resetPvState(this.decks[2].pv);
          this.resetPvState(this.looper.pv);
          this.resetLooperFilterState();
          if (msg.resetCounters) {
            this.hardSnapCount = 0;
            this.snappedRecentlyBlocks = 0;
          }
          this.deck1Playing = d1Play;
          this.deck2Playing = d2Play;
          this.looperPlaying = lpPlay;
          this.playing = this.deck1Playing || this.deck2Playing || this.looperPlaying;
          this.emitTelemetry();
          break;
        }
        case 'setDeckPlaying': {
          const deckNum = msg.deck === 2 ? 2 : 1;
          const wantPlay = Boolean(msg.playing);
          const wasPlaying = this.playing;
          const hasD1 = Boolean(this.decks[1] && this.decks[1].channels && this.decks[1].length > 1);
          const hasD2 = Boolean(this.decks[2] && this.decks[2].channels && this.decks[2].length > 1);

          if (!wantPlay) {
            if (deckNum === 1) {
              this.deck1Playing = false;
              this.resetPvState(this.decks[1].pv);
            } else {
              this.deck2Playing = false;
              this.resetPvState(this.decks[2].pv);
            }
            this.integralErrSec = 0;
            this.currentRateTrimFrac = 0;
            this.xfadeRemaining = 0;
            if (!this.deck1Playing && !this.deck2Playing) {
              this.looperPlaying = false;
              this.playing = false;
              this.resetPvState(this.looper.pv);
              this.resetLooperFilterState();
            } else {
              this.playing = true;
            }
            this.emitTelemetry();
            break;
          }

          // Turning a single deck ON
          const beatFallback = typeof msg.elapsedBeats === 'number' ? msg.elapsedBeats : this.masterBeatPos;
          const desiredBeats = (this.desiredOffsetMs / 1000) * (this.masterBpm / 60);

          if (!wasPlaying) {
            this.masterBeatPos = beatFallback;
            this.deck2BeatPos = beatFallback - desiredBeats;
            this.integralErrSec = 0;
            this.currentRateTrimFrac = 0;
            this.xfadeRemaining = 0;
            this.resetPvState(this.looper.pv);
            this.resetLooperFilterState();
          }

          if (deckNum === 1) {
            // If Deck 2 is already playing & Beat Sync is on, align Deck 1 seamlessly onto Deck 2's bar/beat grid
            if (wasPlaying && this.deck2Playing && hasD2 && this.syncMode === 'beat') {
              this.masterBeatPos = this.deck2BeatPos + desiredBeats;
              this.resetPvState(this.looper.pv);
            }
            this.resetPvState(this.decks[1].pv);
            this.deck1Playing = true;
          } else {
            // If Deck 1 (or Looper) is already playing & Beat Sync is on, drop Deck 2 in locked at 0.00 ms
            if (wasPlaying && (this.deck1Playing || this.looperPlaying) && (hasD1 || this.looperPlaying) && this.syncMode === 'beat') {
              this.deck2BeatPos = this.masterBeatPos - desiredBeats;
            }
            this.resetPvState(this.decks[2].pv);
            this.integralErrSec = 0;
            this.currentRateTrimFrac = 0;
            this.deck2Playing = true;
          }
          this.looperPlaying = true;
          this.playing = true;
          this.emitTelemetry();
          break;
        }
        case 'stop': {
          this.playing = false;
          this.deck1Playing = false;
          this.deck2Playing = false;
          this.looperPlaying = false;
          this.integralErrSec = 0;
          this.currentRateTrimFrac = 0;
          this.xfadeRemaining = 0;
          this.resetPvState(this.decks[1].pv);
          this.resetPvState(this.decks[2].pv);
          this.resetPvState(this.looper.pv);
          this.resetLooperFilterState();
          this.emitTelemetry();
          break;
        }
        case 'seek': {
          const beat0 = typeof msg.elapsedBeats === 'number' ? msg.elapsedBeats : 0;
          const offsetMs = typeof msg.phaseErrorMs === 'number' ? msg.phaseErrorMs : 0;
          this.xfadeOldBeatPos = this.deck2BeatPos;
          this.xfadeRemaining = this.playing ? this.xfadeTotalSamples : 0;
          this.masterBeatPos = beat0;
          this.deck2BeatPos = beat0 - (offsetMs / 1000) * (this.masterBpm / 60);
          this.integralErrSec = 0;
          this.currentRateTrimFrac = 0;
          this.resetPvState(this.decks[1].pv);
          this.resetPvState(this.decks[2].pv);
          this.resetPvState(this.looper.pv);
          this.emitTelemetry();
          break;
        }
        case 'nudgeMs': {
          const deltaMs = typeof msg.deltaMs === 'number' ? msg.deltaMs : 0;
          const deltaBeats = (deltaMs / 1000) * (this.masterBpm / 60);
          if (Math.abs(deltaMs) >= 0.3 && this.playing) {
            this.xfadeOldBeatPos = this.deck2BeatPos;
            this.xfadeRemaining = this.xfadeTotalSamples;
            this.resetPvState(this.decks[2].pv);
          }
          this.deck2BeatPos += deltaBeats;
          this.emitTelemetry();
          break;
        }
        case 'snapZero': {
          const desiredBeats = (this.desiredOffsetMs / 1000) * (this.masterBpm / 60);
          const targetBeat2 = this.masterBeatPos - desiredBeats;
          if (this.playing) {
            this.xfadeOldBeatPos = this.deck2BeatPos;
            this.xfadeRemaining = this.xfadeTotalSamples;
          }
          this.deck2BeatPos = targetBeat2;
          this.integralErrSec = 0;
          this.currentRateTrimFrac = 0;
          this.resetPvState(this.decks[2].pv);
          this.emitTelemetry();
          break;
        }
      }
    };
  }

  createPvState(initPhaseOffset = 0) {
    return {
      initialized: false,
      initPhaseOffset,
      uRead: initPhaseOffset,
      nextFrameIdx: -4,
      prevBeatCenter: 0,
      hasPrev: false,
      avgFlux: 0,
      framesSinceTransient: 8,
      ringL: new Float32Array(PV_RING_SIZE),
      ringR: new Float32Array(PV_RING_SIZE),
      anaL: new Float32Array(PV_N),
      anaR: new Float32Array(PV_N),
      fftRe: new Float64Array(PV_N),
      fftIm: new Float64Array(PV_N),
      reL: new Float64Array(PV_NUM_BINS),
      imL: new Float64Array(PV_NUM_BINS),
      reR: new Float64Array(PV_NUM_BINS),
      imR: new Float64Array(PV_NUM_BINS),
      mag: new Float64Array(PV_NUM_BINS),
      prevMag: new Float64Array(PV_NUM_BINS),
      anaPhase: new Float64Array(PV_NUM_BINS),
      prevAnaPhase: new Float64Array(PV_NUM_BINS),
      synthPhase: new Float64Array(PV_NUM_BINS),
      prevSynthPhase: new Float64Array(PV_NUM_BINS),
      peakBins: new Int16Array(PV_NUM_BINS),
      peakCount: 0,
      outReL: new Float64Array(PV_NUM_BINS),
      outImL: new Float64Array(PV_NUM_BINS),
      outReR: new Float64Array(PV_NUM_BINS),
      outImR: new Float64Array(PV_NUM_BINS),
    };
  }

  resetPvState(pv) {
    if (!pv) return;
    pv.initialized = false;
    pv.uRead = pv.initPhaseOffset || 0;
    pv.nextFrameIdx = -4;
    pv.prevBeatCenter = 0;
    pv.hasPrev = false;
    pv.avgFlux = 0;
    pv.framesSinceTransient = 8;
  }

  createEmptyDeck(initPhaseOffset = 0) {
    return {
      channels: null,
      length: 0,
      sampleRate: sampleRate,
      durationSec: 0,
      bpm: 124.0,
      anchorSec: 0,
      beatTimesSec: null,
      useBeatTimes: false,
      startBeatOffset: 0,
      tempoMultiplier: 1,
      keyLock: true,
      keyShiftSemitones: 0,
      loopBeatsOverride: 0,
      pv: this.createPvState(initPhaseOffset),
    };
  }

  createEmptyLooper(initPhaseOffset = 170) {
    const deck = this.createEmptyDeck(initPhaseOffset);
    deck.active = true;
    deck.gain = 0.85;
    deck.blendMode = 'auto';
    return deck;
  }

  resetLooperFilterState() {
    this.lpHpX1L = 0;
    this.lpHpX2L = 0;
    this.lpHpY1L = 0;
    this.lpHpY2L = 0;
    this.lpHpX1R = 0;
    this.lpHpX2R = 0;
    this.lpHpY1R = 0;
    this.lpHpY2R = 0;
  }

  updateLooperHpfCoeffs(cutoffHz) {
    if (this.looperHpCutoffHz === cutoffHz) return;
    this.looperHpCutoffHz = cutoffHz;
    if (cutoffHz <= 0 || sampleRate <= cutoffHz * 2.2) {
      this.lpHpB0 = 1;
      this.lpHpB1 = 0;
      this.lpHpB2 = 0;
      this.lpHpA1 = 0;
      this.lpHpA2 = 0;
      return;
    }
    const omega = (TWO_PI * cutoffHz) / sampleRate;
    const cosO = Math.cos(omega);
    const sinO = Math.sin(omega);
    const alpha = sinO / Math.SQRT2;
    const a0 = 1 + alpha;
    const invA0 = 1 / a0;
    this.lpHpB0 = ((1 + cosO) * 0.5) * invA0;
    this.lpHpB1 = -(1 + cosO) * invA0;
    this.lpHpB2 = this.lpHpB0;
    this.lpHpA1 = (-2 * cosO) * invA0;
    this.lpHpA2 = (1 - alpha) * invA0;
    this.resetLooperFilterState();
  }

  wrapHalfBeat(deltaBeats) {
    let w = ((deltaBeats + 0.5) % 1 + 1) % 1 - 0.5;
    if (Math.abs(w) < 1e-9) w = 0;
    return w;
  }

  getLoopBeats(deck) {
    if (typeof deck.loopBeatsOverride === 'number' && deck.loopBeatsOverride >= 0.25) {
      return deck.loopBeatsOverride;
    }
    const beatSec = 60 / Math.max(40, deck.bpm);
    const rawPlayableBeats = Math.max(0.25, (deck.durationSec - deck.anchorSec) / beatSec);
    // Allow up to 0.14 beat (~65 ms) trim tolerance at loop tail so shy-cut loops don't drop a beat
    const ceilBeats = Math.ceil(rawPlayableBeats);
    const alignedBeats =
      ceilBeats - rawPlayableBeats <= 0.14 ? ceilBeats : Math.floor(rawPlayableBeats);
    if (alignedBeats >= 8 && alignedBeats % 4 === 0) {
      return alignedBeats;
    }
    return alignedBeats >= 8
      ? Math.floor(alignedBeats / 4) * 4
      : alignedBeats >= 1
        ? alignedBeats
        : rawPlayableBeats;
  }

  getTrackTimeSecAtShiftedBeat(deck, shiftedBeatPos) {
    if (!deck || !deck.channels || deck.length < 2) return -1;
    const beatSec = 60 / Math.max(40, deck.bpm);
    const loopBeats = this.getLoopBeats(deck);
    const wrappedBeat = ((shiftedBeatPos % loopBeats) + loopBeats) % loopBeats;

    if (deck.useBeatTimes && deck.beatTimesSec && deck.beatTimesSec.length >= 2) {
      const arr = deck.beatTimesSec;
      const maxIdx = arr.length - 1;
      if (wrappedBeat <= 0) {
        return arr[0] + wrappedBeat * beatSec;
      }
      if (wrappedBeat >= maxIdx) {
        const localBeat = arr[maxIdx] - arr[maxIdx - 1];
        return arr[maxIdx] + (wrappedBeat - maxIdx) * (localBeat > 0.25 ? localBeat : beatSec);
      }
      const lo = Math.floor(wrappedBeat);
      const frac = wrappedBeat - lo;
      return arr[lo] + frac * (arr[lo + 1] - arr[lo]);
    }

    return deck.anchorSec + wrappedBeat * beatSec;
  }

  getTrackTimeSec(deck, beatPos) {
    if (!deck || !deck.channels || deck.length < 2) return -1;
    const shifted = beatPos * (deck.tempoMultiplier || 1) + (deck.startBeatOffset || 0);
    return this.getTrackTimeSecAtShiftedBeat(deck, shifted);
  }

  /**
   * 4-point Catmull-Rom Cubic Hermite sample interpolation for crystal-clear highs.
   */
  sampleDeckChannelCubic(deck, chIdx, timeSec) {
    if (!deck || !deck.channels || deck.length < 2 || timeSec < 0) return 0;
    const ch = deck.channels[Math.min(chIdx, deck.channels.length - 1)];
    const pos = timeSec * deck.sampleRate;
    const len = deck.length;
    if (pos < 0 || pos >= len - 1) return 0;

    const i0 = pos | 0;
    const frac = pos - i0;
    const xm1 = ch[i0 > 0 ? i0 - 1 : 0];
    const x0 = ch[i0];
    const x1 = ch[i0 + 1 < len ? i0 + 1 : len - 1];
    const x2 = ch[i0 + 2 < len ? i0 + 2 : len - 1];

    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * frac + c2) * frac + c1) * frac + x0;
  }

  /**
   * Renders fractional sample with seamless 3 ms pre-roll cosine crossfade at the file loop seam
   * so DJ loops blend cleanly without clicks while keeping Beat 1 at exact 0.000 ms.
   */
  sampleDeckAtShiftedBeat(deck, chIdx, shiftedBeatPos) {
    if (!deck || !deck.channels || deck.length < 2) return 0;
    const beatSec = 60 / Math.max(40, deck.bpm);
    if (shiftedBeatPos < 0 && shiftedBeatPos > -1) {
      const preTimeSec = deck.anchorSec + shiftedBeatPos * beatSec;
      if (preTimeSec >= 0) {
        return this.sampleDeckChannelCubic(deck, chIdx, preTimeSec);
      }
    }
    const loopBeats = this.getLoopBeats(deck);
    const wrappedBeat = ((shiftedBeatPos % loopBeats) + loopBeats) % loopBeats;
    const timeSec = this.getTrackTimeSecAtShiftedBeat(deck, wrappedBeat);
    const baseSample = this.sampleDeckChannelCubic(deck, chIdx, timeSec);

    const secRemaining = (loopBeats - wrappedBeat) * beatSec;
    if (secRemaining < 0.003 && loopBeats >= 1) {
      if (deck.anchorSec >= 0.003) {
        const progress = (0.003 - secRemaining) / 0.003;
        const fadeIn = 0.5 - 0.5 * Math.cos(Math.PI * progress);
        const preSample = this.sampleDeckChannelCubic(deck, chIdx, deck.anchorSec - secRemaining);
        return baseSample * (1 - fadeIn) + preSample * fadeIn;
      }
      if (secRemaining < 0.0015) {
        const taper = secRemaining / 0.0015;
        return baseSample * (0.5 - 0.5 * Math.cos(Math.PI * taper));
      }
    }

    return baseSample;
  }

  /**
   * In-place Radix-2 Cooley-Tukey Complex FFT (N = 2048).
   */
  runFft(re, im, inverse) {
    const bitRev = this.fftBitRev;
    for (let i = 0; i < PV_N; i++) {
      const j = bitRev[i];
      if (i < j) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }

    const cosLut = this.fftCosFwd;
    const sinLut = this.fftSinFwd;
    const sinSign = inverse ? -1 : 1;

    for (let halfLen = 1, stride = PV_HALF_N; halfLen < PV_N; halfLen <<= 1, stride >>= 1) {
      const step = halfLen << 1;
      for (let start = 0; start < PV_N; start += step) {
        for (let k = 0; k < halfLen; k++) {
          const lutIdx = k * stride;
          const wr = cosLut[lutIdx];
          const wi = sinLut[lutIdx] * sinSign;
          const evenIdx = start + k;
          const oddIdx = evenIdx + halfLen;
          const oRe = re[oddIdx];
          const oIm = im[oddIdx];
          const tr = wr * oRe - wi * oIm;
          const ti = wr * oIm + wi * oRe;
          re[oddIdx] = re[evenIdx] - tr;
          im[oddIdx] = im[evenIdx] - ti;
          re[evenIdx] += tr;
          im[evenIdx] += ti;
        }
      }
    }

    if (inverse) {
      const invN = 1 / PV_N;
      for (let i = 0; i < PV_N; i++) {
        re[i] *= invN;
        im[i] *= invN;
      }
    }
  }

  /**
   * Synthesize one centered 2048-pt Phase-Locked STFT frame (Laroche-Dolson peak locking
   * with linked-stereo phase coherence) into the deck's circular output ring buffer at `uCenter`.
   */
  synthesizePvFrame(deck, beatCenter, Ha, targetPitch, uCenter) {
    const pv = deck.pv;
    const w = this.pvWindow;
    const hasStereo = Boolean(deck.channels && deck.channels.length > 1);
    const chL = deck.channels[0];
    const chR = hasStereo ? deck.channels[1] : chL;
    const deckLen = deck.length;
    const beatSec = 60 / Math.max(40, deck.bpm);
    const beatsPerSourceSample = 1 / (beatSec * deck.sampleRate);
    const loopBeats = this.getLoopBeats(deck);
    const wrappedBeatCenter = ((beatCenter % loopBeats) + loopBeats) % loopBeats;
    const windowSpanBeats = PV_HALF_N * beatsPerSourceSample;

    const anaL = pv.anaL;
    const anaR = pv.anaR;

    // 1. Sample source window symmetrically around beatCenter: [-N/2 .. +N/2 - 1]
    // Fast direct sequential read whenever window sits strictly inside interior (both Straight & Dynamic grids)
    const interior =
      wrappedBeatCenter > windowSpanBeats + 0.01 &&
      wrappedBeatCenter < loopBeats - windowSpanBeats - 0.01;
    let usedFastRead = false;

    if (interior && !deck.useBeatTimes) {
      const centerSample = (deck.anchorSec + wrappedBeatCenter * beatSec) * deck.sampleRate;
      const startSample = centerSample - PV_HALF_N;
      if (startSample >= 1 && startSample + PV_N < deckLen - 2) {
        const baseIdx = Math.floor(startSample);
        const frac = startSample - baseIdx;
        const oneMinusFrac = 1 - frac;
        for (let n = 0; n < PV_N; n++) {
          const idx = baseIdx + n;
          const win = w[n];
          const sL = (chL[idx] * oneMinusFrac + chL[idx + 1] * frac) * win;
          anaL[n] = sL;
          anaR[n] = hasStereo ? (chR[idx] * oneMinusFrac + chR[idx + 1] * frac) * win : sL;
        }
        usedFastRead = true;
      }
    } else if (interior && deck.useBeatTimes) {
      const tWinStart = this.getTrackTimeSecAtShiftedBeat(deck, wrappedBeatCenter - windowSpanBeats);
      const tWinEnd = this.getTrackTimeSecAtShiftedBeat(deck, wrappedBeatCenter + windowSpanBeats);
      const sStart = tWinStart * deck.sampleRate;
      const sEnd = tWinEnd * deck.sampleRate;
      if (sStart >= 1 && sEnd > sStart && sEnd < deckLen - 2) {
        const step = (sEnd - sStart) / PV_N;
        let pos = sStart;
        for (let n = 0; n < PV_N; n++) {
          const idx = pos | 0;
          const frac = pos - idx;
          const win = w[n];
          const sL = (chL[idx] + frac * (chL[idx + 1] - chL[idx])) * win;
          anaL[n] = sL;
          anaR[n] = hasStereo
            ? (chR[idx] + frac * (chR[idx + 1] - chR[idx])) * win
            : sL;
          pos += step;
        }
        usedFastRead = true;
      }
    }

    if (!usedFastRead) {
      for (let n = 0; n < PV_N; n++) {
        const b = beatCenter + (n - PV_HALF_N) * beatsPerSourceSample;
        const win = w[n];
        const sL = this.sampleDeckAtShiftedBeat(deck, 0, b) * win;
        anaL[n] = sL;
        anaR[n] = hasStereo ? this.sampleDeckAtShiftedBeat(deck, 1, b) * win : sL;
      }
    }

    // 2. Pack L + j*R with zero-phase fftshift so window center aligns to n=0
    const fftRe = pv.fftRe;
    const fftIm = pv.fftIm;
    for (let n = 0; n < PV_HALF_N; n++) {
      fftRe[n] = anaL[n + PV_HALF_N];
      fftRe[n + PV_HALF_N] = anaL[n];
      fftIm[n] = anaR[n + PV_HALF_N];
      fftIm[n + PV_HALF_N] = anaR[n];
    }

    this.runFft(fftRe, fftIm, false);

    // 3. Unpack L & R Hermitian spectra + compute linked mono magnitude/phase
    const reL = pv.reL;
    const imL = pv.imL;
    const reR = pv.reR;
    const imR = pv.imR;
    const mag = pv.mag;
    const anaPhase = pv.anaPhase;

    reL[0] = fftRe[0];
    imL[0] = 0;
    reR[0] = fftIm[0];
    imR[0] = 0;
    mag[0] = Math.sqrt(fftRe[0] * fftRe[0] + fftIm[0] * fftIm[0]);
    anaPhase[0] = 0;

    reL[PV_HALF_N] = fftRe[PV_HALF_N];
    imL[PV_HALF_N] = 0;
    reR[PV_HALF_N] = fftIm[PV_HALF_N];
    imR[PV_HALF_N] = 0;
    mag[PV_HALF_N] = Math.sqrt(fftRe[PV_HALF_N] * fftRe[PV_HALF_N] + fftIm[PV_HALF_N] * fftIm[PV_HALF_N]);
    anaPhase[PV_HALF_N] = 0;

    for (let k = 1; k < PV_HALF_N; k++) {
      const conjIdx = PV_N - k;
      const aRe = fftRe[k];
      const aIm = fftIm[k];
      const bRe = fftRe[conjIdx];
      const bIm = fftIm[conjIdx];

      const lRe = 0.5 * (aRe + bRe);
      const lIm = 0.5 * (aIm - bIm);
      const rRe = 0.5 * (aIm + bIm);
      const rIm = 0.5 * (bRe - aRe);

      reL[k] = lRe;
      imL[k] = lIm;
      reR[k] = rRe;
      imR[k] = rIm;

      const pL = lRe * lRe + lIm * lIm;
      const pR = rRe * rRe + rIm * rIm;
      const pTot = pL + pR;
      mag[k] = Math.sqrt(pTot);

      if (pTot < 1e-16) {
        anaPhase[k] = 0;
      } else {
        // Coherent stereo reference phase (avoid anti-phase cancellation)
        const sRe = lRe + rRe;
        const sIm = lIm + rIm;
        if (sRe * sRe + sIm * sIm >= 0.25 * pTot) {
          anaPhase[k] = fastAtan2(sIm, sRe);
        } else if (pL >= pR) {
          anaPhase[k] = fastAtan2(lIm, lRe);
        } else {
          anaPhase[k] = fastAtan2(rIm, rRe);
        }
      }
    }

    const prevAnaPhase = pv.prevAnaPhase;
    const synthPhase = pv.synthPhase;
    const prevSynthPhase = pv.prevSynthPhase;
    const outReL = pv.outReL;
    const outImL = pv.outImL;
    const outReR = pv.outReR;
    const outImR = pv.outImR;

    outReL[0] = reL[0];
    outImL[0] = 0;
    outReR[0] = reR[0];
    outImR[0] = 0;

    // 4. Laroche-Dolson Peak-Locked Identity Phase Locking (hoisted per-peak cos/sin)
    if (!pv.hasPrev || Ha < 1 || Ha > PV_N * 2) {
      for (let k = 1; k < PV_HALF_N; k++) {
        synthPhase[k] = anaPhase[k];
        outReL[k] = reL[k];
        outImL[k] = imL[k];
        outReR[k] = reR[k];
        outImR[k] = imR[k];
      }
      outReL[PV_HALF_N] = reL[PV_HALF_N];
      outImL[PV_HALF_N] = 0;
      outReR[PV_HALF_N] = reR[PV_HALF_N];
      outImR[PV_HALF_N] = 0;
    } else {
      const peakBins = pv.peakBins;
      let peakCount = 0;
      for (let k = 1; k < PV_HALF_N; k++) {
        const mk = mag[k];
        if (mk >= mag[k - 1] && mk >= mag[k + 1]) {
          peakBins[peakCount++] = k;
        }
      }
      if (peakCount === 0) {
        peakBins[0] = 1;
        peakCount = 1;
      }
      pv.peakCount = peakCount;

      const invTwoPi = 1 / TWO_PI;
      let pIdx = 0;
      let curPeak = peakBins[0];
      let nextMid = peakCount > 1 ? (curPeak + peakBins[1]) >> 1 : PV_HALF_N;

      // Helper values computed once per spectral peak (no per-bin cos/sin calls!)
      let peakRot = 0;
      {
        const omega = this.binOmega[curPeak];
        let dPhi = anaPhase[curPeak] - prevAnaPhase[curPeak] - omega * Ha;
        dPhi -= TWO_PI * Math.round(dPhi * invTwoPi);
        const trueOmega = omega + dPhi / Ha;
        let nextSynth = prevSynthPhase[curPeak] + trueOmega * PV_HS;
        nextSynth -= TWO_PI * Math.round(nextSynth * invTwoPi);
        synthPhase[curPeak] = nextSynth;
        peakRot = nextSynth - anaPhase[curPeak];
      }
      let lutIdx = Math.round(peakRot * TRIG_SCALE) & TRIG_LUT_MASK;
      let c = this.trigCosLut[lutIdx];
      let s = this.trigSinLut[lutIdx];

      for (let k = 1; k < PV_HALF_N; k++) {
        if (k > nextMid && pIdx + 1 < peakCount) {
          pIdx++;
          curPeak = peakBins[pIdx];
          nextMid = pIdx + 1 < peakCount ? (curPeak + peakBins[pIdx + 1]) >> 1 : PV_HALF_N;

          const omega = this.binOmega[curPeak];
          let dPhi = anaPhase[curPeak] - prevAnaPhase[curPeak] - omega * Ha;
          dPhi -= TWO_PI * Math.round(dPhi * invTwoPi);
          const trueOmega = omega + dPhi / Ha;
          let nextSynth = prevSynthPhase[curPeak] + trueOmega * PV_HS;
          nextSynth -= TWO_PI * Math.round(nextSynth * invTwoPi);
          synthPhase[curPeak] = nextSynth;
          peakRot = nextSynth - anaPhase[curPeak];
          lutIdx = Math.round(peakRot * TRIG_SCALE) & TRIG_LUT_MASK;
          c = this.trigCosLut[lutIdx];
          s = this.trigSinLut[lutIdx];
        }

        let lockedSynth = anaPhase[k] + peakRot;
        lockedSynth -= TWO_PI * Math.round(lockedSynth * invTwoPi);
        synthPhase[k] = lockedSynth;

        const lr = reL[k];
        const li = imL[k];
        outReL[k] = lr * c - li * s;
        outImL[k] = lr * s + li * c;

        const rr = reR[k];
        const ri = imR[k];
        outReR[k] = rr * c - ri * s;
        outImR[k] = rr * s + ri * c;
      }

      outReL[PV_HALF_N] = reL[PV_HALF_N];
      outImL[PV_HALF_N] = 0;
      outReR[PV_HALF_N] = reR[PV_HALF_N];
      outImR[PV_HALF_N] = 0;
    }

    // 5. Anti-alias spectral rolloff when shifting pitch UP (targetPitch > 1.01)
    if (targetPitch > 1.01) {
      const maxBin = Math.floor((0.47 * PV_N) / targetPitch);
      const rollBins = 32;
      const startRoll = Math.max(8, maxBin - rollBins);
      for (let k = startRoll; k <= PV_HALF_N; k++) {
        let g = 0;
        if (k < maxBin) {
          const t = (k - startRoll) / Math.max(1, maxBin - startRoll);
          g = 0.5 * (1 + Math.cos(Math.PI * t));
        }
        outReL[k] *= g;
        outImL[k] *= g;
        outReR[k] *= g;
        outImR[k] *= g;
      }
    }

    // Save state for next frame
    prevAnaPhase.set(anaPhase);
    prevSynthPhase.set(synthPhase);
    pv.prevBeatCenter = beatCenter;
    pv.hasPrev = true;

    // 6. Pack L + j*R Hermitian spectrum & run Inverse FFT
    fftRe[0] = outReL[0];
    fftIm[0] = outReR[0];
    fftRe[PV_HALF_N] = outReL[PV_HALF_N];
    fftIm[PV_HALF_N] = outReR[PV_HALF_N];
    for (let k = 1; k < PV_HALF_N; k++) {
      const conjIdx = PV_N - k;
      const lR = outReL[k];
      const lI = outImL[k];
      const rR = outReR[k];
      const rI = outImR[k];

      fftRe[k] = lR - rI;
      fftIm[k] = lI + rR;
      fftRe[conjIdx] = lR + rI;
      fftIm[conjIdx] = -lI + rR;
    }

    this.runFft(fftRe, fftIm, true);

    // 7. Undo zero-phase fftshift & COLA overlap-add (0.25 * w[n] gives exact 1.0 sum across 8 hops at HS=256)
    const ringL = pv.ringL;
    const ringR = pv.ringR;
    const baseOut = uCenter - PV_HALF_N;
    for (let n = 0; n < PV_HALF_N; n++) {
      const w0 = 0.25 * w[n];
      const dst0 = (baseOut + n) & PV_RING_MASK;
      ringL[dst0] += fftRe[n + PV_HALF_N] * w0;
      ringR[dst0] += fftIm[n + PV_HALF_N] * w0;

      const w1 = 0.25 * w[n + PV_HALF_N];
      const dst1 = (baseOut + n + PV_HALF_N) & PV_RING_MASK;
      ringL[dst1] += fftRe[n] * w1;
      ringR[dst1] += fftIm[n] * w1;
    }
  }

  /**
   * Renders stereo sample using either bit-transparent 4-point Cubic Hermite bypass
   * or the zero-latency Phase-Locked STFT Phase Vocoder.
   */
  sampleDeckStereoWithKey(
    deck,
    beatPos,
    dBeatPerSample,
    tempoRatio,
    outPair,
    advancePhase
  ) {
    const tempoMult = deck.tempoMultiplier || 1;
    const shiftedBeat = beatPos * tempoMult + (deck.startBeatOffset || 0);
    const dShiftedBeatPerSample = dBeatPerSample * tempoMult;
    const userPitchRatio = Math.pow(2, (deck.keyShiftSemitones || 0) / 12);
    const safeTempoRatio = Math.max(0.25, tempoRatio);
    const grainPitchRatio = deck.keyLock ? userPitchRatio / safeTempoRatio : userPitchRatio;
    const targetPitch = deck.keyLock ? userPitchRatio : safeTempoRatio * userPitchRatio;

    // Bypass PV cleanly for native playback, pure varispeed (Key Free at 0 st),
    // and sub-0.30% micro-nudge trims (< 5 cents) when keyShift is 0.
    const bypassThreshold = (deck.keyShiftSemitones || 0) === 0 ? 0.003 : 0.001;
    if (Math.abs(grainPitchRatio - 1.0) < bypassThreshold || !advancePhase) {
      outPair[0] = this.sampleDeckAtShiftedBeat(deck, 0, shiftedBeat);
      outPair[1] =
        deck.channels && deck.channels.length > 1
          ? this.sampleDeckAtShiftedBeat(deck, 1, shiftedBeat)
          : outPair[0];
      if (advancePhase && deck.pv && deck.pv.initialized) {
        this.resetPvState(deck.pv);
      }
      return;
    }

    const pv = deck.pv;
    if (!pv.initialized) {
      pv.ringL.fill(0);
      pv.ringR.fill(0);
      pv.uRead = pv.initPhaseOffset || 0;
      pv.nextFrameIdx = -4;
      pv.prevBeatCenter = shiftedBeat;
      pv.hasPrev = false;
      pv.avgFlux = 0;
      pv.framesSinceTransient = 8;
      pv.initialized = true;
    }

    const neededU = Math.floor(pv.uRead) + 2 + PV_HALF_N;
    const samplesPerBeat = (deck.sampleRate * 60) / Math.max(40, deck.bpm);
    const beatAdvancePerStretchedSample =
      targetPitch > 1e-4 ? dShiftedBeatPerSample / targetPitch : dShiftedBeatPerSample;

    while (pv.nextFrameIdx * PV_HS <= neededU) {
      const m = pv.nextFrameIdx;
      const uCenter = m * PV_HS;

      // Clear only the newly exposed PV_HS trailing slots before writing frame m
      const clearStart = uCenter + PV_HALF_N - PV_HS;
      for (let i = 0; i < PV_HS; i++) {
        const idx = (clearStart + i) & PV_RING_MASK;
        pv.ringL[idx] = 0;
        pv.ringR[idx] = 0;
      }

      const beatCenter = shiftedBeat + (uCenter - pv.uRead) * beatAdvancePerStretchedSample;
      const Ha = pv.hasPrev
        ? (beatCenter - pv.prevBeatCenter) * samplesPerBeat
        : (PV_HS * safeTempoRatio) / Math.max(0.25, targetPitch);

      this.synthesizePvFrame(deck, beatCenter, Ha, targetPitch, uCenter);
      pv.nextFrameIdx = m + 1;
    }

    // Read stereo output at uRead via 4-point Catmull-Rom Cubic Hermite interpolation
    const i0 = Math.floor(pv.uRead);
    const frac = pv.uRead - i0;
    const idxM1 = (i0 - 1) & PV_RING_MASK;
    const idx0 = i0 & PV_RING_MASK;
    const idx1 = (i0 + 1) & PV_RING_MASK;
    const idx2 = (i0 + 2) & PV_RING_MASK;

    const ringL = pv.ringL;
    const lm1 = ringL[idxM1];
    const l0 = ringL[idx0];
    const l1 = ringL[idx1];
    const l2 = ringL[idx2];
    const lc1 = 0.5 * (l1 - lm1);
    const lc2 = lm1 - 2.5 * l0 + 2 * l1 - 0.5 * l2;
    const lc3 = 0.5 * (l2 - lm1) + 1.5 * (l0 - l1);
    outPair[0] = ((lc3 * frac + lc2) * frac + lc1) * frac + l0;

    const ringR = pv.ringR;
    const rm1 = ringR[idxM1];
    const r0 = ringR[idx0];
    const r1 = ringR[idx1];
    const r2 = ringR[idx2];
    const rc1 = 0.5 * (r1 - rm1);
    const rc2 = rm1 - 2.5 * r0 + 2 * r1 - 0.5 * r2;
    const rc3 = 0.5 * (r2 - rm1) + 1.5 * (r0 - r1);
    outPair[1] = ((rc3 * frac + rc2) * frac + rc1) * frac + r0;

    pv.uRead += targetPitch;
  }

  computeCurrentErrorMetrics() {
    const beatSec = 60 / Math.max(40, this.masterBpm);
    const desiredBeats = (this.desiredOffsetMs / 1000) * (this.masterBpm / 60);
    const targetBeat2 = this.masterBeatPos - desiredBeats;
    const errToTargetBeats = this.wrapHalfBeat(targetBeat2 - this.deck2BeatPos);
    const errToTargetSec = errToTargetBeats * beatSec;

    // Audible error relative to Deck 1's true beat (0.00 ms when synced & desiredOffsetMs === 0)
    const audibleBeats = this.wrapHalfBeat(this.masterBeatPos - this.deck2BeatPos);
    let audibleMs = audibleBeats * beatSec * 1000;
    if (Math.abs(audibleMs) < 0.005) audibleMs = 0;

    return {
      errToTargetSec,
      audibleMs: Number(audibleMs.toFixed(2)),
    };
  }

  emitTelemetry() {
    const { audibleMs } = this.computeCurrentErrorMetrics();
    const d1Time = this.getTrackTimeSec(this.decks[1], this.masterBeatPos);
    const d2Time = this.getTrackTimeSec(this.decks[2], this.deck2BeatPos);
    const lp = this.looper;
    const hasLooper = Boolean(lp && lp.channels && lp.length > 1);
    const looperLoopBeats = hasLooper ? this.getLoopBeats(lp) : 4;
    const looperShiftedBeat = hasLooper
      ? this.masterBeatPos * (lp.tempoMultiplier || 1) + (lp.startBeatOffset || 0)
      : 0;
    const looperBeatPos = hasLooper
      ? ((looperShiftedBeat % looperLoopBeats) + looperLoopBeats) % looperLoopBeats
      : 0;
    const looperTimeSec = hasLooper ? this.getTrackTimeSec(lp, this.masterBeatPos) : 0;

    this.port.postMessage({
      type: 'telemetry',
      masterBeatPos: this.masterBeatPos,
      deck2BeatPos: this.deck2BeatPos,
      deck1TimeSec: d1Time >= 0 ? d1Time : 0,
      deck2TimeSec: d2Time >= 0 ? d2Time : 0,
      livePhaseErrorMs: audibleMs,
      rateTrimPct: Number((this.currentRateTrimFrac * 100).toFixed(3)),
      hardSnapCount: this.hardSnapCount,
      justSnapped: this.snappedRecentlyBlocks > 0,
      looperTimeSec: looperTimeSec >= 0 ? looperTimeSec : 0,
      looperBeatPos,
      looperLoopBeats,
      looperPhaseErrorMs: 0,
      deck1Playing: this.deck1Playing,
      deck2Playing: this.deck2Playing,
      looperPlaying: this.looperPlaying,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const blockFrames = output[0].length;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];

    if (!this.playing) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    const d1 = this.decks[1];
    const d2 = this.decks[2];
    const lp = this.looper;
    const hasD1 = Boolean(d1 && d1.channels && d1.length > 1);
    const hasD2 = Boolean(d2 && d2.channels && d2.length > 1);
    const hasLooper = Boolean(lp && lp.channels && lp.length > 1);
    const d1Active = hasD1 && this.deck1Playing;
    const d2Active = hasD2 && this.deck2Playing;

    const g1 = this.crossfader <= 0 ? 0.85 : Math.max(0, 0.85 * (1 - this.crossfader));
    const g2 = this.crossfader >= 0 ? 0.85 : Math.max(0, 0.85 * (1 + this.crossfader));
    const looperGain = lp && lp.active ? Math.max(0, Math.min(1.5, lp.gain)) : 0;
    const lpActive =
      hasLooper &&
      looperGain > 0.0005 &&
      (this.looperPlaying || this.deck1Playing || this.deck2Playing);

    // DJ Looper Acoustic Blend EQ: automatically clears < 135 Hz sub-bass/kick clash
    // whenever a song deck is playing so the loop glues transparently into the mix.
    const songDeckAudible = (d1Active && g1 > 0.02) || (d2Active && g2 > 0.02);
    const blendMode = (lp && lp.blendMode) || 'auto';
    const targetCutoffHz =
      blendMode === 'full'
        ? 0
        : blendMode === 'top-260'
          ? 260
          : blendMode === 'blend-140'
            ? 140
            : songDeckAudible
              ? 135
              : 0;
    this.updateLooperHpfCoeffs(targetCutoffHz);
    const useLooperHp = this.looperHpCutoffHz > 0;
    const b0 = this.lpHpB0;
    const b1 = this.lpHpB1;
    const b2 = this.lpHpB2;
    const a1 = this.lpHpA1;
    const a2 = this.lpHpA2;

    const dtBlockSec = blockFrames / sampleRate;
    const nudgeActive =
      this.syncMode === 'beat' && this.autoNudgeEnabled && d1Active && d2Active;

    if (this.snappedRecentlyBlocks > 0) {
      this.snappedRecentlyBlocks--;
    }

    let rateTrimFrac = 0;

    if (nudgeActive) {
      const { errToTargetSec } = this.computeCurrentErrorMetrics();
      const absErrMs = Math.abs(errToTargetSec * 1000);

      if (absErrMs > 15) {
        // Explicit click-free 4 ms cosine crossfade beat snap (0.00 ms residual, NO 12 ms lag)
        const desiredBeats = (this.desiredOffsetMs / 1000) * (this.masterBpm / 60);
        const nearestWholeBeatDelta = Math.round(
          this.masterBeatPos - desiredBeats - this.deck2BeatPos
        );
        this.xfadeOldBeatPos = this.deck2BeatPos;
        this.xfadeRemaining = this.xfadeTotalSamples;
        this.deck2BeatPos = this.masterBeatPos - desiredBeats - nearestWholeBeatDelta;
        this.integralErrSec = 0;
        rateTrimFrac = 0;
        this.hardSnapCount += 1;
        this.snappedRecentlyBlocks = 220; // ~650 ms UI badge window
        this.resetPvState(d2.pv);
      } else if (absErrMs < 0.001 && Math.abs(this.integralErrSec) < 1e-6) {
        // Exact phase lock: advance at exact 1:1 master ratio (0.000 ms drift)
        rateTrimFrac = 0;
      } else {
        // Pitch-transparent continuous micro-nudge at 344 Hz inside the audio thread
        const maxTrimFrac = Math.max(0.0005, Math.min(0.01, this.maxTrimPct / 100));
        const kp = 8.5;
        const ki = 20.0;
        const maxIntSec = maxTrimFrac / ki;
        this.integralErrSec = Math.max(
          -maxIntSec,
          Math.min(maxIntSec, this.integralErrSec + errToTargetSec * dtBlockSec)
        );
        const prop = Math.max(-maxTrimFrac, Math.min(maxTrimFrac, errToTargetSec * kp));
        const integ = this.integralErrSec * ki;
        rateTrimFrac = Math.max(-maxTrimFrac, Math.min(maxTrimFrac, prop + integ));
      }
    } else {
      this.integralErrSec = 0;
      rateTrimFrac = 0;
    }

    this.currentRateTrimFrac = rateTrimFrac;

    const d1StepPerSample = this.masterBpm / 60 / sampleRate;
    const d1TempoRatio = (this.masterBpm * (d1.tempoMultiplier || 1)) / Math.max(40, d1.bpm);
    const d2BaseBpm = this.syncMode !== 'off' ? this.masterBpm : this.deck2TargetBpm;
    const d2StepPerSample = (d2BaseBpm * (1 + rateTrimFrac)) / 60 / sampleRate;
    const d2TempoRatio =
      (d2BaseBpm * (1 + rateTrimFrac) * (d2.tempoMultiplier || 1)) / Math.max(40, d2.bpm);
    const looperTempoRatio = hasLooper
      ? (this.masterBpm * (lp.tempoMultiplier || 1)) / Math.max(40, lp.bpm)
      : 1;

    const advanceMaster = this.deck1Playing || this.deck2Playing || lpActive;

    for (let i = 0; i < blockFrames; i++) {
      let l = 0;
      let r = 0;

      if (d1Active) {
        this.sampleDeckStereoWithKey(
          d1,
          this.masterBeatPos,
          d1StepPerSample,
          d1TempoRatio,
          this.stereoBuf1,
          true
        );
        l += this.stereoBuf1[0] * g1;
        r += this.stereoBuf1[1] * g1;
      }

      if (d2Active) {
        this.sampleDeckStereoWithKey(
          d2,
          this.deck2BeatPos,
          d2StepPerSample,
          d2TempoRatio,
          this.stereoBuf2,
          true
        );
        let d2L = this.stereoBuf2[0];
        let d2R = this.stereoBuf2[1];

        if (this.xfadeRemaining > 0) {
          const progress = 1 - this.xfadeRemaining / this.xfadeTotalSamples;
          const fadeIn = 0.5 - 0.5 * Math.cos(Math.PI * progress);
          const fadeOut = 1 - fadeIn;
          this.sampleDeckStereoWithKey(
            d2,
            this.xfadeOldBeatPos,
            d2StepPerSample,
            d2TempoRatio,
            this.stereoBufOld,
            false
          );
          d2L = this.stereoBufOld[0] * fadeOut + d2L * fadeIn;
          d2R = this.stereoBufOld[1] * fadeOut + d2R * fadeIn;
          this.xfadeOldBeatPos += d2StepPerSample;
          this.xfadeRemaining--;
        }

        l += d2L * g2;
        r += d2R * g2;
      }

      if (lpActive) {
        this.sampleDeckStereoWithKey(
          lp,
          this.masterBeatPos,
          d1StepPerSample,
          looperTempoRatio,
          this.stereoBufLooper,
          true
        );
        let lpL = this.stereoBufLooper[0];
        let lpR = this.stereoBufLooper[1];
        if (useLooperHp) {
          const yL = b0 * lpL + b1 * this.lpHpX1L + b2 * this.lpHpX2L - a1 * this.lpHpY1L - a2 * this.lpHpY2L;
          this.lpHpX2L = this.lpHpX1L;
          this.lpHpX1L = lpL;
          this.lpHpY2L = this.lpHpY1L;
          this.lpHpY1L = yL;
          lpL = yL;

          const yR = b0 * lpR + b1 * this.lpHpX1R + b2 * this.lpHpX2R - a1 * this.lpHpY1R - a2 * this.lpHpY2R;
          this.lpHpX2R = this.lpHpX1R;
          this.lpHpX1R = lpR;
          this.lpHpY2R = this.lpHpY1R;
          this.lpHpY1R = yR;
          lpR = yR;
        }
        l += lpL * looperGain;
        r += lpR * looperGain;
      }

      // Soft-knee transparent master limiter above 0.89 so Deck + Looper sums never digitally clip
      if (l > 0.89) l = 0.89 + 0.1 * Math.tanh((l - 0.89) * 10);
      else if (l < -0.89) l = -0.89 - 0.1 * Math.tanh((-l - 0.89) * 10);

      if (r > 0.89) r = 0.89 + 0.1 * Math.tanh((r - 0.89) * 10);
      else if (r < -0.89) r = -0.89 - 0.1 * Math.tanh((-r - 0.89) * 10);

      outL[i] = l;
      if (outR !== outL) outR[i] = r;

      if (advanceMaster) {
        this.masterBeatPos += d1StepPerSample;
      }
      if (this.deck2Playing) {
        this.deck2BeatPos += d2StepPerSample;
      }
    }

    this.telemetryAccum += blockFrames;
    // Emit telemetry roughly every ~17 ms (at 44.1 / 48 kHz)
    if (this.telemetryAccum >= 768) {
      this.telemetryAccum = 0;
      this.emitTelemetry();
    }

    return true;
  }
}

registerProcessor('phasezero-worklet-processor', PhaseZeroWorkletProcessor);
