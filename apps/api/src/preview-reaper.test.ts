import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { startPreviewReaper } from './preview-reaper.js';

afterEach(() => vi.useRealTimers());

describe('preview reaper schedule', () => {
  it('runs one non-overlapping sweep per interval and reports aggregate errors', async () => {
    let finish!: () => void;
    const firstSweep = new Promise<void>((resolveSweep) => {
      finish = resolveSweep;
    });
    const reap = vi
      .fn()
      .mockReturnValueOnce(firstSweep.then(() => 0))
      .mockRejectedValueOnce(new AggregateError([new Error('broken session')], 'sweep failed'));
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startPreviewReaper({ reap }, 10, logger, app);

    await vi.advanceTimersByTimeAsync(30);
    expect(reap).toHaveBeenCalledTimes(1);
    finish();
    await firstSweep;
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTicks();
    expect(reap).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(AggregateError),
      'Preview reaper sweep failed',
    );

    await schedule.stop();
    await app.close();
    await vi.advanceTimersByTimeAsync(20);
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it('keeps direct API close pending until an active rejected sweep settles', async () => {
    let rejectSweep!: (error: Error) => void;
    const activeSweep = new Promise<number>((_resolve, reject) => {
      rejectSweep = reject;
    });
    const reap = vi.fn().mockReturnValue(activeSweep);
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startPreviewReaper({ reap }, 10, logger, app);
    await vi.advanceTimersByTimeAsync(10);
    expect(reap).toHaveBeenCalledTimes(1);

    let closed = false;
    const close = app.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);

    rejectSweep(new Error('late sweep failure'));
    await close;
    expect(closed).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'late sweep failure' }),
      'Preview reaper sweep failed',
    );
    await expect(schedule.stop()).resolves.toBeUndefined();
  });
});
