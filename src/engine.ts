import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { isRemoteOrigin } from './provider';
import {
  applyTextDiff,
  conflictCandidate,
  isExcludedPath,
  isTextPath,
  merge3,
  normalizeEol,
  sha256Hex,
  toArrayBuffer,
} from './util';

/** What the engine needs from the app it runs in (Obsidian, or a fake in tests). */
export interface VaultAdapter {
  list(): Promise<{ path: string; size: number }[]>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number | null>;
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeText(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  trash(path: string): Promise<void>;
}

export interface Persist {
  load(): Promise<Uint8Array | null>;
  save(data: Uint8Array): Promise<void>;
}

export interface EngineNet {
  peers(): string[];
  sendWant(peer: string, hash: string): void;
  sendBlob(peer: string, hash: string, data: Uint8Array): void;
}

export interface EngineMeta {
  known?: Record<string, { h: string; s: number }>;
  /** text files with local edits that no other device has confirmed yet */
  dirty?: string[];
}

export interface EngineOptions {
  vault: VaultAdapter;
  persist: Persist;
  deviceName: string;
  configDir: string;
  excluded: string[];
  syncAttachments: boolean;
  maxAttachmentBytes: number;
  /** wait before applying remote changes to disk (ms) */
  debounceMs?: number;
  /** how long a brand new device waits for other devices before it shares its own files */
  freshGraceMs?: number;
  /** same, for a device that has synced before */
  knownGraceMs?: number;
  /** extra wait after the first device answered, so its updates have arrived */
  syncSettleMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  notify?: (msg: string) => void;
  now?: () => Date;
}

interface BinEntry {
  h: string;
  s: number;
}

type Timer = ReturnType<typeof setTimeout>;
const timer = (fn: () => void, ms: number): Timer => {
  const t = setTimeout(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
};

/** Origin for changes that come from files on this device. */
export const LOCAL = Object.freeze({ local: true });

export class SyncEngine {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly files: Y.Map<Y.Text>;
  readonly bins: Y.Map<BinEntry>;

  onMetaChange: (() => void) | null = null;

  private net: EngineNet | null = null;
  private ready = false;
  private started = false;
  private stopped = false;
  /** Set once stop() has drained the queue; no work may run after this. */
  private closed = false;
  private freshDoc = false;

  private base = new Map<string, string>();
  private known = new Map<string, BinEntry>();
  private dirty = new Set<string>();
  private deletedWhileDirty = new Set<string>();
  private hashCache = new Map<string, string>();
  private bound = new Set<string>();
  private replaced = new Set<string>();
  private expectDelete = new Set<string>();
  private timers = new Map<string, Timer>();
  private chain = new Map<string, Promise<void>>();
  private wanted = new Map<string, { tried: Set<string>; timer?: Timer }>();
  private persistTimer: Timer | null = null;
  private graceTimer: Timer | null = null;
  private seedTimer: Timer | null = null;

  constructor(private opts: EngineOptions) {
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.files = this.doc.getMap<Y.Text>('files');
    this.bins = this.doc.getMap<BinEntry>('bins');
  }

  // ---------------------------------------------------------------- setup

  setNet(net: EngineNet | null): void {
    this.net = net;
  }

  importMeta(meta?: EngineMeta | null): void {
    this.known.clear();
    for (const [p, v] of Object.entries(meta?.known ?? {})) this.known.set(p, v);
    this.dirty = new Set(meta?.dirty ?? []);
  }

  exportMeta(): EngineMeta {
    return { known: Object.fromEntries(this.known), dirty: [...this.dirty] };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const state = await this.opts.persist.load();
    this.freshDoc = !state;
    if (state) Y.applyUpdate(this.doc, state, 'load');
    for (const [p, t] of this.files) this.base.set(p, t.toString());

    this.doc.on('update', this.schedulePersist);
    this.files.observeDeep(this.onFilesChange);
    this.bins.observe(this.onBinsChange);

    await this.scanAll();

    const grace = this.freshDoc ? (this.opts.freshGraceMs ?? 20000) : (this.opts.knownGraceMs ?? 4000);
    this.graceTimer = timer(() => void this.finishSeeding(), grace);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.wanted.values()) if (w.timer) clearTimeout(w.timer);
    this.wanted.clear();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.seedTimer) clearTimeout(this.seedTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.idle();
    if (this.started) await this.flushPersist();
    this.doc.off('update', this.schedulePersist);
    this.files.unobserveDeep(this.onFilesChange);
    this.bins.unobserve(this.onBinsChange);
    this.awareness.destroy();
    this.closed = true;
  }

  /** The provider tells us another device has answered. */
  notifySynced(): void {
    if (this.dirty.size) {
      this.dirty.clear();
      this.metaChanged();
    }
    if (this.ready || this.seedTimer) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.seedTimer = timer(() => void this.finishSeeding(), this.opts.syncSettleMs ?? 1500);
  }

  onPeersChanged(): void {
    for (const h of this.wanted.keys()) this.askNextPeer(h);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Resolves when no work is queued. Used on shutdown and in tests. */
  async idle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (this.timers.size === 0 && this.chain.size === 0) return;
      await new Promise((r) => timer(() => r(null), (this.opts.debounceMs ?? 250) + 5));
    }
  }

