export type StreamFeedbackSample = {
  kind: "text" | "reasoning";
  token: string;
  receivedAt: number;
  domAt: number | null;
  frameAt: number | null;
  terminalAtFrame: boolean | null;
};

/** Nearest-rank percentiles, per delta, not independent turns or device paint. */
export function streamFeedbackDistribution(values: number[]) {
  if (values.length === 0 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("Stream feedback requires non-empty, finite, non-negative samples");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { n: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) };
}

export function summarizeStreamFeedback(samples: StreamFeedbackSample[]) {
  return ["reasoning", "text"].map(kind => {
    const selected = samples.filter(sample => sample.kind === kind);
    if (selected.some(sample => sample.domAt === null || sample.frameAt === null || sample.terminalAtFrame !== false
      || sample.domAt < sample.receivedAt || sample.frameAt < sample.domAt)) {
      throw new Error(`${kind} has missing, out-of-order or post-completion feedback`);
    }
    return {
      kind,
      dom: streamFeedbackDistribution(selected.map(sample => (sample.domAt ?? NaN) - sample.receivedAt)),
      frame: streamFeedbackDistribution(selected.map(sample => (sample.frameAt ?? NaN) - sample.receivedAt)),
    };
  });
}
