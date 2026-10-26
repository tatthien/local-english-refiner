import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  email?: string;
}

export interface CredentialStore {
  readonly kind: "keychain" | "file";
  read(): Promise<StoredTokens | null>;
  write(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

const SERVICE = "local-english-refiner";
const ACCOUNT = "openai-chatgpt";

/** `security` exits 44 when the item does not exist. */
export class KeychainStore implements CredentialStore {
  readonly kind = "keychain";

  async read(): Promise<StoredTokens | null> {
    try {
      const { stdout } = await run("security", [
        "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w",
      ]);
      return JSON.parse(stdout.trim()) as StoredTokens;
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null;
      throw error;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    await run("security", [
      "add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", JSON.stringify(tokens),
    ]);
  }

  async clear(): Promise<void> {
    try {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    } catch (error) {
      if ((error as { code?: number }).code !== 44) throw error;
    }
  }
}

/** Fallback for systems without the macOS keychain: a file readable only by the user. */
export class FileStore implements CredentialStore {
  readonly kind = "file";

  constructor(
    private readonly path = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      SERVICE,
      "openai.json",
    ),
  ) {}

  async read(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as StoredTokens;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(tokens), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export function defaultCredentialStore(): CredentialStore {
  return process.platform === "darwin" ? new KeychainStore() : new FileStore();
}
