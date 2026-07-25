'use client';

import React from 'react';
import { VersionHistory } from '../version-history';
import { PANEL } from '../ui';

export function VersionsTab({ projectId, refreshKey }: { projectId: string; refreshKey?: string }) {
  return (
    <div className={PANEL}>
      <VersionHistory
        projectId={projectId}
        embedded
        {...(refreshKey === undefined ? {} : { refreshKey })}
      />
    </div>
  );
}
