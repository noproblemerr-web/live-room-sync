import * as Y from 'yjs';
import { SyncEngine, type VaultAdapter, type Persist } from '../src/engine';
import { RoomProvider, type Transport, type MsgType, type PeerInfo, type GateDecision } from '../src/provider';
import { signText, type Identity } from '../src/identity';

// the plugin uses window.setTimeout (for Obsidian's popout windows); in Node there is no window
(globalThis as Record<string, unknown>).window ??= globalThis;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error('timeout waiting for: ' + what);
}

// ---------------------------------------------------------------- fake vault
export class FakeVault implements VaultAdapter {
  files = new Map<string, string | ArrayBuffer>();
  writes = 0;
  engine: SyncEngine | null = null; // events go here, like Obsidian vault events
  eventDelay = 3;

  private fire(fn: () => void) {
    setTimeout(() => this.engine && fn(), this.eventDelay);
  }
  async list() {
    return [...this.files.entries()].map(([path, v]) => ({ path, size: typeof v === 'string' ? v.length : v.byteLength }));
  }
  async exists(p: string) {
    return this.files.has(p);
  }
  async size(p: string) {
    const v = this.files.get(p);
    return v === undefined ? null : typeof v === 'string' ? v.length : v.byteLength;
  }
  async readText(p: string) {
    const v = this.files.get(p);
    return typeof v === 'string' ? v : null;
  }
  async readBinary(p: string) {
    const v = this.files.get(p);
    if (v === undefined) return null;
    return typeof v === 'string' ? (new TextEncoder().encode(v).buffer as ArrayBuffer) : v;
  }
  async writeText(p: string, d: string) {
    const existed = this.files.has(p);
    this.files.set(p, d);
    this.writes++;
    this.fire(() => (existed ? this.engine!.onVaultModify(p) : this.engine!.onVaultCreate(p)));
  }
  async writeBinary(p: string, d: ArrayBuffer) {
    const existed = this.files.has(p);
    this.files.set(p, d);
    this.writes++;
    this.fire(() => (existed ? this.engine!.onVaultModify(p) : this.engine!.onVaultCreate(p)));
  }
  async trash(p: string) {
    this.files.delete(p);
    this.fire(() => this.engine!.onVaultDelete(p));
  }
  // what a person does
  async userWrite(p: string, d: string | ArrayBuffer) {
    if (typeof d === 'string') await this.writeText(p, d);
    else await this.writeBinary(p, d);
  }
  async userDelete(p: string) {
    this.files.delete(p);
    this.fire(() => this.engine!.onVaultDelete(p));
  }
  async userRename(from: string, to: string) {
    const v = this.files.get(from)!;
    this.files.delete(from);
    this.files.set(to, v);
    this.fire(() => this.engine!.onVaultRename(to, from));
  }
  text(p: string) {
    const v = this.files.get(p);
    return typeof v === 'string' ? v : undefined;
  }
  names() {
    return [...this.files.keys()].sort();
  }
}

// ---------------------------------------------------------------- fake network
export class Hub {
  members = new Map<string, MemTransport>();
  drop = false; // simulate a dead link
  blocked = new Set<string>(); // "a|b" pairs that cannot talk
  join(t: MemTransport) {
    for (const o of this.members.values()) {
      if (this.blocked.has(`${t.selfId}|${o.selfId}`) || this.blocked.has(`${o.selfId}|${t.selfId}`)) continue;
      o.link.add(t.selfId);
      t.link.add(o.selfId);
    }
    this.members.set(t.selfId, t);
    for (const id of [...t.link]) {
      const o = this.members.get(id)!;
      setTimeout(() => {
        o.onPeerJoin?.(t.selfId);
        t.onPeerJoin?.(o.selfId);
      }, 2);
    }
  }
  leave(t: MemTransport) {
    this.members.delete(t.selfId);
    for (const id of t.link) {
      const o = this.members.get(id);
      if (o) {
        o.link.delete(t.selfId);
        setTimeout(() => o.onPeerLeave?.(t.selfId), 2);
      }
    }
    t.link.clear();
  }
}

