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
    let peerMod: typeof import('peerjs') | undefined;
    let peer: Peer | undefined;
    let conn: DataConnection | undefined;
    let sink: Sink | undefined;
    let gen = 0; // bumps on every rebuild; events from older attempts are ignored
    let retry: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let iceTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
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

    // Only verified blocks are ever written, so a full-size file on disk is complete and checked.
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
            sink!.write(buf);
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
            verified.forEach((id) => send({ kind: 'received', id }));
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
            if (++rounds <= 3) return requestFiles();
            go('error');
            log('some files kept failing verification', 'err');
          });
          break;
        }
      }
    }

    // ---------- connection ----------
    // Kill the current attempt completely. Bumping `gen` first means any events
    // the old peer fires while being destroyed are ignored.
    function teardown() {
      gen++;
      clearTimeout(retry);
      clearTimeout(openTimer);
      clearTimeout(iceTimer);
      retry = openTimer = iceTimer = undefined;
      const c = cur;
      cur = null;
      if (c) q(() => sink?.close()); // keep verified blocks, drop the half-received one
      const oldConn = conn;
      const oldPeer = peer;
      conn = undefined;
      peer = undefined;
      try { oldConn?.close(); } catch {}
      try { oldPeer?.destroy(); } catch {}
    }

    // Start from scratch with a brand-new peer: the same thing a page refresh does.
    function rebuild() {
      if (disposed || !peerMod || phaseRef.current === 'done') return;
      teardown();
      const my = gen;
      const live = () => !disposed && my === gen;

      const p = new peerMod.Peer({ config: { iceServers: ICE_SERVERS } });
      peer = p;

      p.on('open', () => {
        if (!live()) return;
        log(`dialing ${slug}…`);
        const c = p.connect(slug, { reliable: true, serialization: 'raw', metadata: { client: clientId() } });
        conn = c;
        traceConnection(c, log);

        openTimer = setTimeout(() => {
          if (live() && !c.open) fail('connection timed out');
        }, 15000);

        c.on('open', () => {
          if (!live()) return;
          clearTimeout(openTimer);
          attempt = 0;
          c.dataChannel.binaryType = 'arraybuffer';
          const ph = phaseRef.current;
          if (ph === 'reconnecting' || ph === 'waiting') log('reconnected', 'ok');
          if (ph !== 'done') go('connected'); // the manifest that follows resumes the transfer
        });
        c.on('data', (d) => {
          if (live()) onData(d);
        });
        c.on('close', () => {
          if (live()) fail('connection closed');
        });
        c.on('error', () => {
          if (live()) fail('connection error');
        });
        // A network drop can leave the channel "open" but dead. Give it 5s to recover.
        c.on('iceStateChanged', (s) => {
          if (!live()) return;
          if (s === 'disconnected') {
            clearTimeout(iceTimer);
            iceTimer = setTimeout(() => {
              if (live()) fail('network lost');
            }, 5000);
          } else if (s === 'connected' || s === 'completed') {
            clearTimeout(iceTimer);
          } else if (s === 'failed' || s === 'closed') {
            fail('network failed');
          }
        });
      });

      // Losing the signaling server doesn't matter while the data channel is up.
      p.on('disconnected', () => {
        if (live() && !conn?.open) fail('signaling lost');
      });

      p.on('error', (err) => {
        if (!live()) return;
        if (err.type === 'peer-unavailable') fail('sender offline', true);
        else fail(`signaling: ${err.type}`);
      });
    }

    // One place handles every failure, and only one retry is ever scheduled.
    function fail(reason: string, senderOffline = false) {
      if (disposed || phaseRef.current === 'done') return;
      teardown();
      refresh(true);
      const next: Phase = senderOffline ? 'waiting' : 'reconnecting';
      if (phaseRef.current !== next) {
        log(senderOffline ? 'sender is offline · will keep trying' : `${reason} · reconnecting, progress is saved`, 'warn');
      }
      go(next);
      const delay = senderOffline ? 8000 : Math.min(1000 * 2 ** attempt, 15000);
      attempt++;
      retry = setTimeout(rebuild, delay);
    }

    // Coming back from the background: iOS froze everything, so rebuild immediately.
    function kick(why: string) {
      if (disposed || !peerMod || phaseRef.current === 'done') return;
      log(`${why} · reconnecting`);
      if (phaseRef.current !== 'waiting') go('reconnecting');
      attempt = 0;
      rebuild();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away > 3000 || !conn?.open) kick('back in foreground');
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) kick('page restored');
    };
    const onOnline = () => {
      if (!conn?.open) kick('network back');
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
      log('requesting peer id…');
      rebuild();
    })();

    return () => {
      disposed = true;
      teardown();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
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