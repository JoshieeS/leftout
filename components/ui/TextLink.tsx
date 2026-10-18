import { createElement, type ReactNode } from 'react';
import Link from 'next/link';

type Props = { href: string; className?: string; children: ReactNode; external?: boolean };

export function TextLink({ href, className, children, external = false }: Props) {
  if (external) {
    return createElement('a', { href, className, target: '_blank', rel: 'noopener noreferrer' }, children);
  }
  if (href.startsWith('#')) return createElement('a', { href, className }, children);
  return createElement(Link, { href, className }, children);
}