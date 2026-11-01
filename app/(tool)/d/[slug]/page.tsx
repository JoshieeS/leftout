'use client';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type { DataConnection, Peer } from 'peerjs';
import { Terminal, useLog } from '@/lib/Terminal';
import { AsciiProgress } from '@/components/AsciiProgress';
import { Thumb } from '@/components/Thumb';
import { SaveBar } from '@/components/SaveBar';
import { formatBytes } from '@/lib/format';
import { ICE_SERVERS } from '@/lib/ice';
import { traceConnection } from '@/lib/diagnostics';
import { BLOCK, parseMsg, sendMsg, type FileMeta, type Msg, type Want } from '@/lib/protocol';
import { concat, sha256Hex } from '@/lib/hash';
import { createSink, type Sink } from '@/lib/sink';
import { clientId, loadReceiverDrop, saveReceiverDrop } from '@/lib/dropstore';
import { useWakeLock } from '@/lib/usewakeLock';
import { useVisibilityLog } from '@/lib/useVisibilityLog';

type Phase = 'loading' | 'connecting' | 'connected' | 'receiving' | 'reconnecting' | 'waiting' | 'done' | 'error';
type Got = { id: string; file: File; url: string };
type Block = { offset: number; size: number; hash: string };
type Cur = { meta: FileMeta; next: number; block: Block | null; parts: ArrayBuffer[]; got: number; bad: boolean };

const statusText: Record<Phase, string> = {
  loading: 'loading',
  connecting: 'connecting to sender',
  connected: 'connected · ready',
  receiving: 'receiving · keep this tab open',
  reconnecting: 'connection dropped · reconnecting, your progress is saved',
  waiting: 'sender is offline · this page continues on its own when they are back',
  done: 'everything received and verified ✓',
  error: 'some files kept failing verification · see log',
};

