interface RefinementMetrics {
  totalDurationMs: number;
  promptTokens?: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
}

interface RefinementResult {
  type: "done";
  refined: string;
  casual: string;
  professional: string;
  model: string;
  metrics: RefinementMetrics;
}

interface Window {
  __localEnglishRefinerLoaded?: boolean;
}
