// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { watch } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MIN_FLUSH_INTERVAL_MS,
  DEFAULT_SWEEP_MS,
  MAX_CHANGED_PATHS,
  TranscriptWatcher,
} from '../../src/spend/watcher.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

afterEach(async () => {
  vi.useRealTimers();
  await cleanupTempDirs();
});

function recursiveWatchSupported(dir: string): boolean {
  try {
    watch(dir, { recursive: true }, () => {}).close();
    return true;
  } catch {
    return false;
  }
}

describe('TranscriptWatcher debounce', () => {
  it('coalesces a burst of change events into one flush', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush, minFlushIntervalMs: 0 });
    await watcher.start();
    watcher.resume();

    watcher.notify('a.jsonl');
    watcher.notify('b.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS - 1);
    watcher.notify('c.jsonl');
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // a later burst is a separate flush
    watcher.notify('d.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('starts at most one flush per DEFAULT_MIN_FLUSH_INTERVAL_MS however busy the tree is', async () => {
    // §23.38: ~10 live sessions write constantly; one full walk of thousands of transcripts
    // per 500 ms debounce kept the daemon above a core.
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();

    watcher.notify('a.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // Writes keep landing; each debounce expiry inside the floor is held, not dropped.
    for (let t = 0; t < DEFAULT_MIN_FLUSH_INTERVAL_MS - DEFAULT_DEBOUNCE_MS - 1; t += DEFAULT_DEBOUNCE_MS) {
      watcher.notify('a.jsonl');
      vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    }
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEFAULT_MIN_FLUSH_INTERVAL_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    // Nothing further queued: no extra flush.
    vi.advanceTimersByTime(DEFAULT_MIN_FLUSH_INTERVAL_MS * 3);
    expect(onFlush).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('honours a custom debounce window', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush, debounceMs: 20 });
    await watcher.start();
    watcher.resume();

    watcher.notify();
    vi.advanceTimersByTime(19);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

describe('TranscriptWatcher safety sweep', () => {
  it('flushes every 5 minutes even when no event arrived', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();

    vi.advanceTimersByTime(DEFAULT_SWEEP_MS - 1);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEFAULT_SWEEP_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('stops all timers on stop()', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();
    watcher.notify();
    watcher.stop();

    vi.advanceTimersByTime(DEFAULT_SWEEP_MS * 3);
    expect(onFlush).not.toHaveBeenCalled();
  });
});

describe('TranscriptWatcher mid-scan queueing', () => {
  it('queues events while paused and drains them on resume', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start(); // starts paused: the initial scan owns the store

    watcher.notify('a.jsonl');
    watcher.notify('b.jsonl');
    vi.advanceTimersByTime(DEFAULT_SWEEP_MS * 2);
    expect(onFlush).not.toHaveBeenCalled();
    expect(watcher.pending).toBe(2);

    watcher.resume();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(watcher.pending).toBe(0);
    watcher.stop();
  });

  it('does not flush on resume when nothing was queued', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const onFlush = vi.fn();
    const watcher = new TranscriptWatcher({ dir, onFlush });
    await watcher.start();
    watcher.resume();
    expect(onFlush).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('never runs two flushes concurrently and re-runs once for events raised mid-flush', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    let running = 0;
    let overlaps = 0;
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watcher = new TranscriptWatcher({
      dir,
      debounceMs: 10,
      minFlushIntervalMs: 0,
      onFlush: async () => {
        calls += 1;
        running += 1;
        if (running > 1) overlaps += 1;
        if (calls === 1) await gate;
        running -= 1;
      },
    });
    await watcher.start();
    watcher.resume();

    watcher.notify('a.jsonl');
    vi.advanceTimersByTime(10);
    expect(calls).toBe(1);

    watcher.notify('b.jsonl'); // arrives while the first flush is still awaiting
    vi.advanceTimersByTime(10);
    expect(calls).toBe(1); // queued, not run concurrently

    release();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(overlaps).toBe(0);
    expect(calls).toBe(2);
    watcher.stop();
  });
});

describe('TranscriptWatcher changed paths', () => {
  async function watcherWith(options: { onFlush: (changed: ReadonlySet<string> | null) => void | Promise<void> }) {
    vi.useFakeTimers();
    const watcher = new TranscriptWatcher({ dir: join(await makeTempDir(), 'absent'), ...options });
    await watcher.start();
    return watcher;
  }
  function recorder() {
    const flushes: (string[] | null)[] = [];
    return { flushes, onFlush: (c: ReadonlySet<string> | null) => void flushes.push(c === null ? null : [...c]) };
  }

  it('hands a flush the distinct paths since the last one', async () => {
    const { flushes, onFlush } = recorder();
    const watcher = await watcherWith({ onFlush });
    watcher.resume();
    watcher.notify('p/a.jsonl');
    watcher.notify('p/b.jsonl');
    watcher.notify('p/a.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    watcher.notify('p/c.jsonl');
    vi.advanceTimersByTime(DEFAULT_MIN_FLUSH_INTERVAL_MS);
    expect(flushes).toEqual([['p/a.jsonl', 'p/b.jsonl'], ['p/c.jsonl']]);
    watcher.stop();
  });

  it('asks for everything when an event names no path', async () => {
    const { flushes, onFlush } = recorder();
    const watcher = await watcherWith({ onFlush });
    watcher.resume();
    watcher.notify('p/a.jsonl');
    watcher.notify(null);
    watcher.notify('p/b.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(flushes).toEqual([null]);
    watcher.stop();
  });

  it('asks for everything rather than collect paths without limit', async () => {
    const { flushes, onFlush } = recorder();
    const watcher = await watcherWith({ onFlush });
    for (let i = 0; i <= MAX_CHANGED_PATHS; i += 1) watcher.notify(`p/${i}.jsonl`);
    watcher.resume();
    expect(flushes).toEqual([null]);
    watcher.stop();
  });

  it('asks for everything on the safety sweep, even one the flush floor holds back', async () => {
    const { flushes, onFlush } = recorder();
    const watcher = await watcherWith({ onFlush });
    watcher.resume();
    vi.advanceTimersByTime(DEFAULT_SWEEP_MS - DEFAULT_DEBOUNCE_MS - 1);
    watcher.notify('p/a.jsonl');
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(flushes).toEqual([['p/a.jsonl']]);
    vi.advanceTimersByTime(1); // the sweep, inside the floor
    vi.advanceTimersByTime(DEFAULT_MIN_FLUSH_INTERVAL_MS);
    expect(flushes).toEqual([['p/a.jsonl'], null]);
    watcher.stop();
  });

  it('asks for everything after a flush that failed', async () => {
    const seen: (string[] | null)[] = [];
    const watcher = await watcherWith({
      onFlush: async (changed) => {
        seen.push(changed === null ? null : [...changed]);
        if (seen.length === 1) throw new Error('scan failed');
      },
    });
    watcher.resume();
    watcher.notify('p/a.jsonl');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    watcher.notify('p/b.jsonl');
    await vi.advanceTimersByTimeAsync(DEFAULT_MIN_FLUSH_INTERVAL_MS);
    expect(seen).toEqual([['p/a.jsonl'], null]);
    watcher.stop();
  });

  it('keeps a path that changes while a flush is running for the next one', async () => {
    const seen: (string[] | null)[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watcher = await watcherWith({
      onFlush: async (changed) => {
        seen.push(changed === null ? null : [...changed]);
        if (seen.length === 1) await gate;
      },
    });
    watcher.resume();
    watcher.notify('p/a.jsonl');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    watcher.notify('p/a.jsonl');
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS);
    release();
    await vi.advanceTimersByTimeAsync(DEFAULT_MIN_FLUSH_INTERVAL_MS);
    expect(seen).toEqual([['p/a.jsonl'], ['p/a.jsonl']]);
    watcher.stop();
  });
});

describe('TranscriptWatcher real filesystem events', () => {
  it('names the file that was written, relative to the watched dir', async () => {
    const dir = await makeTempDir();
    if (!recursiveWatchSupported(dir)) return;
    await mkdir(join(dir, 'proj', 'session'), { recursive: true });
    const named = new Set<string>();
    const watcher = new TranscriptWatcher({
      dir,
      debounceMs: 20,
      minFlushIntervalMs: 0,
      sweepMs: 60_000,
      onFlush: (changed) => {
        for (const path of changed ?? ['(everything)']) named.add(path);
      },
    });
    await watcher.start();
    watcher.resume();
    const deadline = Date.now() + 8000;
    for (let i = 0; !named.has('proj/session/a.jsonl') && Date.now() < deadline; i += 1) {
      await writeFile(join(dir, 'proj', 'session', 'a.jsonl'), `{"n":${i}}\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    watcher.stop();
    expect([...named]).toContain('proj/session/a.jsonl');
    expect([...named]).not.toContain('(everything)');
  }, 10_000);

  it('flushes when a transcript is written under a nested dir', async () => {
    const dir = await makeTempDir();
    if (!recursiveWatchSupported(dir)) return; // platform without recursive fs.watch

    const nested = join(dir, 'proj', 'session', 'subagents');
    await mkdir(nested, { recursive: true });

    let flushes = 0;
    const watcher = new TranscriptWatcher({
      dir,
      debounceMs: 20,
      sweepMs: 60_000,
      onFlush: () => {
        flushes += 1;
      },
    });
    await watcher.start();
    watcher.resume();

    // A recursive watch can take a moment to arm (FSEvents on macOS), so keep writing
    // until the change is delivered rather than racing a single write.
    const deadline = Date.now() + 8000;
    for (let i = 0; flushes === 0 && Date.now() < deadline; i += 1) {
      await writeFile(join(nested, 'agent-x.jsonl'), `{"n":${i}}\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    watcher.stop();
    expect(flushes).toBeGreaterThan(0);
  });

  it('survives a missing directory without throwing', async () => {
    const dir = await makeTempDir();
    const watcher = new TranscriptWatcher({ dir: join(dir, 'absent'), onFlush: () => {} });
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.watching).toBe(false);
    watcher.stop();
  });
});
