import { BLOCK, sendMsg, type Want } from './protocol';
import { sha256Hex } from './hash';

const HIGH_WATER = 8 * 1024 * 1024; // stay well under Chrome's ~16 MB queue limit
const LOW_WATER = 2 * 1024 * 1024;
const SAFE_CHUNK = 16 * 1024;

export type SendStats = { waitMs: number; totalMs: number; chunk: number; bytes: number };
type Log = (msg: string, level?: 'info' | 'ok' | 'warn' | 'err') => void;

function drained(dc: RTCDataChannel) {
  return new Promise<void>((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('channel closed')); };
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', ok);
      dc.removeEventListener('close', fail);
    };
    dc.addEventListener('bufferedamountlow', ok);
    dc.addEventListener('close', fail);
  });
}

// Read and fingerprint the next block while the current one is being sent.
function prepare(file: File, offset: number) {
  const p = file
    .slice(offset, offset + BLOCK)
    .arrayBuffer()
    .then(async (buf) => ({ buf, hash: await sha256Hex(buf) }));
  p.catch(() => {});
  return p;
}

export async function sendFiles(
  dc: RTCDataChannel,
  files: Map<string, File>,
  want: Want[],
  onProgress: (doneBytes: number) => void,
  initialChunk: number,
  log?: Log
): Promise<SendStats> {
  dc.bufferedAmountLowThreshold = LOW_WATER;
  const t0 = performance.now();
  let chunk = initialChunk;
  let waitMs = 0;
  let bytes = 0;
  let done = want.reduce((s, w) => s + w.offset, 0); // what the receiver already had

  const waitForRoom = async () => {
    const w = performance.now();
    await drained(dc);
    waitMs += performance.now() - w;
  };

  const sendPiece = async (piece: ArrayBuffer): Promise<boolean> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (dc.readyState !== 'open') throw new Error('channel closed');
      if (dc.bufferedAmount + piece.byteLength > HIGH_WATER) await waitForRoom();
      try {
        dc.send(piece);
        return true;
      } catch (err) {
        const e = err as DOMException;
        if (e.name === 'TypeError' && chunk > SAFE_CHUNK) {
          chunk = SAFE_CHUNK;
          log?.(`chunk rejected as too large · falling back to ${SAFE_CHUNK / 1024} KB`, 'warn');
          return false;
        }
        if (e.name === 'OperationError') {
          await waitForRoom();
          continue;
        }
        throw err;
      }
    }
    throw new Error('send queue stayed full');
  };

  for (const w of want) {
    const file = files.get(w.id);
    if (!file) {
      log?.(`receiver asked for an unknown file (${w.id})`, 'warn');
      continue;
    }
    const start = Math.min(Math.max(0, w.offset), file.size);
    sendMsg(dc, { kind: 'file-start', id: w.id, offset: start });

    let next = start < file.size ? prepare(file, start) : null;
    for (let offset = start; offset < file.size; offset += BLOCK) {
      const { buf, hash } = await next!;
      next = offset + BLOCK < file.size ? prepare(file, offset + BLOCK) : null;

      if (dc.readyState !== 'open') throw new Error('channel closed');
      sendMsg(dc, { kind: 'block', id: w.id, offset, size: buf.byteLength, hash });

      let p = 0;
      while (p < buf.byteLength) {
        const piece = buf.slice(p, p + chunk);
        if (!(await sendPiece(piece))) continue; // chunk size shrank: re-slice
        p += piece.byteLength;
        bytes += piece.byteLength;
        done += piece.byteLength;
        onProgress(done);
      }
    }
    sendMsg(dc, { kind: 'file-end', id: w.id });
  }

  sendMsg(dc, { kind: 'complete' });

  while (dc.bufferedAmount > 0 && dc.readyState === 'open') {
    const w = performance.now();
    await new Promise((r) => setTimeout(r, 50));
    waitMs += performance.now() - w;
  }

  return { waitMs, totalMs: performance.now() - t0, chunk, bytes };
}