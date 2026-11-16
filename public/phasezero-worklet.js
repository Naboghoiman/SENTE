/**
 * PhaseZeroWorkletProcessor
 *
 * Single-transport-owner Web Audio render engine modeled after Section 5 of the
 * VirtualDJ / IMAN timing architecture:
 *  - One authoritative audio-render clock (`masterBeatPos`) advances inside process().
 *  - Both Deck 1 (master) and Deck 2 (follower) sample continuously with linear interpolation.
 *  - Musical offset (desiredOffsetMs, SYNC, platter nudge) is cleanly separated from
 *    bounded continuous micro-nudge rate control (<= ±maxTrimPct, default ±0.25%).
 *  - Click-free 4 ms cosine crossfade on explicit snaps (>15 ms) or manual platter nudges,
 *    with ZERO future-schedule lag (no 12 ms snap offset error).
 */
class PhaseZeroWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playing = false;
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

    // 4 ms cosine crossfade for click-free Deck 2 beat snap / manual nudge
    this.xfadeTotalSamples = Math.max(32, Math.round(sampleRate * 0.004));
    this.xfadeRemaining = 0;
    this.xfadeOldBeatPos = 0;

    this.decks = {
      1: this.createEmptyDeck(),
      2: this.createEmptyDeck(),
    };

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'loadTrack': {
          const deckNum = msg.deck === 2 ? 2 : 1;
          this.decks[deckNum] = {
            channels: msg.channels || null,
            length: msg.length || 0,
            sampleRate: msg.trackSampleRate || sampleRate,
            durationSec: msg.durationSec || 0,
            bpm: Math.max(40, msg.bpm || 124),
            anchorSec: Math.max(0, (msg.anchorMs || 0) / 1000),
            beatTimesSec: msg.beatTimesSec ? new Float64Array(msg.beatTimesSec) : null,
            useBeatTimes: Boolean(msg.useBeatTimes),
          };
          break;
        }
        case 'clearDeck': {
          const deckNum = msg.deck === 2 ? 2 : 1;
          this.decks[deckNum] = this.createEmptyDeck();
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
            if (patch && this.decks[d]) {
              if (typeof patch.bpm === 'number') this.decks[d].bpm = Math.max(40, patch.bpm);
              if (typeof patch.anchorMs === 'number') {
                this.decks[d].anchorSec = Math.max(0, patch.anchorMs / 1000);
              }
              if (typeof patch.useBeatTimes === 'boolean') {
                this.decks[d].useBeatTimes = patch.useBeatTimes;
              }
              if (patch.beatTimesSec) {
                this.decks[d].beatTimesSec = new Float64Array(patch.beatTimesSec);
              }
            }
          }
          break;
        }
        case 'start': {
          const beat0 = typeof msg.elapsedBeats === 'number' ? msg.elapsedBeats : 0;
          const initOffsetMs = typeof msg.initialPhaseErrorMs === 'number' ? msg.initialPhaseErrorMs : 0;
          this.masterBeatPos = beat0;
          this.deck2BeatPos = beat0 - (initOffsetMs / 1000) * (this.masterBpm / 60);
          this.integralErrSec = 0;
          this.currentRateTrimFrac = 0;
          this.xfadeRemaining = 0;
          if (msg.resetCounters) {
            this.hardSnapCount = 0;
            this.snappedRecentlyBlocks = 0;
          }
          this.playing = true;
          this.emitTelemetry();
          break;
        }
        case 'stop': {
          this.playing = false;
          this.integralErrSec = 0;
          this.currentRateTrimFrac = 0;
          this.xfadeRemaining = 0;
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
          this.emitTelemetry();
          break;
        }
        case 'nudgeMs': {
          const deltaMs = typeof msg.deltaMs === 'number' ? msg.deltaMs : 0;
          const deltaBeats = (deltaMs / 1000) * (this.masterBpm / 60);
          if (Math.abs(deltaMs) >= 0.3 && this.playing) {
            this.xfadeOldBeatPos = this.deck2BeatPos;
            this.xfadeRemaining = this.xfadeTotalSamples;
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
          this.emitTelemetry();
          break;
        }
      }
    };
  }

  createEmptyDeck() {
    return {
      channels: null,
      length: 0,
      sampleRate: sampleRate,
      durationSec: 0,
      bpm: 124.0,
      anchorSec: 0,
      beatTimesSec: null,
      useBeatTimes: false,
    };
  }

  wrapHalfBeat(deltaBeats) {
    let w = ((deltaBeats + 0.5) % 1 + 1) % 1 - 0.5;
    if (Math.abs(w) < 1e-9) w = 0;
    return w;
  }

  getTrackTimeSec(deck, beatPos) {
    if (!deck || !deck.channels || deck.length < 2) return -1;
    const beatSec = 60 / Math.max(40, deck.bpm);
    const rawPlayableBeats = Math.max(0.25, (deck.durationSec - deck.anchorSec) / beatSec);
    const wholeBeats = Math.floor(rawPlayableBeats);
    // Align loop boundary to whole bars when >= 8 beats so continuous loops keep downbeat order
    const loopBeats =
      wholeBeats >= 8
        ? Math.floor(wholeBeats / 4) * 4
        : wholeBeats >= 1
          ? wholeBeats
          : rawPlayableBeats;
    const wrappedBeat = ((beatPos % loopBeats) + loopBeats) % loopBeats;

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

  sampleDeckChannel(deck, chIdx, timeSec) {
    if (!deck || !deck.channels || deck.length < 2 || timeSec < 0) return 0;
    const ch = deck.channels[Math.min(chIdx, deck.channels.length - 1)];
    const pos = timeSec * deck.sampleRate;
    if (pos < 0 || pos >= deck.length - 1) return 0;
    const i0 = pos | 0;
    const frac = pos - i0;
    const s0 = ch[i0];
    const s1 = ch[i0 + 1];
    return s0 + frac * (s1 - s0);
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
    const hasD1 = Boolean(d1 && d1.channels && d1.length > 1);
    const hasD2 = Boolean(d2 && d2.channels && d2.length > 1);

    const g1 = this.crossfader <= 0 ? 0.85 : Math.max(0, 0.85 * (1 - this.crossfader));
    const g2 = this.crossfader >= 0 ? 0.85 : Math.max(0, 0.85 * (1 + this.crossfader));

    const dtBlockSec = blockFrames / sampleRate;
    const nudgeActive =
      this.syncMode === 'beat' && this.autoNudgeEnabled && hasD1 && hasD2;

    if (this.snappedRecentlyBlocks > 0) {
      this.snappedRecentlyBlocks--;
    }

    let rateTrimFrac = 0;

    if (nudgeActive) {
      const { errToTargetSec } = this.computeCurrentErrorMetrics();
      const absErrMs = Math.abs(errToTargetSec * 1000);

      if (absErrMs > 15) {
        // Explicit click-free 4 ms cosine crossfade beat snap (0.00 ms residual, NO 12 ms lag)
        const beatSec = 60 / Math.max(40, this.masterBpm);
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
    const d2BaseBpm = this.syncMode !== 'off' ? this.masterBpm : this.deck2TargetBpm;
    const d2StepPerSample = (d2BaseBpm * (1 + rateTrimFrac)) / 60 / sampleRate;

    for (let i = 0; i < blockFrames; i++) {
      let l = 0;
      let r = 0;

      if (hasD1) {
        const t1 = this.getTrackTimeSec(d1, this.masterBeatPos);
        l += this.sampleDeckChannel(d1, 0, t1) * g1;
        r += this.sampleDeckChannel(d1, 1, t1) * g1;
      }

      if (hasD2) {
        const t2 = this.getTrackTimeSec(d2, this.deck2BeatPos);
        let d2L = this.sampleDeckChannel(d2, 0, t2);
        let d2R = this.sampleDeckChannel(d2, 1, t2);

        if (this.xfadeRemaining > 0) {
          const progress = 1 - this.xfadeRemaining / this.xfadeTotalSamples;
          const fadeIn = 0.5 - 0.5 * Math.cos(Math.PI * progress);
          const fadeOut = 1 - fadeIn;
          const tOld = this.getTrackTimeSec(d2, this.xfadeOldBeatPos);
          const oldL = this.sampleDeckChannel(d2, 0, tOld);
          const oldR = this.sampleDeckChannel(d2, 1, tOld);
          d2L = oldL * fadeOut + d2L * fadeIn;
          d2R = oldR * fadeOut + d2R * fadeIn;
          this.xfadeOldBeatPos += d2StepPerSample;
          this.xfadeRemaining--;
        }

        l += d2L * g2;
        r += d2R * g2;
      }

      outL[i] = l;
      if (outR !== outL) outR[i] = r;

      this.masterBeatPos += d1StepPerSample;
      this.deck2BeatPos += d2StepPerSample;
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
