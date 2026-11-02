import { sha256Hex } from './util';

export type VersionReason = 'auto' | 'remote' | 'merge' | 'restore';

export interface Version {
  /** when the text was saved (ms) */
  t: number;
  reason: VersionReason;
  text: string;
}

/** Where history is kept. In Obsidian this is a folder inside the plugin folder. */
export interface HistoryStore {
  read(key: string): Promise<string | null>;
  write(key: string, data: string): Promise<void>;
}

export const REASON_TEXT: Record<VersionReason, string> = {
  auto: 'Saved while you worked',
  remote: 'Before a friend\'s change',
  merge: 'Before two versions were merged',
  restore: 'Before you restored an older version',
};

const AUTO_EVERY_MS = 2 * 60 * 1000;

/**
 * A few earlier versions of each note, kept on this device only. It is a safety net for the
 * moment a friend's change (or your own mistake) is not what you wanted.
 */
export class History {
  private chain = new Map<string, Promise<unknown>>();

  constructor(
    private store: HistoryStore,
    private now: () => number = () => Date.now(),
    private maxVersions = 15,
    private maxChars = 500_000,
  ) {}

  private async key(path: string): Promise<string> {
    return (await sha256Hex(new TextEncoder().encode(path))).slice(0, 20) + '.json';
  }

  private async load(key: string): Promise<{ path: string; versions: Version[] }> {
    const raw = await this.store.read(key);
    if (!raw) return { path: '', versions: [] };
    try {
      return JSON.parse(raw);
    } catch {
      return { path: '', versions: [] }; // a damaged file just starts over
    }
  }

  /** One at a time per note, so two quick saves cannot overwrite each other. */
  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chain.set(key, next);
    return next;
  }

  async record(path: string, text: string, reason: VersionReason): Promise<void> {
    if (text.length > this.maxChars) return;
    const key = await this.key(path);
    await this.exclusive(key, async () => {
      const data = await this.load(key);
      const last = data.versions[0];
      if (last && last.text === text) return;
      const t = this.now();
      if (reason === 'auto' && last && t - last.t < AUTO_EVERY_MS) return;
      data.path = path;
      data.versions.unshift({ t, reason, text });
      data.versions.length = Math.min(data.versions.length, this.maxVersions);
      await this.store.write(key, JSON.stringify(data));
    });
  }

  /** Newest first. */
  async list(path: string): Promise<Version[]> {
    const key = await this.key(path);
    return this.exclusive(key, async () => (await this.load(key)).versions);
  }
}

/** "just now", "5 min ago", "yesterday": short and friendly. */
export function whenText(t: number, now = Date.now()): string {
  const m = Math.round(Math.max(0, now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
