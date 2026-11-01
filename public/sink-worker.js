// Dedicated worker: writes verified blocks to the Origin Private File System.
let dir = null;
let handle = null;
let pos = 0;
let failure = null;
let chain = Promise.resolve();

// Handle messages strictly in order, even though some steps are async.
self.onmessage = (e) => {
  chain = chain
    .then(() => run(e.data))
    .catch((err) => {
      failure = failure || String(err);
      self.postMessage({ op: 'error', message: String(err) });
    });
};

async function closeHandle() {
  if (!handle) return;
  handle.flush();
  handle.close();
  handle = null;
}

async function run(m) {
  switch (m.op) {
    case 'init': {
      try {
        const root = await navigator.storage.getDirectory();
        dir = await root.getDirectoryHandle(m.dir, { create: true });
        const probe = await dir.getFileHandle('.probe', { create: true });
        (await probe.createSyncAccessHandle()).close();
        await dir.removeEntry('.probe');
        self.postMessage({ op: 'reply', ok: true });
      } catch (err) {
        self.postMessage({ op: 'reply', ok: false, message: String(err) });
      }
      return;
    }
    case 'sizes': {
      const sizes = {};
      for (const id of m.ids) {
        try {
          sizes[id] = (await (await dir.getFileHandle(id)).getFile()).size;
        } catch {
          sizes[id] = 0;
        }
      }
      self.postMessage({ op: 'reply', ok: true, sizes });
      return;
    }
    case 'open': {
      await closeHandle();
      const fh = await dir.getFileHandle(m.id, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(m.offset); // drop anything past the last verified block
      pos = m.offset;
      failure = null;
      return;
    }
    case 'write': {
      if (!handle) throw new Error('write with no open file');
      pos += handle.write(new Uint8Array(m.buf), { at: pos });
      return;
    }
    case 'close': {
      try {
        await closeHandle();
      } catch (err) {
        failure = failure || String(err);
      }
      self.postMessage({ op: 'reply', ok: !failure, message: failure, size: pos });
      failure = null;
      return;
    }
  }
}