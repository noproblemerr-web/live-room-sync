import { sha256Hex } from './util';

/**
 * Each device has its own key pair. The short id other people see is made from the public
 * key, and a device proves it owns that id by signing a short message when it joins. This is
 * what lets "allow this device" mean something: nobody can copy another device's id.
 */
export interface Identity {
  id: string;
  pub: JsonWebKey;
  priv: JsonWebKey;
}

const KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Only the parts of the public key that matter, so what we send and hash is always the same. */
export const publicPart = (k: JsonWebKey): JsonWebKey => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });

export async function idOf(pub: JsonWebKey): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(`${pub.x}.${pub.y}`))).slice(0, 32);
}

export async function createIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey(KEY, true, ['sign', 'verify']);
  const pub = publicPart(await crypto.subtle.exportKey('jwk', pair.publicKey));
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { id: await idOf(pub), pub, priv };
}

const toBase64 = (u8: Uint8Array) => {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function signText(priv: JsonWebKey, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', priv, KEY, false, ['sign']);
  const sig = await crypto.subtle.sign(SIG, key, new TextEncoder().encode(text));
  return toBase64(new Uint8Array(sig));
}

export async function verifyText(pub: JsonWebKey, sig: string, text: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', publicPart(pub), KEY, false, ['verify']);
    return await crypto.subtle.verify(SIG, key, fromBase64(sig), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}
