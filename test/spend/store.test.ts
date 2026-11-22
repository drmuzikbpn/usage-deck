// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import * as fs from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanAll } from '../../src/spend/scanner.js';
import {
  AggregateStore,
  InvalidSinceError,
  parseSince,
  SNAPSHOT_VERSION,
  STATE_FILE,
} from '../../src/spend/store.js';
import type { UsageEvent } from '../../src/spend/types.js';
import {
  cleanupTempDirs,
  copyFixtures,
  makeTempDir,
  PROJECT_A,
  PROJECT_B,
  SESSION_A,
  SESSION_B,
} from './helpers.js';

// A spy that still calls through, to see the size of each write.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

afterEach(cleanupTempDirs);

const NOW = new Date('2026-09-13T12:00:00.000Z');
const now = () => NOW;

async function loadedStore(
  overrides: { retentionDays?: number } = {},
): Promise<{ store: AggregateStore; stateDir: string; projects: string }> {
  const projects = await copyFixtures();
  const stateDir = await makeTempDir('claude-usage-state-');
  const store = new AggregateStore({ stateDir, now, ...overrides });
  const events: UsageEvent[] = [];
  const res = await scanAll(projects, {}, (e) => events.push(e));
  store.ingestAll(events);
  store.setOffsets(res.offsets);
  return { store, stateDir, projects };
}

function sessionEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    dedupKey: 'k',
    timestamp: '2026-09-13T11:00:00.000Z',
    day: '2026-09-13',
    projectKey: PROJECT_A,
    sessionId: 's',
    model: 'a-model',
    cwd: '/home/dev/alpha',
    topLevel: true,
    input: 1,
    output: 1,
    cacheCreate: 0,
    cacheRead: 0,
    ...over,
  };
}

describe('parseSince', () => {
  it('accepts `today` as the UTC day boundary', () => {
    expect(parseSince('today', NOW).instant.toISOString()).toBe('2026-09-13T00:00:00.000Z');
    expect(parseSince('today', NOW).day).toBe('2026-09-13');
  });

  it('accepts `<N>d` and `<N>h` durations', () => {
    expect(parseSince('7d', NOW).instant.toISOString()).toBe('2026-09-06T12:00:00.000Z');
    expect(parseSince('24h', NOW).instant.toISOString()).toBe('2026-09-12T12:00:00.000Z');
    expect(parseSince('1d', NOW).day).toBe('2026-09-12');
  });

  it('accepts an ISO-8601 instant', () => {
    expect(parseSince('2026-09-01T00:00:00.000Z', NOW).day).toBe('2026-09-01');
  });

  it('rejects anything else with a coded error', () => {
    expect(() => parseSince('last tuesday', NOW)).toThrow(InvalidSinceError);
    expect(() => parseSince('', NOW)).toThrow(InvalidSinceError);
    try {
      parseSince('7x', NOW);
    } catch (err) {
      expect((err as InvalidSinceError).code).toBe('invalid_since');
    }
  });
});

describe('AggregateStore.ingest', () => {
  it('counts a dedup key once, however many lines carry it', async () => {
    const { store } = await loadedStore();
    const all = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    expect(all.totals).toEqual({
      input: 1116,
      output: 2228,
      cacheCreate: 3340,
      cacheRead: 4452,
      messages: 5,
    });
    expect(store.counts.dedupKeys).toBe(5);
  });
});