  // ---------------------------------------------------------------- editor API

  shouldSync(path: string): boolean {
    if (isExcludedPath(path, this.opts.configDir, this.opts.excluded)) return false;
    return isTextPath(path) || this.opts.syncAttachments;
  }

  hasText(path: string): boolean {
    return this.files.has(path);
  }

  getText(path: string): Y.Text | null {
    return this.files.get(path) ?? null;
  }

  /** While a file is open in a live editor, the editor is the source of truth. */
  setBound(path: string, bound: boolean): void {
    if (bound) this.bound.add(path);
    else {
      this.bound.delete(path);
      void this.reconcileNow(path);
    }
  }

  reconcileNow(path: string): Promise<void> {
    return this.queue(path, () => this.reconcileText(path));
  }

  /** Check every file again (command "Check all files now"). */
  rescan(): Promise<void> {
    return this.scanAll();
  }

  status(): { ready: boolean; files: number; pending: number } {
    return { ready: this.ready, files: this.files.size + this.bins.size, pending: this.timers.size + this.chain.size };
  }

  // ---------------------------------------------------------------- vault events

  onVaultCreate(path: string): void {
    if (!this.started || this.stopped || !this.ready || !this.shouldSync(path)) return;
    if (isTextPath(path)) {
      void this.queue(path, () => (this.files.has(path) ? this.reconcileText(path) : this.seedText(path)));
    } else {
      void this.queue(path, () => this.reconcileBinary(path));
    }
  }

  onVaultModify(path: string): void {
    if (!this.started || this.stopped || !this.shouldSync(path)) return;
    if (isTextPath(path)) {
      void this.queue(path, async () => {
        if (!this.files.has(path)) {
          if (this.ready) await this.seedText(path);
          return;
        }
        if (this.bound.has(path)) {
          const d = await this.readText(path);
          if (d !== null) this.base.set(path, d);
          this.markPushed(path);
          return;
        }
        await this.reconcileText(path);
      });
    } else {
      this.hashCache.delete(path);
      if (this.ready) void this.queue(path, () => this.reconcileBinary(path));
    }
  }

  onVaultDelete(path: string): void {
    if (!this.started || this.stopped) return;
    if (this.expectDelete.delete(path)) return;
    this.base.delete(path);
    this.hashCache.delete(path);
    this.known.delete(path);
    this.metaChanged();
    if (this.files.has(path) || this.bins.has(path)) {
      this.doc.transact(() => {
        this.files.delete(path);
        this.bins.delete(path);
      }, LOCAL);
    }
  }

  onVaultRename(newPath: string, oldPath: string): void {
    if (!this.started || this.stopped) return;
    this.onVaultDelete(oldPath);
    this.onVaultCreate(newPath);
  }

  // ---------------------------------------------------------------- blobs (attachments)

