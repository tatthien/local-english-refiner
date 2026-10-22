import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { NATIVE_HOST_NAME } from "../native-host/constants.ts";
import { extensionIdFromKey } from "../native-host/protocol.ts";

const root = resolve(import.meta.dirname, "..");
const hostEntry = resolve(root, "dist/native-host/host.js");

const hostDirectories: Partial<Record<NodeJS.Platform, string>> = {
  darwin: resolve(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
  linux: resolve(homedir(), ".config/google-chrome/NativeMessagingHosts"),
};

const directory = hostDirectories[process.platform];
if (!directory) throw new Error(`Native host installation is not supported on ${process.platform}.`);

const manifestPath = resolve(directory, `${NATIVE_HOST_NAME}.json`);
const wrapperPath = resolve(directory, `${NATIVE_HOST_NAME}.sh`);

if (process.argv.includes("--uninstall")) {
  await Promise.all([rm(manifestPath, { force: true }), rm(wrapperPath, { force: true })]);
  console.log(`Removed the native host from ${directory}.`);
  process.exit(0);
}

if (!existsSync(hostEntry)) throw new Error("Run `npm run build` before `npm run install-host`.");

const extensionManifest = JSON.parse(
  await readFile(resolve(root, "extension/manifest.json"), "utf8"),
) as { key?: string };
if (!extensionManifest.key) throw new Error("extension/manifest.json has no `key`.");
const extensionId = extensionIdFromKey(extensionManifest.key);

// Chrome starts the host with a minimal environment, so the wrapper pins Node and the idle timeout.
const node = realpathSync(process.execPath);
const idleTimeout = process.env.IDLE_TIMEOUT_MS;
if (idleTimeout !== undefined && !/^\d+$/.test(idleTimeout)) {
  throw new Error("IDLE_TIMEOUT_MS must be a whole number of milliseconds.");
}
await mkdir(directory, { recursive: true });
await writeFile(
  wrapperPath,
  [
    "#!/bin/sh",
    ...(idleTimeout === undefined ? [] : [`export IDLE_TIMEOUT_MS=${idleTimeout}`]),
    `exec ${JSON.stringify(node)} ${JSON.stringify(hostEntry)} "$@"`,
    "",
  ].join("\n"),
);
await chmod(wrapperPath, 0o755);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "Starts the Local English Refiner backend on demand.",
      path: wrapperPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`,
);

console.log(`Installed the native host for extension ${extensionId}.`);
console.log(`Node: ${node}`);
console.log(`Manifest: ${manifestPath}`);
