import type { ReactNode } from 'react';
import { Nav, type NavLink } from './nav';

export function Shell({ children, navLinks }: { children: ReactNode; navLinks?: NavLink[] }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav links={navLinks} />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
