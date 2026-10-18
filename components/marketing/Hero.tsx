import {TextLink} from '@/components/ui/TextLink'
import { DropVisual } from './DropVisual';

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
          <TextLink href="/app" className="border border-accent bg-accent px-5 py-3 text-bg transition-colors hover:bg-transparent hover:text-accent">
            start sharing →
          </TextLink>
          <TextLink href="#how" className="text-dim hover:text-fg">
            see how it works ↓
          </TextLink>
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