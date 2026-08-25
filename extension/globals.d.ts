interface RefinementMetrics {
  totalDurationMs: number;
  promptTokens?: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
}

interface RefinementResult {
  type: "done";
  refined: string;
  model: string;
  metrics: RefinementMetrics;
}

interface Window {
  __localEnglishRefinerLoaded?: boolean;
  __localEnglishRefinerRequest?: (
    text: string,
    onDelta: (accumulatedText: string) => void,
  ) => Promise<RefinementResult>;
}
