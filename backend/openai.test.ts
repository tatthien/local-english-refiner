import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileStore, type StoredTokens } from "./credentials.ts";
import { OpenAIAuth } from "./openai-auth.ts";
import { OpenAIRefiner } from "./openai-refiner.ts";

const tokens: StoredTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3_600_000,
  accountId: "acct_1",
};

async function tempStore(): Promise<FileStore> {
  return new FileStore(join(await mkdtemp(join(tmpdir(), "refiner-")), "nested", "openai.json"));
}

test("file store round-trips tokens with owner-only permissions", async () => {
  const store = await tempStore();
  assert.equal(await store.read(), null);
  await store.write(tokens);
  assert.deepEqual(await store.read(), tokens);
  const mode = (await stat(join((store as unknown as { path: string }).path))).mode & 0o777;
  assert.equal(mode, 0o600);
  await store.clear();
  assert.equal(await store.read(), null);
});

test("credentials refreshes an expiring token once for parallel callers", async () => {
  const store = await tempStore();
  await store.write({ ...tokens, expiresAt: Date.now() + 1_000 });
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_2" } }),
  ).toString("base64url");
  let calls = 0;
  const auth = new OpenAIAuth(store, (async (_url: unknown, init: RequestInit) => {
    calls += 1;
    assert.match(String(init.body), /grant_type=refresh_token/);
    return Response.json({ access_token: `h.${claims}.s`, refresh_token: "r2", expires_in: 3600 });
  }) as typeof fetch);

  const [a, b] = await Promise.all([auth.credentials(), auth.credentials()]);
  assert.equal(calls, 1);
  assert.equal(a.accountId, "acct_2");
  assert.equal(b.accessToken, a.accessToken);
  assert.equal((await store.read())?.refreshToken, "r2");
});

test("refiner streams deltas from the SSE response and reports usage", async () => {
  const store = await tempStore();
  await store.write(tokens);
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    'data: {"type":"response.output_text.delta","delta":" there"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
  ].join("\n\n") + "\n\n";
  let headers: Headers | undefined;
  const refiner = new OpenAIRefiner(new OpenAIAuth(store), "gpt-5", (async (_url: unknown, init: RequestInit) => {
    headers = new Headers(init.headers);
    return new Response(sse);
  }) as typeof fetch);

  const chunks: string[] = [];
  const result = await refiner.generate("hi", {
    signal: new AbortController().signal,
    onTextChunk: (chunk) => chunks.push(chunk),
  });
  assert.deepEqual(chunks, ["Hello", " there"]);
  assert.deepEqual(result, { text: "Hello there", promptTokens: 5, outputTokens: 2 });
  assert.equal(headers?.get("chatgpt-account-id"), "acct_1");
});

test("refiner fails when the stream ends without completion", async () => {
  const store = await tempStore();
  await store.write(tokens);
  const refiner = new OpenAIRefiner(new OpenAIAuth(store), "gpt-5", (async () =>
    new Response('data: {"type":"response.output_text.delta","delta":"x"}\n\n')) as typeof fetch);
  await assert.rejects(refiner.generate("hi", { signal: new AbortController().signal }), /before completion/);
});
