// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../config.js';
import { isSessionId } from '../sessions/validate.js';
import { defaultFetch, fetchLimits, type FetchLike } from './client.js';
import { normalizeLimits } from './normalize.js';
import {
  LimitsError,
  emptySnapshot,
  type LimitsErrorInfo,
  type LegacyWindow,
  type LimitsSnapshot,
  type NormalizedLimit,
  type ObserveResult,
} from './types.js';

/**
 * The usage endpoint's budget is unpublished, and 60 s polling from one machine was enough
 * to earn a 429 with a 50-minute Retry-After (§23.33). Limits move slowly; five minutes is
 * plenty for a dashboard, and the floor below holds for configs written with the old default.
 */
export const DEFAULT_POLL_INTERVAL_MS = 300_000;
/** No configured interval polls faster than this (§23.33). */
export const MIN_POLL_INTERVAL_MS = 120_000;
/** Each upstream 429 doubles the effective interval, up to this (§23.33). */
export const MAX_ADAPTIVE_INTERVAL_MS = 1_800_000;
/** Consecutive successful polls before a slowed-down interval is halved again (§23.33). */
export const RELAX_AFTER_SUCCESSES = 12;
/** Backoff cap, and the interval an expired token is parked at (§23.3). */
export const MAX_BACKOFF_MS = 600_000;
/**
 * `POST /v1/refresh` is served from cache when upstream was called less than this long ago —
 * by a refresh *or* a scheduled poll (§4, amended by §23.33).
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/** `config.pollIntervalMs` as the poller will actually use it (§23.33). */
export function effectivePollIntervalMs(configured: number): number {
  return Math.max(configured, MIN_POLL_INTERVAL_MS);
}
/**
 * Ceiling on an upstream `Retry-After` (§23.32). Upstream has asked for ~50 min; a value in
 * days is more likely a parse or clock problem than an instruction, and the daemon must not
 * go quiet for that long on the strength of one header.
 */
export const MAX_RETRY_AFTER_MS = 6 * 3_600_000;
/**
 * §23.36: how long a statusline observation is believed. Claude Code keeps serving the last
 * header values while its own requests are refused, so an observation also ends at its
 * window's `resets_at`, whichever comes first.
 */
export const OBSERVATION_TTL_MS = 900_000;
/** §23.36: upstream poll interval while observations are fresh — only for what they lack. */
export const OBSERVED_UPSTREAM_INTERVAL_MS = 3_600_000;

/**
 * §23.40: two statusline readings whose `resets_at` differ by less than this describe the
 * same window. Real windows are hours apart; this only absorbs any jitter in the header.
 */
export const SAME_WINDOW_TOLERANCE_MS = 1_800_000;

/** §23.64: how long a session's last reading is remembered, and how many sessions at most. */
export const SESSION_READING_TTL_MS = 24 * 3_600_000;
const MAX_SESSION_READINGS = 256;

interface SessionReading {
  win: ObservedWindow;
  movedAt: number | undefined;
}

/** Statusline window → the limit id it feeds, in the order a statusline-only body lists them. */
const OBSERVED_WINDOWS: ReadonlyArray<{ key: string; id: string; kind: string; group: string }> = [
  { key: 'five_hour', id: 'session', kind: 'session', group: 'session' },
  { key: 'seven_day', id: 'weekly_all', kind: 'weekly_all', group: 'weekly' },
];

interface Observation {
  percent: number;
  /** `used_percentage` as sent, unrounded, for `legacyWindows` (§23.37). */
  utilization: number;
  resetsAt: string | null;
  resetsAtMs: number | null;
  observedAt: number;
  /** §23.64: when the posting session's own number last changed; absent when unknown. */
  movedAt?: number;
  /** §23.64: a move overruled §23.40 here (a plan change); unmoved readings may not undo it. */
  dropped?: boolean;
}

type ObservedWindow = Omit<Observation, 'observedAt' | 'movedAt' | 'dropped'>;

/**
 * §23.64/§23.65: when this session's reading last changed — its number or its window. A
 * change from its own previous reading is `now`; an unchanged one keeps its earlier time; a
 * session's first reading is of unknown age.
 */
function movedAtOf(previous: SessionReading | undefined, win: ObservedWindow, now: number): number | undefined {
  if (previous === undefined) return undefined;
  const unchanged = win.utilization === previous.win.utilization && win.resetsAtMs === previous.win.resetsAtMs;
  return unchanged ? previous.movedAt : now;
}

