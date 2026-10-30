// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * §23.36: rate limits observed from Claude Code's own statusline input.
 *
 * The usage endpoint allows this daemon only a few calls an hour (§23.32–§23.35). Claude Code
 * already reads the 5-hour and 7-day utilisation from the headers of every model response
 * and passes them to the statusline command as `rate_limits`, so the daemon can take them
 * from there at no upstream cost and keep the endpoint for what only it has.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/clients/http.js';
import { writeJsonFile } from '../src/config.js';
import {
  LimitsPoller,
  OBSERVATION_TTL_MS,
  OBSERVED_UPSTREAM_INTERVAL_MS,
} from '../src/limits/poller.js';
import { OBSERVE_DEDUPE_MS, OBSERVE_PATH, runObserve } from '../src/observe.js';
import { createServer, type UsageServer } from '../src/server/index.js';
import { runStatusline } from '../src/statusline.js';
import { FakeTimers, flush } from './helpers/fake-timers.js';
import { testConfig } from './helpers/fakes.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const EPOCH = Date.parse('2026-09-26T08:00:00.000Z');
const INTERVAL = 120_000;
const secs = (ms: number): number => Math.floor(ms / 1000);

function rateLimits(fiveHour: number, sevenDay: number, resetMs = EPOCH + 3 * 3_600_000) {
  return {
    five_hour: { used_percentage: fiveHour, resets_at: secs(resetMs) },
    seven_day: { used_percentage: sevenDay, resets_at: secs(EPOCH + 5 * 86_400_000) },
  };
}

/**
 * The live fixture with its windows moved to reset at `sessionResetMs` / `weeklyResetMs`.
 * Its own dates are two weeks before EPOCH, so every window in it has already reset (§23.40).
 */
function upstreamResettingAt(sessionResetMs: number, weeklyResetMs = EPOCH + 5 * 86_400_000) {
  const text = JSON.stringify(liveLimitsFixture())
    .replaceAll('2026-09-13T18:00:00.114379+00:00', new Date(sessionResetMs).toISOString())
    .replaceAll(/2026-09-16T13:00:00\.\d+\+00:00/g, new Date(weeklyResetMs).toISOString());
  return JSON.parse(text) as Record<string, unknown>;
}

