export interface Settings {
  provider: "local" | "openai";
  openaiModel: string;
}

const DEFAULTS: Settings = { provider: "local", openaiModel: "" };

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

export function saveSettings(settings: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(settings);
}
