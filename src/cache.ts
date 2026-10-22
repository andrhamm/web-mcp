import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function cacheDir(env = process.env, platform = process.platform): string {
  if (env.WEB_MCP_CACHE_DIR) return env.WEB_MCP_CACHE_DIR;
  const base =
    platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : platform === "win32"
        ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "web-mcp");
}

export const HOUR = 3_600_000;

/**
 * Flat-file TTL cache: one `sha256(key).json` per entry holding `{expires, body}`.
 * shortcut: expired files are ignored, never swept; add a sweep if the directory grows past a few thousand files.
 */
export class FileCache {
  constructor(readonly dir = cacheDir()) {}

  private path(key: string) {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async get<T>(key: string, now = Date.now()): Promise<T | undefined> {
    try {
      const { expires, body } = JSON.parse(await readFile(this.path(key), "utf8"));
      return expires > now ? (body as T) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, body: unknown, ttlMs: number, now = Date.now()): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const p = this.path(key);
      const tmp = `${p}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ expires: now + ttlMs, body }));
      await rename(tmp, p);
    } catch (e) {
      console.error(`[web-mcp] cache write failed: ${(e as Error).message}`);
    }
  }
}

/** In-memory TTL map for data that must not touch disk (Brave results: its terms allow transient storage only). */
export class MemoryCache<T> {
  private m = new Map<string, { expires: number; value: T }>();
  constructor(private ttlMs: number) {}
  get(key: string, now = Date.now()): T | undefined {
    const e = this.m.get(key);
    if (e && e.expires > now) return e.value;
    this.m.delete(key);
    return undefined;
  }
  set(key: string, value: T, now = Date.now()) {
    if (this.m.size > 500) this.m.clear(); // bounded; entries live minutes anyway
    this.m.set(key, { expires: now + this.ttlMs, value });
  }
}

export const normKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
