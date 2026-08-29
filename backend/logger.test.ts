import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, parseLogLevel } from "./logger.ts";

interface PinoRecord {
  level: number;
  event: string;
  err?: { type: string; message: string; stack: string };
}

function captureLogs(level: "debug" | "info" | "warn" | "error") {
  const records: PinoRecord[] = [];
  const logger = createLogger(level, {
    write(line: string) {
      records.push(JSON.parse(line) as PinoRecord);
    },
  });
  return { logger, records };
}

test("logger filters records below the configured level", () => {
  const { logger, records } = captureLogs("warn");

  logger.debug("debug.event");
  logger.info("info.event");
  logger.warn("warn.event");
  logger.error("error.event");

  assert.deepEqual(
    records.map((record) => record.event),
    ["warn.event", "error.event"],
  );
});

test("logger serializes errors with debugging details", () => {
  const { logger, records } = captureLogs("info");

  logger.error({ err: new TypeError("Invalid value") }, "operation.failed");

  assert.equal(records[0]?.level, 50);
  assert.equal(records[0]?.err?.type, "TypeError");
  assert.equal(records[0]?.err?.message, "Invalid value");
  assert.match(records[0]?.err?.stack ?? "", /TypeError: Invalid value/);
});

test("log level parsing is case-insensitive and rejects unsupported values", () => {
  assert.equal(parseLogLevel(" DEBUG "), "debug");
  assert.equal(parseLogLevel("verbose"), "info");
  assert.equal(parseLogLevel(undefined), "info");
});
