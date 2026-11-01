'use client';
import { useEffect, useRef, useState } from 'react';
import type { DataConnection, Peer } from 'peerjs';
import { QRCodeSVG } from 'qrcode.react';
import { Dropzone } from './DropZone';
import { FileList } from './FileList';
import { Terminal, useLog } from '../lib/Terminal';
import { AsciiProgress } from './AsciiProgress';
import { formatBytes } from '@/lib/format';
import { ICE_SERVERS } from '@/lib/ice';
import { makeSlug } from '@/lib/slug';
import { traceConnection } from '@/lib/diagnostics';
import { fileId, parseMsg, pickChunkSize, sendMsg, typeOf, type FileMeta, type Want } from '@/lib/protocol';
import { sendFiles } from '@/lib/send';
import {
  clearSenderSession,
  loadSenderSession,
  needsResume,
  saveSenderSession,
  type SenderSession,
} from '@/lib/dropstore';
import { useWakeLock } from '@/lib/usewakeLock';
import { useVisibilityLog } from '@/lib/useVisibilityLog';

type Lvl = 'info' | 'ok' | 'warn' | 'err';
const keyOf = (f: File) => `${f.name}-${f.size}-${f.lastModified}`;
const DAY = 24 * 60 * 60 * 1000;
const RECLAIM_MS = 60000; // how long to keep trying to get the old link back

type Phase = 'idle' | 'starting' | 'hosting';
type PeerInfo = {
  state: 'connecting' | 'connected' | 'sending' | 'done' | 'offline';
  sent: number;
  total: number;
  verified: number;
};
const blank: PeerInfo = { state: 'connecting', sent: 0, total: 0, verified: 0 };

function withIds(files: File[]) {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const base = fileId(file);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, file };
  });
}