function harness(
  opts: { upstream?: boolean; upstreamBody?: () => Record<string, unknown>; configDir?: string; startAt?: number } = {},
) {
  const timers = new FakeTimers();
  timers.clock = opts.startAt ?? 0;
  let calls = 0;
  let failing = opts.upstream === false;
  const poller = new LimitsPoller({
    intervalMs: INTERVAL,
    timers,
    now: () => EPOCH + timers.clock,
    getToken: async () => 'tok',
    fetchLimitsImpl: async () => {
      calls += 1;
      if (failing) throw new Error('no upstream in this test');
      return (opts.upstreamBody ?? liveLimitsFixture)();
    },
    ...(opts.configDir === undefined ? {} : { configDir: opts.configDir }),
  });
  return {
    poller,
    timers,
    calls: () => calls,
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

const byId = (poller: LimitsPoller, id: string) => poller.snapshot().limits.find((l) => l.id === id);

describe('LimitsPoller.observe (§23.36)', () => {
  it('serves session and weekly_all from a statusline observation', () => {
    const h = harness();
    expect(h.poller.observe(rateLimits(10.4, 52))).toEqual({ accepted: true });
    const session = byId(h.poller, 'session');
    expect(session).toMatchObject({
      percent: 10,
      source: 'statusline',
      asOf: new Date(EPOCH).toISOString(),
      resetsAt: new Date(secs(EPOCH + 3 * 3_600_000) * 1000).toISOString(),
    });
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 52, source: 'statusline', group: 'weekly' });
  });

  it('accepts resets_at as an ISO string too', () => {
    const h = harness();
    const iso = '2026-09-26T11:00:00.000Z';
    h.poller.observe({ five_hour: { used_percentage: 5, resets_at: iso } });
    expect(byId(h.poller, 'session')?.resetsAt).toBe(iso);
  });

  it('garbage never overwrites good data', () => {
    const h = harness();
    h.poller.observe(rateLimits(40, 50));
    const garbage: unknown[] = [
      null,
      'nope',
      [],
      {},
      { five_hour: null },
      { five_hour: { used_percentage: 150, resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: -1, resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: '40', resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: Number.NaN, resets_at: secs(EPOCH) } },
      { five_hour: { used_percentage: 12, resets_at: 'soon' } },
      { five_hour: { used_percentage: 12, resets_at: secs(EPOCH) }, seven_day: { used_percentage: 999 } },
    ];
    for (const input of garbage) {
      const result = h.poller.observe(input);
      expect(result.accepted, JSON.stringify(input)).toBe(false);
    }
    expect(byId(h.poller, 'session')?.percent).toBe(40);
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(50);
  });

  it('an observation expires at its own resets_at, even inside the freshness window', async () => {
    const reset = EPOCH + 5 * 60_000;
    const h = harness({ upstreamBody: () => upstreamResettingAt(reset) });
    h.poller.start();
    await flush();
    h.poller.stop();
    expect(byId(h.poller, 'session')).toMatchObject({ percent: 5, source: 'upstream', stale: false });

    h.poller.observe(rateLimits(77, 50, reset));
    expect(byId(h.poller, 'session')).toMatchObject({ percent: 77, source: 'statusline' });

    h.timers.clock += 5 * 60_000; // exactly the reset, well inside OBSERVATION_TTL_MS
    expect(5 * 60_000).toBeLessThan(OBSERVATION_TTL_MS);
    // §23.40: the upstream row underneath describes the window that just ended. Its 5% is
    // not old news, it is wrong — so the row is unknown and stale, not a fallback.
    expect(byId(h.poller, 'session')).toMatchObject({ percent: null, severity: null, source: 'upstream', stale: true });
    expect(h.poller.snapshot().legacyWindows['five_hour']?.utilization).toBeNull();
    // The 7-day window has not reset, so it is still served from the observation…
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 50, source: 'statusline', stale: false });
    // …and that no longer hides the session row going stale (§23.40).
    expect(h.poller.snapshot().stale).toBe(true);
  });

  describe('a new week while upstream is failing (§23.67)', () => {
    const start = async (weeklyResetMs: number) => {
      const h = harness({ upstreamBody: () => upstreamResettingAt(EPOCH + 3 * 3_600_000, weeklyResetMs) });
      h.poller.start();
      await flush();
      return h;
    };
    const fail = async (h: Awaited<ReturnType<typeof start>>) => {
      h.setFailing(true);
      await h.timers.advance(OBSERVED_UPSTREAM_INTERVAL_MS + INTERVAL);
      await flush();
      h.poller.stop();
    };

    it('serves the scoped rows as unknown once the statusline names another week', async () => {
      const h = await start(EPOCH + 2 * 86_400_000);
      expect(byId(h.poller, 'weekly_scoped:fable')?.percent).not.toBeNull();
      await fail(h);
      expect(h.poller.observe(rateLimits(0, 0)).accepted).toBe(true); // resets at EPOCH + 5d
      expect(byId(h.poller, 'weekly_scoped:fable')).toMatchObject({ percent: null, severity: null, resetsAt: null, stale: true });
      expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 0, source: 'statusline', stale: false });
      const legacy = h.poller.snapshot().legacyWindows;
      expect(legacy['seven_day']).toMatchObject({ utilization: 0 });
      for (const [key, win] of Object.entries(legacy)) {
        if (key !== 'five_hour' && key !== 'seven_day') expect(win).toEqual({ utilization: null, resetsAt: null });
      }
    });

    it('keeps them while the statusline shows the same week', async () => {
      const h = await start(EPOCH + 5 * 86_400_000);
      const before = byId(h.poller, 'weekly_scoped:fable')?.percent;
      await fail(h);
      h.poller.observe(rateLimits(3, 4));
      expect(byId(h.poller, 'weekly_scoped:fable')?.percent).toBe(before);
    });

    it('keeps them when upstream is healthy, because it speaks for them', async () => {
      const h = await start(EPOCH + 2 * 86_400_000);
      h.poller.stop();
      const before = byId(h.poller, 'weekly_scoped:fable')?.percent;
      h.poller.observe(rateLimits(0, 0));
      expect(byId(h.poller, 'weekly_scoped:fable')?.percent).toBe(before);
    });
  });

  it('an upstream row is served as-is until its own window resets', async () => {
    const reset = EPOCH + 60 * 60_000;
    const h = harness({ upstreamBody: () => upstreamResettingAt(reset) });
    h.poller.start();
    await flush();
    h.poller.stop();
    h.timers.clock += 60 * 60_000 - 1;
    expect(byId(h.poller, 'session')).toMatchObject({ percent: 5, stale: false });
    expect(h.poller.snapshot().stale).toBe(false);
    h.timers.clock += 1;
    expect(byId(h.poller, 'session')).toMatchObject({ percent: null, stale: true });
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 13, stale: false });
    expect(h.poller.snapshot().stale).toBe(true);
  });

  it('an idle session re-sending an old reading does not overwrite a newer one (§23.40)', () => {
    const h = harness({ upstream: false });
    const window1 = EPOCH + 3 * 3_600_000;
    const window2 = window1 + 5 * 3_600_000;

    h.poller.observe(rateLimits(10, 52, window1));
    // An idle session re-renders with its last response's numbers: same window, lower.
    h.timers.clock += 1_000;
    h.poller.observe(rateLimits(3, 50, window1));
    expect(byId(h.poller, 'session')).toMatchObject({ percent: 10, asOf: new Date(EPOCH).toISOString() });
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(52);

    // A live session's higher reading in the same window is taken, as is an equal one.
    h.poller.observe(rateLimits(12, 52, window1));
    expect(byId(h.poller, 'session')?.percent).toBe(12);
    h.timers.clock += 1_000;
    h.poller.observe(rateLimits(12, 52, window1));
    expect(byId(h.poller, 'session')?.asOf).toBe(new Date(EPOCH + 2_000).toISOString());

    // A small jitter in resets_at is still the same window.
    h.poller.observe(rateLimits(4, 52, window1 + 1_000));
    expect(byId(h.poller, 'session')?.percent).toBe(12);

    // After the reset: the new window's low reading wins; the old window's is refused.
    h.timers.clock = window1 - EPOCH;
    h.poller.observe(rateLimits(1, 53, window2));
    expect(byId(h.poller, 'session')).toMatchObject({ percent: 1, stale: false });
    h.poller.observe(rateLimits(26, 53, window1));
    expect(byId(h.poller, 'session')?.percent).toBe(1);
    // Nor does an earlier window get in while the held one is still open.
    h.poller.observe(rateLimits(30, 53, window2 - 5 * 3_600_000 + 60_000));
    expect(byId(h.poller, 'session')?.percent).toBe(1);
  });

  it('an old reading is refused even after the held observation has gone quiet', () => {
    const h = harness({ upstream: false });
    const window1 = EPOCH + 3 * 3_600_000;
    h.poller.observe(rateLimits(10, 52, window1));
    h.timers.clock += OBSERVATION_TTL_MS;
    expect(byId(h.poller, 'session')).toBeUndefined();
    // The only session still rendering is an idle one with older numbers.
    h.poller.observe(rateLimits(3, 50, window1));
    expect(byId(h.poller, 'session')).toBeUndefined();
  });

  it('a plan change drops weekly_all mid-window: a session whose own reading moves is believed (§23.64)', () => {
    const h = harness({ upstream: false });
    const window1 = EPOCH + 3 * 3_600_000;
    const live = '11111111-1111-4111-8111-111111111111';
    const idle = '22222222-2222-4222-8222-222222222222';
    const fresh = '33333333-3333-4333-8333-333333333333';
    const tagged = (sessionId: string, fiveHour: number, sevenDay: number) => ({
      ...rateLimits(fiveHour, sevenDay, window1),
      session_id: sessionId,
    });

    h.poller.observe(tagged(live, 10, 99));
    h.poller.observe(tagged(idle, 10, 99));
    // The upgrade: the live session's next response reports far less of the bigger budget.
    h.timers.clock += 1_000;
    h.poller.observe(tagged(live, 10, 1));
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 1, stale: false });
    // The idle session re-renders its unchanged pre-upgrade numbers: an old reading, even
    // though it is higher. Nor does an untagged one raise the dropped window.
    h.poller.observe(tagged(idle, 10, 99));
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(1);
    h.poller.observe(rateLimits(10, 99, window1));
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(1);
    // The live session's unchanged re-render refreshes asOf; its next response climbs.
    h.timers.clock += 1_000;
    h.poller.observe(tagged(live, 10, 1));
    expect(byId(h.poller, 'weekly_all')?.asOf).toBe(new Date(EPOCH + 2_000).toISOString());
    h.poller.observe(tagged(live, 11, 2));
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(2);

    // A session first seen after the drop is not believed on its first lower reading
    // (it could be an idle one just resumed), only once its own number moves.
    const h2 = harness({ upstream: false });
    h2.poller.observe({ ...rateLimits(10, 99, window1), session_id: live });
    h2.poller.observe({ ...rateLimits(10, 1, window1), session_id: fresh });
    expect(byId(h2.poller, 'weekly_all')?.percent).toBe(99);
    h2.poller.observe({ ...rateLimits(10, 2, window1), session_id: fresh });
    expect(byId(h2.poller, 'weekly_all')?.percent).toBe(2);

    // Untagged bodies (an older client) and non-UUID ids keep the plain §23.40 rule.
    const h3 = harness({ upstream: false });
    h3.poller.observe({ ...rateLimits(10, 99, window1), session_id: 'nope' });
    h3.poller.observe({ ...rateLimits(10, 1, window1), session_id: 'nope' });
    expect(byId(h3.poller, 'weekly_all')?.percent).toBe(99);
  });

  it(`an observation expires after OBSERVATION_TTL_MS`, () => {
    const h = harness();
    h.poller.observe(rateLimits(20, 30));
    h.timers.clock += OBSERVATION_TTL_MS - 1;
    expect(byId(h.poller, 'session')?.source).toBe('statusline');
    h.timers.clock += 1;
    expect(byId(h.poller, 'session')).toBeUndefined();
    expect(h.poller.snapshot().limits).toEqual([]);
  });

  it('newer wins per limit id, giving a mixed-source snapshot', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.poller.stop();

    h.timers.clock += 60_000;
    h.poller.observe(rateLimits(11, 22));
    const mixed = h.poller.snapshot();
    expect(mixed.limits.find((l) => l.id === 'session')).toMatchObject({ percent: 11, source: 'statusline' });
    expect(mixed.limits.find((l) => l.id === 'weekly_all')).toMatchObject({ percent: 22, source: 'statusline' });
    const scoped = mixed.limits.find((l) => l.id.startsWith('weekly_scoped'));
    expect(scoped).toMatchObject({ source: 'upstream', asOf: new Date(EPOCH).toISOString() });
    // Observed values have no upstream severity to lean on.
    expect(mixed.limits.find((l) => l.id === 'session')?.severity).toBeNull();

    // A newer upstream fetch wins back both ids.
    h.timers.clock += 60_000;
    await h.poller.refresh();
    expect(byId(h.poller, 'session')?.source).toBe('upstream');
    expect(byId(h.poller, 'weekly_all')?.source).toBe('upstream');
  });

  it('statusline-only data: source and age on each limit, fetchedAt null, stale false', () => {
    const h = harness({ upstream: false });
    h.poller.observe(rateLimits(10, 52));
    const snap = h.poller.snapshot();
    expect(snap.fetchedAt).toBeNull();
    expect(snap.stale).toBe(false);
    expect(snap.raw).toBeNull();
    expect(snap.limits.map((l) => [l.id, l.source, l.asOf])).toEqual([
      ['session', 'statusline', new Date(EPOCH).toISOString()],
      ['weekly_all', 'statusline', new Date(EPOCH).toISOString()],
    ]);
  });

  it('a fresh observation clears stale even while upstream is failing', async () => {
    const h = harness({ upstream: false });
    h.poller.start();
    await flush();
    h.poller.stop();
    h.poller.observe(rateLimits(10, 52));
    expect(h.poller.snapshot().stale).toBe(false);
    expect(h.poller.snapshot().error?.code).toBe('network');
  });

  it('notifies onChange when an observation changes the body', () => {
    const h = harness();
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });
    h.poller.observe(rateLimits(10, 52));
    h.poller.observe(rateLimits(10, 52));
    expect(fired).toBe(1);
    h.poller.observe(rateLimits(11, 52));
    expect(fired).toBe(2);
  });

  it('legacyWindows mirrors a fresh observation, unrounded, and falls back once it expires', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.poller.stop();
    const upstreamLegacy = h.poller.snapshot().legacyWindows;

    h.poller.observe(rateLimits(41.6, 63.2));
    const legacy = h.poller.snapshot().legacyWindows;
    expect(legacy['five_hour']).toEqual({ utilization: 41.6, resetsAt: byId(h.poller, 'session')?.resetsAt });
    expect(legacy['seven_day']).toEqual({ utilization: 63.2, resetsAt: byId(h.poller, 'weekly_all')?.resetsAt });

    h.timers.clock += OBSERVATION_TTL_MS;
    expect(h.poller.snapshot().legacyWindows).toEqual(upstreamLegacy);
  });

  it('when an observation lapses, push clients hear it: onChange fires and stale returns', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    h.setFailing(true);
    await h.timers.advance(INTERVAL);
    expect(h.poller.snapshot().stale).toBe(true);

    h.poller.observe(rateLimits(41, 63));
    expect(h.poller.snapshot().stale).toBe(false);
    let fired = 0;
    h.poller.onChange(() => {
      fired += 1;
    });

    // Nothing else changes the body between now and the lapse; only the expiry wake-up can.
    await h.timers.advance(OBSERVATION_TTL_MS - 1);
    expect(fired).toBe(0);
    await h.timers.advance(1);
    expect(fired).toBe(1);
    expect(h.poller.snapshot().stale).toBe(true);
    expect(byId(h.poller, 'session')?.source).toBe('upstream');

    // stop() takes a pending expiry wake-up with it.
    h.poller.observe(rateLimits(42, 63));
    h.poller.stop();
    expect(h.timers.pendingCount).toBe(0);
  });

  it('fresh observations survive a restart, and the new process does not poll upstream for them (§23.42)', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cu-observed-'));
    const before = harness({ configDir });
    before.poller.start();
    await flush();
    before.poller.observe(rateLimits(21, 86));
    before.poller.stop(); // what an auto-update's SIGTERM runs

    // Five minutes later: past the base interval, well inside OBSERVATION_TTL_MS.
    const after = harness({ configDir, startAt: 5 * 60_000 });
    expect(byId(after.poller, 'session')).toMatchObject({ percent: 21, source: 'statusline', stale: false });
    expect(after.poller.snapshot().legacyWindows['seven_day']?.utilization).toBe(86);
    expect(after.poller.snapshot().stale).toBe(false);
    after.poller.start();
    await flush();
    expect(after.calls()).toBe(0);
    // Its lapse is still pushed on time.
    let fired = 0;
    after.poller.onChange(() => {
      fired += 1;
    });
    await after.timers.advance(OBSERVATION_TTL_MS - 5 * 60_000);
    expect(fired).toBe(1);
    after.poller.stop();

    // A restart after the TTL has nothing to restore.
    const late = harness({ configDir, startAt: OBSERVATION_TTL_MS });
    expect(byId(late.poller, 'session')?.source).toBe('upstream');
  });

  it('an old reading is still refused after a restart (§23.40, §23.42)', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cu-observed-'));
    const before = harness({ configDir, upstream: false });
    before.poller.start();
    before.poller.observe(rateLimits(21, 86));
    before.poller.stop();
    const after = harness({ configDir, upstream: false, startAt: 1_000 });
    after.poller.observe(rateLimits(3, 80));
    expect(byId(after.poller, 'session')?.percent).toBe(21);
    expect(byId(after.poller, 'weekly_all')?.percent).toBe(86);
  });

  it('a plan upgrade that starts an earlier-resetting window: the moved session wins (§23.65)', () => {
    const h = harness({ upstream: false });
    const oldWeek = EPOCH + 5 * 86_400_000;
    const newWeek = EPOCH + 2 * 86_400_000;
    const live = '77777777-7777-4777-8777-777777777777';
    const idle = '88888888-8888-4888-8888-888888888888';
    const body = (sessionId: string, sevenDay: number, resetMs: number) => ({
      seven_day: { used_percentage: sevenDay, resets_at: secs(resetMs) },
      session_id: sessionId,
    });

    h.poller.observe(body(live, 99, oldWeek));
    h.poller.observe(body(idle, 99, oldWeek));
    h.timers.clock += 1_000;
    h.poller.observe(body(live, 1, newWeek));
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 1, resetsAt: new Date(newWeek).toISOString() });
    // The idle session's old, later-resetting week does not come back…
    h.poller.observe(body(idle, 99, oldWeek));
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(1);
    // …nor does an untagged, unmoved one; the live session keeps climbing.
    h.poller.observe({ seven_day: { used_percentage: 99, resets_at: secs(oldWeek) } });
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(1);
    h.poller.observe(body(live, 2, newWeek));
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(2);

    // When the new week resets, the next window is taken from anyone, as before.
    h.timers.clock = newWeek - EPOCH;
    h.poller.observe({ seven_day: { used_percentage: 0, resets_at: secs(newWeek + 7 * 86_400_000) } });
    expect(byId(h.poller, 'weekly_all')?.percent).toBe(0);
  });

  it('a session whose window changes but whose percent does not has still moved (§23.65)', () => {
    const h = harness({ upstream: false });
    const oldWeek = EPOCH + 5 * 86_400_000;
    const newWeek = EPOCH + 2 * 86_400_000;
    const live = '99999999-9999-4999-8999-999999999999';
    const body = (sevenDay: number, resetMs: number) => ({
      seven_day: { used_percentage: sevenDay, resets_at: secs(resetMs) },
      session_id: live,
    });

    h.poller.observe(body(5, oldWeek));
    h.timers.clock += 1_000;
    h.poller.observe(body(5, newWeek));
    expect(byId(h.poller, 'weekly_all')).toMatchObject({ percent: 5, resetsAt: new Date(newWeek).toISOString() });
  });

  it('a dropped window stays dropped across a restart (§23.42, §23.64)', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cu-observed-'));
    const live = '55555555-5555-4555-8555-555555555555';
    const before = harness({ configDir, upstream: false });
    before.poller.start();
    before.poller.observe({ ...rateLimits(10, 99), session_id: live });
    before.timers.clock += 1_000;
    before.poller.observe({ ...rateLimits(10, 1), session_id: live });
    before.poller.stop();
    const after = harness({ configDir, upstream: false, startAt: 2_000 });
    // An idle session's pre-upgrade numbers, first seen by the new process.
    after.poller.observe({ ...rateLimits(10, 99), session_id: '66666666-6666-4666-8666-666666666666' });
    expect(byId(after.poller, 'weekly_all')?.percent).toBe(1);
  });

  it('polls upstream at most hourly while observations are fresh, adaptive again after', async () => {
    const h = harness();
    h.poller.start();
    await flush();
    expect(h.timers.nextDelay).toBe(INTERVAL);

    h.poller.observe(rateLimits(10, 52));
    await h.timers.advance(INTERVAL);
    expect(h.calls()).toBe(2);
    // The poll, plus the §23.37 wake-up for when the observation lapses.
    expect(h.timers.delays).toEqual([OBSERVATION_TTL_MS - INTERVAL, OBSERVED_UPSTREAM_INTERVAL_MS]);

    // Observation long gone by the time the hourly poll lands: back to the base interval.
    await h.timers.advance(OBSERVED_UPSTREAM_INTERVAL_MS);
    expect(h.calls()).toBe(3);
    expect(h.timers.nextDelay).toBe(INTERVAL);
    h.poller.stop();
  });
});

