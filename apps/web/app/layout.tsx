import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Foundry',
  description: 'A local-first, auditable multi-agent software delivery pipeline.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        <div className="noise" />
        <header className="topbar">
          <a className="brand" href="/">
            <span className="brandMark">AF</span>
            <span>
              <strong>Agent Foundry</strong>
              <small>PRD → software, sem caixa-preta</small>
            </span>
          </a>
          <span className="localBadge">local-first</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