/** §23.40: both readings name a `resets_at`, within `SAME_WINDOW_TOLERANCE_MS` of each other. */
function sameWindow(a: ObservedWindow | undefined, b: ObservedWindow): boolean {
  if (a === undefined || a.resetsAtMs === null || b.resetsAtMs === null) return false;
  return Math.abs(a.resetsAtMs - b.resetsAtMs) <= SAME_WINDOW_TOLERANCE_MS;
}

/**
 * One statusline window, validated field by field; `null` when it is not usable.
 * `used_percentage` must be a finite 0–100; `resets_at` epoch seconds, an ISO string, or absent.
 */
function parseObservedWindow(value: unknown): ObservedWindow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const pct = rec['used_percentage'];
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  const raw = rec['resets_at'];
  let resetsAtMs: number | null = null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    resetsAtMs = raw * 1000;
  } else if (typeof raw === 'string') {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return null;
    resetsAtMs = at;
  } else if (raw !== undefined && raw !== null) {
    return null;
  }
  return {
    percent: Math.round(pct),
    utilization: pct,
    resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
    resetsAtMs,
  };
}

/** §23.40: has the window a `resetsAt` names already reset? Unknown (`null`) never has. */
function hasReset(resetsAt: string | null, now: number): boolean {
  if (resetsAt === null) return false;
  const at = Date.parse(resetsAt);
  return !Number.isNaN(at) && at <= now;
}

/** Where the last good snapshot survives a restart (§23.19). */
export const LIMITS_CACHE_FILE = 'limits-cache.json';

export const LIMITS_CACHE_VERSION = 1;

export function limitsCachePath(configDir: string): string {
  return join(configDir, LIMITS_CACHE_FILE);
}

/**
 * The last good snapshot from a previous process, or `null`.
 *
 * Deliberately **not** including `raw`: the cache exists so a freshly restarted daemon can
 * answer with real percentages, and the upstream payload is neither needed for that nor
 * something to leave lying on disk.
 */
export function readCachedSnapshot(configDir: string): LimitsSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(limitsCachePath(configDir), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['version'] !== LIMITS_CACHE_VERSION) return null;
  if (!Array.isArray(rec['limits'])) return null;
  const fetchedAt = typeof rec['fetchedAt'] === 'string' ? rec['fetchedAt'] : null;
  if (fetchedAt === null) return null;
  const base = emptySnapshot();
  // Validate field by field rather than casting. This file is ours and 0600, but it is the
  // one input that flows straight into `/v1/summary` — and from there to a dashboard — with
  // no upstream call to sanity-check it. A half-written or hand-edited entry must degrade
  // to "no cache", never to a limit with a NaN percent.
  const limits: NormalizedLimit[] = [];
  for (const entry of rec['limits'] as unknown[]) {
    const limit = coerceLimit(entry);
    if (limit === null) return null;
    limits.push(limit);
  }
  if (limits.length === 0) return null;
  return {
    ...base,
    fetchedAt,
    stale: true,
    error: null,
    limits,
    legacyWindows: coerceLegacyWindows(rec['legacyWindows']),
    extraUsage: (rec['extraUsage'] as LimitsSnapshot['extraUsage']) ?? base.extraUsage,
  };
}

/**
 * The end of an upstream 429 window a previous process was told about, or `null` (§23.32).
 * Read separately from the snapshot so a 429 before any successful fetch still survives.
 */
