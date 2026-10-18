'use client';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type { DataConnection, Peer } from 'peerjs';
import { Terminal, useLog } from '@/lib/Terminal';
import { AsciiProgress } from '@/components/AsciiProgress';
import { Thumb } from '@/components/Thumb';
import { formatBytes } from '@/lib/format';
import { ICE_SERVERS } from '@/lib/ice';
import { traceConnection } from '@/lib/diagnostics';
import { parseMsg, sendMsg, type FileMeta } from '@/lib/protocol';
import { createSink, type Sink } from '@/lib/sink';
import { useWakeLock } from '@/lib/usewakeLock';
import { useVisibilityLog } from '@/lib/useVisibilityLog';

type Phase = 'connecting' | 'connected' | 'receiving' | 'done' | 'unavailable' | 'closed' | 'error';
type Got = { file: File; url: string };

const statusText: Record<Phase, string> = {
  connecting: 'connecting to sender',
  connected: 'connected · ready',
  receiving: 'receiving · keep this tab open',
  done: 'transfer complete',
  unavailable: 'link expired. the sender closed their tab or stopped sharing.',
  closed: 'sender disconnected',
  error: 'connection failed. see log below.',
};

const safe = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_');

export default function DownloadPage() {
  const { slug } = useParams<{ slug: string }>();
  const { lines, log } = useLog();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [manifest, setManifest] = useState<FileMeta[]>([]);
  const [bytes, setBytes] = useState(0);
  const [received, setReceived] = useState<Got[]>([]);
  const connRef = useRef<DataConnection | null>(null);
  const phaseRef = useRef<Phase>('connecting');

  const go = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  useEffect(() => {
    let peer: Peer | undefined;
    let sink: Sink | undefined;
    let cancelled = false;
    const urls: string[] = [];

    (async () => {
      sink = await createSink((m) => log(`storage error: ${m}`, 'err'));
      if (cancelled) return sink.dispose();
      log(
        sink.kind === 'disk' ? 'storage: disk (opfs)' : 'storage: memory · very large videos may fail',
        sink.kind === 'disk' ? 'ok' : 'warn'
      );

      const mod = await import('peerjs');
      if (cancelled) return;

      log('requesting peer id…');
      peer = new mod.Peer({ config: { iceServers: ICE_SERVERS } });

      peer.on('open', () => {
        log(`dialing ${slug}…`);
        const conn = peer!.connect(slug, { reliable: true, serialization: 'raw' });
        connRef.current = conn;
        traceConnection(conn, log);

        let files: FileMeta[] = [];
        let fileBytes = 0;
        let total = 0;
        let lastUi = 0;
        let t0 = 0;

        conn.on('open', () => {
          conn.dataChannel.binaryType = 'arraybuffer';
          go('connected');
        });

        conn.on('data', (data) => {
          // ---- binary: a chunk of the current file ----
          if (data instanceof ArrayBuffer) {
            const n = data.byteLength;   // read first: transferring to the worker empties it
            sink!.write(data);
            fileBytes += n;
            total += n;
            const now = performance.now();
            if (now - lastUi > 100) {
              lastUi = now;
              setBytes(total);
            }
            return;
          }

          // ---- text: a control message ----
          const msg = parseMsg(data);
          if (!msg) return;

          switch (msg.kind) {
            case 'manifest': {
              files = msg.files;
              setManifest(msg.files);
              const size = msg.files.reduce((s, f) => s + f.size, 0);
              log(`manifest: ${msg.files.length} files, ${formatBytes(size)}`, 'ok');
              navigator.storage?.estimate?.().then(({ quota = 0, usage = 0 }) => {
                if (quota && quota - usage < size) {
                  log(`low storage: ${formatBytes(quota - usage)} free, ${formatBytes(size)} needed`, 'warn');
                }
              });
              break;
            }
            case 'file-start': {
              fileBytes = 0;
              if (msg.index === 0) t0 = performance.now();
              sink!.open(`${msg.index}-${safe(files[msg.index].name)}`);
              break;
            }
            case 'file-end': {
              const meta = files[msg.index];
              if (fileBytes !== meta.size) {
                log(`${meta.name}: size mismatch (${fileBytes} of ${meta.size} bytes)`, 'err');
              }
              sink!
                .close(meta.name, meta.type)
                .then((file) => {
                  const url = URL.createObjectURL(file);
                  urls.push(url);
                  setReceived((r) => [...r, { file, url }]);
                  log(`received ${meta.name}`, 'ok');
                })
                .catch((e) => log(`could not save ${meta.name}: ${e}`, 'err'));
              break;
            }
            case 'complete': {
              setBytes(total);
              const secs = Math.max((performance.now() - t0) / 1000, 0.001);
              log(`done · ${formatBytes(total)} in ${secs.toFixed(1)}s · avg ${formatBytes(total / secs)}/s`, 'ok');
              go('done');
              break;
            }
          }
        });

        conn.on('close', () => {
          const p = phaseRef.current;
          if (p === 'done' || p === 'unavailable') return;
          go('closed');
          log(
            p === 'receiving' ? 'sender disconnected mid-transfer' : 'sender disconnected',
            p === 'receiving' ? 'err' : 'warn'
          );
        });
      });

      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          go('unavailable');
          log(`no peer at ${slug}`, 'err');
        } else {
          go('error');
          log(`error: ${err.type}`, 'err');
        }
      });
    })();

    return () => {
      cancelled = true;
      peer?.destroy();
      sink?.dispose();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [slug, log, go]);

  useWakeLock(phase === 'receiving', log);
  useVisibilityLog(phase === 'receiving' || phase === 'connecting', log);

  // Warn before closing the tab mid-transfer.
  useEffect(() => {
    if (phase !== 'receiving') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  function requestDownload() {
    const dc = connRef.current?.dataChannel;
    if (!dc || dc.readyState !== 'open') return;
    sendMsg(dc, { kind: 'start' });
    go('receiving');
    log('download requested');
  }

  const totalSize = manifest.reduce((s, f) => s + f.size, 0);
  const bad = phase === 'unavailable' || phase === 'error' || phase === 'closed';

  return (
    <section className="space-y-6">
      <h1 className="text-lg">
        incoming from <span className="text-accent">{slug}</span>
      </h1>

      <div className={bad ? 'text-err' : phase === 'connecting' ? 'cursor text-dim' : 'text-accent'}>
        {statusText[phase]}
      </div>

      {manifest.length > 0 && received.length === 0 && (
        <div className="rounded border border-line bg-panel">
          <ul className="divide-y divide-line">
            {manifest.map((f, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {f.type.startsWith('video/') && <span className="text-xs text-accent">vid</span>}
                <span className="text-xs text-dim">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-line px-3 py-2 text-xs text-dim">
            <span>{manifest.length} files</span>
            <span>{formatBytes(totalSize)}</span>
          </div>
        </div>
      )}

      {phase === 'connected' && manifest.length > 0 && (
        <button
          onClick={requestDownload}
          className="w-full border border-accent px-4 py-2 text-accent transition-colors hover:bg-accent hover:text-bg"
        >
          download {formatBytes(totalSize)} →
        </button>
      )}

      {(phase === 'receiving' || (phase === 'closed' && bytes > 0)) && (
        <AsciiProgress value={bytes} total={totalSize} />
      )}

      {received.length > 0 && (
        <ul className="grid grid-cols-3 gap-2">
          {received.map((r) => (
            <li key={r.url} className="min-w-0 space-y-1">
              {createElement(Thumb, { src: r.url, video: r.file.type.startsWith('video/'), large: true })}
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