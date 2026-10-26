import { SERVER_URL } from "../native-host/constants.ts";
import { loadSettings, saveSettings } from "./settings.ts";

interface AuthStatus {
  connected: boolean;
  pending: boolean;
  email?: string;
  storage: "keychain" | "file";
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const provider = $<HTMLSelectElement>("provider");
const model = $<HTMLSelectElement>("model");
const status = $("status");
const dot = $("dot");
const storage = $("storage");
const error = $("error");
const connect = $<HTMLButtonElement>("connect");
const disconnect = $<HTMLButtonElement>("disconnect");

/** Same mark as the refiner popup, without the animation. */
function drawMark(): void {
  const lobes = 8;
  const steps = lobes * 12;
  const points = Array.from({ length: steps }, (_, index) => {
    const angle = (index / steps) * 2 * Math.PI;
    const distance = 14.4 + 0.9 * Math.cos(lobes * angle);
    return `${(16 + distance * Math.cos(angle)).toFixed(2)} ${(16 + distance * Math.sin(angle)).toFixed(2)}`;
  });
  const eyes = [{ cx: 11.3, cy: 13.8 }, { cx: 18.7, cy: 14.2 }]
    .map(({ cx, cy }) => `<rect x="${cx - 2.5}" y="${cy - 3.9}" width="5" height="7.8" rx="2.2" fill="#fff"/><circle cx="${cx + 1.1}" cy="${cy + 0.6}" r="1.5" fill="#111"/>`)
    .join("");
  $("mark").innerHTML = `<path d="M${points.join("L")}Z" fill="#EE6A2B"/>${eyes}`;
}
drawMark();

function startServer(): Promise<void> {
  return chrome.runtime.sendMessage({ type: "ensure-server" }).then((reply: { ok: boolean; error?: string }) => {
    if (!reply.ok) throw new Error(reply.error);
  });
}

async function call<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, { method });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

function render(auth: AuthStatus): void {
  status.textContent = auth.connected
    ? `Connected${auth.email ? ` as ${auth.email}` : ""}`
    : auth.pending
      ? "Waiting for sign-in in the other tab…"
      : "Not connected";
  dot.className = `dot${auth.connected ? " connected" : auth.pending ? " pending" : ""}`;
  connect.hidden = auth.connected;
  connect.disabled = auth.pending;
  disconnect.hidden = !auth.connected;
  storage.textContent = auth.connected
    ? `Tokens are stored in ${auth.storage === "keychain" ? "the macOS keychain" : "a file readable only by you"}.`
    : "";
}

async function loadModels(): Promise<void> {
  const { models } = await call<{ models: Array<{ id: string; name: string }> }>("/api/auth/openai/models");
  const saved = (await loadSettings()).openaiModel;
  model.replaceChildren(
    ...models.map(({ id, name }) => new Option(`${name} (${id})`, id, false, id === saved)),
  );
  model.disabled = models.length === 0;
  if (models.length > 0) await saveSettings({ openaiModel: model.value });
}

function clearModels(): void {
  model.replaceChildren(new Option("Connect an account to list models", ""));
  model.disabled = true;
}

async function refresh(): Promise<AuthStatus> {
  const auth = await call<AuthStatus>("/api/auth/openai");
  render(auth);
  if (auth.connected && model.disabled) await loadModels();
  if (!auth.connected) clearModels();
  return auth;
}

async function guarded(action: () => Promise<void>): Promise<void> {
  error.textContent = "";
  try {
    await action();
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Something went wrong.";
  }
}

async function waitForSignIn(): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const auth = await refresh();
    if (!auth.pending) return;
  }
}

connect.addEventListener("click", () =>
  guarded(async () => {
    await startServer();
    const { url } = await call<{ url: string }>("/api/auth/openai/login", "POST");
    window.open(url, "_blank");
    render({ connected: false, pending: true, storage: "keychain" });
    await waitForSignIn();
  }),
);

disconnect.addEventListener("click", () =>
  guarded(async () => {
    await call("/api/auth/openai/logout", "POST");
    await refresh();
  }),
);

function showModelField(): void {
  $("model-field").hidden = provider.value !== "openai";
}

provider.addEventListener("change", () => {
  showModelField();
  return saveSettings({ provider: provider.value as "local" | "openai" });
});
model.addEventListener("change", () => saveSettings({ openaiModel: model.value }));

void (async () => {
  const settings = await loadSettings();
  provider.value = settings.provider;
  showModelField();
  await guarded(async () => {
    await startServer();
    await refresh();
  });
})();
