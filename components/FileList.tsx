'use client';
import { createElement, useEffect, useState } from 'react';
import { formatBytes, isVideo } from '@/lib/format';
import { Thumb } from './Thumb';

type Props = { files: File[]; onRemove?: (index: number) => void };

export function FileList({ files, onRemove }: Props) {
  const [previews, setPreviews] = useState<string[]>([]);

  // Create preview URLs and revoke them in the same effect, so Strict Mode is safe.
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const total = files.reduce((sum, f) => sum + f.size, 0);
  const videos = files.filter(isVideo).length;

  return (
    <div className="rounded border border-line bg-panel">
      <ul className="divide-y divide-line">
        {files.map((f, i) => (
          <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center gap-3 px-3 py-2">
            {previews[i]
              ? createElement(Thumb, { src: previews[i], type: f.type, name: f.name })
              : createElement('div', { className: 'size-10 shrink-0 rounded bg-line' })}

            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            {isVideo(f) && <span className="shrink-0 text-xs text-accent">vid</span>}
            <span className="shrink-0 text-xs text-dim">{formatBytes(f.size)}</span>

            {onRemove && (
              <button
                onClick={() => onRemove(i)}
                aria-label={`remove ${f.name}`}
                className="shrink-0 px-1 text-dim hover:text-err"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-between border-t border-line px-3 py-2 text-xs text-dim">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'}
          {videos > 0 && ` · ${videos} video${videos === 1 ? '' : 's'}`}
        </span>
        <span>{formatBytes(total)}</span>
      </div>
    </div>
  );
}