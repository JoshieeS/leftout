export type NavItem = { href: string; label: string; external?: boolean };

export const NAV: NavItem[] = [
  { href: '#how', label: 'how it works' },
  { href: '#privacy', label: 'privacy' },
  { href: 'https://github.com/JoshieeS/leftout', label: 'github', external: true },
];