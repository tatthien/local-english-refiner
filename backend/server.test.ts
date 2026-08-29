import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerationOptions,
  GenerationResult,
  TextRefiner,
} from "./llama-refiner.ts";
import { configFromEnvironment, createApp } from "./server.ts";

class MockRefiner implements TextRefiner {
  calls: Array<{ text: string; options: GenerationOptions }> = [];

  constructor(
    private readonly chunks: string[] = ["This is the revised text."],
    private readonly usage = { promptTokens: 20, outputTokens: 12 },
  ) {}

  async generate(text: string, options: GenerationOptions): Promise<GenerationResult> {
    this.calls.push({ text, options });
    for (const chunk of this.chunks) options.onTextChunk?.(chunk);

    return {
      text: this.chunks.join(""),
      ...this.usage,
    };
  }
}

test("configuration uses local model settings", () => {
  const config = configFromEnvironment({
    MODEL: "/models/editor.gguf",
    CONTEXT_SIZE: "4096",
    MAX_OUTPUT_TOKENS: "512",
    INFERENCE_TIMEOUT_MS: "30000",
  });

  assert.equal(config.model, "/models/editor.gguf");
  assert.equal(config.contextSize, 4096);
  assert.equal(config.maxOutputTokens, 512);
  assert.equal(config.timeoutMs, 30_000);
});

test("health endpoint reports the configured model", async () => {
  const app = createApp({ model: "test-model" });

  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    model: "test-model",
  });
});

test("refine endpoint delegates to the local model", async () => {
  const refiner = new MockRefiner();
  const app = createApp({ model: "test-model" }, refiner);

  const response = await app.request("/api/refine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "This are incorrect." }),
  });

  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    refined: string;
    model: string;
    metrics: { promptTokens: number; outputTokens: number };
  };
  assert.equal(result.refined, "This is the revised text.");
  assert.equal(result.model, "test-model");
  assert.equal(result.metrics.promptTokens, 20);
  assert.equal(result.metrics.outputTokens, 12);
  assert.equal(refiner.calls.length, 1);
  assert.equal(refiner.calls[0]?.text, "This are incorrect.");
  assert.equal(refiner.calls[0]?.options.signal.aborted, false);
});

test("refine endpoint validates input before running inference", async () => {
  const refiner = new MockRefiner();
  const app = createApp({}, refiner);

  const response = await app.request("/api/refine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });

  assert.equal(response.status, 400);
  const result = (await response.json()) as { error: string };
  assert.match(result.error, /non-empty/);
  assert.equal(refiner.calls.length, 0);
});

test("Chrome extensions are allowed to call the API", async () => {
  const app = createApp();

  const response = await app.request("/api/refine", {
    method: "OPTIONS",
    headers: {
      Origin: "chrome-extension://local-english-refiner",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "chrome-extension://local-english-refiner",
  );
});

test("stream endpoint forwards model output incrementally", async () => {
  const refiner = new MockRefiner(["This is ", "the revised text."]);
  const app = createApp({ model: "stream-model" }, refiner);

  const response = await app.request("/api/refine/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "This are incorrect." }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "delta", "delta", "done"],
  );
  assert.equal(`${events[1]?.delta}${events[2]?.delta}`, "This is the revised text.");
  assert.equal(events[3]?.refined, "This is the revised text.");
  assert.equal(refiner.calls[0]?.options.signal.aborted, false);
});
