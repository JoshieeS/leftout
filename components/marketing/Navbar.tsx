import {TextLink} from '@/components/ui/TextLink'
import Link from 'next/dist/client/link';

export function Navbar() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <TextLink href="/" className="text-base tracking-tight">
          left<span className="text-accent">out</span>
        </TextLink>

        <div className="flex items-center gap-6 text-xs">
          <TextLink href="#how" className="hidden text-dim hover:text-fg sm:inline">
            how it works
          </TextLink>
          <TextLink href="#privacy" className="hidden text-dim hover:text-fg sm:inline">
            privacy
          </TextLink>
          <TextLink href="https://github.com/JoshieeS/drop" external className="hidden text-dim hover:text-fg sm:inline">
            github
          </TextLink>
          <TextLink href="/app" className="border border-accent px-3 py-1.5 text-accent transition-colors hover:bg-accent hover:text-bg">
            start sharing →
          </TextLink>
        </div>
      </nav>
    </header>
  );
}