  async handleWant(hash: string, from: string): Promise<void> {
    if (!this.net) return;
    for (const [path, e] of this.bins) {
      if (e.h !== hash) continue;
      const h = await this.hashOf(path);
      if (h !== hash) continue;
      const data = await this.vault.readBinary(path);
      if (data) {
        this.net.sendBlob(from, hash, new Uint8Array(data));
        return;
      }
    }
  }

  async receiveBlob(hash: string, data: Uint8Array): Promise<void> {
    if ((await sha256Hex(data)) !== hash) {
      this.log('warn', 'received a file with the wrong checksum, ignoring it');
      return;
    }
    const w = this.wanted.get(hash);
    if (w?.timer) clearTimeout(w.timer);
    this.wanted.delete(hash);
    const buf = toArrayBuffer(data);
    for (const [path, e] of [...this.bins]) {
      if (e.h !== hash) continue;
      await this.queue(path, async () => {
        if ((await this.hashOf(path)) === hash) {
          this.known.set(path, { h: hash, s: data.length });
          return;
        }
        await this.vault.writeBinary(path, buf);
        this.hashCache.set(path, hash);
        this.known.set(path, { h: hash, s: data.length });
        this.metaChanged();
      });
    }
  }

  private requestBlob(hash: string): void {
    if (this.wanted.has(hash)) return;
    this.wanted.set(hash, { tried: new Set() });
    this.askNextPeer(hash);
  }

  private askNextPeer(hash: string): void {
    const w = this.wanted.get(hash);
    if (!w || !this.net || this.stopped) return;
    if (w.timer) clearTimeout(w.timer);
    const peers = this.net.peers().filter((p) => !w.tried.has(p));
    if (peers.length === 0) {
      w.tried.clear(); // try everyone again the next time someone joins
      return;
    }
    const peer = peers[0];
    w.tried.add(peer);
    this.net.sendWant(peer, hash);
    w.timer = timer(() => this.askNextPeer(hash), 15000);
  }

  // ---------------------------------------------------------------- scan

