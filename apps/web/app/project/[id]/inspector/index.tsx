'use client';

import React, { type ReactNode } from 'react';
import type { StatusTone } from '@/components/status-pill';
import { cn } from '@/lib/utils';

export const INSPECTOR_TAB_IDS = [
  'atividade',
  'execucao',
  'mudancas',
  'artefatos',
  'router',
  'versoes',
] as const;

export type InspectorTabId = (typeof INSPECTOR_TAB_IDS)[number];

export type InspectorTab = {
  id: InspectorTabId;
  label: string;
  badge?: { tone: StatusTone; count?: number };
  content: ReactNode;
};

export function inspectorTabFromSearch(value: string | null): InspectorTabId {
  return INSPECTOR_TAB_IDS.includes(value as InspectorTabId)
    ? (value as InspectorTabId)
    : 'atividade';
}

/**
 * Anchor target for the provisioning error's "ver detalhes na linha do tempo"
 * link. The timeline lives in the Atividade tab, which is also the default tab.
 */
export function ProjectTimeline({ children }: { children: ReactNode }) {
  return (
    <section id="project-timeline" className="flex flex-col gap-3">
      {children}
    </section>
  );
}

const BADGE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
  neutral: 'bg-ink-subtle',
};

export function InspectorTabs({
  activeTab,
  onTabChange,
  tabs,
}: {
  activeTab: InspectorTabId;
  onTabChange: (tab: InspectorTabId) => void;
  tabs: InspectorTab[];
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    onTabChange(next.id);
    const sibling = event.currentTarget.parentElement?.children[nextIndex];
    if (sibling instanceof HTMLElement) sibling.focus();
  }

  return (
    <section
      role="region"
      aria-label="Changes"
      data-testid="inspector"
      className="text-ink flex min-h-0 flex-1 flex-col gap-3"
    >
      <div
        role="tablist"
        aria-label="Inspetor"
        // Wraps rather than scrolls: six tabs do not fit the inspector column at
        // 1440px, and a horizontally scrolled tablist hides tabs off-screen.
        className="glass rounded-panel flex shrink-0 flex-wrap gap-0.5 p-1"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            id={`inspector-tab-${tab.id}`}
            aria-controls={`inspector-panel-${tab.id}`}
            aria-selected={tab.id === activeTab}
            tabIndex={tab.id === activeTab ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'rounded-control flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium',
              // `text-accent` on `bg-accent-wash` is only 2.85:1 — see BTN_ACTIVE in ../ui.
              tab.id === activeTab
                ? 'bg-accent-wash text-ink font-semibold'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
            {tab.badge ? (
              <span
                data-badge-tone={tab.badge.tone}
                className={cn('size-1.5 rounded-full', BADGE_CLASS[tab.badge.tone])}
              >
                {tab.badge.count === undefined ? null : (
                  <span className="sr-only">{tab.badge.count} pendente(s)</span>
                )}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/*
        Every panel stays mounted; only `hidden` toggles. ChatPane and
        ModelPinPanel hold pane-local state that silently resets on unmount
        (see the comments at their useState blocks), and `hidden` also removes
        the inactive panels from the accessibility tree.
      */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`inspector-panel-${tab.id}`}
          aria-labelledby={`inspector-tab-${tab.id}`}
          hidden={tab.id !== activeTab}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {tab.content}
        </div>
      ))}
    </section>
  );
}