// --- the HTTP route ---------------------------------------------------------

const servers: UsageServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function serve(poller: LimitsPoller): Promise<string> {
  const server = createServer({ config: testConfig(), limits: poller, version: '9.9.9' });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${String(port)}`;
}

describe(`POST ${OBSERVE_PATH}`, () => {
  it('needs the bearer token even from loopback', async () => {
    const base = await serve(harness().poller);
    const res = await fetch(`${base}${OBSERVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rateLimits(10, 52)),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a good body and GET /v1/limits reflects it; garbage is a 400', async () => {
    const h = harness();
    const base = await serve(h.poller);
    const client = new DaemonClient({ baseUrl: base, token: 'test-bearer-token' });
    await client.post(OBSERVE_PATH, rateLimits(10, 52));
    const body = (await client.get('/v1/limits')) as { limits: Array<{ id: string; percent: number; source: string }> };
    expect(body.limits.find((l) => l.id === 'session')).toMatchObject({ percent: 10, source: 'statusline' });

    const err = await client.post(OBSERVE_PATH, { five_hour: { used_percentage: 500 } }).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect(byId(h.poller, 'session')?.percent).toBe(10);
  });
});

// --- the `observe` subcommand -----------------------------------------------

function observeHarness() {
  const configDir = mkdtempSync(join(tmpdir(), 'cu-observe-'));
  writeJsonFile(join(configDir, 'config.json'), { auth: { token: 'test-bearer-token' } });
  const posts: Array<{ path: string; body: unknown; token: string | undefined }> = [];
  let clock = EPOCH;
  let fail = false;
  const run = (stdin: string) =>
    runObserve({
      stdin,
      configDir,
      now: () => clock,
      post: async (path, body, token) => {
        if (fail) throw new Error('daemon down');
        posts.push({ path, body, token });
      },
    });
  return {
    run,
    posts,
    advance: (ms: number) => {
      clock += ms;
    },
    failPosts: () => {
      fail = true;
    },
  };
}

