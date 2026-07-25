import React from 'react';
import { GlassBar } from './glass-bar';
import { RuntimePill } from './runtime-pill';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Projetos' },
  { href: '/router', label: 'Router' },
];

export function TopBar({ activePath }: { activePath: string }) {
  return (
    <GlassBar
      as="header"
      className="sticky top-0 z-30 flex h-14 items-center gap-6 rounded-none border-x-0 border-t-0 px-6"
    >
      <a href="/" className="flex items-center gap-2.5">
        <span className="bg-accent grid size-7 place-items-center rounded-[7px] font-mono text-[11px] font-bold text-surface">
          AF
        </span>
        <strong className="text-ink text-[14px]">Agent Foundry</strong>
      </a>

      <nav className="flex items-center gap-1" aria-label="Principal">
        {NAV.map((item) => {
          const active = item.href === activePath;
          return (
            <a
              key={item.href}
              href={item.href}
              {...(active ? { 'aria-current': 'page' as const } : {})}
              className={cn(
                'rounded-control px-3 py-1.5 text-[13px] font-medium transition-colors',
                active ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:text-ink',
              )}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <RuntimePill />
        <span className="text-ink-subtle hidden font-mono text-[11px] tracking-wide uppercase sm:inline">
          local-first
        </span>
      </div>
    </GlassBar>
  );
}
