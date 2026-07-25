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
        <TopBarClient />
        <main>{children}</main>
      </body>
    </html>
  );
}
