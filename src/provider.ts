import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { idOf, publicPart, verifyText } from './identity';

/** Origin used for changes that came from another device. */
export const remoteOrigin = (peer: string) => ({ peer });
export const isRemoteOrigin = (o: unknown): o is { peer: string } =>
  typeof o === 'object' && o !== null && 'peer' in (o as object);

/**
 * hi   = who I am (name, picture, signed proof of my device id)
 * ok   = I have allowed you in
 * sv   = my state vector (what I already have)
 * upd  = changes you are missing
 * sy   = I sent you everything I had
 * aw   = cursors and who is where
 * want / blob = pictures and other files
 */
export type MsgType = 'hi' | 'ok' | 'sv' | 'upd' | 'sy' | 'aw' | 'want' | 'blob';

/** Minimal "talk to the other devices in the room" interface. */
export interface Transport {
  readonly selfId: string;
  peers(): string[];
  send(type: MsgType, payload: Uint8Array, target?: string): void;
  onMessage: ((type: MsgType, payload: Uint8Array, peerId: string) => void) | null;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  leave(): Promise<void> | void;
}

export interface PeerInfo {
  id: string;
  name: string;
  avatar: string;
  color: string;
}

export type GateDecision = 'allow' | 'ask' | 'block';

/** Joining: who may come in. Without these options the provider lets every device in. */
export interface JoinOptions {
  /** Same on every device in the room; part of what a device signs. */
  room: string;
  pub: JsonWebKey;
  sign(text: string): Promise<string>;
  profile(): { name: string; avatar: string; color: string };
  decide(peer: PeerInfo): GateDecision;
}

export const helloText = (room: string, peerId: string) => `live-room-sync/hi/${room}/${peerId}`;

const HASH_LEN = 64;
const ascii = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
};
const fromAscii = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return s;
};

type PeerState = 'new' | 'pending' | 'allowed' | 'blocked';
interface PeerRec {
  state: PeerState;
  info?: PeerInfo;
  helloSent: boolean;
}

export interface RosterPeer {
  peerId: string;
  state: PeerState;
  info?: PeerInfo;
}

/** Keeps one Y.Doc and one Awareness in sync with every device that is in the same room. */
export class RoomProvider {
  readonly syncedPeers = new Set<string>();
  private peerClients = new Map<string, Set<number>>();
  private recs = new Map<string, PeerRec>();

  onSynced: (() => void) | null = null;
  onPeersChanged: (() => void) | null = null;
  onWant: ((hash: string, from: string) => void) | null = null;
  onBlob: ((hash: string, data: Uint8Array, from: string) => void) | null = null;

  constructor(
    readonly doc: Y.Doc,
    readonly awareness: Awareness,
    readonly transport: Transport,
    private join?: JoinOptions,
  ) {
    doc.on('update', this.handleDocUpdate);
    awareness.on('update', this.handleAwarenessUpdate);
    transport.onMessage = this.handleMessage;
    transport.onPeerJoin = this.handleJoin;
    transport.onPeerLeave = this.handleLeave;
    for (const p of transport.peers()) this.handleJoin(p);
  }

  /** Devices that may exchange notes with us. */
  allowedPeers(): string[] {
    const out: string[] = [];
    for (const [p, r] of this.recs) if (r.state === 'allowed') out.push(p);
    return out;
  }

  peerCount(): number {
    return this.allowedPeers().length;
  }

  roster(): RosterPeer[] {
    return [...this.recs].map(([peerId, r]) => ({ peerId, state: r.state, info: r.info }));
  }

  approve(peerId: string): void {
    const r = this.recs.get(peerId);
    if (r && r.state === 'pending') this.allow(peerId, r);
  }

  block(peerId: string): void {
    const r = this.recs.get(peerId);
    if (!r) return;
    r.state = 'blocked';
    this.onPeersChanged?.();
  }

  sendWant(peer: string, hash: string): void {
    this.transport.send('want', ascii(hash), peer);
  }

  sendBlob(peer: string, hash: string, data: Uint8Array): void {
    const out = new Uint8Array(HASH_LEN + data.length);
    out.set(ascii(hash), 0);
    out.set(data, HASH_LEN);
    this.transport.send('blob', out, peer);
  }

  async destroy(): Promise<void> {
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.transport.onMessage = null;
    this.transport.onPeerJoin = null;
    this.transport.onPeerLeave = null;
    await this.transport.leave();
  }

  // ------------------------------------------------------------------ joining

  private rec(peer: string): PeerRec {
    let r = this.recs.get(peer);
    if (!r) {
      r = { state: 'new', helloSent: false };
      this.recs.set(peer, r);
      if (this.join) void this.sendHello(peer, r);
      else this.allow(peer, r);
    }
    return r;
  }

