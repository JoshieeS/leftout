'use client';
import { createElement, useEffect, useState } from 'react';
import { TextLink } from '@/components/ui/TextLink';
import { NAV } from './nav';

export function MobileMenu() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'close menu' : 'open menu'}
        aria-expanded={open}
        aria-controls="mobile-nav"
        className="flex size-9 items-center justify-center rounded border border-line text-base text-fg"
      >
        {open ? '✕' : '☰'}
      </button>

      {open && (
        <div
          id="mobile-nav"
          onClick={() => setOpen(false)} // tapping any link closes the menu
          className="absolute inset-x-0 top-full border-b border-line bg-bg"
        >
          <nav className="flex flex-col px-5 py-2 text-sm">
            {NAV.map((n) =>
              createElement(
                TextLink,
                {
                  key: n.href,
                  href: n.href,
                  external: n.external,
                  className: 'border-b border-line py-4 text-dim last:border-0 active:text-accent',
                },
                n.external ? `${n.label} ↗` : n.label
              )
            )}
          </nav>
        </div>
      )}
    </div>
  );
}