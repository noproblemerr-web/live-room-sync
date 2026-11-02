import DiffMatchPatch from 'diff-match-patch';
import * as Y from 'yjs';

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 1;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Turn the contents of `ytext` into `next` using the smallest edits we can find. */
export function applyTextDiff(ytext: Y.Text, next: string, origin: unknown): void {
  const cur = ytext.toString();
  if (cur === next) return;
  const doc = ytext.doc;

  let start = 0;
  const min = Math.min(cur.length, next.length);
  while (start < min && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  if (start > 0 && isHigh(cur.charCodeAt(start - 1))) start--;

  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)) {
    endCur--;
    endNext--;
  }
  if (endCur < cur.length && isLow(cur.charCodeAt(endCur))) {
    endCur++;
    endNext++;
  }

  const a = cur.slice(start, endCur);
  const b = next.slice(start, endNext);

  const apply = () => {
    if (a.length + b.length > 200_000) {
      if (a.length) ytext.delete(start, a.length);
      if (b.length) ytext.insert(start, b);
      return;
    }
    const diffs = dmp.diff_main(a, b, false);
    let idx = start;
    for (const [op, text] of diffs) {
      if (op === 0) idx += text.length;
      else if (op === -1) ytext.delete(idx, text.length);
      else {
        ytext.insert(idx, text);
        idx += text.length;
      }
    }
  };
  if (doc) doc.transact(apply, origin);
  else apply();
}

/** Three-way merge. `ok` is false when part of the local change could not be placed. */
export function merge3(base: string, local: string, remote: string): { text: string; ok: boolean } {
  if (local === remote) return { text: local, ok: true };
  if (base === remote) return { text: local, ok: true };
  if (base === local) return { text: remote, ok: true };
  const patches = dmp.patch_make(base, local);
  const [text, results] = dmp.patch_apply(patches, remote);
  return { text, ok: results.every(Boolean) };
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export const TEXT_EXT = /\.(md|txt|canvas)$/i;
export const isTextPath = (p: string) => TEXT_EXT.test(p);

/** Editors (CodeMirror) always use \n, so we keep \n inside the shared text. */
export const normalizeEol = (s: string) => (s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n'));

export function isExcludedPath(path: string, configDir: string, extra: string[]): boolean {
  const p = path.replace(/^\/+/, '');
  if (!p) return true;
  const cfg = configDir.replace(/^\/+|\/+$/g, '');
  if (cfg && (p === cfg || p.startsWith(cfg + '/'))) return true;
  if (p.split('/').some((seg) => seg.startsWith('.'))) return true;
  for (const raw of extra) {
    const x = raw.trim().replace(/^\/+|\/+$/g, '');
    if (x && (p === x || p.startsWith(x + '/'))) return true;
  }
  return false;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function conflictCandidate(path: string, who: string, when: Date, n: number): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : '';
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  const name = who.replace(/[\\/:*?"<>|]/g, '').trim() || 'device';
  return `${stem} (conflict ${name} ${stamp}${n ? ' ' + n : ''})${ext}`;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return formatRoomCode(raw);
}

export function formatRoomCode(raw: string): string {
  return raw.match(/.{1,5}/g)?.join('-') ?? raw;
}

/** Returns the clean code (no dashes, upper case) or '' when it is too short to be safe. */
export function normalizeRoomCode(input: string): string {
  const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length >= 16 ? clean : '';
}