describe('AggregateStore.query groupBy', () => {
  it('groups by project, keyed by the projects dir name verbatim', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    expect(res.groupBy).toBe('project');
    const keys = res.groups.map((g) => g.key);
    expect(keys).toContain(PROJECT_A);
    expect(keys).toContain(PROJECT_B);
    // the encoding is lossy and must never be decoded back into a path
    expect(keys.every((k) => !k.startsWith('/'))).toBe(true);

    const alpha = res.groups.find((g) => g.key === PROJECT_A);
    expect(alpha).toMatchObject({
      label: '/home/dev/alpha',
      input: 16,
      output: 28,
      cacheCreate: 40,
      cacheRead: 52,
      messages: 3,
    });
    const beta = res.groups.find((g) => g.key === PROJECT_B);
    expect(beta).toMatchObject({ label: '/home/dev/beta', input: 1100, messages: 2 });
  });

  it('groups by session, rolling subagent transcripts into the parent session', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'session' });
    expect(res.groups.map((g) => g.key).sort()).toEqual([SESSION_A, SESSION_B].sort());

    // session A's counted lines carry three different cwd values; still one group,
    // labelled with the cwd of the first counted line of its top-level transcript.
    const a = res.groups.find((g) => g.key === SESSION_A);
    expect(a).toMatchObject({ label: '/home/dev/alpha', input: 16, messages: 3 });
  });

  it('groups by model', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'model' });
    const byKey = new Map(res.groups.map((g) => [g.key, g]));
    expect([...byKey.keys()].sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(byKey.get('claude-opus-5')).toMatchObject({
      label: 'claude-opus-5',
      input: 1110,
      output: 2220,
      messages: 3,
    });
    expect(byKey.get('claude-sonnet-5')).toMatchObject({ input: 6, output: 8, messages: 2 });
  });

  it('groups by UTC day, newest first', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'day' });
    expect(res.groups.map((g) => g.key)).toEqual(['2026-09-13', '2026-09-10', '2025-01-01']);
    expect(res.groups[0]).toMatchObject({ label: '2026-09-13', input: 16, messages: 3 });
    expect(res.groups[1]).toMatchObject({ input: 100, messages: 1 });
  });
});

describe('AggregateStore.query since', () => {
  it('`today` keeps only the current UTC day', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: 'today', groupBy: 'day' });
    expect(res.since).toBe('2026-09-13T00:00:00.000Z');
    expect(res.groups.map((g) => g.key)).toEqual(['2026-09-13']);
    expect(res.totals.messages).toBe(3);
  });

  it('`24h` keeps the current UTC day only, given the fixture timestamps', async () => {
    const { store } = await loadedStore();
    expect(store.query({ since: '24h', groupBy: 'day' }).groups.map((g) => g.key)).toEqual([
      '2026-09-13',
    ]);
  });

  it('`7d` reaches back to 2026-09-06 and picks up the 09-10 day', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: '7d', groupBy: 'day' });
    expect(res.groups.map((g) => g.key)).toEqual(['2026-09-13', '2026-09-10']);
    expect(res.totals.messages).toBe(4);
  });

  it('accepts an explicit ISO instant', async () => {
    const { store } = await loadedStore();
    const res = store.query({ since: '2026-09-11T00:00:00.000Z', groupBy: 'day' });
    expect(res.groups.map((g) => g.key)).toEqual(['2026-09-13']);
  });

  it('defaults to since=today, groupBy=project', async () => {
    const { store } = await loadedStore();
    const res = store.query({});
    expect(res.groupBy).toBe('project');
    expect(res.since).toBe('2026-09-13T00:00:00.000Z');
    expect(res.groups.map((g) => g.key)).toEqual([PROJECT_A]);
  });
});

describe('AggregateStore retention', () => {
  it('prunes aggregates and dedup entries older than the window together', async () => {
    const { store } = await loadedStore({ retentionDays: 90 });
    expect(store.counts.dedupKeys).toBe(5);

    const removed = store.prune();
    expect(removed).toBe(1); // the 2025-01-01 aggregate

    const res = store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'day' });
    expect(res.groups.map((g) => g.key)).toEqual(['2026-09-13', '2026-09-10']);
    expect(res.totals).toEqual({
      input: 116,
      output: 228,
      cacheCreate: 340,
      cacheRead: 452,
      messages: 4,
    });
    expect(store.counts.dedupKeys).toBe(4);
  });

  it('keeps everything inside the window', async () => {
    const { store } = await loadedStore({ retentionDays: 3650 });
    expect(store.prune()).toBe(0);
    expect(store.counts.dedupKeys).toBe(5);
  });
});

