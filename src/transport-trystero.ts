import { joinRoom as joinNostr } from '@trystero-p2p/nostr';
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent';
import { joinRoom as joinMqtt } from '@trystero-p2p/mqtt';
import type { Room, DataPayload, TurnServerConfig } from '@trystero-p2p/core';
import type { MsgType, Transport } from './provider';
import { sha256Hex } from './util';

export type NetworkKind = 'nostr' | 'torrent' | 'mqtt';

const TYPES: MsgType[] = ['hi', 'ok', 'sv', 'upd', 'sy', 'aw', 'want', 'blob'];

const toU8 = (d: unknown): Uint8Array | null => {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
};

/**
 * Talks to other devices over WebRTC. The only thing that goes through a public server is the
 * tiny "hello, I am here" message used to find each other. Everything else goes straight
 * between the devices, scrambled with a key made from the room code.
 */
export class TrysteroTransport implements Transport {
  onMessage: Transport['onMessage'] = null;
  onPeerJoin: Transport['onPeerJoin'] = null;
  onPeerLeave: Transport['onPeerLeave'] = null;

  private room: Room;
  private actions = new Map<MsgType, { send: (d: DataPayload, o?: { target?: string }) => Promise<void> }>();
  private connected = new Set<string>();

  private constructor(room: Room, readonly selfId: string) {
    this.room = room;
  }

  static async create(opts: {
    code: string; // clean room code
    network: NetworkKind;
    turn?: TurnServerConfig[];
    selfId: string;
  }): Promise<TrysteroTransport> {
    // The room name that other people can see on the public relay is a hash, not the code.
    const roomId = (await sha256Hex(new TextEncoder().encode('live-room-sync/room/' + opts.code))).slice(0, 32);
    const password = await sha256Hex(new TextEncoder().encode('live-room-sync/key/' + opts.code));
    const join = opts.network === 'torrent' ? joinTorrent : opts.network === 'mqtt' ? joinMqtt : joinNostr;
    const room = join(
      {
        appId: 'live-room-sync-v2',
        password,
        ...(opts.turn && opts.turn.length ? { turnConfig: opts.turn } : {}),
      },
      roomId,
    );
    const t = new TrysteroTransport(room, opts.selfId);
    t.wire();
    return t;
  }

  private wire(): void {
    for (const type of TYPES) {
      const a = this.room.makeAction<DataPayload>(type, {
        onMessage: (data, ctx) => {
          const u8 = toU8(data);
          if (!u8) return;
          // a message can arrive before we heard about the peer: treat that as a join
          this.markConnected(ctx.peerId);
          this.onMessage?.(type, u8, ctx.peerId);
        },
      });
      this.actions.set(type, a as never);
    }
    this.room.onPeerJoin = (id) => this.markConnected(id);
    this.room.onPeerLeave = (id) => {
      if (this.connected.delete(id)) this.onPeerLeave?.(id);
    };
  }

  private markConnected(id: string): void {
    if (this.connected.has(id)) return;
    this.connected.add(id);
    this.onPeerJoin?.(id);
  }

  peers(): string[] {
    return [...this.connected];
  }

  send(type: MsgType, payload: Uint8Array, target?: string): void {
    const a = this.actions.get(type);
    if (!a) return;
    if (!target && this.connected.size === 0) return;
    const buf = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
    a.send(buf, target ? { target } : undefined).catch((err: unknown) => {
      console.warn('[live-room] send failed', type, err);
    });
  }

  async leave(): Promise<void> {
    this.onMessage = null;
    this.onPeerJoin = null;
    this.onPeerLeave = null;
    try {
      await this.room.leave();
    } catch {
      /* already gone */
    }
  }
}
