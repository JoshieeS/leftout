import { TextLink } from '@/components/ui/TextLink'

export default function ToolLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 mx-auto flex min-h-dvh max-w-xl flex-col px-5 py-8">
      <header className="mb-10 flex items-center justify-between">
        <TextLink href="/" className="hover:text-accent">
          <span className="text-accent">$</span> leftout
        </TextLink>
        <span className="text-xs text-dim">p2p · encrypted · no uploads</span>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="mt-10 text-xs text-dim">
        files move device → device. nothing is stored.
      </footer>
    </div>
  );
}