export class MemTransport implements Transport {
  onMessage: Transport['onMessage'] = null;
  onPeerJoin: Transport['onPeerJoin'] = null;
  onPeerLeave: Transport['onPeerLeave'] = null;
  link = new Set<string>();
  sent = 0;
  constructor(readonly selfId: string, private hub: Hub) {}
  peers() {
    return [...this.link];
  }
  send(type: MsgType, payload: Uint8Array, target?: string) {
    const copy = payload.slice();
    const to = target ? [target] : [...this.link];
    for (const id of to) {
      if (!this.link.has(id)) continue;
      this.sent++;
      setTimeout(() => {
        if (this.hub.drop) return;
        this.hub.members.get(id)?.onMessage?.(type, copy, this.selfId);
      }, 1);
    }
  }
  leave() {
    this.hub.leave(this);
  }
}

// ---------------------------------------------------------------- device
export class Device {
  vault = new FakeVault();
  engine!: SyncEngine;
  provider!: RoomProvider;
  transport!: MemTransport;
  state: Uint8Array | null = null;
  meta: any = {};
  logs: string[] = [];
  notices: string[] = [];

  constructor(
    readonly name: string,
    private hub: Hub,
    private opts: {
      fresh?: number;
      known?: number;
      attachments?: boolean;
      /** turn on the signed hello: this device's identity */
      identity?: Identity;
      /** what this device decides about someone who wants in (default: allow) */
      decide?: (p: PeerInfo) => GateDecision;
    } = {},
  ) {}

  persist: Persist = {
    load: async () => this.state,
    save: async (d) => {
      this.state = d;
    },
  };

  async start(online = true) {
    this.engine = new SyncEngine({
      vault: this.vault,
      persist: this.persist,
      deviceName: this.name,
      configDir: '.obsidian',
      excluded: [],
      syncAttachments: this.opts.attachments ?? true,
      maxAttachmentBytes: 1024 * 1024,
      debounceMs: 20,
      freshGraceMs: this.opts.fresh ?? 400,
      knownGraceMs: this.opts.known ?? 150,
      syncSettleMs: 60,
      log: (l, m) => this.logs.push(`${l}: ${m}`),
      notify: (m) => this.notices.push(m),
      now: () => new Date(2026, 10, 2, 12, 0),
    });
    this.engine.importMeta(this.meta);
    this.engine.onMetaChange = () => {
      this.meta = this.engine.exportMeta();
    };
    this.vault.engine = this.engine;
    await this.engine.start();
    if (online) await this.connect();
  }

  async connect() {
    this.transport = new MemTransport(this.name + '-' + Math.random().toString(36).slice(2, 6), this.hub);
    const id = this.opts.identity;
    this.provider = new RoomProvider(
      this.engine.doc,
      this.engine.awareness,
      this.transport,
      id && {
        room: 'test-room',
        pub: id.pub,
        sign: (t) => signText(id.priv, t),
        profile: () => ({ name: this.name, avatar: '🦊', color: '#0091ff' }),
        decide: (p) => (this.opts.decide ? this.opts.decide(p) : 'allow'),
      },
    );
    this.engine.setNet({
      peers: () => this.provider.allowedPeers(),
      sendWant: (p, h) => this.provider.sendWant(p, h),
      sendBlob: (p, h, d) => this.provider.sendBlob(p, h, d),
    });
    this.provider.onSynced = () => this.engine.notifySynced();
    this.provider.onPeersChanged = () => this.engine.onPeersChanged();
    this.provider.onWant = (h, f) => void this.engine.handleWant(h, f);
    this.provider.onBlob = (h, d) => void this.engine.receiveBlob(h, d);
    this.hub.join(this.transport);
  }

  async stop() {
    await this.provider?.destroy();
    this.meta = this.engine.exportMeta();
    await this.engine.stop();
    this.vault.engine = null;
  }
}

export const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer as ArrayBuffer;
export const same = (a: ArrayBuffer | string | undefined, b: ArrayBuffer | string | undefined) => {
  if (typeof a === 'string' || typeof b === 'string' || !a || !b) return a === b;
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
export { Y };
