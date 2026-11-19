import { analyzeBeatGrid, computeWaveformPeaks } from '../utils/audioAnalysis';

interface AnalysisWorkerRequest {
  id: number;
  mono: Float32Array;
  sampleRate: number;
  peakSamplesPerSec: number;
}

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { id, mono, sampleRate, peakSamplesPerSec } = event.data;
  try {
    const grid = analyzeBeatGrid(mono, sampleRate);
    const peaks = computeWaveformPeaks(mono, sampleRate, peakSamplesPerSec);
    self.postMessage(
      { id, grid, peaks },
      { transfer: [peaks.buffer] }
    );
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : 'Worker analysis failed.',
    });
  }
};