export function Uploader() {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [link, setLink] = useState('');
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({});
  const [copied, setCopied] = useState(false);
  const [resume, setResume] = useState<SenderSession | null>(null);
  const { lines, log } = useLog();

  const peerRef = useRef<Peer | null>(null);
  const hostGen = useRef(0); // bumps on start/stop so stale timers and peers do nothing
  const slugRef = useRef('');
  const filesRef = useRef(new Map<string, File>());
  const manifestRef = useRef<FileMeta[]>([]);
  const verifiedRef = useRef(new Map<string, Set<string>>());
  const connsRef = useRef(new Map<string, DataConnection>());
  const pendingRef = useRef(new Set<string>());
  const doneRef = useRef(new Set<string>());

  const update = (key: string, patch: Partial<PeerInfo>) =>
    setPeers((prev) => {
      const next = { ...prev };
      next[key] = { ...(prev[key] ?? blank), ...patch };
      return next;
    });

  const saveSession = () => {
    if (!slugRef.current) return;
    saveSenderSession({
      slug: slugRef.current,
      ids: manifestRef.current.map((f) => f.id),
      pending: [...pendingRef.current],
      done: doneRef.current.size,
    });
  };

  // Record whether this receiver still needs files. Returns true if it has everything.
  const track = (key: string, verified: Set<string>) => {
    const all = verified.size >= manifestRef.current.length;
    if (all) {
      pendingRef.current.delete(key);
      doneRef.current.add(key);
    } else {
      pendingRef.current.add(key);
    }
    saveSession();
    return all;
  };

  // Only offer to resume drops that were actually left unfinished.
  useEffect(() => {
    const s = loadSenderSession();
    if (s && Date.now() - s.updated < DAY && needsResume(s)) setResume(s);
    else clearSenderSession();
  }, []);

  // ---------- file selection ----------
  function add(incoming: File[]) {
    setFiles((prev) => {
      const seen = new Set(prev.map(keyOf));
      return [...prev, ...incoming.filter((f) => !seen.has(keyOf(f)))];
    });
  }
  const remove = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  // ---------- hosting ----------
  async function start() {
    const tagged = withIds(files);
    filesRef.current = new Map(tagged.map((t) => [t.id, t.file]));
    manifestRef.current = tagged.map((t) => ({
      id: t.id,
      name: t.file.name,
      size: t.file.size,
      type: typeOf(t.file.name, t.file.type),
    }));
    pendingRef.current.clear();
    doneRef.current.clear();

    const my = ++hostGen.current;
    const alive = () => hostGen.current === my;
    const wanted = resume?.slug ?? null;
    if (resume) {
      const matched = tagged.filter((t) => resume.ids.includes(t.id)).length;
      log(`resuming ${resume.slug} · ${matched}/${resume.ids.length} original files matched`, matched ? 'ok' : 'warn');
    }

    setPhase('starting');
    log('requesting peer id…');
    const mod = await import('peerjs');
    if (!alive()) return;

    let deadline = Date.now() + RECLAIM_MS;
    let waitLogged = false;

    const open = (slug: string | null) => {
      if (!alive()) return;
      const peer = new mod.Peer(slug ?? makeSlug(), { config: { iceServers: ICE_SERVERS } });

      peer.on('open', (id) => {
        if (!alive()) return peer.destroy();
        peerRef.current = peer;
        slugRef.current = id;
        setLink(`${window.location.origin}/d/${id}`);
        setPhase('hosting');
        setResume(null);
        saveSession();
        log(`listening as ${id}`, 'ok');
      });

      peer.on('connection', (c) => {
        if (alive()) serve(c);
        else c.close();
      });

      // Lost the signaling server: open channels keep working, just re-register.
      peer.on('disconnected', () => {
        if (!alive() || peer.destroyed) return;
        try {
          peer.reconnect();
        } catch {
          // the 5s heal loop retries
        }
      });

      // Destroyed unexpectedly (fatal signaling error): reopen the same link.
      peer.on('close', () => {
        if (!alive() || peerRef.current !== peer) return;
        peerRef.current = null;
        log('signaling connection lost · reopening the same link', 'warn');
        deadline = Date.now() + RECLAIM_MS;
        setTimeout(() => open(slugRef.current || null), 2000);
      });

      peer.on('error', (err) => {
        if (!alive()) return;
        if (err.type === 'unavailable-id') {
          peer.destroy(); // peerRef isn't this peer, so its 'close' is ignored
          if (slug && Date.now() < deadline) {
            if (!waitLogged) log('old link still registered · waiting for it to free up (up to 60s)', 'warn');
            waitLogged = true;
            setTimeout(() => open(slug), 3000);
          } else {
            if (slug) log('could not get the old link back · made a new one, share the new QR', 'warn');
            open(null);
          }
          return;
        }
        if (err.type === 'peer-unavailable') return; // not relevant for the sender
        log(`signaling: ${err.type}`, 'warn');
      });
    };

    open(wanted);
  }

  function serve(conn: DataConnection) {
    const key = (conn.metadata as { client?: string } | undefined)?.client ?? conn.connectionId;
    const who = `peer ${key.slice(0, 6)}`;
    const verified = verifiedRef.current.get(key) ?? new Set<string>();
    verifiedRef.current.set(key, verified);

    // Register the new connection *before* closing the old one,
    // so the old one's close event knows it has been replaced.
    const prev = connsRef.current.get(key);
    connsRef.current.set(key, conn);
    prev?.close();

    const current = () => connsRef.current.get(key) === conn;
    const clog = (m: string, l?: Lvl) => {
      if (current()) log(m, l);
    };
    let busy = false;
    let queued: Want[] | null = null;

    update(key, { state: 'connecting', verified: verified.size });
    clog(prev ? `${who} reconnecting…` : `${who} connecting…`);
    traceConnection(conn, clog);

    conn.on('open', () => {
      if (!current()) return;
      conn.dataChannel.binaryType = 'arraybuffer';
      const all = track(key, verified);
      update(key, { state: all ? 'done' : 'connected' });
      sendMsg(conn.dataChannel, { kind: 'manifest', files: manifestRef.current });
      clog(`manifest sent to ${who} (${manifestRef.current.length} files)`, 'ok');
    });

    async function run(want: Want[]) {
      busy = true;
      const sizes = new Map(manifestRef.current.map((f) => [f.id, f.size]));
      const total = want.reduce((s, w) => s + (sizes.get(w.id) ?? 0), 0);
      const already = want.reduce((s, w) => s + w.offset, 0);
      update(key, { state: 'sending', sent: already, total });

      const chunk = pickChunkSize(conn.peerConnection);
      clog(
        `sending ${want.length} file${want.length === 1 ? '' : 's'} to ${who}` +
          (already ? ` · resuming, ${formatBytes(already)} already there` : '') +
          ` · chunk ${chunk / 1024} KB`
      );

      const t0 = performance.now();
      let lastUi = 0;
      try {
        const stats = await sendFiles(
          conn.dataChannel,
          filesRef.current,
          want,
          (done) => {
            const now = performance.now();
            if (now - lastUi > 150 && current()) {
              lastUi = now;
              update(key, { sent: done });
            }
          },
          chunk,
          clog
        );
        const secs = Math.max((performance.now() - t0) / 1000, 0.001);
        clog(`sent ${formatBytes(stats.bytes)} to ${who} in ${secs.toFixed(1)}s · avg ${formatBytes(stats.bytes / secs)}/s`, 'ok');
        if (current()) {
          update(key, { sent: total, state: verified.size >= manifestRef.current.length ? 'done' : 'connected' });
        }
      } catch (err) {
        if (current()) {
          update(key, { state: 'offline' });
          log(`transfer to ${who} paused: ${(err as Error).message} · resumes when they reconnect`, 'warn');
        }
      } finally {
        busy = false;
        if (queued && conn.open && current()) {
          const w = queued;
          queued = null;
          run(w);
        }
      }
    }

    conn.on('data', (raw) => {
      if (!current()) return;
      const msg = parseMsg(raw);
      if (!msg) return;

      if (msg.kind === 'ping') {
        if (conn.open) sendMsg(conn.dataChannel, { kind: 'pong' });
        return;
      }

      if (msg.kind === 'received') {
        const had = verified.has(msg.id);
        verified.add(msg.id);
        const all = track(key, verified);
        update(key, all ? { verified: verified.size, state: 'done' } : { verified: verified.size });
        if (all && !had) log(`${who} has everything ✓`, 'ok');
        return;
      }

      if (msg.kind !== 'start') return;
      if (busy) {
        queued = msg.want;
        return;
      }
      run(msg.want);
    });

    conn.on('close', () => {
      if (!current()) return; // replaced by a newer connection from the same phone
      connsRef.current.delete(key);
      setPeers((prev) => {
        const p = prev[key];
        if (!p || p.state === 'done') return prev;
        const next = { ...prev };
        next[key] = { ...p, state: 'offline' };
        return next;
      });
      log(`${who} disconnected`, 'warn');
    });

    conn.on('error', (err) => clog(`connection error: ${err.type}`, 'err'));
  }

  function stop() {
    hostGen.current++;
    peerRef.current?.destroy();
    peerRef.current = null;
    slugRef.current = '';
    connsRef.current.clear();
    verifiedRef.current.clear();
    pendingRef.current.clear();
    doneRef.current.clear();
    clearSenderSession();
    setPhase('idle');
    setLink('');
    setPeers({});
    log('sharing stopped', 'warn');
  }

  // ---------- effects (before any early return) ----------
  useEffect(
    () => () => {
      hostGen.current++;
      peerRef.current?.destroy();
    },
    []
  );

  useEffect(() => {
    if (phase !== 'hosting') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  // Re-register with the signaling server whenever the phone wakes up or the network returns,
  // so receivers can find this phone again.
  useEffect(() => {
    if (phase !== 'hosting') return;
    const heal = () => {
      const p = peerRef.current;
      if (p && !p.destroyed && p.disconnected) {
        try {
          p.reconnect();
        } catch {
          // try again on the next tick
        }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') heal();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', heal);
    const timer = setInterval(heal, 5000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', heal);
      clearInterval(timer);
    };
  }, [phase]);

  useWakeLock(phase === 'hosting', log);
  useVisibilityLog(phase === 'hosting', log);

  // ---------- render ----------
  const matched = resume ? withIds(files).filter((t) => resume.ids.includes(t.id)).length : 0;

  const banner =
    phase === 'idle' && resume ? (
      <div className="space-y-2 rounded border border-warn/40 bg-panel p-3 text-xs">
        <div>
          unfinished drop <span className="text-accent">{resume.slug}</span> · {resume.ids.length} files
          {resume.pending.length > 0 && ` · ${resume.pending.length} still receiving`}
        </div>
        <div className="text-dim">
          re-select the same files to continue on the same link. friends who were receiving pick up where they left off.
        </div>
        {files.length > 0 && (
          <div className={matched ? 'text-accent' : 'text-warn'}>
            {matched}/{resume.ids.length} files matched
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            clearSenderSession();
            setResume(null);
          }}
          className="text-dim hover:text-err"
        >
          forget it
        </button>
      </div>
    ) : null;

  if (files.length === 0 && phase === 'idle') {
    return (
      <div className="space-y-4">
        {banner}
        <Dropzone onFiles={add} />
        {lines.length > 0 && <Terminal lines={lines} />}
      </div>
    );
  }

  const entries = Object.entries(peers);
  const everyone = entries.filter(([, p]) => p.state === 'done').length;

  return (
    <div className="space-y-4">
      {banner}
      <FileList files={files} onRemove={phase === 'idle' ? remove : undefined} />

      {phase === 'idle' && (
        <>
          <Dropzone onFiles={add} compact />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={start}
              className="flex-1 border border-accent px-4 py-2 text-accent transition-colors hover:bg-accent hover:text-bg"
            >
              {resume ? 'resume sharing →' : 'start sharing →'}
            </button>
            <button
              type="button"
              onClick={() => setFiles([])}
              className="border border-line px-4 py-2 text-dim hover:border-dim hover:text-fg"
            >
              clear
            </button>
          </div>
        </>
      )}

      {phase === 'starting' && <div className="cursor text-dim">opening channel</div>}

      {phase === 'hosting' && (
        <div className="space-y-4 rounded border border-line bg-panel p-4">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <QRCodeSVG value={link} size={148} bgColor="#c8d3cc" fgColor="#0a0c0b" marginSize={2} />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="text-xs text-dim">scan or open on the other device</div>
              <div className="break-all text-accent">{link}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="border border-line px-3 py-1 text-xs hover:border-dim"
                >
                  {copied ? 'copied ✓' : 'copy link'}
                </button>
                <button
                  type="button"
                  onClick={stop}
                  className="border border-line px-3 py-1 text-xs text-dim hover:border-err hover:text-err"
                >
                  stop sharing
                </button>
              </div>
            </div>
          </div>

          {entries.length > 0 && (
            <div className="space-y-3 border-t border-line pt-3">
              {entries.map(([k, p]) => (
                <div key={k} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-dim">peer {k.slice(0, 6)}</span>
                    <span className={p.state === 'done' ? 'text-accent' : p.state === 'offline' ? 'text-warn' : ''}>
                      {p.state === 'done' ? '✓ has everything' : `${p.state} · ${p.verified}/${files.length}`}
                    </span>
                  </div>
                  {p.total > 0 && p.state !== 'done' && <AsciiProgress value={p.sent} total={p.total} />}
                </div>
              ))}
            </div>
          )}

          <div className="text-xs text-dim">
            {everyone}/{entries.length} have everything · keep this tab open
          </div>
        </div>
      )}

      {lines.length > 0 && <Terminal lines={lines} />}
    </div>
  );
}