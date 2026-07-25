import { describe, expect, it } from 'vitest';
import { parseIssueFilters } from './filters';

describe('parseIssueFilters', () => {
  it('returns empty filters when no query params are present', () => {
    expect(parseIssueFilters({})).toEqual({ statuses: [], priorities: [] });
  });

  it('parses a single status and a single priority', () => {
    expect(parseIssueFilters({ status: 'open', priority: 'high' })).toEqual({
      statuses: ['open'],
      priorities: ['high'],
    });
  });

  it('combines multiple comma-separated statuses and priorities', () => {
    expect(parseIssueFilters({ status: 'open,in_progress', priority: 'high,critical' })).toEqual({
      statuses: ['open', 'in_progress'],
      priorities: ['high', 'critical'],
    });
  });

  it('drops invalid values instead of throwing', () => {
    expect(parseIssueFilters({ status: 'not-a-status,open' })).toEqual({
      statuses: ['open'],
      priorities: [],
    });
  });
});
