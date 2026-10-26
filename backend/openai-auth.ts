import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { defaultCredentialStore, type CredentialStore, type StoredTokens } from "./credentials.ts";

/** Public client ID of the Codex CLI. OpenAI offers no OAuth client for third-party apps. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
/** The redirect URI of this client ID is fixed to this port. */
export const CALLBACK_PORT = 1455;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

export interface OpenAIStatus {
  connected: boolean;
  pending: boolean;
  email?: string;
  storage: CredentialStore["kind"];
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function accountIdFrom(...tokens: Array<string | undefined>): string | undefined {
  for (const token of tokens) {
    if (!token) continue;
    const auth = jwtClaims(token)["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
  }
  return undefined;
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Local English Refiner</title><body style="font:16px system-ui;margin:3rem"><p>${message}</p>`;
}

export class OpenAIAuth {
  #pendingLogin: { server: Server; timer: NodeJS.Timeout } | undefined;
  #refreshing: Promise<StoredTokens> | undefined;

  constructor(
    private readonly store: CredentialStore = defaultCredentialStore(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async status(): Promise<OpenAIStatus> {
    const tokens = await this.store.read();
    return {
      connected: tokens !== null,
      pending: this.#pendingLogin !== undefined,
      email: tokens?.email,
      storage: this.store.kind,
    };
  }

  async logout(): Promise<void> {
    this.#cancelLogin();
    await this.store.clear();
  }

  /** Starts the callback listener and returns the URL the user must open. */
  async startLogin(): Promise<string> {
    this.#cancelLogin();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/auth/callback`;

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const failure =
        url.searchParams.get("state") !== state || !code
          ? "The sign-in response was not valid."
          : null;
      const finish = (html: string, status = 200) => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        this.#cancelLogin();
      };
      if (failure || !code) {
        finish(page(failure ?? ""), 400);
        return;
      }
      this.#exchange(code, verifier, redirectUri).then(
        () => finish(page("Connected. You can close this tab.")),
        (error: unknown) =>
          finish(page(error instanceof Error ? error.message : "Sign-in failed."), 502),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "EADDRINUSE"
            ? new Error(`Port ${CALLBACK_PORT} is in use. Close the Codex CLI login and try again.`)
            : error,
        ),
      );
      server.listen(CALLBACK_PORT, "127.0.0.1", resolve);
    });
    const timer = setTimeout(() => this.#cancelLogin(), LOGIN_TIMEOUT_MS);
    this.#pendingLogin = { server, timer };

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "codex_cli_rs",
    });
    return `${ISSUER}/oauth/authorize?${params}`;
  }

  /** Returns a valid access token and refreshes it shortly before it expires. */
  async credentials(): Promise<{ accessToken: string; accountId: string }> {
    let tokens = await this.store.read();
    if (!tokens) throw new Error("OpenAI is not connected. Open the extension settings.");
    if (tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      this.#refreshing ??= this.#refresh(tokens).finally(() => {
        this.#refreshing = undefined;
      });
      tokens = await this.#refreshing;
    }
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  #cancelLogin(): void {
    if (!this.#pendingLogin) return;
    clearTimeout(this.#pendingLogin.timer);
    this.#pendingLogin.server.close();
    this.#pendingLogin.server.closeAllConnections();
    this.#pendingLogin = undefined;
  }

  async #token(body: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchImpl(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
    });
    if (!response.ok) throw new Error(`OpenAI sign-in failed (${response.status}).`);
    return (await response.json()) as TokenResponse;
  }

  async #exchange(code: string, verifier: string, redirectUri: string): Promise<StoredTokens> {
    const token = await this.#token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    return this.#save(token, undefined);
  }

  async #refresh(current: StoredTokens): Promise<StoredTokens> {
    const token = await this.#token({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      scope: "openid profile email",
    });
    return this.#save(token, current);
  }

  async #save(token: TokenResponse, previous: StoredTokens | undefined): Promise<StoredTokens> {
    const email = jwtClaims(token.id_token ?? "").email;
    const accountId = accountIdFrom(token.id_token, token.access_token) ?? previous?.accountId;
    if (!accountId) throw new Error("The ChatGPT account ID is missing from the sign-in response.");
    const tokens: StoredTokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || previous?.refreshToken || "",
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      accountId,
      email: typeof email === "string" ? email : previous?.email,
    };
    await this.store.write(tokens);
    return tokens;
  }
}
