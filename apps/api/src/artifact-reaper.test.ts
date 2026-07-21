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

  it('keeps direct API close pending until an active rejected sweep settles', async () => {
    let rejectSweep!: (error: Error) => void;
    const activeSweep = new Promise<number>((_resolve, reject) => {
      rejectSweep = reject;
    });
    const reapExpired = vi.fn().mockReturnValue(activeSweep);
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startArtifactReaper({ reapExpired }, 10, logger, app);
    await vi.advanceTimersByTimeAsync(0);
    expect(reapExpired).toHaveBeenCalledTimes(1);

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
      'Artifact reaper sweep failed',
    );
    await expect(schedule.stop()).resolves.toBeUndefined();
  });

  it('runs the optional blob GC sweep after reapExpired, with the same timestamp', async () => {
    const calls: string[] = [];
    const reapExpired = vi.fn((_now: Date) => {
      calls.push('reapExpired');
      return Promise.resolve(2);
    });
    const gcSweep = vi.fn((_now: Date) => {
      calls.push('gcSweep');
      return Promise.resolve(3);
    });
    const logger = { error: vi.fn() };
    const app = Fastify();
    const schedule = startArtifactReaper({ reapExpired }, 10_000, logger, app, gcSweep);

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['reapExpired', 'gcSweep']);
    expect(reapExpired.mock.calls[0]![0]).toBe(gcSweep.mock.calls[0]![0]);

    await schedule.stop();
    await app.close();
  });
});
