/**
 * Everything two pilots say to each other through the public relay is sealed with a key made from the room code, so the
 * relay (and anyone watching it) sees only noise, and nothing can be added or changed without knowing the code. This is
 * what keeps the connection set-up safe even though the relay is run by someone else.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0, O, 1, I
export const CODE_LENGTH = 10;
const MAX_PLAIN_BYTES = 256 * 1024;

export interface RoomKeys { topic: string; key: CryptoKey }

/** A fresh room code: ten characters of 32 possible, about 50 bits, which is plenty for a short-lived room. */
export function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join(""); // 256 is a multiple of 32, so no bias
}

export function formatRoomCode(code: string): string { return code.length === CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code; }

/** Accepts the code as typed or pasted (spaces, dashes, any case) and returns it clean, or null if it cannot be a code. */
/** The link that opens Obsidian and fills in a room code: obsidian://starfield-join?code=ABCDEFGHJK (the code only; nothing is joined until the reader presses Join). */
export function inviteLink(code: string): string { return `obsidian://starfield-join?code=${encodeURIComponent(code)}`; }

export function parseRoomCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === CODE_LENGTH && [...c].every(ch => CODE_CHARS.includes(ch)) ? c : null;
}

const hex = (b: Uint8Array): string => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

function toB64Url(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try { const s = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")); return Uint8Array.from(s, ch => ch.charCodeAt(0)); }
  catch { return null; }
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length; if (total > MAX_PLAIN_BYTES) { await reader.cancel(); return null; } // a decompression bomb
    parts.push(value);
  }
  const out = new Uint8Array(total); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The relay topic and the encryption key for a room, both derived from the code. */
export async function deriveRoomKeys(code: string): Promise<RoomKeys> {
  const topicHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("constellation-graph/room-topic/v1/" + code)));
  const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("constellation-graph/room-key/v1"), iterations: 150_000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { topic: "cg-" + hex(topicHash).slice(0, 40), key };
}

/** Encrypt a message (compressing it first if that helps) into text that is safe to put through the relay. */
export async function seal(keys: RoomKeys, value: unknown): Promise<string> {
  const plain = enc.encode(JSON.stringify(value));
  const squeezed = plain.length > 240 && typeof CompressionStream === "function" ? await gzip(plain) : null;
  const body = squeezed && squeezed.length < plain.length ? squeezed : plain;
  const payload = new Uint8Array(body.length + 1); payload[0] = body === plain ? 0 : 1; payload.set(body, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.key, payload));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv, 0); out.set(ct, iv.length);
  return toB64Url(out);
}

/** Decrypt and check a message; null if it was not sealed with this room's key, or is damaged. */
export async function unseal(keys: RoomKeys, text: string): Promise<unknown> {
  const bytes = fromB64Url(text.trim());
  if (!bytes || bytes.length < 12 + 17 || bytes.length > 64 * 1024) return null;
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, keys.key, bytes.slice(12)));
    if (!plain.length || plain.length > MAX_PLAIN_BYTES) return null;
    const body = plain[0] === 1 ? await gunzip(plain.subarray(1)) : plain.subarray(1);
    if (!body || body.length > MAX_PLAIN_BYTES) return null;
    return JSON.parse(dec.decode(body)) as unknown;
  } catch { return null; }
}
