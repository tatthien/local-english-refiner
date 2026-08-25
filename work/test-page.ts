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

type StreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; delta: string }
  | RefinementResult
  | { type: "error"; error: string };

interface ErrorPayload {
  error?: string;
}

window.__localEnglishRefinerRequest = async (text, onDelta) => {
  const response = await fetch("http://127.0.0.1:3030/api/refine/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    let payload: ErrorPayload;
    try {
      payload = (await response.json()) as ErrorPayload;
    } catch {
      throw new Error(
        `The local service returned an unreadable response (${response.status}).`,
      );
    }
    throw new Error(payload.error || `The local service failed (${response.status}).`);
  }
  if (!response.body) throw new Error("The local service returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let result: RefinementResult | null = null;

  const processLine = (line: string): void => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamEvent;
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "delta") {
      accumulated += event.delta || "";
      onDelta(accumulated);
    }
    if (event.type === "done") result = event;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
    if (done) break;
  }
  if (buffer.trim()) processLine(buffer);
  if (!result) throw new Error("The refinement stream ended before completion.");
  return result;
};

export {};