  private async finishSeeding(): Promise<void> {
    if (this.ready || this.stopped) return;
    this.ready = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.seedTimer) clearTimeout(this.seedTimer);
    this.log('info', 'ready: sharing new local files now');
    await this.scanAll();
  }

  private async scanAll(): Promise<void> {
    const list = await this.vault.list();
    const seen = new Set<string>();
    for (const f of list) {
      if (this.stopped) return;
      if (!this.shouldSync(f.path)) continue;
      seen.add(f.path);
      if (isTextPath(f.path)) {
        if (this.files.has(f.path)) await this.queue(f.path, () => this.reconcileText(f.path));
        else if (this.ready) await this.queue(f.path, () => this.seedText(f.path));
      } else {
        if (f.size > this.opts.maxAttachmentBytes) continue;
        if (this.bins.has(f.path) || this.ready) {
          await this.queue(f.path, () => this.reconcileBinary(f.path, f.size));
        }
      }
    }
    for (const key of [...this.files.keys()]) {
      if (!seen.has(key) && this.shouldSync(key)) await this.queue(key, () => this.reconcileText(key));
    }
    if (this.opts.syncAttachments) {
      for (const key of [...this.bins.keys()]) {
        if (!seen.has(key) && this.shouldSync(key)) await this.queue(key, () => this.reconcileBinary(key));
      }
    }
  }

  // ---------------------------------------------------------------- text

  private async seedText(path: string): Promise<void> {
    if (this.files.has(path)) return this.reconcileText(path);
    const d = await this.readText(path);
    if (d === null) return;
    this.doc.transact(() => this.files.set(path, new Y.Text(d)), LOCAL);
    this.base.set(path, d);
  }

  /** Make disk and shared text agree, without ever dropping someone's edit. */
  private async reconcileText(path: string): Promise<void> {
    if (!this.shouldSync(path)) return;
    const ytext = this.files.get(path);
    if (!ytext) return this.handleRemoteDelete(path);
    if (this.bound.has(path)) return; // the live editor handles this file

    const T = ytext.toString();
    const D = await this.readText(path); // null when the file does not exist here
    const B = this.base.get(path);

    if (this.replaced.delete(path)) {
      // two devices created the same file at the same time; the other one won.
      if (D !== null && D !== T) await this.conflictCopy(path, D);
      if (D !== T) await this.vault.writeText(path, T);
      this.base.set(path, T);
      return;
    }
    if (D === null) {
      await this.vault.writeText(path, T);
      this.base.set(path, T);
      return;
    }
    if (D === T) {
      this.base.set(path, D);
      return;
    }
    if (B === undefined) {
      // a file that was already here collides with one from the room: keep both
      await this.conflictCopy(path, D);
      await this.vault.writeText(path, T);
      this.base.set(path, T);
      return;
    }
    if (D === B) {
      // only the room changed it
      await this.vault.writeText(path, T);
      this.base.set(path, T);
      return;
    }
    if (T === B) {
      // only this device changed it
      applyTextDiff(ytext, D, LOCAL);
      this.base.set(path, D);
      this.markPushed(path);
      return;
    }
    // both changed
    const m = merge3(B, D, T);
    if (!m.ok) await this.conflictCopy(path, D);
    applyTextDiff(ytext, m.text, LOCAL);
    if (m.text !== D) await this.vault.writeText(path, m.text);
    this.base.set(path, m.text);
    this.markPushed(path);
  }

  private async handleRemoteDelete(path: string): Promise<void> {
    if (!this.base.has(path)) return; // we never had it
    const D = await this.readText(path);
    if (D === null) {
      this.base.delete(path);
      return;
    }
    const unconfirmed = this.deletedWhileDirty.delete(path);
    if ((unconfirmed || D !== this.base.get(path)) && !this.bound.has(path)) {
      // someone deleted it, but this device has newer edits: keep them and share again
      this.doc.transact(() => this.files.set(path, new Y.Text(D)), LOCAL);
      this.base.set(path, D);
      return;
    }
    this.expectDelete.add(path);
    timer(() => this.expectDelete.delete(path), 5000);
    this.base.delete(path);
    await this.vault.trash(path);
  }

  // ---------------------------------------------------------------- attachments

  private async reconcileBinary(path: string, knownSize?: number): Promise<void> {
    if (!this.opts.syncAttachments || !this.shouldSync(path)) return;
    const entry = this.bins.get(path);
    const size = knownSize ?? (await this.vault.size(path));

    if (size !== null && size > this.opts.maxAttachmentBytes) {
      this.log('info', `skipping ${path}: bigger than the attachment limit`);
      return;
    }
    // quick path at startup: same size and same checksum as last time
    const k = this.known.get(path);
    if (!this.ready && entry && k && k.h === entry.h && k.s === size && !this.hashCache.has(path)) return;

    const h = size === null ? null : await this.hashOf(path);

    if (!entry) {
      if (h === null) return;
      if (this.known.has(path)) {
        if (this.known.get(path)!.h === h) {
          // deleted on another device
          this.expectDelete.add(path);
          timer(() => this.expectDelete.delete(path), 5000);
          this.known.delete(path);
          this.hashCache.delete(path);
          this.metaChanged();
          await this.vault.trash(path);
          return;
        }
        // deleted elsewhere but changed here: share it again
        this.doc.transact(() => this.bins.set(path, { h, s: size ?? 0 }), LOCAL);
        this.known.set(path, { h, s: size ?? 0 });
        this.metaChanged();
        return;
      }
      if (this.ready) {
        this.doc.transact(() => this.bins.set(path, { h, s: size ?? 0 }), LOCAL);
        this.known.set(path, { h, s: size ?? 0 });
        this.metaChanged();
      }
      return;
    }

    if (h === entry.h) {
      this.known.set(path, entry);
      this.metaChanged();
      return;
    }
    if (h === null) {
      this.requestBlob(entry.h);
      return;
    }
    const last = this.known.get(path);
    if (last?.h === h) {
      this.requestBlob(entry.h); // only the room changed it
      return;
    }
    if (last?.h === entry.h) {
      this.doc.transact(() => this.bins.set(path, { h, s: size ?? 0 }), LOCAL); // only we changed it
      this.known.set(path, { h, s: size ?? 0 });
      this.metaChanged();
      return;
    }
    const mine = await this.vault.readBinary(path);
    if (mine) await this.conflictCopy(path, mine);
    this.requestBlob(entry.h);
  }

  // ---------------------------------------------------------------- remote changes

  private onFilesChange = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) => {
    if (!isRemoteOrigin(txn.origin)) return;
    const touched = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.files) {
        for (const [key, change] of (ev as Y.YMapEvent<Y.Text>).keys) {
          touched.add(key);
          if (change.action === 'update') this.replaced.add(key);
          if (change.action === 'delete' && this.dirty.has(key)) this.deletedWhileDirty.add(key);
        }
      } else {
        const k = ev.path[0];
        if (typeof k === 'string') touched.add(k);
      }
    }
    for (const p of touched) this.schedule(p, () => this.reconcileText(p));
  };

  private onBinsChange = (ev: Y.YMapEvent<BinEntry>, txn: Y.Transaction) => {
    if (!isRemoteOrigin(txn.origin) || !this.opts.syncAttachments) return;
    for (const key of ev.keysChanged) this.schedule(key, () => this.reconcileBinary(key));
  };

  // ---------------------------------------------------------------- helpers

  private get vault(): VaultAdapter {
    return this.opts.vault;
  }

  private async readText(path: string): Promise<string | null> {
    const t = await this.vault.readText(path);
    return t === null ? null : normalizeEol(t);
  }

  private async hashOf(path: string): Promise<string | null> {
    const cached = this.hashCache.get(path);
    if (cached) return cached;
    const b = await this.vault.readBinary(path);
    if (!b) return null;
    const h = await sha256Hex(b);
    this.hashCache.set(path, h);
    return h;
  }

  private async conflictCopy(path: string, content: string | ArrayBuffer): Promise<void> {
    const when = (this.opts.now ?? (() => new Date()))();
    let n = 0;
    let target = conflictCandidate(path, this.opts.deviceName, when, n);
    while (await this.vault.exists(target)) target = conflictCandidate(path, this.opts.deviceName, when, ++n);
    if (typeof content === 'string') await this.vault.writeText(target, content);
    else await this.vault.writeBinary(target, content);
    this.opts.notify?.(`Two versions of "${path}" met. Your copy was kept as "${target}".`);
  }

  private schedule(path: string, fn: () => Promise<void>): void {
    const old = this.timers.get(path);
    if (old) clearTimeout(old);
    this.timers.set(
      path,
      timer(() => {
        this.timers.delete(path);
        void this.queue(path, fn);
      }, this.opts.debounceMs ?? 250),
    );
  }

  private queue(path: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chain.get(path) ?? Promise.resolve();
    const next: Promise<void> = prev
      .catch(() => undefined)
      .then(() => (this.closed ? undefined : fn()))
      .catch((err) => this.log('error', `${path}: ${err instanceof Error ? err.message : String(err)}`))
      .then(() => {
        if (this.chain.get(path) === next) this.chain.delete(path);
      });
    this.chain.set(path, next);
    return next;
  }

  /** A local edit went into the shared text. Remember it until another device has seen it. */
  private markPushed(path: string): void {
    const online = (this.net?.peers().length ?? 0) > 0;
    if (online) {
      if (this.dirty.delete(path)) this.metaChanged();
    } else if (!this.dirty.has(path)) {
      this.dirty.add(path);
      this.metaChanged();
    }
  }

  private metaChanged(): void {
    this.onMetaChange?.();
  }

  private schedulePersist = () => {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = timer(() => void this.flushPersist(), 700);
  };

  async flushPersist(): Promise<void> {
    try {
      await this.opts.persist.save(Y.encodeStateAsUpdate(this.doc));
    } catch (err) {
      this.log('warn', `could not save sync state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.opts.log?.(level, msg);
  }
}
