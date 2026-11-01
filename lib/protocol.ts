export type FileMeta = { id: string; name: string; size: number; type: string };
export type Want = { id: string; offset: number };

export type Msg =
  | { kind: 'manifest'; files: FileMeta[] }
  | { kind: 'start'; want: Want[] }
  | { kind: 'file-start'; id: string; offset: number }
  | { kind: 'block'; id: string; offset: number; size: number; hash: string }
  | { kind: 'file-end'; id: string }
  | { kind: 'complete' }
  | { kind: 'received'; id: string }
  | { kind: 'ping' }   // receiver → sender: are you still there?
  | { kind: 'pong' };  // sender → receiver: yes

export const BLOCK = 4 * 1024 * 1024;

export function sendMsg(dc: RTCDataChannel, msg: Msg) {
  dc.send(JSON.stringify(msg));
}

export function parseMsg(data: unknown): Msg | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as Msg;
  } catch {
    return null;
  }
}

export function pickChunkSize(pc: RTCPeerConnection): number {
  const max = pc.sctp?.maxMessageSize ?? 0;
  if (max >= 64 * 1024) return Math.min(max, 256 * 1024);
  return 16 * 1024;
}

export function fileId(f: { name: string; size: number }): string {
  const s = `${f.name}|${f.size}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  pdf: 'application/pdf', zip: 'application/zip',
};

export function typeOf(name: string, type: string): string {
  if (type) return type;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT[ext] ?? 'application/octet-stream';
}