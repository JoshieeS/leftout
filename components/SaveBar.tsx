'use client';
import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import { loadSaved, markSaved } from '@/lib/dropstore';
import { canShareFiles, downloadAll, isIOS, makeBatches } from '@/lib/saveToDevice';

type Item = { id: string; file: File; url: string };
const isMedia = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/');

export function SaveBar({ items, slug }: { items: Item[]; slug: string }) {
  const [saved, setSaved] = useState<Set<string>>(() => loadSaved(slug));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pending = items.filter((i) => !saved.has(i.id));
  const media = pending.filter((i) => isMedia(i.file));
  const docs = pending.filter((i) => !isMedia(i.file));
  // Photos and videos first. Documents go in their own batches, because a
  // mixed batch may not offer "Save to Photos".
  const batches = [...makeBatches(media), ...makeBatches(docs)];
  const next = batches[0] ?? [];
  const useShare = isIOS() && next.length > 0 && canShareFiles(next.map((i) => i.file));

  const mark = (ids: string[]) => {
    const n = new Set(saved);
    ids.forEach((id) => n.add(id));
    setSaved(n);
    markSaved(slug, n);
  };

  async function share() {
    setError('');
    try {
      // Must be the first await: iOS only allows the share sheet straight after a tap.
      await navigator.share({ files: next.map((i) => i.file) });
      mark(next.map((i) => i.id));
    } catch (e) {
      const name = (e as Error).name;
      if (name !== 'AbortError') setError(`share sheet failed (${name}) · tap a file's name below to save it on its own`);
    }
  }

  async function downloadEverything() {
    setBusy(true);
    await downloadAll(pending);
    mark(pending.map((i) => i.id));
    setBusy(false);
  }

  if (items.length === 0) return null;
  if (pending.length === 0) {
    return <div className="text-xs text-accent">✓ all {items.length} saved to this device</div>;
  }

  const allMedia = next.every((i) => isMedia(i.file));
  const size = next.reduce((s, i) => s + i.file.size, 0);

  return (
    <div className="space-y-2 rounded border border-line bg-panel p-3">
      {useShare ? (
        <button
          type="button"
          onClick={share}
          className="w-full bg-accent px-4 py-3 text-bg transition-opacity hover:opacity-90"
        >
          {allMedia ? 'save to photos' : 'save files'} · {next.length} item{next.length === 1 ? '' : 's'} ({formatBytes(size)})
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={downloadEverything}
          className="w-full border border-accent px-4 py-3 text-accent transition-colors hover:bg-accent hover:text-bg disabled:opacity-40"
        >
          {busy ? 'downloading…' : `download all (${pending.length})`}
        </button>
      )}
      <div className="text-xs text-dim">
        {useShare
          ? `${batches.length} tap${batches.length === 1 ? '' : 's'} left · in the sheet, choose “Save Images” or “Save Video”`
          : 'files go to your downloads folder'}
      </div>
      {error && <div className="text-xs text-err">{error}</div>}
    </div>
  );
}