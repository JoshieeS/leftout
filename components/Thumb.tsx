'use client';
import { createElement } from 'react';

type Props = { src: string; type: string; name: string; large?: boolean };

export function Thumb({ src, type, name, large = false }: Props) {
  const size = large ? 'aspect-square w-full' : 'size-10 shrink-0';
  const className = `${size} rounded bg-line object-cover`;

  if (type.startsWith('video/')) {
    return createElement('video', {
      src: `${src}#t=0.1`,
      className,
      muted: true,
      playsInline: true,
      preload: 'metadata',
    });
  }

  if (type.startsWith('image/')) {
    return createElement('img', { src, alt: '', className });
  }

  // Anything else (pdf, docx, zip…): show the extension as a label.
  const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? 'file').toLowerCase();
  return createElement(
    'div',
    { className: `${className} flex items-center justify-center border border-line text-xs text-accent` },
    `.${ext}`
  );
}