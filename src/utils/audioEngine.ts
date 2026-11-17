import {
  analyzeBeatGrid,
  type AnalyzedTrackData,
  computeWaveformPeaks,
  generateTestAudioPcm,
} from './audioAnalysis';

export interface LoadedDeckTrack extends AnalyzedTrackData {
  buffer: AudioBuffer;
  isDemo: boolean;
}

export interface WorkletTelemetry {
  masterBeatPos: number;
  deck2BeatPos: number;
  deck1TimeSec: number;
  deck2TimeSec: number;
  livePhaseErrorMs: number;
  rateTrimPct: number;
  hardSnapCount: number;
  justSnapped: boolean;
  receivedAtPerfMs: number;
}

export interface WorkletParamsPayload {
  masterBpm: number;
  deck2TargetBpm: number;
  syncMode: 'off' | 'tempo' | 'beat';
  gridMode: 'straight' | 'dynamic';
  autoNudgeEnabled: boolean;
  maxTrimPct: number;
  desiredOffsetMs: number;
  crossfader: number;
  deck1Grid?: {
    bpm: number;
    anchorMs: number;
    useBeatTimes: boolean;
    beatTimesSec?: number[];
    startBeatOffset?: number;
    tempoMultiplier?: 0.5 | 1 | 2;
    keyLock?: boolean;
    keyShiftSemitones?: number;
  };
  deck2Grid?: {
    bpm: number;
    anchorMs: number;
    useBeatTimes: boolean;
    beatTimesSec?: number[];
    startBeatOffset?: number;
    tempoMultiplier?: 0.5 | 1 | 2;
    keyLock?: boolean;
    keyShiftSemitones?: number;
  };
}

interface DeckPlaybackCursor {
  anchorCtxTime: number;
  anchorTrackSec: number;
  currentRate: number;
  nextChangeCtxTime: number | null;
  nextTrackSec: number;
  nextRate: number;
}

/**
 * Dual-Deck Web Audio engine:
 *  - Primary: Single-transport-owner AudioWorkletProcessor (`/phasezero-worklet.js`)
 *    rendering both Deck 1 and Deck 2 on the same audio-thread clock with 0.00 ms
 *    continuous lock and click-free 4 ms cosine crossfade (zero 12 ms snap offset).
 *  - Fallback: Hardware-clock AudioBufferSourceNode cursors with future-quantum rate
 *    steering and exact scheduleAt target projection if AudioWorklet is unavailable.
 */
class DualDeckAudioEngine {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private crossfader = 0; // -1 = full Deck 1, 0 = 50/50 sum, +1 = full Deck 2

  private deck1Track: LoadedDeckTrack | null = null;
  private deck2Track: LoadedDeckTrack | null = null;

  private deck1Gain: GainNode | null = null;
  private deck2Gain: GainNode | null = null;

  private deck1Source: AudioBufferSourceNode | null = null;
  private deck2Source: AudioBufferSourceNode | null = null;

  private deck1Cursor: DeckPlaybackCursor | null = null;
  private deck2Cursor: DeckPlaybackCursor | null = null;
  private lastResyncCtxTime = -1;

