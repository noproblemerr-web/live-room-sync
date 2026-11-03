import type { Identity } from './identity';
import type { NetworkKind } from './transport-trystero';

export const AVATARS = ['🦊', '🐼', '🐸', '🐙', '🦄', '🐯', '🐵', '🐧', '🦉', '🐢', '👾', '🚀'];
export const COLORS = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#0091ff', '#8e4ec6', '#d6409f', '#12a594'];

/** Someone you have partied with. Kept on this device only. */
export interface Person {
  name: string;
  avatar: string;
  color: string;
  lastSeen: number;
  status: 'trusted' | 'blocked';
}

export interface Settings {
  roomCode: string;
  /**
   * host = you started this party and your vault leads it. guest = you joined someone else's, so the
   * notes already in your vault stay private (see localOnly).
   */
  role: 'host' | 'guest';
  /** Notes that were in this vault when you joined as a guest. They are never shared. */
  localOnly: string[];
  /** Your name in the party (kept as "deviceName" so older settings still load). */
  deviceName: string;
  avatar: string;
  color: string;
  liveTyping: boolean;
  /** Let the party see which note you are in. */
  showActivity: boolean;
  /** small messages when someone joins or leaves the party */
  showToasts: boolean;
  syncAttachments: boolean;
  maxAttachmentMB: number;
  excludedFolders: string;
  network: NetworkKind;
  turnJson: string;
  /** New devices must be allowed by someone already in the party. */
  askBeforeJoin: boolean;
  accepted: boolean; // user confirmed they made a backup
  paused: boolean;
  metaRoom: string;
  known: Record<string, { h: string; s: number }>;
  identity: Identity | null;
  people: Record<string, Person>;
  /** Until this time, a device that just joined with a code trusts the devices it meets. */
  guestUntil: number;
}

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export const defaultSettings = (name: string, mobile: boolean): Settings => ({
  roomCode: '',
  role: 'host',
  localOnly: [],
  deviceName: name,
  avatar: pick(AVATARS),
  color: pick(COLORS),
  liveTyping: true,
  showActivity: true,
  showToasts: true,
  syncAttachments: true,
  maxAttachmentMB: mobile ? 10 : 25,
  excludedFolders: '',
  network: 'nostr',
  turnJson: '',
  askBeforeJoin: true,
  accepted: false,
  paused: false,
  metaRoom: '',
  known: {},
  identity: null,
  people: {},
  guestUntil: 0,
});

/** "4d ago", "just now": short and friendly. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
