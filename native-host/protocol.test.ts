import assert from "node:assert/strict";
import test from "node:test";

import { encodeMessage, extensionIdFromKey } from "./protocol.ts";

test("messages carry a little-endian length before the JSON body", () => {
  const encoded = encodeMessage({ type: "ready" });
  const body = '{"type":"ready"}';

  assert.equal(encoded.readUInt32LE(0), body.length);
  assert.equal(encoded.subarray(4).toString("utf8"), body);
});

test("extension IDs use 32 characters from a to p", () => {
  const id = extensionIdFromKey(Buffer.from("public key").toString("base64"));

  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, extensionIdFromKey(Buffer.from("public key").toString("base64")));
});
