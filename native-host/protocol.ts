import { createHash } from "node:crypto";

export type HostMessage =
  | { type: "ready" }
  | { type: "error"; error: string };

/** Chrome frames each message with a 32-bit length in native byte order, which is little-endian on every platform Chrome ships. */
export function encodeMessage(message: HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** Chrome derives the ID from the SHA-256 of the DER key, hex digits 0-f mapped to a-p. */
export function extensionIdFromKey(base64Key: string): string {
  const hash = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return [...hash.slice(0, 32)]
    .map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)))
    .join("");
}
