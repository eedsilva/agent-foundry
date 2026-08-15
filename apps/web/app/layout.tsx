import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { TopBarClient } from '@/components/top-bar-client';
import './theme.css';

export const metadata: Metadata = {
  title: 'Agent Foundry',
  description: 'A local-first, auditable multi-agent software delivery pipeline.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        {/* Visually hidden until focused (`.skip-link` in theme.css) — the one
            basic a11y affordance a survey found genuinely absent anywhere in
            this app. Must stay first in the DOM to be the page's first Tab
            stop. */}
        <a href="#main-content" className="skip-link">
          Pular para o conteúdo
        </a>
        <TopBarClient />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
