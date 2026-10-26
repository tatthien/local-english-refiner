import {
  systemPromptFor,
  userPromptFor,
  type GenerationOptions,
  type GenerationResult,
  type TextRefiner,
} from "./llama-refiner.ts";
import type { OpenAIAuth } from "./openai-auth.ts";

/** Backend of the ChatGPT plan. It is undocumented and can change without notice. */
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** The list depends on this value: Codex versions below 1.0.0 get no current models. */
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";

export interface OpenAIModel {
  id: string;
  name: string;
}

export async function listOpenAIModels(
  auth: OpenAIAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAIModel[]> {
  const { accessToken, accountId } = await auth.credentials();
  const response = await fetchImpl(MODELS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      originator: "codex_cli_rs",
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`Could not list OpenAI models (${response.status}).`);
  const { models } = (await response.json()) as {
    models?: Array<{ slug: string; display_name?: string; visibility?: string }>;
  };
  return (models ?? [])
    .filter((model) => model.visibility === "list")
    .map((model) => ({ id: model.slug, name: model.display_name || model.slug }));
}

interface SseEvent {
  type?: string;
  delta?: string;
  message?: string;
  response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
}

export class OpenAIRefiner implements TextRefiner {
  constructor(
    private readonly auth: OpenAIAuth,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(text: string, options: GenerationOptions): Promise<GenerationResult> {
    const { accessToken, accountId } = await this.auth.credentials();
    const response = await this.fetchImpl(RESPONSES_URL, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: this.model,
        instructions: systemPromptFor(options.style),
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userPromptFor(text) }] }],
        stream: true,
        store: false,
      }),
    });
    if (!response.ok || !response.body) {
      const detail = response.ok ? "" : (await response.text()).slice(0, 300);
      throw new Error(`OpenAI request failed (${response.status}). ${detail}`.trim());
    }

    let output = "";
    let promptTokens = 0;
    let outputTokens = 0;
    let completed = false;

    const handle = (data: string): void => {
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data) as SseEvent;
      if (event.type === "response.output_text.delta" && event.delta) {
        output += event.delta;
        options.onTextChunk?.(event.delta);
      } else if (event.type === "response.completed") {
        completed = true;
        promptTokens = event.response?.usage?.input_tokens ?? 0;
        outputTokens = event.response?.usage?.output_tokens ?? 0;
      } else if (event.type === "response.failed" || event.type === "error") {
        throw new Error(event.response?.error?.message ?? event.message ?? "OpenAI returned an error.");
      }
    };

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) handle(dataOf(block));
    }
    if (buffer.trim()) handle(dataOf(buffer));
    if (!completed) throw new Error("The OpenAI stream ended before completion.");
    return { text: output, promptTokens, outputTokens };
  }
}

function dataOf(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
}