export default function DownloadPage() {
  const { slug } = useParams<{ slug: string }>();
  const { lines, log } = useLog();
  const [phase, setPhase] = useState<Phase>('loading');
  const [manifest, setManifest] = useState<FileMeta[]>([]);
  const [bytes, setBytes] = useState(0);
  const [perFile, setPerFile] = useState<Record<string, number>>({});
  const [received, setReceived] = useState<Got[]>([]);
  const [started, setStarted] = useState(false);
  const phaseRef = useRef<Phase>('loading');
  const startRef = useRef<() => void>(() => {});

  const go = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  useEffect(() => {
    let disposed = false;
    let peer: Peer | undefined;
    let conn: DataConnection | undefined;
    let sink: Sink | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let rounds = 0;
    let lastUi = 0;
    let cur: Cur | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    const urls: string[] = [];

    // ---- memory from an earlier visit ----
    const saved = loadReceiverDrop(slug);
    let files: FileMeta[] = saved?.manifest ?? [];
    let wantsStart = saved?.started ?? false;
    const verified = new Set<string>();
    const haveBytes: Record<string, number> = {};

    // Storage steps run strictly in order, even though some are async.
    const q = (fn: () => unknown) => {
      chain = chain.then(fn).catch((e) => log(`storage: ${(e as Error).message}`, 'err'));
    };
    const persist = () => saveReceiverDrop(slug, { manifest: files, verified: [...verified], started: wantsStart });
    const send = (msg: Msg) => {
      if (conn?.open) sendMsg(conn.dataChannel, msg);
    };

    const refresh = (force = false) => {
      const now = performance.now();
      if (!force && now - lastUi < 150) return;
      lastUi = now;
      const stored = files.reduce((s, f) => s + Math.min(haveBytes[f.id] ?? 0, f.size), 0);
      setBytes(stored + (cur?.got ?? 0));
      setPerFile({ ...haveBytes });
    };

    // Everything not yet verified, resuming at the last verified block.
    const wants = (): Want[] =>
      files
        .filter((f) => !verified.has(f.id))
        .map((f) => ({ id: f.id, offset: Math.floor((haveBytes[f.id] ?? 0) / BLOCK) * BLOCK }));

    async function addReceived(meta: FileMeta) {
      const file = await sink!.getFile(meta.id, meta.name, meta.type);
      if (!file || disposed) return;
      const url = URL.createObjectURL(file);
      urls.push(url);
      setReceived((r) => (r.some((x) => x.id === meta.id) ? r : [...r, { id: meta.id, file, url }]));
    }

    // Work out what's already on disk. Only verified blocks are ever written,
    // so a full-size file on disk is a complete, checked file.
    async function restore(prevVerified: Set<string>) {
      const sizes = await sink!.sizes(files.map((f) => f.id));
      verified.clear();
      for (const f of files) {
        const s = Math.min(sizes[f.id] ?? 0, f.size);
        haveBytes[f.id] = s === f.size ? s : Math.floor(s / BLOCK) * BLOCK;
        if (s === f.size && (s > 0 || prevVerified.has(f.id))) {
          verified.add(f.id);
          await addReceived(f);
        }
      }
    }

    function finish() {
      if (phaseRef.current === 'done') return;
      go('done');
      refresh(true);
      log(`all ${files.length} files received and verified ✓`, 'ok');
    }

    function requestFiles() {
      const w = wants();
      if (!w.length) return finish();
      if (!conn?.open) return;
      send({ kind: 'start', want: w });
      go('receiving');
      const resumed = w.filter((x) => x.offset > 0).length;
      log(`requesting ${w.length} file${w.length === 1 ? '' : 's'}${resumed ? ` · resuming ${resumed} mid-file` : ''}`);
    }

    // Called when the user taps "download".
    startRef.current = () => {
      wantsStart = true;
      persist();
      setStarted(true);
      q(() => requestFiles());
    };

    function onData(data: unknown) {
      // ---- binary: part of the current block ----
      if (data instanceof ArrayBuffer) {
        const c = cur;
        if (!c || !c.block || c.bad) return;
        c.parts.push(data);
        c.got += data.byteLength;
        if (c.got > c.block.size) {
          c.bad = true;
          log(`${c.meta.name}: too much data in a block · will resend`, 'err');
          return;
        }
        if (c.got === c.block.size) {
          const block = c.block;
          const buf = concat(c.parts);
          c.parts = [];
          c.got = 0;
          c.block = null;
          q(async () => {
            if (c.bad) return;
            if ((await sha256Hex(buf)) !== block.hash) {
              c.bad = true;
              log(`${c.meta.name}: block at ${formatBytes(block.offset)} failed verification · will resend`, 'err');
              return;
            }
            sink!.write(buf); // only verified bytes ever reach the disk
            haveBytes[c.meta.id] = block.offset + block.size;
            refresh();
          });
        }
        refresh();
        return;
      }

      // ---- text: control message ----
      const msg = parseMsg(data);
      if (!msg) return;

      switch (msg.kind) {
        case 'manifest': {
          files = msg.files;
          setManifest(files);
          const prev = new Set([...verified, ...(loadReceiverDrop(slug)?.verified ?? [])]);
          q(async () => {
            await restore(prev);
            persist();
            refresh(true);
            const total = files.reduce((s, f) => s + f.size, 0);
            log(
              `manifest: ${files.length} files, ${formatBytes(total)}` +
                (verified.size ? ` · ${verified.size} already here` : ''),
              'ok'
            );
            verified.forEach((id) => send({ kind: 'received', id })); // keep the sender's view accurate
            if (wantsStart) requestFiles();
            else if (phaseRef.current !== 'done') go('connected');
          });
          break;
        }
        case 'file-start': {
          const meta = files.find((f) => f.id === msg.id);
          if (!meta) {
            cur = null;
            break;
          }
          cur = { meta, next: msg.offset, block: null, parts: [], got: 0, bad: false };
          const off = msg.offset;
          q(() => {
            sink!.open(meta.id, off);
            haveBytes[meta.id] = off;
          });
          break;
        }
        case 'block': {
          const c = cur;
          if (!c || c.bad) break;
          if (msg.id !== c.meta.id || msg.offset !== c.next) {
            c.bad = true;
            log(`${c.meta.name}: block out of order · will resend`, 'err');
            break;
          }
          c.block = { offset: msg.offset, size: msg.size, hash: msg.hash };
          c.next = msg.offset + msg.size;
          break;
        }
        case 'file-end': {
          const c = cur;
          cur = null;
          if (!c) break;
          q(async () => {
            await sink!.close();
            if (!c.bad && haveBytes[c.meta.id] === c.meta.size) {
              verified.add(c.meta.id);
              persist();
              send({ kind: 'received', id: c.meta.id });
              await addReceived(c.meta);
              log(`✓ ${c.meta.name}`, 'ok');
            } else {
              log(`${c.meta.name}: incomplete · will retry`, 'warn');
            }
            refresh(true);
          });
          break;
        }
        case 'complete': {
          q(() => {
            if (!wants().length) return finish();
            if (++rounds <= 3) return requestFiles(); // resend anything that failed the check
            go('error');
            log('some files kept failing verification', 'err');
          });
          break;
        }
      }
    }

    // ---- connection + automatic reconnect ----
    function onDrop(reason: string) {
      if (disposed || phaseRef.current === 'done') return;
      const c = cur;
      cur = null;
      if (c) q(() => sink!.close()); // keep verified blocks, discard the half-received one
      refresh(true);
      if (phaseRef.current !== 'reconnecting' && phaseRef.current !== 'waiting') {
        log(`${reason} · reconnecting, progress is saved`, 'warn');
      }
      go(phaseRef.current === 'waiting' ? 'waiting' : 'reconnecting');
      scheduleReconnect();
    }

    // Retry after 1s, 2s, 4s, 8s, then every 15s.
    function scheduleReconnect() {
      if (disposed || timer) return;
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      attempt++;
      timer = setTimeout(() => {
        timer = undefined;
        connect();
      }, delay);
    }

    function connect() {
      if (disposed || !peer || peer.destroyed) return;
      if (peer.disconnected) {
        // Lost the signaling server too: reconnect it first; its 'open' event dials again.
        try {
          peer.reconnect();
        } catch {
          scheduleReconnect();
        }
        return;
      }

      conn?.close();
      clearTimeout(openTimer);
      log(`dialing ${slug}…`);
      const c = peer.connect(slug, { reliable: true, serialization: 'raw', metadata: { client: clientId() } });
      conn = c;
      traceConnection(c, log);

      // If the channel never opens, treat it as a drop and try again.
      openTimer = setTimeout(() => {
        if (conn === c && !c.open) {
          c.close();
          onDrop('connection timed out');
        }
      }, 20000);

      c.on('open', () => {
        if (conn !== c) return;
        clearTimeout(openTimer);
        attempt = 0;
        c.dataChannel.binaryType = 'arraybuffer';
        const p = phaseRef.current;
        if (p === 'reconnecting' || p === 'waiting') log('reconnected', 'ok');
        if (p !== 'done') go('connected'); // the manifest that follows resumes the transfer
      });
      c.on('data', (d) => {
        if (conn === c) onData(d);
      });
      c.on('close', () => {
        if (conn === c) onDrop('connection closed');
      });
      c.on('error', () => {
        if (conn === c) onDrop('connection error');
      });
    }

    // Reconnect straight away when the tab comes back or the network returns.
    const kick = () => {
      if (disposed || !peer || phaseRef.current === 'done' || conn?.open) return;
      clearTimeout(timer);
      timer = undefined;
      attempt = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', kick);

    // ---- start up ----
    (async () => {
      sink = await createSink(slug, (m) => log(`storage error: ${m}`, 'err'));
      if (disposed) return sink.dispose();
      log(
        sink.kind === 'disk' ? 'storage: disk (opfs) · progress survives reloads' : 'storage: memory · progress is lost on reload',
        sink.kind === 'disk' ? 'ok' : 'warn'
      );

      if (files.length) {
        setManifest(files);
        await restore(new Set(saved?.verified ?? []));
        refresh(true);
        if (verified.size) log(`restored ${verified.size}/${files.length} files from last time`, 'ok');
        if (verified.size === files.length) finish();
      }
      setStarted(wantsStart);

      const mod = await import('peerjs');
      if (disposed) return;
      if (phaseRef.current !== 'done') go('connecting');

      log('requesting peer id…');
      peer = new mod.Peer({ config: { iceServers: ICE_SERVERS } });

      peer.on('open', () => {
        if (!conn?.open) connect();
      });

      peer.on('disconnected', () => {
        if (disposed || peer!.destroyed) return;
        try {
          peer!.reconnect();
        } catch {
          // the error handler schedules the next attempt
        }
      });

      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          clearTimeout(openTimer);
          if (phaseRef.current === 'done') return;
          if (phaseRef.current !== 'waiting') log('sender is offline · will keep trying', 'warn');
          go('waiting');
          attempt = Math.max(attempt, 3); // check every ~8–15s while waiting
          scheduleReconnect();
          return;
        }
        if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)) {
          onDrop(`signaling: ${err.type}`);
          return;
        }
        log(`error: ${err.type}`, 'err');
      });
    })();

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(openTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', kick);
      peer?.destroy();
      sink?.dispose();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [slug, log, go]);

  useWakeLock(phase === 'receiving', log);
  useVisibilityLog(phase === 'receiving' || phase === 'connected', log);

  // ---------- render ----------
  const total = manifest.reduce((s, f) => s + f.size, 0);
  const doneIds = new Set(received.map((r) => r.id));
  const order = new Map(manifest.map((f, i) => [f.id, i]));
  const gallery = [...received].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const tone =
    phase === 'done'
      ? 'text-accent'
      : phase === 'error'
        ? 'text-err'
        : phase === 'reconnecting' || phase === 'waiting'
          ? 'text-warn'
          : phase === 'loading' || phase === 'connecting'
            ? 'cursor text-dim'
            : 'text-accent';

  return (
    <section className="space-y-6">
      <h1 className="text-lg">
        incoming from <span className="text-accent">{slug}</span>
      </h1>

      <div className={tone}>{statusText[phase]}</div>

      {phase === 'connected' && !started && manifest.length > 0 && (
        <button
          type="button"
          onClick={() => startRef.current()}
          className="w-full border border-accent px-4 py-3 text-accent transition-colors hover:bg-accent hover:text-bg"
        >
          download {manifest.length} file{manifest.length === 1 ? '' : 's'} · {formatBytes(total)} →
        </button>
      )}

      {started && manifest.length > 0 && phase !== 'done' && <AsciiProgress value={bytes} total={total} />}

      <SaveBar items={gallery} slug={slug} />

      {manifest.length > 0 && (
        <div className="rounded border border-line bg-panel">
          <ul className="max-h-64 divide-y divide-line overflow-y-auto">
            {manifest.map((f) => {
              const ok = doneIds.has(f.id);
              const pct = f.size ? Math.floor(((perFile[f.id] ?? 0) / f.size) * 100) : 0;
              return (
                <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {f.type.startsWith('video/') && <span className="text-xs text-accent">vid</span>}
                  <span className="text-xs text-dim">{formatBytes(f.size)}</span>
                  <span className={`w-10 text-right text-xs ${ok ? 'text-accent' : 'text-dim'}`}>
                    {ok ? '✓' : started ? `${pct}%` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-between border-t border-line px-3 py-2 text-xs text-dim">
            <span>
              {received.length}/{manifest.length} verified
            </span>
            <span>{formatBytes(total)}</span>
          </div>
        </div>
      )}

      {gallery.length > 0 && (
        <ul className="grid grid-cols-3 gap-2">
          {gallery.map((r) => (
            <li key={r.id} className="min-w-0 space-y-1">
              {createElement(Thumb, { src: r.url, type: r.file.type, name: r.file.name, large: true })}
              {createElement(
                'a',
                { href: r.url, download: r.file.name, className: 'block truncate text-xs text-accent hover:underline' },
                `↓ ${r.file.name}`
              )}
            </li>
          ))}
        </ul>
      )}

      <Terminal lines={lines} />
    </section>
  );
}