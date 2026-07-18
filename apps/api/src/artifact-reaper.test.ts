import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { startArtifactReaper } from './artifact-reaper.js';

afterEach(() => vi.useRealTimers());

describe('artifact reaper schedule', () => {
  it('runs immediately, passes the current time, and prevents interval overlap', async () => {
    let finish!: () => void;
    const firstSweep = new Promise<void>((resolveSweep) => {
      finish = resolveSweep;
    });
    const reapExpired = vi
      .fn()
      .mockReturnValueOnce(firstSweep.then(() => 0))
      .mockResolvedValueOnce(2);
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startArtifactReaper({ reapExpired }, 10, logger, app);

    await vi.advanceTimersByTimeAsync(0);
    expect(reapExpired).toHaveBeenCalledTimes(1);
    expect(reapExpired.mock.calls[0]![0]).toBeInstanceOf(Date);
    await vi.advanceTimersByTimeAsync(30);
    expect(reapExpired).toHaveBeenCalledTimes(1);
    finish();
    await firstSweep;
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTicks();
    expect(reapExpired).toHaveBeenCalledTimes(2);

    await schedule.stop();
    await app.close();
  });

  it('logs and continues after a failed sweep', async () => {
    const reapExpired = vi.fn().mockRejectedValueOnce(new Error('disk error')).mockResolvedValue(0);
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startArtifactReaper({ reapExpired }, 10, logger, app);

    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), 'Artifact reaper sweep failed');

    await schedule.stop();
    await app.close();
  });
});
