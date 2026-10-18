import {TextLink} from '@/components/ui/TextLink'
import { DropVisual } from './DropVisual';
import { createElement } from 'react';

export function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-14 px-5 pb-24 pt-16 md:grid-cols-2 md:pt-28">
      <div className="space-y-7">
        <div className="text-xs text-accent">share more. leave no one out.</div>

        <h1 className="text-4xl leading-tight tracking-tight text-white md:text-6xl">
          No one gets <span className="text-accent">Leftout.</span>
        </h1>

        <p className="max-w-md text-base leading-relaxed text-dim">
          Share the original photos and videos from the night with everyone, whatever phone they use.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          {createElement(
            TextLink,
            { href: '/app', className: 'bg-accent px-6 py-3 text-bg transition-opacity hover:opacity-90' },
            'start sharing →'
          )}
          {createElement(TextLink, { href: '#how', className: 'text-dim hover:text-fg' }, 'see how it works ↓')}
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-dim">
          <span>✓ no account</span>
          <span>✓ no compression</span>
          <span>✓ direct device-to-device</span>
        </div>
      </div>

      <DropVisual />
    </section>
  );
}