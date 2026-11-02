import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';

/** Origin used for changes that came from another device. */
export const remoteOrigin = (peer: string) => ({ peer });
export const isRemoteOrigin = (o: unknown): o is { peer: string } =>
  typeof o === 'object' && o !== null && 'peer' in (o as object);

export type MsgType = 'sv' | 'upd' | 'sy' | 'aw' | 'want' | 'blob';

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

/** Keeps one Y.Doc and one Awareness in sync with every device that is in the same room. */
export class RoomProvider {
  readonly syncedPeers = new Set<string>();
  private peerClients = new Map<string, Set<number>>();

  onSynced: (() => void) | null = null;
  onPeersChanged: (() => void) | null = null;
  onWant: ((hash: string, from: string) => void) | null = null;
  onBlob: ((hash: string, data: Uint8Array, from: string) => void) | null = null;

  constructor(
    readonly doc: Y.Doc,
    readonly awareness: Awareness,
    readonly transport: Transport,
  ) {
    doc.on('update', this.handleDocUpdate);
    awareness.on('update', this.handleAwarenessUpdate);
    transport.onMessage = this.handleMessage;
    transport.onPeerJoin = this.handleJoin;
    transport.onPeerLeave = this.handleLeave;
    for (const p of transport.peers()) this.handleJoin(p);
  }

  peerCount(): number {
    return this.transport.peers().length;
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

  private handleJoin = (peer: string) => {
    this.transport.send('sv', Y.encodeStateVector(this.doc), peer);
    const ids = [...this.awareness.getStates().keys()];
    if (ids.length) this.transport.send('aw', encodeAwarenessUpdate(this.awareness, ids), peer);
    this.onPeersChanged?.();
  };

  private handleLeave = (peer: string) => {
    this.syncedPeers.delete(peer);
    const ids = this.peerClients.get(peer);
    this.peerClients.delete(peer);
    if (ids && ids.size) removeAwarenessStates(this.awareness, [...ids], 'peer-left');
    this.onPeersChanged?.();
  };

  private handleMessage = (type: MsgType, data: Uint8Array, from: string) => {
    try {
      switch (type) {
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
    // Forward to everyone except the device it came from (this also works when two
    // devices cannot reach each other directly but both reach a third one).
    const skip = isRemoteOrigin(origin) ? origin.peer : null;
    if (skip === null) {
      this.transport.send('upd', update);
      return;
    }
    for (const p of this.transport.peers()) if (p !== skip) this.transport.send('upd', update, p);
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
    if (changed.length) this.transport.send('aw', encodeAwarenessUpdate(this.awareness, changed));
  };
}
