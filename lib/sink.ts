import { forgetStaleDrops, loadReceiverDrop } from './dropstore';

const DAY = 24 * 60 * 60 * 1000;

export type Sink = {
  kind: 'disk' | 'memory';
  sizes(ids: string[]): Promise<Record<string, number>>;
  open(id: string, offset: number): void;
  write(buf: ArrayBuffer): void;
  close(): Promise<void>;
  getFile(id: string, name: string, type: string): Promise<File | null>;
  dispose(): void;
};

export async function createSink(slug: string, onError: (msg: string) => void): Promise<Sink> {
  await sweep(slug);
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear our files
  return (await diskSink(slug, onError)) ?? memorySink();
}

// Delete drops older than 3 days, folders with no record, and folders from the old version.
async function sweep(keep: string) {
  try {
    if (!navigator.storage?.getDirectory) return;
    forgetStaleDrops(3 * DAY);
    const root = await navigator.storage.getDirectory();
    const doomed: string[] = [];
    const entries = (root as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries();
    for await (const [name] of entries) {
      if (name.startsWith('incoming-')) doomed.push(name);
      else if (name.startsWith('drop-')) {
        const s = name.slice(5);
        if (s !== keep && !loadReceiverDrop(s)) doomed.push(name);
      }
    }
    for (const n of doomed) await root.removeEntry(n, { recursive: true }).catch(() => {});
  } catch {
    // cleanup is best effort
  }
}

async function diskSink(slug: string, onError: (msg: string) => void): Promise<Sink | null> {
  if (typeof Worker === 'undefined' || !navigator.storage?.getDirectory) return null;

  const dirName = `drop-${slug}`;
  const worker = new Worker('/sink-worker.js');
  const waiters: ((reply: any) => void)[] = [];
  let lastError = '';

  worker.onmessage = (e) => {
    if (e.data.op === 'error') {
      if (e.data.message !== lastError) onError(e.data.message); // don't repeat the same error
      lastError = e.data.message;
      return;
    }
    waiters.shift()?.(e.data);
  };

  const ask = (msg: object) =>
    new Promise<any>((resolve) => {
      waiters.push(resolve);
      worker.postMessage(msg);
    });

  const timeout = new Promise<any>((r) => setTimeout(() => r({ ok: false }), 3000));
  const ready = await Promise.race([ask({ op: 'init', dir: dirName }), timeout]);
  if (!ready.ok) {
    worker.terminate();
    return null;
  }

  return {
    kind: 'disk',
    async sizes(ids) {
      return (await ask({ op: 'sizes', ids })).sizes ?? {};
    },
    open(id, offset) {
      lastError = '';
      worker.postMessage({ op: 'open', id, offset });
    },
    write(buf) {
      worker.postMessage({ op: 'write', buf }, [buf]); // hand over without copying
    },
    async close() {
      const reply = await ask({ op: 'close' });
      if (!reply.ok && reply.message) throw new Error(reply.message);
    },
    async getFile(id, name, type) {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(dirName);
        const f = await (await dir.getFileHandle(id)).getFile();
        return new File([f], name, { type, lastModified: f.lastModified });
      } catch {
        return null;
      }
    },
    dispose() {
      worker.terminate();
    },
  };
}

// Fallback when disk storage isn't available: works, but forgets everything on reload.
function memorySink(): Sink {
  const store = new Map<string, ArrayBuffer[]>();
  let current = '';
  const size = (id: string) => (store.get(id) ?? []).reduce((s, b) => s + b.byteLength, 0);

  return {
    kind: 'memory',
    async sizes(ids) {
      return Object.fromEntries(ids.map((id) => [id, size(id)]));
    },
    open(id, offset) {
      const kept: ArrayBuffer[] = [];
      let n = 0;
      for (const b of store.get(id) ?? []) {
        if (n + b.byteLength > offset) break;
        kept.push(b);
        n += b.byteLength;
      }
      store.set(id, kept);
      current = id;
    },
    write(buf) {
      store.get(current)?.push(buf);
    },
    async close() {},
    async getFile(id, name, type) {
      const parts = store.get(id);
      return parts ? new File(parts, name, { type }) : null;
    },
    dispose() {
      store.clear();
    },
  };
}