  // AudioWorklet Single-Transport-Owner state
  private workletNode: AudioWorkletNode | null = null;
  private workletReady = false;
  private workletLoadPromise: Promise<boolean> | null = null;
  private workletTelemetry: WorkletTelemetry | null = null;
  private pendingWorkletParams: WorkletParamsPayload | null = null;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx({ latencyHint: 'interactive' });
        this.deck1Gain = this.ctx.createGain();
        this.deck2Gain = this.ctx.createGain();
        this.deck1Gain.connect(this.ctx.destination);
        this.deck2Gain.connect(this.ctx.destination);
        this.applyCrossfaderGains();
      }
    }
    return this.ctx;
  }

  private async ensureWorkletReady(): Promise<boolean> {
    if (this.workletReady && this.workletNode) return true;
    const ctx = this.ensureContext();
    if (!ctx || !ctx.audioWorklet) return false;
    if (this.workletLoadPromise) return this.workletLoadPromise;

    this.workletLoadPromise = (async () => {
      try {
        await ctx.audioWorklet.addModule('/phasezero-worklet.js?v=2');
        const node = new AudioWorkletNode(ctx, 'phasezero-worklet-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.port.onmessage = (ev: MessageEvent) => {
          const data = ev.data;
          if (data && data.type === 'telemetry') {
            this.workletTelemetry = {
              masterBeatPos: data.masterBeatPos,
              deck2BeatPos: data.deck2BeatPos,
              deck1TimeSec: data.deck1TimeSec,
              deck2TimeSec: data.deck2TimeSec,
              livePhaseErrorMs: data.livePhaseErrorMs,
              rateTrimPct: data.rateTrimPct,
              hardSnapCount: data.hardSnapCount,
              justSnapped: Boolean(data.justSnapped),
              receivedAtPerfMs: performance.now(),
            };
          }
        };
        node.connect(ctx.destination);
        this.workletNode = node;
        this.workletReady = true;

        // Upload any already-loaded tracks & params into the worklet
        if (this.deck1Track) this.uploadTrackToWorklet(1, this.deck1Track);
        if (this.deck2Track) this.uploadTrackToWorklet(2, this.deck2Track);
        if (this.pendingWorkletParams) {
          this.updateWorkletParams(this.pendingWorkletParams);
        }
        return true;
      } catch {
        this.workletReady = false;
        this.workletNode = null;
        return false;
      } finally {
        this.workletLoadPromise = null;
      }
    })();

    return this.workletLoadPromise;
  }

  private uploadTrackToWorklet(deck: 1 | 2, track: LoadedDeckTrack): void {
    if (!this.workletNode || !(track.buffer instanceof AudioBuffer)) return;
    const channels: Float32Array[] = [];
    const chCount = Math.min(2, track.buffer.numberOfChannels);
    for (let c = 0; c < chCount; c++) {
      // Copy channel PCM cleanly so AudioBuffer on main thread remains intact for waveform rendering
      channels.push(new Float32Array(track.buffer.getChannelData(c)));
    }
    this.workletNode.port.postMessage({
      type: 'loadTrack',
      deck,
      channels,
      length: track.buffer.length,
      trackSampleRate: track.buffer.sampleRate,
      durationSec: track.durationSec,
      bpm: track.exactBpm,
      anchorMs: track.firstTransientMs,
      beatTimesSec: track.beatTimesSec,
      useBeatTimes: !track.isConstantTempo,
    });
  }

  public isUsingWorklet(): boolean {
    return this.enabled && this.workletReady && Boolean(this.workletNode);
  }

  public getWorkletTelemetry(): WorkletTelemetry | null {
    return this.workletTelemetry;
  }

  public updateWorkletParams(params: WorkletParamsPayload): void {
    this.pendingWorkletParams = params;
    if (!this.workletNode || !this.workletReady) return;
    this.workletNode.port.postMessage({
      type: 'setParams',
      ...params,
    });
  }

  public startWorkletTransport(params: {
    elapsedBeats: number;
    initialPhaseErrorMs: number;
    resetCounters?: boolean;
  }): boolean {
    if (!this.isUsingWorklet() || !this.workletNode) return false;
    // Ensure BufferSource fallback is stopped when worklet takes ownership
    this.stopFallbackSources();
    this.workletNode.port.postMessage({
      type: 'start',
      elapsedBeats: params.elapsedBeats,
      initialPhaseErrorMs: params.initialPhaseErrorMs,
      resetCounters: Boolean(params.resetCounters),
    });
    return true;
  }

  public seekWorkletTransport(elapsedBeats: number, phaseErrorMs: number): void {
    if (!this.isUsingWorklet() || !this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'seek',
      elapsedBeats,
      phaseErrorMs,
    });
  }

  public snapWorkletZero(): void {
    if (!this.isUsingWorklet() || !this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'snapZero' });
  }

  public getContextTimeSec(): number | null {
    return this.ctx ? this.ctx.currentTime : null;
  }

  public async setEnabled(on: boolean): Promise<boolean> {
    if (!on) {
      this.enabled = false;
      this.stopTrackSources();
      return false;
    }
    try {
      const ctx = this.ensureContext();
      if (ctx && ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (ctx) {
        await this.ensureWorkletReady();
      }
      this.enabled = Boolean(ctx);
      return this.enabled;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setCrossfader(value: number): void {
    this.crossfader = Math.max(-1, Math.min(1, value));
    this.applyCrossfaderGains();
    if (this.workletNode && this.workletReady) {
      this.workletNode.port.postMessage({
        type: 'setParams',
        crossfader: this.crossfader,
      });
    }
  }

  private applyCrossfaderGains(): void {
    if (!this.ctx || !this.deck1Gain || !this.deck2Gain) return;
    const g1 = this.crossfader <= 0 ? 0.85 : Math.max(0, 0.85 * (1 - this.crossfader));
    const g2 = this.crossfader >= 0 ? 0.85 : Math.max(0, 0.85 * (1 + this.crossfader));
    this.deck1Gain.gain.setValueAtTime(g1, this.ctx.currentTime);
    this.deck2Gain.gain.setValueAtTime(g2, this.ctx.currentTime);
  }

  public async loadLocalFile(deck: 1 | 2, file: File): Promise<LoadedDeckTrack> {
    const ctx = this.ensureContext();
    if (!ctx) {
      throw new Error('Web Audio API is unavailable in this browser.');
    }
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const mono = this.mixDownToMono(audioBuffer);
    const grid = analyzeBeatGrid(mono, audioBuffer.sampleRate);
    const peakSamplesPerSec = 400;
    const peaks = computeWaveformPeaks(mono, audioBuffer.sampleRate, peakSamplesPerSec);

    const track: LoadedDeckTrack = {
      name: file.name,
      durationSec: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      detectedBpm: grid.bpm,
      exactBpm: grid.exactBpm,
      firstTransientMs: grid.firstTransientMs,
      beatTimesSec: grid.beatTimesSec,
      isConstantTempo: grid.isConstantTempo,
      gridResidualMs: grid.gridResidualMs,
      barRhythm: grid.barRhythm,
      musicalKey: grid.musicalKey,
      peaks,
      peakSamplesPerSec,
      buffer: audioBuffer,
      isDemo: false,
    };

    if (deck === 1) this.deck1Track = track;
    else this.deck2Track = track;

    this.uploadTrackToWorklet(deck, track);

    return track;
  }

  public loadDemoTrack(
    deck: 1 | 2,
    bpm = 124,
    initialOffsetMs = 0,
    label?: string,
    options?: {
      beatShift?: number;
      rootMidi?: number;
      mode?: 'major' | 'minor';
    }
  ): LoadedDeckTrack {
    const ctx = this.ensureContext();
    const sampleRate = ctx ? ctx.sampleRate : 44100;
    const durationSec = 16;
    const pcm = generateTestAudioPcm(
      bpm,
      durationSec,
      sampleRate,
      initialOffsetMs,
      deck === 1 ? 'master' : 'incoming',
      options ?? {
        beatShift: 0,
        rootMidi: deck === 1 ? 57 : 62, // Deck 1: Am (8A), Deck 2: Dm (7A)
        mode: 'minor',
      }
    );

    let buffer: AudioBuffer;
    if (ctx) {
      buffer = ctx.createBuffer(1, pcm.length, sampleRate);
      buffer.copyToChannel(new Float32Array(pcm), 0);
    } else {
      buffer = {
        duration: durationSec,
        length: pcm.length,
        numberOfChannels: 1,
        sampleRate,
      } as AudioBuffer;
    }

    const peakSamplesPerSec = 400;
    const peaks = computeWaveformPeaks(pcm, sampleRate, peakSamplesPerSec);
    const grid = analyzeBeatGrid(pcm, sampleRate);

    const track: LoadedDeckTrack = {
      name:
        label ??
        (deck === 1
          ? `Demo Beat ${bpm} BPM`
          : `Demo Loop ${bpm} BPM (+${initialOffsetMs.toFixed(1)}ms)`),
      durationSec,
      sampleRate,
      detectedBpm: grid.bpm,
      exactBpm: grid.exactBpm,
      firstTransientMs: grid.firstTransientMs,
      beatTimesSec: grid.beatTimesSec,
      isConstantTempo: grid.isConstantTempo,
      gridResidualMs: grid.gridResidualMs,
      barRhythm: grid.barRhythm,
      musicalKey: grid.musicalKey,
      peaks,
      peakSamplesPerSec,
      buffer,
      isDemo: true,
    };

    if (deck === 1) this.deck1Track = track;
    else this.deck2Track = track;

    this.uploadTrackToWorklet(deck, track);

    return track;
  }

  public clearDeck(deck: 1 | 2): void {
    this.stopTrackSources();
    if (deck === 1) this.deck1Track = null;
    else this.deck2Track = null;
    if (this.workletNode && this.workletReady) {
      this.workletNode.port.postMessage({ type: 'clearDeck', deck });
    }
  }

  public getTrack(deck: 1 | 2): LoadedDeckTrack | null {
    return deck === 1 ? this.deck1Track : this.deck2Track;
  }

  public hasAnyLoadedTrack(): boolean {
    return Boolean(this.deck1Track || this.deck2Track);
  }

  public getDeckTimeSec(deck: 1 | 2, atCtxTime?: number): number | null {
    if (this.isUsingWorklet() && this.workletTelemetry) {
      return deck === 1
        ? this.workletTelemetry.deck1TimeSec
        : this.workletTelemetry.deck2TimeSec;
    }
    if (!this.ctx) return null;
    const cursor = deck === 1 ? this.deck1Cursor : this.deck2Cursor;
    const track = deck === 1 ? this.deck1Track : this.deck2Track;
    if (!cursor || !track) return null;

    const now = atCtxTime ?? this.ctx.currentTime;
    const dur = Math.max(0.01, track.durationSec);

    if (now < cursor.anchorCtxTime) {
      return cursor.anchorTrackSec;
    }

    // Commit scheduled transition seamlessly once AudioContext passes nextChangeCtxTime
    if (cursor.nextChangeCtxTime !== null && now >= cursor.nextChangeCtxTime) {
      cursor.anchorCtxTime = cursor.nextChangeCtxTime;
      cursor.anchorTrackSec = cursor.nextTrackSec;
      cursor.currentRate = cursor.nextRate;
      cursor.nextChangeCtxTime = null;
    }

    const elapsed = now - cursor.anchorCtxTime;
    const raw = cursor.anchorTrackSec + elapsed * cursor.currentRate;
    return ((raw % dur) + dur) % dur;
  }

  public startTrackSources(params: {
    deck1OffsetSec: number;
    deck2OffsetSec: number;
    deck1Rate: number;
    deck2Rate: number;
    deck1DetuneCents?: number;
    deck2DetuneCents?: number;
  }): void {
    if (!this.enabled || !this.ctx || !this.deck1Gain || !this.deck2Gain) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    this.stopFallbackSources();
    const baseStartAt = this.ctx.currentTime + 0.035;

    if (this.deck1Track && this.deck1Track.buffer instanceof AudioBuffer) {
      const rate1 = Math.max(0.5, Math.min(2.0, params.deck1Rate));
      const dur1 = Math.max(0.01, this.deck1Track.durationSec);
      const start1 =
        params.deck1OffsetSec < 0 ? baseStartAt + Math.abs(params.deck1OffsetSec) / rate1 : baseStartAt;
      const offset1 = params.deck1OffsetSec < 0 ? 0 : params.deck1OffsetSec % dur1;

      const src1 = this.ctx.createBufferSource();
      src1.buffer = this.deck1Track.buffer;
      src1.loop = true;
      src1.playbackRate.setValueAtTime(rate1, start1);
      if (typeof params.deck1DetuneCents === 'number') {
        src1.detune.setValueAtTime(params.deck1DetuneCents, start1);
      }
      src1.connect(this.deck1Gain);
      src1.start(start1, offset1);
      this.deck1Source = src1;
      this.deck1Cursor = {
        anchorCtxTime: start1,
        anchorTrackSec: offset1,
        currentRate: rate1,
        nextChangeCtxTime: null,
        nextTrackSec: offset1,
        nextRate: rate1,
      };
    }

    if (this.deck2Track && this.deck2Track.buffer instanceof AudioBuffer) {
      const rate2 = Math.max(0.5, Math.min(2.0, params.deck2Rate));
      const dur2 = Math.max(0.01, this.deck2Track.durationSec);
      const start2 =
        params.deck2OffsetSec < 0 ? baseStartAt + Math.abs(params.deck2OffsetSec) / rate2 : baseStartAt;
      const offset2 = params.deck2OffsetSec < 0 ? 0 : params.deck2OffsetSec % dur2;

      const src2 = this.ctx.createBufferSource();
      src2.buffer = this.deck2Track.buffer;
      src2.loop = true;
      src2.playbackRate.setValueAtTime(rate2, start2);
      if (typeof params.deck2DetuneCents === 'number') {
        src2.detune.setValueAtTime(params.deck2DetuneCents, start2);
      }
      src2.connect(this.deck2Gain);
      src2.start(start2, offset2);
      this.deck2Source = src2;
      this.deck2Cursor = {
        anchorCtxTime: start2,
        anchorTrackSec: offset2,
        currentRate: rate2,
        nextChangeCtxTime: null,
        nextTrackSec: offset2,
        nextRate: rate2,
      };
    }
    this.lastResyncCtxTime = baseStartAt;
  }

  /**
   * Future-quantum scheduled playbackRate steering for fallback AudioBufferSourceNode path.
   */
  public steerDeck2Rate(newRate: number): void {
    if (!this.ctx || !this.deck2Source || !this.deck2Cursor || !this.deck2Track) return;
    const now = this.ctx.currentTime;
    const c = this.deck2Cursor;
    if (now < c.anchorCtxTime) return;

    if (c.nextChangeCtxTime !== null) {
      if (now >= c.nextChangeCtxTime) {
        c.anchorCtxTime = c.nextChangeCtxTime;
        c.anchorTrackSec = c.nextTrackSec;
        c.currentRate = c.nextRate;
        c.nextChangeCtxTime = null;
      } else {
        return;
      }
    }

    const clampedRate = Math.max(0.5, Math.min(2.0, newRate));
    if (Math.abs(clampedRate - c.currentRate) < 2e-6) return;

    const dur = Math.max(0.01, this.deck2Track.durationSec);
    const scheduleAt = now + 0.008;
    const dtToSchedule = scheduleAt - c.anchorCtxTime;
    const trackAtSchedule =
      (((c.anchorTrackSec + dtToSchedule * c.currentRate) % dur) + dur) % dur;

    c.nextChangeCtxTime = scheduleAt;
    c.nextTrackSec = trackAtSchedule;
    c.nextRate = clampedRate;
    this.deck2Source.playbackRate.setValueAtTime(clampedRate, scheduleAt);
  }

  /**
   * Click-free manual sub-millisecond phase nudge on Deck 2 while Deck 1 continues smoothly.
   */
  public nudgeDeck2PhaseMs(deltaMs: number): boolean {
    if (this.isUsingWorklet() && this.workletNode) {
      this.workletNode.port.postMessage({ type: 'nudgeMs', deltaMs });
      return true;
    }

    if (!this.enabled || !this.ctx || !this.deck2Cursor || !this.deck2Track) return false;
    const scheduleAt = this.ctx.currentTime + 0.012;
    const projectedSec = this.getDeckTimeSec(2, scheduleAt);
    if (projectedSec === null) return false;
    const activeRate =
      this.deck2Cursor.nextChangeCtxTime !== null &&
      scheduleAt >= this.deck2Cursor.nextChangeCtxTime
        ? this.deck2Cursor.nextRate
        : this.deck2Cursor.currentRate;
    return this.resyncDeck2ToTime(projectedSec + deltaMs / 1000, activeRate, true, scheduleAt);
  }

  /**
   * Hard-snaps only Deck 2 to an exact sample-accurate timestamp while Deck 1 keeps playing.
   * Advances targetOffsetSec cleanly to explicitScheduleAt so zero 12 ms schedule lag occurs.
   */
  public resyncDeck2ToTime(
    targetOffsetSec: number,
    rate: number,
    bypassDebounce = false,
    explicitScheduleAt?: number
  ): boolean {
    if (!this.enabled || !this.ctx || !this.deck2Gain || !this.deck2Track) return false;
    if (!(this.deck2Track.buffer instanceof AudioBuffer)) return false;
    if (!bypassDebounce && this.ctx.currentTime - this.lastResyncCtxTime < 0.15) return false;

    const scheduleLeadSec = 0.012;
    const now = explicitScheduleAt ?? this.ctx.currentTime + scheduleLeadSec;
    const clampedRate = Math.max(0.5, Math.min(2.0, rate));
    // Project targetOffsetSec forward by scheduleLeadSec when caller evaluated target at ctx.currentTime
    const effectiveTargetSec =
      explicitScheduleAt !== undefined
        ? targetOffsetSec
        : targetOffsetSec + scheduleLeadSec * clampedRate;

    this.lastResyncCtxTime = now;

    if (this.deck2Source) {
      try {
        this.deck2Source.stop(now);
      } catch {
        // Ignore already stopped
      }
    }

    const dur = Math.max(0.01, this.deck2Track.durationSec);
    const offset = ((effectiveTargetSec % dur) + dur) % dur;

    const src2 = this.ctx.createBufferSource();
    src2.buffer = this.deck2Track.buffer;
    src2.loop = true;
    src2.playbackRate.setValueAtTime(clampedRate, now);
    src2.connect(this.deck2Gain);
    src2.start(now, offset);

    this.deck2Source = src2;
    this.deck2Cursor = {
      anchorCtxTime: now,
      anchorTrackSec: offset,
      currentRate: clampedRate,
      nextChangeCtxTime: null,
      nextTrackSec: offset,
      nextRate: clampedRate,
    };
    return true;
  }

  private stopFallbackSources(): void {
    if (this.deck1Source) {
      try {
        this.deck1Source.stop();
        this.deck1Source.disconnect();
      } catch {
        // Ignore
      }
      this.deck1Source = null;
    }
    if (this.deck2Source) {
      try {
        this.deck2Source.stop();
        this.deck2Source.disconnect();
      } catch {
        // Ignore
      }
      this.deck2Source = null;
    }
    this.deck1Cursor = null;
    this.deck2Cursor = null;
  }

  public stopTrackSources(): void {
    this.stopFallbackSources();
    if (this.workletNode && this.workletReady) {
      this.workletNode.port.postMessage({ type: 'stop' });
    }
  }

  public triggerBeatPair(phaseErrorMs: number, isDownbeat: boolean): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (this.hasAnyLoadedTrack()) return;

    const now = this.ctx.currentTime + 0.015;
    this.scheduleKick(now, 118, isDownbeat ? 0.38 : 0.28);

    const offsetSec = phaseErrorMs / 1000;
    const deck2Time = Math.max(this.ctx.currentTime + 0.002, now + offsetSec);
    this.scheduleKick(deck2Time, 134, isDownbeat ? 0.34 : 0.25);
  }

  private scheduleKick(startTime: number, startFreq: number, peakGain: number): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, startTime);
    osc.frequency.exponentialRampToValueAtTime(44, startTime + 0.09);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.14);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + 0.15);
  }

  private mixDownToMono(buffer: AudioBuffer): Float32Array {
    const ch0 = buffer.getChannelData(0);
    if (buffer.numberOfChannels === 1) return ch0;
    const ch1 = buffer.getChannelData(1);
    const mono = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      mono[i] = (ch0[i] + ch1[i]) * 0.5;
    }
    return mono;
  }

  public dispose(): void {
    this.stopTrackSources();
    this.enabled = false;
    this.workletReady = false;
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore
      }
      this.workletNode = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export const audioEngine = new DualDeckAudioEngine();
