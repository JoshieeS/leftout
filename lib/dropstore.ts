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
// pending = receivers that joined but don't have everything yet
// done    = how many receivers finished
export type SenderSession = { slug: string; ids: string[]; pending: string[]; done: number; updated: number };

export function loadSenderSession(): SenderSession | null {
  const s = read<Partial<SenderSession>>(TX);
  if (!s?.slug || !s.ids) return null;
  return { slug: s.slug, ids: s.ids, pending: s.pending ?? [], done: s.done ?? 0, updated: s.updated ?? 0 };
}
export const saveSenderSession = (s: Omit<SenderSession, 'updated'>) => write(TX, { ...s, updated: Date.now() });
export const clearSenderSession = () => safe(() => localStorage.removeItem(TX), undefined);

// Worth resuming if someone is still missing files, or nobody has received it yet.
export const needsResume = (s: SenderSession) => s.pending.length > 0 || s.done === 0;

// ---- which received files were already saved to the device ----
export const loadSaved = (slug: string) => new Set(read<string[]>(SAVED + slug) ?? []);
export const markSaved = (slug: string, ids: Set<string>) => write(SAVED + slug, [...ids]);