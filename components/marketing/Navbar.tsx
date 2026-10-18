import { createElement } from 'react';
import { TextLink } from '@/components/ui/TextLink';
import { MobileMenu } from './MobileMenu';
import { NAV } from './nav';

export function Navbar() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        {createElement(
          TextLink,
          { href: '/', className: 'text-base tracking-tight text-white' },
          'left',
          createElement('span', { className: 'text-accent' }, 'out')
        )}

        <div className="flex items-center gap-3 text-xs sm:gap-6">
          {/* desktop links */}
          <div className="hidden items-center gap-6 sm:flex">
            {NAV.map((n) =>
              createElement(
                TextLink,
                { key: n.href, href: n.href, external: n.external, className: 'text-dim hover:text-fg' },
                n.label
              )
            )}
          </div>

          {createElement(
            TextLink,
            {
              href: '/app',
              className:
                'border border-accent px-3 py-1.5 text-accent transition-colors hover:bg-accent hover:text-bg',
            },
            'start sharing →'
          )}

          {/* mobile only */}
          <MobileMenu />
        </div>
      </nav>
    </header>
  );
}