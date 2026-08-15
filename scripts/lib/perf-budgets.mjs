// Given the build's route-bundle-stats manifest and a route -> budget (KB) map,
// report every budgeted route's measured size and whether it breaches budget.
// A budgeted route absent from the manifest is a breach, not a silent pass —
// a check that no-ops when the build moved is worse than none.
export function evaluateFirstLoadJsBudgets(manifestRoutes, budgets) {
  const bytesByRoute = new Map();
  for (const entry of manifestRoutes ?? []) {
    if (
      entry &&
      typeof entry.route === 'string' &&
      typeof entry.firstLoadUncompressedJsBytes === 'number'
    ) {
      bytesByRoute.set(entry.route, entry.firstLoadUncompressedJsBytes);
    }
  }

  const results = Object.entries(budgets ?? {}).map(([route, budgetKb]) => {
    const bytes = bytesByRoute.get(route);
    if (bytes === undefined) {
      return {
        route,
        budgetKb,
        measuredKb: null,
        breach: true,
        note: 'route missing from build output',
      };
    }
    const measuredKb = Math.round((bytes / 1024) * 10) / 10;
    const breach = measuredKb > budgetKb;
    return { route, budgetKb, measuredKb, breach, note: null };
  });

  return { ok: results.every((r) => !r.breach), results };
}