export function readCachedRateLimitedUntil(configDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(limitsCachePath(configDir), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = (parsed as Record<string, unknown>)['rateLimitedUntil'];
    if (typeof raw !== 'string') return null;
    const at = Date.parse(raw);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

/**
 * §23.42: statusline observations a previous process held, keyed by limit id. Validated
 * exactly as a live `observe()` body; freshness is the caller's to judge.
 */
export function readCachedObservations(configDir: string): Map<string, Observation> {
  const out = new Map<string, Observation>();
  try {
    const parsed = JSON.parse(readFileSync(limitsCachePath(configDir), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return out;
    const list = (parsed as Record<string, unknown>)['observed'];
    if (!Array.isArray(list)) return out;
    for (const entry of list as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const id = rec['id'];
      const observedAt = typeof rec['observedAt'] === 'string' ? Date.parse(rec['observedAt']) : NaN;
      if (!OBSERVED_WINDOWS.some((w) => w.id === id) || Number.isNaN(observedAt)) continue;
      const win = parseObservedWindow(rec);
      if (win === null) continue;
      const movedAt = typeof rec['movedAt'] === 'string' ? Date.parse(rec['movedAt']) : NaN;
      out.set(id as string, {
        ...win,
        observedAt,
        ...(Number.isNaN(movedAt) ? {} : { movedAt }),
        ...(rec['dropped'] === true ? { dropped: true } : {}),
      });
    }
  } catch {
    // no cache, or not ours to read: start with none
  }
  return out;
}

/** The `error` a caller sees while upstream is rate-limiting us (§23.32). */
export function rateLimitedInfo(retryAt: number | null): LimitsErrorInfo {
  const base = 'Anthropic is rate-limiting the usage endpoint (HTTP 429)';
  const hint =
    'nothing to fix locally — the daemon retries on its own; percentages are from the last successful fetch (see fetchedAt)';
  if (retryAt === null) return { code: 'rate_limited', message: base, hint };
  const iso = new Date(retryAt).toISOString();
  return { code: 'rate_limited', message: `${base}; next attempt after ${iso}`, hint, retryAt: iso };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A cached limit, or `null` when it is not one. `percent` must be a real number or absent. */
function coerceLimit(value: unknown): NormalizedLimit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || rec['id'].length === 0) return null;
  if (typeof rec['kind'] !== 'string') return null;
  const percent = rec['percent'];
  if (percent !== null && percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent))) {
    return null;
  }
  return {
    id: rec['id'],
    kind: rec['kind'],
    group: optionalString(rec['group']),
    percent: typeof percent === 'number' ? percent : null,
    severity: optionalString(rec['severity']),
    resetsAt: optionalString(rec['resetsAt']),
    scope: (rec['scope'] as NormalizedLimit['scope']) ?? null,
    isActive: rec['isActive'] === true,
  };
}

/** Drops any window that is not `{ utilization: number|null, resetsAt: string|null }`. */
function coerceLegacyWindows(value: unknown): LimitsSnapshot['legacyWindows'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: LimitsSnapshot['legacyWindows'] = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const win = raw as Record<string, unknown>;
    const utilization = win['utilization'];
    if (utilization !== null && (typeof utilization !== 'number' || !Number.isFinite(utilization))) continue;
    out[key] = { utilization: typeof utilization === 'number' ? utilization : null, resetsAt: optionalString(win['resetsAt']) };
  }
  return out;
}

