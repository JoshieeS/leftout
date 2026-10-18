import Link from 'next/link';

export function Navbar() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link href="/" className="text-base tracking-tight">
          left<span className="text-accent">out</span>
        </Link>

        <div className="flex items-center gap-6 text-xs">
          <a href="#how" className="hidden text-dim hover:text-fg sm:inline">how it works</a>
          <a href="#privacy" className="hidden text-dim hover:text-fg sm:inline">privacy</a>
          <a
            href="https://github.com/JoshieeS/drop"
            target="_blank"
            rel="noreferrer"
            className="hidden text-dim hover:text-fg sm:inline"
          >
            github
          </a>
          <Link
            href="/app"
            className="border border-accent px-3 py-1.5 text-accent transition-colors hover:bg-accent hover:text-bg"
          >
            start sharing →
          </Link>
        </div>
      </nav>
    </header>
  );
}