// Thin wrapper around PeerJS (WebRTC data channels). Signalling goes through the free public
// PeerJS server (0.peerjs.com) and its TURN relays, so the game needs no server of its own.
// For local testing a private PeerServer can be used: ?peerhost=localhost&peerport=9000

import type { DataConnection, Peer } from 'peerjs';

export type { DataConnection, Peer };

export const ROOM_PREFIX = 'penetration-v1-';
export const PROTOCOL = 2;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(n = 5): string {
  let s = '';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

/** Normalise a typed room code (case, spaces; codes never use 0/O/1/I). */
export function normCode(s: string): string {
  return s
    .toUpperCase()
    .split('')
    .filter((c) => ALPHABET.includes(c))
    .join('')
    .slice(0, 5);
}

function options(): Record<string, unknown> {
  const q = new URLSearchParams(location.search);
  const o: Record<string, unknown> = { debug: 0 };
  const host = q.get('peerhost');
  if (host) {
    o.host = host;
    o.port = Number(q.get('peerport') ?? 9000);
    o.path = q.get('peerpath') ?? '/';
    o.secure = q.get('peersecure') === '1';
  }
  return o;
}

export class NetError extends Error {
  kind: string;
  constructor(kind: string, msg?: string) {
    super(msg ?? kind);
    this.kind = kind;
  }
}

/** Create a peer; resolves once registered with the signalling server. */
export async function openPeer(id?: string): Promise<Peer> {
  let PeerCtor: typeof Peer;
  try {
    PeerCtor = (await import('peerjs')).Peer;
  } catch {
    throw new NetError('load', 'Could not load the network module');
  }
  return new Promise((resolve, reject) => {
    const p = id ? new PeerCtor(id, options()) : new PeerCtor(options());
    const fail = (e: NetError) => {
      clearTimeout(to);
      p.destroy();
      reject(e);
    };
    const to = setTimeout(() => fail(new NetError('timeout', 'The matchmaking server did not answer')), 15000);
    p.once('open', () => {
      clearTimeout(to);
      resolve(p);
    });
    p.once('error', (e: Error & { type?: string }) => fail(new NetError(e.type ?? 'error', e.message)));
  });
}

/** Connect to a room host. */
export function connectTo(peer: Peer, code: string): Promise<DataConnection> {
  return new Promise((resolve, reject) => {
    const conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'json' });
    const to = setTimeout(() => {
      cleanup();
      conn.close();
      reject(new NetError('timeout', 'Could not reach the room'));
    }, 20000);
    const onErr = (e: Error & { type?: string }) => {
      cleanup();
      reject(new NetError(e.type === 'peer-unavailable' ? 'not-found' : e.type ?? 'error', e.message));
    };
    const cleanup = () => {
      clearTimeout(to);
      peer.off('error', onErr);
    };
    peer.on('error', onErr);
    conn.once('open', () => {
      cleanup();
      resolve(conn);
    });
    conn.once('error', (e) => onErr(e as Error & { type?: string }));
  });
}
