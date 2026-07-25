'use client';

import React, { type ReactNode } from 'react';

/**
 * Task 4 keeps every inspector section stacked in the order the builder page
 * rendered them before the split. The tab strip arrives in Task 5.
 */
export function ProjectTimeline({ children }: { children: ReactNode }) {
  return (
    <section id="project-timeline" className="dashboardGrid">
      {children}
    </section>
  );
}

export function Inspector({
  changes,
  modelPin,
  activity,
  artifacts,
  run,
  routes,
}: {
  changes: ReactNode;
  modelPin: ReactNode;
  activity: ReactNode;
  artifacts: ReactNode;
  run: ReactNode;
  routes: ReactNode;
}) {
  return (
    <>
      {changes}
      {modelPin}
      <ProjectTimeline>
        {activity}
        {artifacts}
      </ProjectTimeline>
      {run}
      {routes}
    </>
  );
}
