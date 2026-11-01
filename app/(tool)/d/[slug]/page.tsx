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

type Lvl = 'info' | 'ok' | 'warn' | 'err';
type Phase = 'loading' | 'connecting' | 'connected' | 'receiving' | 'reconnecting' | 'waiting' | 'done' | 'error';
type Got = { id: string; file: File; url: string };
type Block = { offset: number; size: number; hash: string };
type Cur = { meta: FileMeta; next: number; block: Block | null; parts: ArrayBuffer[]; got: number; bad: boolean };

const OPEN_TIMEOUT = 12000; // give up on a dial that never opens
const PING_EVERY = 5000;    // when nothing has arrived for this long, ask the sender
const PROBE_WAIT = 4000;    // after returning to the tab, how long to wait for any reply
const STALL_AFTER = 20000;  // no data at all for this long → reconnect

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
    let peerMod: typeof import('peerjs') | undefined;
    let peer: Peer | undefined;
    let conn: DataConnection | undefined;
    let sink: Sink | undefined;
    let peerGen = 0; // events from older peers are ignored
    let connGen = 0; // events from older connections are ignored
    let retry: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let forceFresh = false; // next attempt must register a new peer
    let lastRx = 0;
    let lastPing = 0;
    let probeAt = 0;
    let hiddenAt = 0;
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

    startRef.current = () => {
      wantsStart = true;
      persist();
      setStarted(true);
      q(() => requestFiles());
    };

    function onData(data: unknown) {
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
            sink!.write(buf);
            haveBytes[c.meta.id] = block.offset + block.size;
            refresh();
          });
        }
        refresh();
        return;
      }

      const msg = parseMsg(data);
      if (!msg) return;

      switch (msg.kind) {
        case 'pong':
        case 'ping':
          return; // liveness only; lastRx was already updated
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
            verified.forEach((id) => send({ kind: 'received', id }));
            if (wantsStart) requestFiles();
            else if (phaseRef.current !== 'done') go('connected');
          });
          return;
        }
        case 'file-start': {
          const meta = files.find((f) => f.id === msg.id);
          if (!meta) {
            cur = null;
            return;
          }
          cur = { meta, next: msg.offset, block: null, parts: [], got: 0, bad: false };
          const off = msg.offset;
          q(() => {
            sink!.open(meta.id, off);
            haveBytes[meta.id] = off;
          });
          return;
        }
        case 'block': {
          const c = cur;
          if (!c || c.bad) return;
          if (msg.id !== c.meta.id || msg.offset !== c.next) {
            c.bad = true;
            log(`${c.meta.name}: block out of order · will resend`, 'err');
            return;
          }
          c.block = { offset: msg.offset, size: msg.size, hash: msg.hash };
          c.next = msg.offset + msg.size;
          return;
        }
        case 'file-end': {
          const c = cur;
          cur = null;
          if (!c) return;
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
          return;
        }
        case 'complete': {
          q(() => {
            if (!wants().length) return finish();
            if (++rounds <= 3) return requestFiles();
            go('error');
            log('some files kept failing verification', 'err');
          });
          return;
        }
      }
    }

    // ---------- connection management ----------
    const peerUsable = () => !!peer && peer.open && !peer.disconnected && !peer.destroyed;

    // Close only the data connection. Verified blocks stay on disk.
    function dropConn() {
      connGen++;
      clearTimeout(openTimer);
      openTimer = undefined;
      probeAt = 0;
      const c = cur;
      cur = null;
      if (c) {
        q(async () => {
          try {
            await sink?.close();
          } catch {
            // the half-received block is discarded anyway
          }
        });
      }
      const old = conn;
      conn = undefined;
      try {
        old?.close();
      } catch {}
    }

    function dropPeer() {
      dropConn();
      peerGen++;
      const old = peer;
      peer = undefined;
      try {
        old?.destroy();
      } catch {}
    }

    // Single entry point for every (re)connect. Only one attempt runs at a time.
    function connectNow() {
      clearTimeout(retry);
      retry = undefined;
      if (disposed || !peerMod || phaseRef.current === 'done') return;
      if (forceFresh || !peerUsable()) {
        forceFresh = false;
        newPeer();
      } else {
        dial();
      }
    }

    function newPeer() {
      dropPeer();
      const my = peerGen;
      const live = () => !disposed && my === peerGen;
      const p = new peerMod!.Peer({ config: { iceServers: ICE_SERVERS } });
      peer = p;

      p.on('open', () => {
        if (live()) dial();
      });

      p.on('disconnected', () => {
        if (!live()) return;
        if (conn?.open) {
          try {
            p.reconnect(); // the transfer keeps going; just re-register quietly
          } catch {}
        } else {
          fail('lost signaling server', { fresh: true });
        }
      });

      p.on('error', (err) => {
        if (!live()) return;
        if (err.type === 'peer-unavailable') {
          if (conn && !conn.open) fail('sender offline', { offline: true });
          return;
        }
        if (conn?.open) return; // signaling trouble doesn't matter mid-transfer
        fail(`signaling: ${err.type}`, { fresh: true });
      });
    }

    function dial() {
      if (!peerUsable()) return newPeer();
      dropConn();
      const my = connGen;
      const live = () => !disposed && my === connGen;
      const glog = (m: string, l?: Lvl) => {
        if (live()) log(m, l);
      };

      if (attempt === 0) log(`dialing ${slug}…`);
      const c = peer!.connect(slug, { reliable: true, serialization: 'raw', metadata: { client: clientId() } });
      conn = c;
      traceConnection(c, glog);

      openTimer = setTimeout(() => {
        if (live() && !c.open) fail('connection timed out', { fresh: true });
      }, OPEN_TIMEOUT);

      c.on('open', () => {
        if (!live()) return;
        clearTimeout(openTimer);
        c.dataChannel.binaryType = 'arraybuffer';
        lastRx = Date.now();
        attempt = 0;
        rounds = 0;
        const ph = phaseRef.current;
        if (ph === 'reconnecting' || ph === 'waiting') log('reconnected · resuming', 'ok');
        if (ph !== 'done') go('connected'); // the manifest that follows resumes the transfer
      });
      c.on('data', (d) => {
        if (!live()) return;
        lastRx = Date.now();
        onData(d);
      });
      c.on('close', () => {
        if (live()) fail('connection closed');
      });
      c.on('error', (err) => {
        if (!live()) return;
        if ((err as { type?: string }).type === 'peer-unavailable') fail('sender offline', { offline: true });
        else fail('connection error');
      });
      c.on('iceStateChanged', (s) => {
        if (live() && (s === 'failed' || s === 'closed')) fail('network failed', { fresh: true });
      });
    }

    function fail(reason: string, opts: { offline?: boolean; fresh?: boolean } = {}) {
      if (disposed || phaseRef.current === 'done') return;
      dropConn();
      refresh(true);
      attempt++;
      if (opts.fresh || (!opts.offline && attempt >= 3)) forceFresh = true;

      const next: Phase = opts.offline ? 'waiting' : 'reconnecting';
      if (phaseRef.current !== next) {
        log(opts.offline ? 'sender is offline · will keep checking' : `${reason} · reconnecting, progress is saved`, 'warn');
      }
      go(next);

      const delay = opts.offline ? Math.min(2000 * attempt, 10000) : Math.min(500 * 2 ** (attempt - 1), 8000);
      clearTimeout(retry);
      retry = setTimeout(connectNow, delay);
    }

    // Detects connections that look open but are dead (common after iOS suspends the tab).
    const watchdog = setInterval(() => {
      if (disposed || phaseRef.current === 'done' || !conn?.open) return;
      const now = Date.now();
      if (probeAt) {
        if (lastRx >= probeAt) probeAt = 0; // got a reply: the connection survived
        else if (now - probeAt > PROBE_WAIT) fail('no reply after returning', { fresh: true });
        return;
      }
      if (now - lastRx > PING_EVERY && now - lastPing > PING_EVERY) {
        send({ kind: 'ping' });
        lastPing = now;
      }
      if (now - lastRx > STALL_AFTER) fail('connection stalled', { fresh: true });
    }, 1000);

    // Returning to the tab: test the connection first, only rebuild if it's dead.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (disposed || !peerMod || phaseRef.current === 'done') return;

      if (conn?.open) {
        if (away < 2000) return;
        probeAt = Date.now();
        lastPing = probeAt;
        send({ kind: 'ping' });
        return;
      }
      attempt = 0;
      forceFresh = true; // after a background stretch the signaling socket is usually dead
      if (phaseRef.current !== 'waiting') go('reconnecting');
      log('back in foreground · reconnecting');
      connectNow();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted || disposed || !peerMod) return;
      attempt = 0;
      forceFresh = true;
      log('page restored · reconnecting');
      connectNow();
    };
    const onOnline = () => {
      if (disposed || !peerMod || conn?.open) return;
      attempt = 0;
      connectNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);

    // ---------- start up ----------
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

      peerMod = await import('peerjs');
      if (disposed || phaseRef.current === 'done') return;
      go('connecting');
      connectNow();
    })();

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      dropPeer();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      sink?.dispose();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [slug, log, go]);

  // Keep the screen on for the whole download, not just while bytes are flowing.
  useWakeLock(started && phase !== 'done', log);

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

      <SaveBar items={gallery} slug={slug} ready={phase === 'done'} />

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