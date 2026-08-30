import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import {
  LlamaCppRefiner,
  SYSTEM_PROMPT,
  type GenerationResult,
  type TextRefiner,
} from "./llama-refiner.ts";
import {
  createLogger,
  parseLogLevel,
  type Logger,
  type LogLevel,
} from "./logger.ts";

export { SYSTEM_PROMPT };

export interface AppConfig {
  host: string;
  port: number;
  model: string;
  timeoutMs: number;
  contextSize: number;
  maxOutputTokens: number;
  maxInputCharacters: number;
  logLevel: LogLevel;
}

export interface RefinementMetrics {
  totalDurationMs: number;
  promptTokens?: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
}

export interface RefinementResult {
  refined: string;
  model: string;
  metrics: RefinementMetrics;
}

export type RefinementEvent =
  | { type: "start"; model: string }
  | { type: "delta"; delta: string }
  | ({ type: "done" } & RefinementResult);

type AppEnvironment = {
  Variables: {
    requestId: string;
  };
};

type AppContext = Context<AppEnvironment>;

const DEFAULTS: Readonly<AppConfig> = Object.freeze({
  host: "127.0.0.1",
  port: 3030,
  model: "hf:bartowski/google_gemma-3-12b-it-GGUF:Q4_K_M",
  timeoutMs: 120_000,
  contextSize: 8_192,
  maxOutputTokens: 1_024,
  maxInputCharacters: 20_000,
  logLevel: "info",
});

function numberFromEnvironment(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function configFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return {
    host: environment.HOST || DEFAULTS.host,
    port: numberFromEnvironment(environment.PORT, DEFAULTS.port),
    model: environment.MODEL || DEFAULTS.model,
    timeoutMs: numberFromEnvironment(
      environment.INFERENCE_TIMEOUT_MS,
      DEFAULTS.timeoutMs,
    ),
    contextSize: numberFromEnvironment(environment.CONTEXT_SIZE, DEFAULTS.contextSize),
    maxOutputTokens: numberFromEnvironment(
      environment.MAX_OUTPUT_TOKENS,
      DEFAULTS.maxOutputTokens,
    ),
    maxInputCharacters: numberFromEnvironment(
      environment.MAX_INPUT_CHARACTERS,
      DEFAULTS.maxInputCharacters,
    ),
    logLevel: parseLogLevel(environment.LOG_LEVEL),
  };
}

function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (origin.startsWith("chrome-extension://")) return origin;

  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    ) {
      return origin;
    }
  } catch {
    // A malformed origin is omitted so the browser rejects the response.
  }

  return null;
}

function isTextRequest(value: unknown): value is { text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The refinement request failed.";
}

function createAbortSignal(timeoutMs: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const abortFromOutside = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromOutside, { once: true });
  if (externalSignal?.aborted) abortFromOutside();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(`Local inference did not finish within ${timeoutMs / 1000} seconds.`),
      ),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    abort(reason: unknown) {
      controller.abort(reason);
    },
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromOutside);
    },
  };
}

function metricsFromUsage(
  usage: Pick<GenerationResult, "promptTokens" | "outputTokens">,
  totalDurationMs: number,
): RefinementMetrics {
  const outputTokensPerSecond =
    usage.outputTokens && totalDurationMs > 0
      ? Number((usage.outputTokens / (totalDurationMs / 1000)).toFixed(2))
      : undefined;

  return {
    totalDurationMs,
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    outputTokensPerSecond,
  };
}

export async function refineText(
  text: string,
  config: AppConfig,
  refiner: TextRefiner = new LlamaCppRefiner(config),
): Promise<RefinementResult> {
  const abort = createAbortSignal(config.timeoutMs);
  const startedAt = performance.now();

  try {
    const result = await refiner.generate(text, { signal: abort.signal });
    const refined = result.text.trim();
    if (!refined) throw new Error("The model returned an empty revision.");
    const totalDurationMs = Math.round(performance.now() - startedAt);
    return {
      refined,
      model: config.model,
      metrics: metricsFromUsage(result, totalDurationMs),
    };
  } catch (error) {
    if (abort.signal.aborted && abort.signal.reason instanceof Error) throw abort.signal.reason;
    throw error;
  } finally {
    abort.cleanup();
  }
}

export async function streamRefinement(
  text: string,
  config: AppConfig,
  onEvent: (event: RefinementEvent) => void | Promise<void>,
  refiner: TextRefiner = new LlamaCppRefiner(config),
  externalSignal?: AbortSignal,
): Promise<Extract<RefinementEvent, { type: "done" }>> {
  const abort = createAbortSignal(config.timeoutMs, externalSignal);
  const startedAt = performance.now();

  try {
    let pendingWrite = Promise.resolve();
    let writeError: unknown;

    await onEvent({ type: "start", model: config.model });
    const result = await refiner.generate(text, {
      signal: abort.signal,
      onTextChunk(delta) {
        pendingWrite = pendingWrite
          .then(() => onEvent({ type: "delta", delta }))
          .catch((error: unknown) => {
            writeError ??= error;
            abort.abort(error);
          });
      },
    });
    await pendingWrite;
    if (writeError !== undefined) throw writeError;

    const trimmed = result.text.trim();
    if (!trimmed) throw new Error("The model returned an empty revision.");
    const totalDurationMs = Math.round(performance.now() - startedAt);
    const done = {
      type: "done" as const,
      refined: trimmed,
      model: config.model,
      metrics: metricsFromUsage(result, totalDurationMs),
    };
    await onEvent(done);
    return done;
  } catch (error) {
    if (abort.signal.aborted && abort.signal.reason instanceof Error) throw abort.signal.reason;
    throw error;
  } finally {
    abort.cleanup();
  }
}