  private async sendHello(peer: string, r: PeerRec): Promise<void> {
    const j = this.join;
    if (!j || r.helloSent) return;
    r.helloSent = true;
    try {
      const sig = await j.sign(helloText(j.room, this.transport.selfId));
      const body = JSON.stringify({ pub: publicPart(j.pub), sig, ...j.profile() });
      this.transport.send('hi', new TextEncoder().encode(body), peer);
    } catch (err) {
      console.error('[live-room] could not send hello', err);
    }
  }

  private async handleHello(from: string, data: Uint8Array): Promise<void> {
    const j = this.join;
    const r = this.rec(from);
    if (!j || r.state !== 'new') return;
    try {
      const m = JSON.parse(new TextDecoder().decode(data)) as {
        pub: JsonWebKey;
        sig: string;
        name?: string;
        avatar?: string;
        color?: string;
      };
      if (!(await verifyText(m.pub, m.sig, helloText(j.room, from)))) {
        r.state = 'blocked';
        return;
      }
      const info: PeerInfo = {
        id: await idOf(m.pub),
        name: String(m.name ?? 'Someone').slice(0, 40),
        avatar: String(m.avatar ?? '🙂').slice(0, 8),
        color: /^#[0-9a-fA-F]{6}$/.test(String(m.color)) ? String(m.color) : '#0091ff',
      };
      r.info = info;
      const d = j.decide(info);
      if (d === 'allow') this.allow(from, r);
      else if (d === 'block') r.state = 'blocked';
      else r.state = 'pending';
    } catch {
      r.state = 'blocked';
    }
    this.onPeersChanged?.();
  }

  /** Start sharing with this device. Both sides must have allowed each other before notes flow. */
  private allow(peer: string, r: PeerRec): void {
    r.state = 'allowed';
    if (this.join) this.transport.send('ok', new Uint8Array([1]), peer);
    this.transport.send('sv', Y.encodeStateVector(this.doc), peer);
    const ids = [...this.awareness.getStates().keys()];
    if (ids.length) this.transport.send('aw', encodeAwarenessUpdate(this.awareness, ids), peer);
    this.onPeersChanged?.();
  }

  private handleJoin = (peer: string) => {
    this.rec(peer);
    this.onPeersChanged?.();
  };

  private handleLeave = (peer: string) => {
    this.recs.delete(peer);
    this.syncedPeers.delete(peer);
    const ids = this.peerClients.get(peer);
    this.peerClients.delete(peer);
    if (ids && ids.size) removeAwarenessStates(this.awareness, [...ids], 'peer-left');
    this.onPeersChanged?.();
  };

  // ------------------------------------------------------------------ messages

  private handleMessage = (type: MsgType, data: Uint8Array, from: string) => {
    try {
      if (type === 'hi') {
        void this.handleHello(from, data);
        return;
      }
      const r = this.rec(from); // a message can arrive before we heard about the peer
      if (r.state !== 'allowed') return; // not let in (yet): ignore everything else
      switch (type) {
        case 'ok':
          this.transport.send('sv', Y.encodeStateVector(this.doc), from);
          break;
        case 'sv':
          this.transport.send('upd', Y.encodeStateAsUpdate(this.doc, data), from);
          this.transport.send('sy', new Uint8Array([1]), from);
          break;
        case 'upd':
          Y.applyUpdate(this.doc, data, remoteOrigin(from));
          break;
        case 'sy':
          this.syncedPeers.add(from);
          this.onSynced?.();
          this.onPeersChanged?.();
          break;
        case 'aw':
          applyAwarenessUpdate(this.awareness, data, remoteOrigin(from));
          break;
        case 'want':
          this.onWant?.(fromAscii(data), from);
          break;
        case 'blob':
          if (data.length >= HASH_LEN) {
            this.onBlob?.(fromAscii(data.subarray(0, HASH_LEN)), data.subarray(HASH_LEN), from);
          }
          break;
      }
    } catch (err) {
      console.error('[live-room] bad message', type, err);
    }
  };

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Forward to everyone allowed except the device it came from (this also works when two
    // devices cannot reach each other directly but both reach a third one).
    const skip = isRemoteOrigin(origin) ? origin.peer : null;
    for (const p of this.allowedPeers()) if (p !== skip) this.transport.send('upd', update, p);
  };

  private handleAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (isRemoteOrigin(origin)) {
      let set = this.peerClients.get(origin.peer);
      if (!set) this.peerClients.set(origin.peer, (set = new Set()));
      for (const id of change.added) set.add(id);
      return;
    }
    const changed = change.added.concat(change.updated, change.removed);
    if (!changed.length) return;
    const payload = encodeAwarenessUpdate(this.awareness, changed);
    for (const p of this.allowedPeers()) this.transport.send('aw', payload, p);
  };
}
