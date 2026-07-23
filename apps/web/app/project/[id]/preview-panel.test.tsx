import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewLogEntry } from '@agent-foundry/contracts';
import { startPreviewLogPolling } from './preview-panel';

afterEach(() => vi.useRealTimers());

describe('startPreviewLogPolling', () => {
  it('schedules the next log poll after one failed page fetch', async () => {
    vi.useFakeTimers();
    const getPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        entries: [
          {
            cursor: 1,
            stream: 'stdout',
            message: 'resumed',
            timestamp: '2026-07-23T00:00:00.000Z',
          },
        ],
        nextCursor: 1,
      });
    const received: PreviewLogEntry[] = [];

    const stop = startPreviewLogPolling({
      getPage,
      onEntries: (entries) => received.push(...entries),
      onError: () => undefined,
      schedule: (callback) => setTimeout(callback, 2_000),
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getPage).toHaveBeenCalledTimes(2);
    expect(received.map((entry) => entry.message)).toEqual(['resumed']);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getPage).toHaveBeenCalledTimes(2);
  });
});
