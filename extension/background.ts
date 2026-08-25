const API_URL = "http://127.0.0.1:3030/api/refine";
const STREAM_API_URL = "http://127.0.0.1:3030/api/refine/stream";
const REQUEST_TIMEOUT_MS = 120_000;

interface RefineRequest {
  type: "refine-english";
  text: string;
}

interface StartStreamMessage {
  type: "start";
  text: string;
}

interface ApiError {
  error?: string;
}

type StreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; delta: string }
  | { type: "done"; refined: string; model: string; metrics: Record<string, number> }
  | { type: "error"; error: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse): boolean => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "refine-english"
    ) {
      return false;
    }

    const request = message as RefineRequest;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: request.text }),
      signal: controller.signal,
    })
      .then(async (response) => {
        let payload: ApiError;
        try {
          payload = (await response.json()) as ApiError;
        } catch {
          throw new Error(
            `The local service returned an unreadable response (${response.status}).`,
          );
        }

        if (!response.ok) {
          throw new Error(payload.error || `The local service failed (${response.status}).`);
        }

        sendResponse({ ok: true, ...payload });
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error:
            error instanceof DOMException && error.name === "AbortError"
              ? "The local service took too long to respond."
              : errorMessage(error, "Could not reach the local refinement service."),
        });
      })
      .finally(() => clearTimeout(timeout));

    return true;
  },
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "refine-english-stream") return;

  const controller = new AbortController();
  let started = false;
  let disconnected = false;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const safePost = (message: StreamEvent): void => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch {
      disconnected = true;
      controller.abort();
    }
  };

  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller.abort();
    clearTimeout(timeout);
  });

  port.onMessage.addListener((message: unknown) => {
    if (
      started ||
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "start"
    ) {
      return;
    }
    started = true;
    const request = message as StartStreamMessage;

    void (async () => {
      const response = await fetch(STREAM_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: request.text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let payload: ApiError;
        try {
          payload = (await response.json()) as ApiError;
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
      let receivedDone = false;

      const processLine = (line: string): void => {
        if (!line.trim()) return;
        let event: StreamEvent;
        try {
          event = JSON.parse(line) as StreamEvent;
        } catch {
          throw new Error("The local service returned an invalid stream.");
        }
        if (event.type === "done") receivedDone = true;
        if (event.type === "error") {
          throw new Error(event.error || "The refinement stream failed.");
        }
        safePost(event);
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
      if (!receivedDone && !disconnected) {
        throw new Error("The refinement stream ended before completion.");
      }
    })()
      .catch((error: unknown) => {
        if (disconnected) return;
        safePost({
          type: "error",
          error:
            error instanceof DOMException && error.name === "AbortError"
              ? "The local service took too long to respond."
              : errorMessage(error, "Could not reach the local refinement service."),
        });
      })
      .finally(() => clearTimeout(timeout));
  });
});
