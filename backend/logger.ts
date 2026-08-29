import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type { Logger } from "pino";

const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized && LOG_LEVELS.has(normalized) ? (normalized as LogLevel) : "info";
}

export function createLogger(
  level: LogLevel = "info",
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: "local-english-refiner" },
    messageKey: "event",
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  return destination ? pino(options, destination) : pino(options);
}
