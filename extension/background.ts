import { NATIVE_HOST_NAME, SERVER_URL } from "../native-host/constants.ts";
import { loadSettings } from "./settings.ts";

const API_URL = `${SERVER_URL}/api/refine`;
const STREAM_API_URL = `${SERVER_URL}/api/refine/stream`;
const HEALTH_URL = `${SERVER_URL}/health`;
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
  | { type: "starting" }
  | { type: "start"; model: string }
  | { type: "delta"; delta: string }
  | { type: "done"; refined: string; model: string; metrics: Record<string, number> }
  | { type: "error"; error: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function isServerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startServerWithNativeHost(): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    let settled = false;

    port.onMessage.addListener((message: unknown) => {
      if (settled || typeof message !== "object" || message === null || !("type" in message)) {
        return;
      }
      settled = true;
      if (message.type === "ready") {
        resolve();
      } else {
        reject(
          new Error(
            "error" in message && typeof message.error === "string"
              ? message.error
              : "The local server could not start.",
          ),
        );
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      const reason = chrome.runtime.lastError?.message ?? "";
      reject(
        new Error(
          /not found|forbidden/i.test(reason)
            ? "The local server is not running and the native host is not installed. Run `npm run install-host`."
            : reason || "The native host closed before the local server started.",
        ),
      );
    });
  });
}

let pendingServerStart: Promise<void> | null = null;

/** All tabs share one start, so two clicks cannot spawn two servers. */
async function ensureServer(onStarting: () => void): Promise<void> {
  if (!pendingServerStart && (await isServerHealthy())) return;
  onStarting();
  pendingServerStart ??= startServerWithNativeHost().finally(() => {
    pendingServerStart = null;
  });
  await pendingServerStart;
}

async function refineBody(text: string): Promise<string> {
  const { provider, openaiModel } = await loadSettings();
  return JSON.stringify({ text, provider, model: openaiModel });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse): boolean => {
  if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "ensure-server") {
    return false;
  }
  ensureServer(() => {}).then(
    () => sendResponse({ ok: true }),
    (error: unknown) => sendResponse({ ok: false, error: errorMessage(error, "The local server could not start.") }),
  );
  return true;
});

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

    refineBody(request.text)
      .then((body) =>
        fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        }),
      )
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
  let timeout: ReturnType<typeof setTimeout> | undefined;

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
      await ensureServer(() => safePost({ type: "starting" }));
      if (disconnected) return;
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(STREAM_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await refineBody(request.text),
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
