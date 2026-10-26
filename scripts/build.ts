import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await Promise.all([
  mkdir(resolve(output, "backend"), { recursive: true }),
  mkdir(resolve(output, "extension"), { recursive: true }),
  mkdir(resolve(output, "native-host"), { recursive: true }),
]);

await Promise.all([
  build({
    entryPoints: [resolve(root, "backend/server.ts")],
    outfile: resolve(output, "backend/server.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    sourcemap: true,
  }),
  build({
    entryPoints: [resolve(root, "native-host/host.ts")],
    outfile: resolve(output, "native-host/host.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
  }),
  build({
    entryPoints: {
      background: resolve(root, "extension/background.ts"),
      content: resolve(root, "extension/content.ts"),
      options: resolve(root, "extension/options.ts"),
    },
    outdir: resolve(output, "extension"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    sourcemap: true,
  }),
]);

await copyFile(
  resolve(root, "extension/manifest.json"),
  resolve(output, "extension/manifest.json"),
);

await copyFile(
  resolve(root, "extension/options.html"),
  resolve(output, "extension/options.html"),
);

console.log("Built backend, native host, and Chrome extension in dist/.");
