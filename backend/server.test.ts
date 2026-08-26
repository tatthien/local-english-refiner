import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import test from "node:test";

import { createApp, SYSTEM_PROMPT } from "./server.ts";

interface OllamaRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  think: boolean;
  stream: boolean;
  temperature: number;
  top_p: number;
  max_output_tokens: number;
  options: { num_predict: number };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The test server did not expose a TCP port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function ollamaChunk(
  model: string,
  content: string,
  done: boolean,
): Record<string, unknown> {
  return {
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content },
    done,
    ...(done
      ? {
          done_reason: "stop",
          total_duration: 2_000_000_000,
          prompt_eval_count: 20,
          prompt_eval_duration: 500_000_000,
          eval_count: 12,
          eval_duration: 1_000_000_000,
        }
      : {}),
  };
}

function createMockOllama(onRequest: (payload: OllamaRequest) => void): Server {
  return http.createServer(async (request, response) => {
    assert.equal(request.url, "/api/chat");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OllamaRequest;
    onRequest(payload);

    if (payload.stream) {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.write(`${JSON.stringify(ollamaChunk(payload.model, "This is ", false))}\n`);
      response.end(
        `${JSON.stringify(ollamaChunk(payload.model, "the revised text.", true))}\n`,
      );
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(ollamaChunk(payload.model, "This is the revised text.", true)),
    );
  });
}

test("health endpoint reports the configured model", async (context) => {
  const app = createApp({ model: "test-model" });

  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    model: "test-model",
    ollamaUrl: "http://127.0.0.1:11434",
  });
});

test("refine endpoint uses AI SDK with thinking disabled", async (context) => {
  let receivedPayload: OllamaRequest | undefined;
  const mockOllama = createMockOllama((payload) => {
    receivedPayload = payload;
  });
  context.after(() => close(mockOllama));
  const ollamaUrl = await listen(mockOllama);

  const app = createApp({ ollamaUrl, model: "test-model" });

  const response = await app.request("/api/refine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "This are incorrect." }),
  });

  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    refined: string;
    metrics: { promptTokens: number; outputTokens: number };
  };
  assert.equal(result.refined, "This is the revised text.");
  assert.equal(result.metrics.promptTokens, 20);
  assert.equal(result.metrics.outputTokens, 12);
  assert.ok(receivedPayload);
  assert.equal(receivedPayload.think, false);
  assert.equal(receivedPayload.stream, false);
  assert.equal(receivedPayload.messages[0]?.content, SYSTEM_PROMPT);
  assert.equal(receivedPayload.messages[1]?.content, "This are incorrect.");
  assert.equal(receivedPayload.options.num_predict, 1024);
});

test("refine endpoint validates input before calling Ollama", async (context) => {
  const app = createApp();

  const response = await app.request("/api/refine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });

  assert.equal(response.status, 400);
  const result = (await response.json()) as { error: string };
  assert.match(result.error, /non-empty/);
});

test("Chrome extensions are allowed to call the API", async (context) => {
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

test("stream endpoint forwards AI SDK text incrementally", async (context) => {
  let receivedPayload: OllamaRequest | undefined;
  const mockOllama = createMockOllama((payload) => {
    receivedPayload = payload;
  });
  context.after(() => close(mockOllama));
  const ollamaUrl = await listen(mockOllama);

  const app = createApp({ ollamaUrl, model: "stream-model" });

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
  assert.ok(receivedPayload);
  assert.equal(receivedPayload.think, false);
  assert.equal(receivedPayload.stream, true);
});
