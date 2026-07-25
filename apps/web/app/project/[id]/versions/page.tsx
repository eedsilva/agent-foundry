'use client';

import { use } from 'react';
import { VersionHistory } from '../version-history';
import { EYEBROW } from '@/lib/ui';
import { cn } from '@/lib/utils';

export default function ProjectVersionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-10">
      <a
        href={`/project/${id}`}
        className="text-ink-muted hover:text-ink mb-6 inline-block text-[13px] font-medium"
      >
        ← projeto
      </a>
      {/* The only eyebrow that sits on the mesh rather than on a card:
          `--ink-subtle` measures 4.51:1 against the teal bloom here, which
          passes but with no margin, so this one steps up to `--ink-muted`
          (4.69:1). DESIGN.md §7 requires the check on the mesh, not on white. */}
      <p className={cn(EYEBROW, 'text-ink-muted mb-2')}>{id}</p>
      <h1 className="text-ink mb-6 text-[28px] leading-tight font-semibold tracking-[-0.02em]">
        Histórico de versões
      </h1>
      <VersionHistory projectId={id} />
    </div>
  );
}