async function parseRefinementBody(
  context: AppContext,
  config: AppConfig,
): Promise<{ text: string } | Response> {
  let body: unknown;
  try {
    body = await context.req.json<unknown>();
  } catch {
    return context.json({ error: "Request body must be valid JSON." }, 400);
  }

  if (!isTextRequest(body) || body.text.trim() === "") {
    return context.json(
      { error: "The request must include a non-empty 'text' string." },
      400,
    );
  }

  if (body.text.length > config.maxInputCharacters) {
    return context.json(
      { error: `Text cannot exceed ${config.maxInputCharacters} characters.` },
      413,
    );
  }

  return body;
}

export function createApp(
  overrides: Partial<AppConfig> = {},
  refiner?: TextRefiner,
  logger?: Logger,
): Hono<AppEnvironment> {
  const config: AppConfig = { ...DEFAULTS, ...overrides };
  const appLogger = logger ?? createLogger(config.logLevel);
  const textRefiner = refiner ?? new LlamaCppRefiner(config, appLogger);
  const app = new Hono<AppEnvironment>();

  app.use("*", async (context, next) => {
    const requestId = context.req.header("X-Request-ID")?.trim() || randomUUID();
    const startedAt = performance.now();
    context.set("requestId", requestId);
    context.header("X-Request-ID", requestId);

    try {
      await next();
    } finally {
      context.header("Cache-Control", "no-store");
      context.header("X-Content-Type-Options", "nosniff");
      appLogger.info(
        {
          requestId,
          method: context.req.method,
          path: context.req.path,
          status: context.res.status,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "http.request.completed",
      );
    }
  });

  app.use(
    "*",
    cors({
      origin: (origin) => allowedOrigin(origin) ?? "",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "X-Request-ID"],
      exposeHeaders: ["X-Request-ID"],
      maxAge: 86_400,
    }),
  );

  const limitRequestBody = bodyLimit({
    maxSize: config.maxInputCharacters * 4,
    onError: (context) => context.json({ error: "Request body is too large." }, 413),
  });

  app.get("/health", (context) =>
    context.json({
      status: "ok",
      model: config.model,
    }),
  );

  app.post("/api/refine", limitRequestBody, async (context) => {
    const body = await parseRefinementBody(context, config);
    if (body instanceof Response) return body;

    try {
      return context.json(await refineText(body.text, config, textRefiner));
    } catch (error) {
      appLogger.error(
        {
          requestId: context.get("requestId"),
          path: context.req.path,
          inputCharacters: body.text.length,
          err: error,
        },
        "refinement.request.failed",
      );
      return context.json({ error: errorMessage(error) }, 502);
    }
  });

  app.post("/api/refine/stream", limitRequestBody, async (context) => {
    const body = await parseRefinementBody(context, config);
    if (body instanceof Response) return body;

    context.header("Content-Type", "application/x-ndjson; charset=utf-8");
    return stream(context, async (output) => {
      const clientController = new AbortController();
      output.onAbort(() => clientController.abort());

      try {
        await streamRefinement(
          body.text,
          config,
          async (event) => {
            await output.writeln(JSON.stringify(event));
          },
          textRefiner,
          clientController.signal,
        );
      } catch (error) {
        const logContext = {
          requestId: context.get("requestId"),
          path: context.req.path,
          inputCharacters: body.text.length,
          clientAborted: clientController.signal.aborted,
          err: error,
        };
        if (clientController.signal.aborted) {
          appLogger.warn(logContext, "refinement.stream.aborted");
        } else {
          appLogger.error(logContext, "refinement.stream.failed");
        }
        if (!clientController.signal.aborted) {
          await output.writeln(
            JSON.stringify({ type: "error", error: errorMessage(error) }),
          );
        }
      }
    });
  });

  app.notFound((context) => context.json({ error: "Not found." }, 404));
  app.onError((error, context) => {
    appLogger.error(
      {
        requestId: context.get("requestId"),
        method: context.req.method,
        path: context.req.path,
        err: error,
      },
      "http.request.failed",
    );
    return context.json({ error: errorMessage(error) }, 500);
  });

  return app;
}

export async function startServer(
  config: AppConfig = configFromEnvironment(),
): Promise<ServerType> {
  const logger = createLogger(config.logLevel);
  const refiner = new LlamaCppRefiner(config, logger);
  await refiner.initialize();
  const app = createApp(config, refiner, logger);
  return serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    () => {
      logger.info(
        {
          url: `http://${config.host}:${config.port}`,
          model: config.model,
          contextSize: config.contextSize,
          maxOutputTokens: config.maxOutputTokens,
        },
        "backend.started",
      );
    },
  );
}

function isEntryPoint(): boolean {
  if (process.env.NODE_APP_INSTANCE !== undefined) return true;

  const entryPoint = process.argv[1];
  if (!entryPoint) return false;

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryPoint);
  } catch {
    return import.meta.url === pathToFileURL(entryPoint).href;
  }
}

if (isEntryPoint()) await startServer();