describe('AggregateStore snapshot', () => {
  it('writes atomically only when dirty and round-trips through a fresh store', async () => {
    const { store, stateDir } = await loadedStore();
    expect(store.dirty).toBe(true);
    expect(await store.save()).toBe(true);
    expect(store.dirty).toBe(false);
    expect(await store.save()).toBe(false); // clean → no rewrite

    const raw = JSON.parse(await readFile(join(stateDir, STATE_FILE), 'utf8')) as {
      version: number;
      dedup: string[];
      offsets: Record<string, number>;
    };
    expect(raw.version).toBe(SNAPSHOT_VERSION);
    expect(Array.isArray(raw.dedup)).toBe(true);
    expect(raw.dedup.every((k) => typeof k === 'string')).toBe(true);
    expect(Object.keys(raw.offsets)).toHaveLength(4);

    const reloaded = new AggregateStore({ stateDir, now });
    const load = await reloaded.load();
    expect(load).toEqual({ loaded: true, versionMismatch: false });
    expect(reloaded.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' })).toEqual(
      store.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' }),
    );
    expect(reloaded.offsets).toEqual(store.offsets);
    expect(reloaded.sessionStartedAt(SESSION_A)).toBe(store.sessionStartedAt(SESSION_A));
    // a reloaded dedup set still suppresses the same keys
    expect(reloaded.counts.dedupKeys).toBe(5);
  });

  // One 66 MB string per save was most of the daemon's memory (§23.71).
  it('writes a large snapshot in small pieces that add up to the same state', async () => {
    const stateDir = await makeTempDir('claude-usage-state-');
    const store = new AggregateStore({ stateDir, now });
    for (let i = 0; i < 20_000; i += 1) {
      store.ingest(sessionEvent({ dedupKey: `msg_"${i}"\\é:req_${i}`, sessionId: `s${i % 500}` }));
    }
    store.setTitle('s1', 'a "quoted" title');
    store.setOffsets({ 'p/a.jsonl': 10, 'p/"b".jsonl': 20 });

    vi.mocked(fs.writeFileSync).mockClear();
    await store.save();
    const sizes = vi.mocked(fs.writeFileSync).mock.calls.map((call) => String(call[1]).length);
    const total = sizes.reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(800_000);
    expect(Math.max(...sizes)).toBeLessThan(100_000);

    const reloaded = new AggregateStore({ stateDir, now });
    expect(await reloaded.load()).toEqual({ loaded: true, versionMismatch: false });
    const all = { since: '2020-01-01T00:00:00.000Z', groupBy: 'session' } as const;
    expect(reloaded.query(all)).toEqual(store.query(all));
    expect(reloaded.counts).toEqual(store.counts);
    expect(reloaded.offsets).toEqual(store.offsets);
    expect(reloaded.sessionTitle('s1')).toBe('a "quoted" title');
    expect(reloaded.ingest(sessionEvent({ dedupKey: 'msg_"7"\\é:req_7' }))).toBe(false);
  });

  it('round-trips an empty store', async () => {
    const stateDir = await makeTempDir('claude-usage-state-');
    const store = new AggregateStore({ stateDir, now });
    store.setOffsets({});
    expect(await store.save()).toBe(true);
    const reloaded = new AggregateStore({ stateDir, now });
    expect(await reloaded.load()).toEqual({ loaded: true, versionMismatch: false });
  });

  it('keeps the snapshot private to the user', async () => {
    const { store, stateDir } = await loadedStore();
    await store.save();
    expect((await stat(join(stateDir, STATE_FILE))).mode & 0o777).toBe(0o600);
  });

  it('keeps the old snapshot, cleans up and tries again after a write that failed', async () => {
    const { store, stateDir } = await loadedStore();
    await store.save();
    const before = await readFile(join(stateDir, STATE_FILE), 'utf8');

    store.ingest(sessionEvent({ dedupKey: 'later' }));
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(store.save()).rejects.toThrow('disk full');
    expect(await readFile(join(stateDir, STATE_FILE), 'utf8')).toBe(before);
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
    expect(store.dirty).toBe(true);
    expect(await store.save()).toBe(true);
  });

  it('cleans up when the snapshot cannot be put in place', async () => {
    const { store, stateDir } = await loadedStore();
    await mkdir(join(stateDir, STATE_FILE, 'in-the-way'), { recursive: true });
    await expect(store.save()).rejects.toThrow();
    expect(await readdir(stateDir)).toEqual([STATE_FILE]);
    expect(store.dirty).toBe(true);
    await rm(join(stateDir, STATE_FILE), { recursive: true });
    expect(await store.save()).toBe(true);
  });

  // Aggregates and dedup keys from different moments would lose or double-count on reload.
  it('never tears: what arrives during a save is in all of the snapshot or none', async () => {
    const stateDir = await makeTempDir('claude-usage-state-');
    const store = new AggregateStore({ stateDir, now });
    let next = 0;
    const arrive = (): void => {
      store.ingest(sessionEvent({ dedupKey: `msg_${next}:req`, sessionId: `s${next}` }));
      next += 1;
    };
    while (next < 5_000) arrive();

    let saving = true;
    const saved = store.save().finally(() => {
      saving = false;
    });
    while (saving) {
      for (let i = 0; i < 50; i += 1) arrive();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await saved;

    const reloaded = new AggregateStore({ stateDir, now });
    await reloaded.load();
    const { totals } = reloaded.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' });
    expect(totals.messages).toBe(reloaded.counts.dedupKeys);
    // and whatever missed this one is still due
    expect(reloaded.counts.dedupKeys < next).toBe(store.dirty);
  });

  it('reports a version mismatch but keeps the old aggregates serving', async () => {
    const { store, stateDir } = await loadedStore();
    await store.save();
    const path = join(stateDir, STATE_FILE);
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    snapshot['version'] = SNAPSHOT_VERSION + 99;
    await writeFile(path, JSON.stringify(snapshot));

    const reloaded = new AggregateStore({ stateDir, now });
    expect(await reloaded.load()).toEqual({ loaded: true, versionMismatch: true });
    expect(reloaded.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' }).totals
      .messages).toBe(5);
  });

  it('treats a missing or unreadable snapshot as a cold start', async () => {
    const stateDir = await makeTempDir('claude-usage-state-');
    const store = new AggregateStore({ stateDir, now });
    expect(await store.load()).toEqual({ loaded: false, versionMismatch: false });

    await writeFile(join(stateDir, STATE_FILE), 'not json at all');
    const broken = new AggregateStore({ stateDir, now });
    expect(await broken.load()).toEqual({ loaded: false, versionMismatch: false });
    expect(broken.query({ since: '2020-01-01T00:00:00.000Z', groupBy: 'project' }).groups).toEqual(
      [],
    );
  });
});

describe('AggregateStore session accessors', () => {
  it('sums a session across its top-level and subagent transcripts', async () => {
    const { store } = await loadedStore();
    expect(store.sessionTotals(SESSION_A)).toEqual({
      input: 16,
      output: 28,
      cacheCreate: 40,
      cacheRead: 52,
      messages: 3,
    });
    expect(store.sessionTotals(SESSION_B)?.messages).toBe(2);
    expect(store.sessionTotals('nope')).toBeNull();
  });

  it('keeps counting a session as more of its lines arrive', async () => {
    const { store } = await loadedStore();
    const before = store.sessionTotals(SESSION_A)?.messages ?? 0;
    expect(store.ingest(sessionEvent({ sessionId: SESSION_A, dedupKey: 'later:1' }))).toBe(true);
    expect(store.ingest(sessionEvent({ sessionId: SESSION_A, dedupKey: 'later:1' }))).toBe(false);
    expect(store.sessionTotals(SESSION_A)?.messages).toBe(before + 1);
  });

  it('sums a session across its days, projects and models', async () => {
    const store = new AggregateStore({ stateDir: await makeTempDir(), now });
    store.ingest(sessionEvent({ dedupKey: 'a', input: 1 }));
    store.ingest(sessionEvent({ dedupKey: 'b', input: 2, day: '2026-09-12' }));
    store.ingest(sessionEvent({ dedupKey: 'c', input: 4, projectKey: PROJECT_B }));
    store.ingest(sessionEvent({ dedupKey: 'd', input: 8, model: 'another-model' }));
    store.ingest(sessionEvent({ dedupKey: 'e', input: 16, sessionId: 'someone-else' }));
    expect(store.sessionTotals('s')).toMatchObject({ input: 15, messages: 4 });
  });

  it('hands out totals the caller cannot change the store through', async () => {
    const { store } = await loadedStore();
    const totals = store.sessionTotals(SESSION_A);
    expect(totals).not.toBeNull();
    if (totals) totals.input = 999_999;
    expect(store.sessionTotals(SESSION_A)?.input).toBe(16);
  });

  it('has the same session totals after a reload, in place of what it held before', async () => {
    const { store, stateDir } = await loadedStore();
    await store.save();
    const reloaded = new AggregateStore({ stateDir, now });
    reloaded.ingest(sessionEvent({ sessionId: 'not-in-snapshot', dedupKey: 'x' }));
    reloaded.ingest(sessionEvent({ sessionId: SESSION_A, dedupKey: 'y' }));
    await reloaded.load();
    expect(reloaded.sessionTotals(SESSION_A)).toEqual(store.sessionTotals(SESSION_A));
    expect(reloaded.sessionTotals(SESSION_B)).toEqual(store.sessionTotals(SESSION_B));
    expect(reloaded.sessionTotals('not-in-snapshot')).toBeNull();
  });

  it('drops pruned days from a session total, and a fully pruned session altogether', async () => {
    const store = new AggregateStore({ stateDir: await makeTempDir(), now, retentionDays: 30 });
    store.ingest(sessionEvent({ dedupKey: 'old', input: 100, day: '2026-01-01' }));
    store.ingest(sessionEvent({ dedupKey: 'new', input: 5 }));
    store.ingest(sessionEvent({ dedupKey: 'gone', sessionId: 'gone', day: '2026-01-01' }));
    expect(store.prune()).toBe(2);
    expect(store.sessionTotals('s')).toMatchObject({ input: 5, messages: 1 });
    expect(store.sessionTotals('gone')).toBeNull();
  });

  // A session read used to walk every aggregate, so listing N sessions cost N². With one
  // aggregate per session, 8,000 of them took many seconds and blocked the daemon (§23.69).
  it('reads one session without walking the others', async () => {
    const store = new AggregateStore({ stateDir: await makeTempDir(), now });
    for (let i = 0; i < 8_000; i += 1) store.ingest(sessionEvent({ sessionId: `s-${i}`, dedupKey: `k-${i}` }));
    const started = performance.now();
    for (let i = 0; i < 8_000; i += 1) expect(store.sessionTotals(`s-${i}`)?.messages).toBe(1);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 60_000);

  it('reports the most recent top-level model and the first counted timestamp', async () => {
    const { store } = await loadedStore();
    expect(store.sessionModel(SESSION_A)).toBe('claude-sonnet-5');
    expect(store.sessionStartedAt(SESSION_A)).toBe('2026-09-13T10:00:00.000Z');
    expect(store.sessionModel('nope')).toBeNull();
    expect(store.sessionStartedAt('nope')).toBeNull();
  });
});
