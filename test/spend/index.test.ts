// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpendStore } from '../../src/spend/index.js';
import { SNAPSHOT_VERSION, STATE_FILE } from '../../src/spend/store.js';
import {
  cleanupTempDirs,
  copyFixtures,
  MAIN_A,
  makeTempDir,
  PROJECT_A,
  SESSION_A,
} from './helpers.js';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const now = (): Date => NOW;

const started: SpendStore[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.stop()));
  await cleanupTempDirs();
});

async function makeStore(
  options: { projects?: string; stateDir?: string; retentionDays?: number } = {},
): Promise<{ store: SpendStore; projects: string; stateDir: string }> {
  const projects = options.projects ?? (await copyFixtures());
  const stateDir = options.stateDir ?? (await makeTempDir('claude-usage-state-'));
  const store = new SpendStore({
    projectsDir: projects,
    stateDir,
    now,
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
  });
  started.push(store);
  return { store, projects, stateDir };
}

const APPENDED = `${JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-13T13:00:00.000Z',
  cwd: '/home/dev/alpha',
  sessionId: SESSION_A,
  requestId: 'req_fixture_live',
  message: {
    id: 'msg_fixture_LIVE',
    model: 'claude-opus-5',
    role: 'assistant',
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
})}\n`;

describe('SpendStore lifecycle', () => {
  it('reports ready:false with empty totals before the initial scan completes', async () => {
    const { store } = await makeStore();
    expect(store.ready).toBe(false);
    const before = store.query({ since: 'today', groupBy: 'project' });
    expect(before).toMatchObject({
      ready: false,
      stale: false,
      since: '2026-09-13T00:00:00.000Z',
      groupBy: 'project',
      groups: [],
    });
    expect(before.totals).toEqual({
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      messages: 0,
    });
  });

  it('scans the fixture tree on start and answers queries', async () => {
    const { store } = await makeStore();
    await store.start();

    expect(store.ready).toBe(true);
    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    expect(res.ready).toBe(true);
    expect(res.stale).toBe(false);
    expect(res.totals).toEqual({
      input: 116,
      output: 228,
      cacheCreate: 340,
      cacheRead: 452,
      messages: 4,
    });
    expect(res.groups.map((g) => g.key).sort()).toEqual(['-home-dev-alpha', '-home-dev-beta']);
    expect(store.stats).toMatchObject({ filesTotal: 4, filesDone: 4, parseErrors: 1 });
    expect(store.stats.lastScanAt).toBe(NOW.toISOString());

    // `scanning` is NOT settled the instant `start()` resolves, and asserting that it was
    // made this test flaky — it failed on `macos-latest` in CI while passing eleven
    // consecutive local runs. `start()` marks the store ready and then calls
    // `watcher.resume()`, which drains whatever the watcher queued while the foreground scan
    // was running; a queued event there starts a *background* scan, so `#current` is
    // non-null again immediately after `start()` returns. That is the documented design
    // (src/spend/index.ts:6, "mark ready → drain the queued events"), not a defect: the
    // answers above are already correct and `ready` is already true. Whether the drain
    // happens to find work is a timing question about the filesystem watcher, which is
    // exactly the kind of thing a loaded CI runner decides differently.
    //
    // So wait for quiescence and assert it there, where it means something.
    await store.whenIdle();
    expect(store.stats).toMatchObject({ scanning: false });
  });

  it('accepts an explicit projectsDir passed to start()', async () => {
    const projects = await copyFixtures();
    const stateDir = await makeTempDir('claude-usage-state-');
    const store = new SpendStore({ projectsDir: join(stateDir, 'unused'), stateDir, now });
    started.push(store);
    await store.start(projects);
    expect(store.query({ since: '7d', groupBy: 'project' }).totals.messages).toBe(4);
  });

  it('exposes session totals, model and start time including subagent rollup', async () => {
    const { store } = await makeStore();
    await store.start();
    expect(store.sessionTotals(SESSION_A)).toEqual({
      input: 16,
      output: 28,
      cacheCreate: 40,
      cacheRead: 52,
      messages: 3,
    });
    expect(store.sessionModel(SESSION_A)).toBe('claude-sonnet-5');
    expect(store.sessionStartedAt(SESSION_A)).toBe('2026-09-13T10:00:00.000Z');
    expect(store.sessionTotals('missing')).toBeNull();
    expect(store.sessionModel('missing')).toBeNull();
    expect(store.sessionStartedAt('missing')).toBeNull();
  });

  it('applies retention on start', async () => {
    const { store } = await makeStore({ retentionDays: 90 });
    await store.start();
    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'day' });
    expect(res.groups.map((g) => g.key)).toEqual(['2026-09-13', '2026-09-10']);
  });

  it('is safe to start twice and to stop without starting', async () => {
    const { store } = await makeStore();
    await store.start();
    await store.start();
    expect(store.query({ since: '7d', groupBy: 'project' }).totals.messages).toBe(4);

    const { store: other } = await makeStore();
    await expect(other.stop()).resolves.toBeUndefined();
  });
});

