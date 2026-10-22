import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SERVER_URL } from "./constants.ts";
import { encodeMessage, type HostMessage } from "./protocol.ts";

const STARTUP_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

const root = resolve(import.meta.dirname, "../..");
const serverEntry = resolve(root, "dist/backend/server.js");
const stateDirectory = resolve(homedir(), ".local-english-refiner");
const logFile = resolve(stateDirectory, "server.log");
const pidFile = resolve(stateDirectory, "server.pid");

// stdout carries the Chrome protocol, so nothing else may write to it.
function send(message: HostMessage): Promise<void> {
  return new Promise((done) => process.stdout.write(encodeMessage(message), () => done()));
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The server binds its port only after the model loads, so the pid file is what stops a second start during that window. */
function startingServerPid(): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    return Number.isInteger(pid) && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function spawnServer(): number {
  mkdirSync(stateDirectory, { recursive: true });
  const log = openSync(logFile, "a");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      IDLE_TIMEOUT_MS: process.env.IDLE_TIMEOUT_MS ?? String(DEFAULT_IDLE_TIMEOUT_MS),
    },
  });
  if (child.pid === undefined) throw new Error(`Could not start ${serverEntry}.`);
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  return child.pid;
}

async function waitForServer(pid: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    if (!isAlive(pid)) {
      throw new Error(`The local server stopped during startup. See ${logFile}.`);
    }
    await delay(500);
  }
  throw new Error(`The local server did not start within ${STARTUP_TIMEOUT_MS / 60_000} minutes.`);
}

async function main(): Promise<void> {
  if (!(await isHealthy())) {
    await waitForServer(startingServerPid() ?? spawnServer());
  }
  await send({ type: "ready" });
}

try {
  await main();
} catch (error) {
  await send({
    type: "error",
    error: error instanceof Error ? error.message : "The local server could not start.",
  });
}
process.exit(0);
