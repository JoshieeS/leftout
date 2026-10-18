import './globals.css';
import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  title: {
    default: 'Leftout — share the originals with everyone',
    template: '%s . Leftout'
  },
  description: 'Share original-quality photos and videos with everyone in the group, Android or iPhone. Direct, private, no account',
};

export const viewport: Viewport = { themeColor: '#0a0c0b' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body className="min-h-dvh bg-bg font-mono text-sm text-fg antialiased">{children}</body>
    </html>
  );
}