describe('SpendStore incremental updates', () => {
  it('picks up appended lines and notifies onChange subscribers', async () => {
    const { store, projects } = await makeStore();
    const changes = vi.fn();
    const unsubscribe = store.onChange(changes);
    await store.start();
    changes.mockClear();

    await appendFile(join(projects, MAIN_A), APPENDED);
    await store.refresh();

    expect(store.query({ since: 'today', groupBy: 'project' }).totals.messages).toBe(4);
    expect(changes).toHaveBeenCalledTimes(1);

    unsubscribe();
    await appendFile(
      join(projects, MAIN_A),
      APPENDED.replace(/msg_fixture_LIVE/g, 'msg_fixture_LIVE2').replace(
        /req_fixture_live/g,
        'req_fixture_live2',
      ),
    );
    await store.refresh();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(store.query({ since: 'today', groupBy: 'project' }).totals.messages).toBe(5);
  });

  it('does not re-count a rescanned line and stays quiet when nothing changed', async () => {
    const { store } = await makeStore();
    const changes = vi.fn();
    store.onChange(changes);
    await store.start();
    changes.mockClear();

    await store.refresh();
    await store.refresh();
    expect(changes).not.toHaveBeenCalled();
    expect(store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' }).totals.messages)
      .toBe(4);
  });

  it('restarts a truncated file and reconciles through a background rescan', async () => {
    const { store, projects } = await makeStore();
    await store.start();
    const before = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    const scansBefore = store.stats.scans;

    await writeFile(join(projects, MAIN_A), APPENDED);
    await store.refresh();
    await store.whenIdle();

    // the pass that noticed the truncation, plus the forced full rescan it scheduled
    expect(store.stats.scans).toBe(scansBefore + 2);

    const after = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    // pre-summed counters are never rolled back; the replaced file's one new line is added
    expect(after.totals.messages).toBe(before.totals.messages + 1);
    expect(after.stale).toBe(false);
  });
});

describe('SpendStore snapshot', () => {
  it('writes the snapshot on stop and reuses it on the next start', async () => {
    const { store, projects, stateDir } = await makeStore();
    await store.start();
    await store.stop();

    const snapshot = JSON.parse(await readFile(join(stateDir, STATE_FILE), 'utf8')) as {
      version: number;
      offsets: Record<string, number>;
    };
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(Object.keys(snapshot.offsets)).toHaveLength(4);

    const { store: second } = await makeStore({ projects, stateDir });
    const changes = vi.fn();
    second.onChange(changes);
    await second.start();

    // resumed from the stored offsets: nothing new to count
    expect(changes).not.toHaveBeenCalled();
    expect(second.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' }).totals.messages)
      .toBe(4);
    expect(second.ready).toBe(true);
  });

  it('keeps serving the old aggregates with stale:true while a version mismatch rescans', async () => {
    const { store, projects, stateDir } = await makeStore();
    await store.start();
    await store.stop();

    const path = join(stateDir, STATE_FILE);
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    snapshot['version'] = SNAPSHOT_VERSION + 1;
    await writeFile(path, JSON.stringify(snapshot));

    const { store: second } = await makeStore({ projects, stateDir });
    await second.start();

    // ready immediately from the loaded aggregates — not a cold start
    const during = second.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    expect(during.ready).toBe(true);
    expect(during.stale).toBe(true);
    expect(during.totals.messages).toBe(4);

    await second.whenIdle();
    const after = second.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    expect(after.stale).toBe(false);
    expect(after.totals.messages).toBe(4);
  });

  it('cold-starts when there is no snapshot at all', async () => {
    const { store } = await makeStore();
    expect(store.ready).toBe(false);
    await store.start();
    expect(store.ready).toBe(true);
    expect(store.stats.dedupKeys).toBe(4);
  });
});

describe('SpendStore watcher integration', () => {
  it('queues filesystem events raised during the initial scan and drains them after', async () => {
    const { store, projects } = await makeStore();
    const startPromise = store.start();
    // an event delivered mid-scan must not be dropped
    await appendFile(join(projects, MAIN_A), APPENDED);
    store.notifyChanged();
    await startPromise;

    // On a slow runner the scan can finish before the append does. The notify then goes through
    // the watcher's debounce instead of the drain, so `whenIdle()` can return before that scan
    // starts (#92). Dropping the event would still fail here, after the timeout.
    await vi.waitFor(() => expect(store.query({ since: 'today', groupBy: 'project' }).totals.messages).toBe(4), {
      timeout: 8000,
      interval: 50,
    });
    expect(store.query({ since: 'today', groupBy: 'project' }).groups[0]?.key).toBe(PROJECT_A);
  }, 10_000);
});
