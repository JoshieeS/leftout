import type { FileMeta } from './protocol';

const RX = 'leftout:rx:';
const TX = 'leftout:tx';
const SAVED = 'leftout:saved:';
const CLIENT = 'leftout:client';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
function read<T>(key: string): T | null {
  return safe(() => JSON.parse(localStorage.getItem(key) ?? 'null') as T | null, null);
}
function write(key: string, value: unknown) {
  safe(() => localStorage.setItem(key, JSON.stringify(value)), undefined);
}

// A stable id for this browser, so the sender recognises a receiver when it reconnects.
export function clientId(): string {
  return safe(() => {
    let id = localStorage.getItem(CLIENT);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT, id);
    }
    return id;
  }, crypto.randomUUID());
}

// ---- receiver ----
export type ReceiverDrop = { manifest: FileMeta[]; verified: string[]; started: boolean; updated: number };

export const loadReceiverDrop = (slug: string) => read<ReceiverDrop>(RX + slug);
export const saveReceiverDrop = (slug: string, d: Omit<ReceiverDrop, 'updated'>) =>
  write(RX + slug, { ...d, updated: Date.now() });

export function forgetStaleDrops(maxAgeMs: number) {
  safe(() => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(RX)) continue;
      const d = read<ReceiverDrop>(k);
      if (!d || Date.now() - d.updated > maxAgeMs) {
        localStorage.removeItem(k);
        localStorage.removeItem(SAVED + k.slice(RX.length));
      }
    }
  }, undefined);
}

// ---- sender ----
export type SenderSession = { slug: string; ids: string[]; updated: number };

export const loadSenderSession = () => read<SenderSession>(TX);
export const saveSenderSession = (s: Omit<SenderSession, 'updated'>) => write(TX, { ...s, updated: Date.now() });
export const clearSenderSession = () => safe(() => localStorage.removeItem(TX), undefined);

// ---- which received files were already saved to the device ----
export const loadSaved = (slug: string) => new Set(read<string[]>(SAVED + slug) ?? []);
export const markSaved = (slug: string, ids: Set<string>) => write(SAVED + slug, [...ids]);