export interface Timers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realTimers: Timers = {
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    if (typeof t === 'object' && t !== null && typeof t.unref === 'function') t.unref();
    return t;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type TokenReader = (opts?: { fresh?: boolean }) => Promise<string>;

export interface PollerOptions {
  getToken: TokenReader;
  intervalMs?: number;
  maxBackoffMs?: number;
  refreshMinIntervalMs?: number;
  fetchImpl?: FetchLike;
  /** Override the whole fetch step (tests). */
  fetchLimitsImpl?: (token: string, fetchImpl: FetchLike) => Promise<unknown>;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Default-level log for state *transitions* only — ok, rate_limited (with each new
   * retryAt), or another error code (§23.35). Silent in steady state, so it can stay on.
   */
  notice?: (line: string) => void;
  /**
   * Config dir to persist the last good snapshot in, so a restart serves numbers instead
   * of an empty list (§23.19). Omitted (tests, one-shot CLI reads) disables the cache.
   */
  configDir?: string | null;
}

/**
 * Change signature of a snapshot for `onChange` (§19).
 *
 * `fetchedAt` and `raw` are deliberately excluded: a poll that re-fetched the same numbers
 * is not news, and waking every SSE client once a minute to say so would defeat the point.
 */
export function snapshotSignature(snapshot: LimitsSnapshot): string {
  return JSON.stringify([
    snapshot.stale,
    snapshot.error === null ? null : [snapshot.error.code, snapshot.error.message],
    snapshot.limits.map((l) => [l.id, l.kind, l.group, l.percent, l.severity, l.resetsAt, l.isActive]),
    snapshot.legacyWindows,
    snapshot.extraUsage,
  ]);
}

function toErrorInfo(err: unknown): LimitsErrorInfo {
  if (err instanceof LimitsError) return err.toInfo();
  const code = (err as { code?: unknown }).code;
  if (code === 'no_credentials' || code === 'unsupported_platform') {
    const hint = (err as { hint?: unknown }).hint;
    const info: LimitsErrorInfo = { code: 'no_credentials', message: (err as Error).message };
    return typeof hint === 'string' ? { ...info, hint } : info;
  }
  return { code: 'network', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Polls `GET /api/oauth/usage` and keeps the last good value (§5.2, §23.3).
 *
 * Failures serve the last good snapshot with `stale: true` and an `error`; the interval
 * doubles from the base up to 10 min. A 401 re-reads credentials once and retries; if it
 * is still 401 the interval parks at 10 min until a fetch succeeds.
 */
export class LimitsPoller {
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
  readonly refreshMinIntervalMs: number;

  private readonly getToken: TokenReader;
  private readonly fetchImpl: FetchLike;
  private readonly fetchLimitsImpl: (token: string, fetchImpl: FetchLike) => Promise<unknown>;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly notice: (line: string) => void;
  /** The last state `notice` reported; `null` before the first outcome. */
  private lastStateKey: string | null = null;

  private current: LimitsSnapshot = emptySnapshot();
  private failures = 0;
  private parked = false;
  private handle: unknown = null;
  /** Wakes the poller when a statusline observation lapses (§23.37). */
  private expiryHandle: unknown = null;
  private running = false;
  private inFlight: Promise<LimitsSnapshot> | null = null;
  /** When upstream was last called, by a poll or a refresh (§23.33). */
  private lastAttemptAt: number | null = null;
  /** Poll interval after 429-driven slow-downs; never below `intervalMs` (§23.33). */
  private adaptiveIntervalMs: number;
  private successStreak = 0;
  /** §23.36: the latest statusline observation per limit id. In memory only. */
  private observed = new Map<string, Observation>();
  /** §23.64: each session's own last reading per limit id, to see whose numbers move. */
  private sessionReadings = new Map<string, { seenAt: number; byId: Map<string, SessionReading> }>();
  /** Epoch ms before which upstream asked not to be called again (§23.32). */
  private rateLimitedUntil: number | null = null;
  private readonly configDir: string | null;
  private readonly listeners = new Set<() => void>();
  private lastSignature: string = snapshotSignature(emptySnapshot());

  constructor(opts: PollerOptions) {
    this.getToken = opts.getToken;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.refreshMinIntervalMs = opts.refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
    this.adaptiveIntervalMs = this.intervalMs;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch();
    this.fetchLimitsImpl = opts.fetchLimitsImpl ?? ((token, f) => fetchLimits(token, f));
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.notice = opts.notice ?? (() => undefined);
    this.configDir = opts.configDir ?? null;
    const restored = this.configDir === null ? null : readCachedSnapshot(this.configDir);
    if (restored !== null) {
      // Marked stale on purpose: these numbers predate this process, and every consumer
      // already knows to treat `stale` as "believe it, but it may have moved".
      this.current = restored;
      this.lastSignature = snapshotSignature(restored);
    }
    // §23.42: an auto-update restart must not drop live numbers back to an hours-old fetch
    // until some session next renders its statusline.
    if (this.configDir !== null) this.observed = readCachedObservations(this.configDir);
    // §23.32: a restart (routine, with auto-update) must not re-poll inside a 429 window a
    // previous process was given — say so from the first request instead.
    const until = this.configDir === null ? null : readCachedRateLimitedUntil(this.configDir);
    if (until !== null && until > this.now()) {
      this.rateLimitedUntil = until;
      this.current = { ...this.current, error: rateLimitedInfo(until) };
      this.lastSignature = snapshotSignature(this.current);
      this.noteState(' (window from a previous process)');
    }
  }

  /**
   * The current `/v1/limits` body: the upstream snapshot, with `session` / `weekly_all`
   * replaced by a fresh statusline observation wherever that is newer (§23.36). Every row
   * carries its `source`, `asOf` and `stale` (§23.40).
   */
  snapshot(): LimitsSnapshot {
    const now = this.now();
    const fetchedAt = this.current.fetchedAt;
    const fetchedAtMs = fetchedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(fetchedAt);
    // §23.40: an upstream row whose window has already reset describes a window that is over.
    // Its percent is not "a bit old", it is wrong, so it is served as unknown and stale.
    const limits: NormalizedLimit[] = this.current.limits.map((l) =>
      hasReset(l.resetsAt, now)
        ? { ...l, percent: null, severity: null, source: 'upstream', asOf: fetchedAt, stale: true }
        : { ...l, source: 'upstream', asOf: fetchedAt, stale: this.current.stale },
    );
    this.voidRowsOfAnEndedWeek(limits, fetchedAtMs, now);
    const legacyWindows: Record<string, LegacyWindow> = {};
    for (const [key, win] of Object.entries(this.current.legacyWindows)) {
      legacyWindows[key] = hasReset(win.resetsAt, now) ? { ...win, utilization: null } : win;
    }
    for (const w of OBSERVED_WINDOWS) {
      const obs = this.observed.get(w.id);
      if (obs === undefined || !this.isFresh(obs, now) || obs.observedAt < fetchedAtMs) continue;
      const at = limits.findIndex((l) => l.id === w.id);
      const base: NormalizedLimit =
        at >= 0
          ? (limits[at] as NormalizedLimit)
          : { id: w.id, kind: w.kind, group: w.group, percent: null, severity: null, resetsAt: null, scope: null, isActive: false };
      // Upstream severity describes an older reading; a client grades the fresh percent itself.
      const row: NormalizedLimit = {
        ...base,
        percent: obs.percent,
        severity: null,
        resetsAt: obs.resetsAt,
        source: 'statusline',
        asOf: new Date(obs.observedAt).toISOString(),
        stale: false,
      };
      if (at >= 0) limits[at] = row;
      else limits.push(row);
      // §23.37: the legacy key names are the statusline's own, and must never lag `limits[]`.
      legacyWindows[w.key] = { utilization: obs.utilization, resetsAt: obs.resetsAt };
    }
    // §23.40: the snapshot is stale when a headline row is — not merely when upstream failed,
    // and not "fresh" because one other headline row happens to be live.
    const headline = limits.filter((l) => OBSERVED_WINDOWS.some((w) => w.id === l.id));
    const stale = headline.length > 0 ? headline.some((l) => l.stale === true) : this.current.stale;
    return { ...this.current, limits, legacyWindows, stale };
  }

  /**
   * §23.67: the statusline carries no scoped rows, so only upstream can update them. When
   * upstream is failing and the statusline shows a different weekly window from the one
   * upstream last described (a reset, a plan change, another account), those rows describe a
   * week that is over, so they are served as unknown rather than as a confident old number.
   */
  private voidRowsOfAnEndedWeek(limits: NormalizedLimit[], fetchedAtMs: number, now: number): void {
    if (!this.current.stale) return;
    const obs = this.observed.get('weekly_all');
    if (obs === undefined || obs.resetsAtMs === null || !this.isFresh(obs, now) || obs.observedAt < fetchedAtMs) return;
    const upstream = limits.find((l) => l.id === 'weekly_all');
    const upstreamReset = upstream?.resetsAt === null || upstream === undefined ? Number.NaN : Date.parse(upstream.resetsAt);
    if (!Number.isFinite(upstreamReset) || Math.abs(upstreamReset - obs.resetsAtMs) <= SAME_WINDOW_TOLERANCE_MS) return;
    limits.forEach((l, i) => {
      if (OBSERVED_WINDOWS.some((w) => w.id === l.id)) return;
      limits[i] = { ...l, percent: null, severity: null, resetsAt: null, stale: true };
    });
  }

  /**
   * Record Claude Code's statusline `rate_limits` (§23.36). All-or-nothing: one unusable
   * window rejects the whole body, so garbage never overwrites a good reading.
   */
  observe(input: unknown): ObserveResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { accepted: false, reason: 'rate_limits must be a JSON object' };
    }
    const rec = input as Record<string, unknown>;
    const parsed: Array<[string, ObservedWindow]> = [];
    for (const w of OBSERVED_WINDOWS) {
      if (!(w.key in rec)) continue;
      const win = parseObservedWindow(rec[w.key]);
      if (win === null) return { accepted: false, reason: `rate_limits.${w.key} is not a usable window` };
      parsed.push([w.id, win]);
    }
    if (parsed.length === 0) return { accepted: false, reason: 'rate_limits has no five_hour or seven_day window' };
    const observedAt = this.now();
    const sessionId = isSessionId(rec['session_id']) ? rec['session_id'] : null;
    const own = sessionId === null ? undefined : this.sessionReadings.get(sessionId)?.byId;
    const readings: Array<[string, SessionReading]> = [];
    for (const [id, win] of parsed) {
      const movedAt = movedAtOf(own?.get(id), win, observedAt);
      readings.push([id, { win, movedAt }]);
      const next = this.nextObservation(this.observed.get(id), win, movedAt, observedAt);
      if (next !== null) this.observed.set(id, next);
    }
    if (sessionId !== null) this.rememberSessionReadings(sessionId, readings, observedAt);
    this.notifyIfChanged();
    this.scheduleObservationExpiry();
    return { accepted: true };
  }

  /**
   * §23.40: every open session posts its statusline, and an idle one re-renders with the
   * numbers from its last model response — possibly hours old. Arrival order says nothing
   * about which reading is newer, but the data does: a later window supersedes an earlier
   * one, and inside one window usage only climbs. So a reading from an earlier window than
   * the one held, or lower than the one held for the same window, is an old reading and is
   * ignored; `null` means "keep the held one".
   *
   * §23.64/§23.65: except that a plan upgrade breaks both — it drops usage mid-window, or
   * starts a new window that resets *earlier*. A session's own reading changes only when it
   * got a new model response, so the reading whose session moved most recently is the
   * newest there is, whatever its number or window. Once a move has overruled §23.40
   * (`dropped`), a reading whose session has not moved since cannot overrule it back.
   */
  private nextObservation(
    held: Observation | undefined,
    win: ObservedWindow,
    movedAt: number | undefined,
    now: number,
  ): Observation | null {
    const fresh: Observation = { ...win, observedAt: now, ...(movedAt === undefined ? {} : { movedAt }) };
    if (held === undefined || held.resetsAtMs === null || win.resetsAtMs === null || held.resetsAtMs <= now) return fresh;
    const same = sameWindow(held, win);
    const earlier = win.resetsAtMs < held.resetsAtMs - SAME_WINDOW_TOLERANCE_MS;
    const refused = earlier || (same && win.utilization < held.utilization);
    if (movedAt !== undefined && (held.movedAt === undefined || movedAt >= held.movedAt)) {
      const dropped = refused || (same && held.dropped === true);
      return dropped ? { ...fresh, dropped } : fresh;
    }
    if (held.dropped === true || refused) return null;
    return fresh;
  }

  /** §23.64: keep each session's latest reading, bounded in age and count. */
  private rememberSessionReadings(sessionId: string, readings: ReadonlyArray<[string, SessionReading]>, now: number): void {
    const entry = this.sessionReadings.get(sessionId) ?? { seenAt: now, byId: new Map<string, SessionReading>() };
    for (const [id, reading] of readings) entry.byId.set(id, reading);
    entry.seenAt = now;
    this.sessionReadings.delete(sessionId);
    this.sessionReadings.set(sessionId, entry);
    for (const [key, value] of this.sessionReadings) {
      if (this.sessionReadings.size > MAX_SESSION_READINGS || now - value.seenAt >= SESSION_READING_TTL_MS) {
        this.sessionReadings.delete(key);
      }
    }
  }

  private isFresh(obs: Observation, now: number): boolean {
    if (now - obs.observedAt >= OBSERVATION_TTL_MS) return false;
    return obs.resetsAtMs === null || now < obs.resetsAtMs;
  }

  /**
   * §23.37: wake when the earliest fresh observation lapses. Without this a push client keeps
   * the last live figure until the next poll — up to an hour — instead of hearing it went stale.
   */
  private scheduleObservationExpiry(): void {
    if (this.expiryHandle !== null) {
      this.timers.clearTimeout(this.expiryHandle);
      this.expiryHandle = null;
    }
    if (!this.running) return;
    const now = this.now();
    let lapsesAt = Number.POSITIVE_INFINITY;
    for (const obs of this.observed.values()) {
      if (!this.isFresh(obs, now)) continue;
      lapsesAt = Math.min(lapsesAt, obs.observedAt + OBSERVATION_TTL_MS, obs.resetsAtMs ?? Number.POSITIVE_INFINITY);
    }
    if (lapsesAt === Number.POSITIVE_INFINITY) return;
    this.expiryHandle = this.timers.setTimeout(() => {
      this.expiryHandle = null;
      this.notifyIfChanged();
      this.scheduleObservationExpiry();
    }, lapsesAt - now);
  }

  private hasFreshObservation(): boolean {
    const now = this.now();
    for (const obs of this.observed.values()) if (this.isFresh(obs, now)) return true;
    return false;
  }

  /**
   * Subscribe to changes: fires after any poll — successful or failed — whose body
   * differs from the last one (§19). Returns an unsubscribe function.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Called once per completed poll, after `this.current` has been replaced. */
  private notifyIfChanged(): void {
    const signature = snapshotSignature(this.snapshot());
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        // A subscriber must never break polling.
        this.log(`limits: onChange listener threw — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Delay until the next scheduled poll, reflecting backoff. */
  get nextDelayMs(): number {
    const blocked = this.blockedForMs();
    // §23.36: while Claude Code is feeding us the headline numbers, upstream is only needed
    // for what it alone has (per-model weekly, extra usage) — hourly is plenty.
    const base = this.hasFreshObservation()
      ? Math.max(this.adaptiveIntervalMs, OBSERVED_UPSTREAM_INTERVAL_MS)
      : this.adaptiveIntervalMs;
    if (this.parked) return Math.max(this.maxBackoffMs, blocked);
    if (this.failures === 0) return Math.max(base, blocked);
    return Math.max(Math.min(this.intervalMs * 2 ** this.failures, this.maxBackoffMs), base, blocked);
  }

  /** How much of upstream's 429 window is left, in ms; 0 when none (§23.32). */
  private blockedForMs(): number {
    if (this.rateLimitedUntil === null) return 0;
    return Math.max(0, this.rateLimitedUntil - this.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin polling; performs an immediate fetch, then schedules by `nextDelayMs`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.blockedForMs() > 0) {
      this.reschedule();
      return;
    }
    // §23.33: a restart (routine, with auto-update) whose cached numbers are younger than
    // the interval has nothing to gain from calling upstream now.
    const fetchedAt = this.current.fetchedAt === null ? NaN : Date.parse(this.current.fetchedAt);
    const age = this.now() - fetchedAt;
    // §23.42: observations restored from a previous process count, as they do between polls.
    const interval = this.hasFreshObservation()
      ? Math.max(this.adaptiveIntervalMs, OBSERVED_UPSTREAM_INTERVAL_MS)
      : this.adaptiveIntervalMs;
    this.scheduleObservationExpiry();
    if (age >= 0 && age < interval) {
      this.scheduleIn(interval - age);
      return;
    }
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
    if (this.expiryHandle !== null) {
      this.timers.clearTimeout(this.expiryHandle);
      this.expiryHandle = null;
    }
    // §23.42: hand fresh observations to the next process (an auto-update restarts us).
    if (this.hasFreshObservation()) this.writeCache();
  }

  /** Forced refetch for `POST /v1/refresh`; one per `refreshMinIntervalMs`. */
  async refresh(): Promise<{ rateLimited: boolean; snapshot: LimitsSnapshot }> {
    const now = this.now();
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.refreshMinIntervalMs) {
      return { rateLimited: true, snapshot: this.current };
    }
    // §23.32: inside an upstream 429 window a forced refetch would only extend it. Answer
    // with the current snapshot, whose error already says until when.
    if (this.blockedForMs() > 0) return { rateLimited: false, snapshot: this.current };
    // Fresh token read: an explicit refresh is the escape hatch from a previous account's
    // still-valid credential (§23.31), and reusing the cached one would defeat it. A refresh
    // that lands on top of an in-flight scheduled poll joins that poll instead — one interval
    // late, not wrong.
    const snapshot = await this.tick(true);
    return { rateLimited: false, snapshot };
  }

  private async tick(freshToken = false): Promise<LimitsSnapshot> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.fetchOnce(freshToken).finally(() => {
      this.inFlight = null;
      this.reschedule();
    });
    this.inFlight = run;
    return run;
  }

  private reschedule(): void {
    this.scheduleIn(this.nextDelayMs);
  }

  private scheduleIn(ms: number): void {
    if (!this.running) return;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      void this.tick();
    }, ms);
  }

  private async fetchOnce(freshToken = false): Promise<LimitsSnapshot> {
    let token: string;
    try {
      token = await this.getToken(freshToken ? { fresh: true } : undefined);
    } catch (err) {
      return this.fail(toErrorInfo(err));
    }

    this.lastAttemptAt = this.now();
    try {
      return this.succeed(await this.fetchLimitsImpl(token, this.fetchImpl));
    } catch (err) {
      if (isRateLimited(err)) return this.rateLimited(err);
      if (!(err instanceof LimitsError) || err.code !== 'unauthorized') {
        return this.fail(toErrorInfo(err));
      }
      // 401: Claude Code may have rotated the token under us. Re-read credentials once.
      this.log('limits: 401 — re-reading credentials once');
      try {
        const fresh = await this.getToken({ fresh: true });
        return this.succeed(await this.fetchLimitsImpl(fresh, this.fetchImpl));
      } catch (retryErr) {
        if (isRateLimited(retryErr)) return this.rateLimited(retryErr);
        const info = toErrorInfo(retryErr);
        if (info.code === 'unauthorized') {
          // Still 401 — park at 10 min rather than hammer an expired token.
          this.parked = true;
          return this.fail(info, false);
        }
        return this.fail(info);
      }
    }
  }

  private succeed(payload: unknown): LimitsSnapshot {
    const normalized = normalizeLimits(payload);
    this.failures = 0;
    this.parked = false;
    this.rateLimitedUntil = null;
    this.successStreak += 1;
    if (this.successStreak >= RELAX_AFTER_SUCCESSES && this.adaptiveIntervalMs > this.intervalMs) {
      this.adaptiveIntervalMs = Math.max(this.intervalMs, Math.floor(this.adaptiveIntervalMs / 2));
      this.successStreak = 0;
    }
    this.current = {
      fetchedAt: new Date(this.now()).toISOString(),
      stale: false,
      error: null,
      ...normalized,
      raw: payload,
    };
    this.writeCache();
    this.noteState();
    this.notifyIfChanged();
    return this.current;
  }

  /**
   * One default-level line per state change (§23.35). A new `retryAt` counts as a change,
   * so each re-armed 429 window is on record; a repeated network error does not.
   */
  private noteState(suffix = ''): void {
    const error = this.current.error;
    const key = error === null ? 'ok' : `${error.code}|${error.code === 'rate_limited' ? (error.retryAt ?? '') : ''}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    let line: string;
    if (error === null) line = 'limits: ok';
    else if (error.code === 'rate_limited') {
      const when = error.retryAt === undefined ? 'no Retry-After given' : `next attempt after ${error.retryAt}`;
      line = `limits: rate_limited by Anthropic (HTTP 429) — ${when}`;
    } else line = `limits: fetch failing (${error.code}) — ${error.message}`;
    this.notice(`${line}${suffix}`);
  }

  /**
   * Persist the last good numbers. Best effort and never on the hot path of a response:
   * a snapshot we cannot write is a slightly worse restart, not a failed poll.
   */
  private writeCache(): void {
    if (this.configDir === null) return;
    try {
      writeJsonFile(limitsCachePath(this.configDir), {
        version: LIMITS_CACHE_VERSION,
        fetchedAt: this.current.fetchedAt,
        limits: this.current.limits,
        legacyWindows: this.current.legacyWindows,
        extraUsage: this.current.extraUsage,
        ...this.observationsForCache(),
        ...(this.rateLimitedUntil === null ? {} : { rateLimitedUntil: new Date(this.rateLimitedUntil).toISOString() }),
      });
    } catch {
      // best effort
    }
  }

  /** §23.42: fresh observations, in `observe()`'s own shape; nothing when there are none. */
  private observationsForCache(): { observed?: unknown[] } {
    const now = this.now();
    const fresh = [...this.observed].filter(([, obs]) => this.isFresh(obs, now));
    if (fresh.length === 0) return {};
    return {
      observed: fresh.map(([id, obs]) => ({
        id,
        used_percentage: obs.utilization,
        resets_at: obs.resetsAt,
        observedAt: new Date(obs.observedAt).toISOString(),
        ...(obs.movedAt === undefined ? {} : { movedAt: new Date(obs.movedAt).toISOString() }),
        ...(obs.dropped === true ? { dropped: true } : {}),
      })),
    };
  }

  /**
   * Upstream 429 (§23.32): back off as for any failure, but never retry before its
   * `Retry-After` (capped at `MAX_RETRY_AFTER_MS`), and persist that so a restart doesn't.
   */
  private rateLimited(err: LimitsError): LimitsSnapshot {
    // The budget is unpublished, so learn it: every 429 halves our rate (§23.33).
    this.adaptiveIntervalMs = Math.min(Math.max(this.adaptiveIntervalMs * 2, this.intervalMs), MAX_ADAPTIVE_INTERVAL_MS);
    this.successStreak = 0;
    const after = err.retryAfterMs;
    this.rateLimitedUntil = after === undefined ? null : this.now() + Math.min(after, MAX_RETRY_AFTER_MS);
    const snapshot = this.fail(rateLimitedInfo(this.rateLimitedUntil));
    this.writeCache();
    return snapshot;
  }

  private fail(error: LimitsErrorInfo, bumpBackoff = true): LimitsSnapshot {
    if (bumpBackoff && !this.parked) this.failures += 1;
    this.log(`limits: fetch failed (${error.code}) — serving last-good, next poll in ${this.nextDelayMs}ms`);
    this.current = {
      ...this.current,
      stale: this.current.fetchedAt !== null,
      error,
    };
    this.noteState();
    this.notifyIfChanged();
    return this.current;
  }
}

function isRateLimited(err: unknown): err is LimitsError {
  return err instanceof LimitsError && err.code === 'rate_limited';
}