const SL_SESSION = '44444444-4444-4444-8444-444444444444';
const statuslineInput = (limits: unknown, sessionId: string = SL_SESSION) =>
  JSON.stringify({ session_id: sessionId, model: { id: 'x' }, rate_limits: limits });

describe('claude-usage observe', () => {
  it('POSTs rate_limits with the bearer token', async () => {
    const h = observeHarness();
    expect(await h.run(statuslineInput(rateLimits(10, 52)))).toBe(0);
    expect(h.posts).toEqual([
      { path: OBSERVE_PATH, body: { ...rateLimits(10, 52), session_id: SL_SESSION }, token: 'test-bearer-token' },
    ]);
  });

  it('tags the body with the session id only when it is a UUID (§23.64)', async () => {
    const h = observeHarness();
    await h.run(statuslineInput(rateLimits(10, 52), 's1'));
    expect(h.posts[0]?.body).toEqual(rateLimits(10, 52));
  });

  it('does nothing without rate_limits, or with unparseable stdin', async () => {
    const h = observeHarness();
    expect(await h.run(JSON.stringify({ session_id: 's1' }))).toBe(0);
    expect(await h.run('not json')).toBe(0);
    expect(await h.run('')).toBe(0);
    expect(h.posts).toHaveLength(0);
  });

  it(`skips a byte-identical payload sent within OBSERVE_DEDUPE_MS`, async () => {
    const h = observeHarness();
    await h.run(statuslineInput(rateLimits(10, 52)));
    h.advance(OBSERVE_DEDUPE_MS - 1);
    await h.run(statuslineInput(rateLimits(10, 52)));
    expect(h.posts).toHaveLength(1);

    // A change goes straight through…
    await h.run(statuslineInput(rateLimits(11, 52)));
    expect(h.posts).toHaveLength(2);
    // …and the same payload again once the dedupe window has passed.
    h.advance(OBSERVE_DEDUPE_MS);
    await h.run(statuslineInput(rateLimits(11, 52)));
    expect(h.posts).toHaveLength(3);
  });

  it('is silent and exits 0 when the daemon is down, and retries next time', async () => {
    const h = observeHarness();
    h.failPosts();
    expect(await h.run(statuslineInput(rateLimits(10, 52)))).toBe(0);
    expect(h.posts).toHaveLength(0);
  });
});

describe('claude-usage statusline forwards rate_limits (§23.36)', () => {
  it('observes as a side effect of rendering', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'cu-sl-'));
    const seen: unknown[] = [];
    await runStatusline({
      stdin: statuslineInput(rateLimits(10, 52)),
      configDir,
      stdout: () => undefined,
      client: { get: async () => ({}) },
      observe: async (stdin) => {
        seen.push(JSON.parse(stdin));
        return 0;
      },
    });
    expect(seen).toHaveLength(1);
  });
});
