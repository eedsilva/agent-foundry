'use client';

import { use } from 'react';
import { VersionHistory } from '../version-history';

export default function ProjectVersionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className="shell">
      <a className="backLink" href={`/project/${id}`}>
        ← projeto
      </a>
      <p className="eyebrow">{id}</p>
      <h1>Histórico de versões</h1>
      <VersionHistory projectId={id} />
    </div>
  );
}
