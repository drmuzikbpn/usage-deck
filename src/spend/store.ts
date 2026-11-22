// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Spend aggregates, dedup, retention and the on-disk snapshot (spec §5.3, §23.6, §23.7).
 *
 * Aggregates are pre-summed counters keyed by `(day, projectKey, sessionId, model)`; the
 * dedup set is keyed by `message.id + ':' + (requestId ?? '')` and is pruned together with
 * the aggregates so the two can never drift. Nothing here touches the filesystem except
 * `load()` / `save()`.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GroupBy, TokensGroup, TokensQuery, TokenTotals, UsageEvent } from './types.js';
import { emptyTotals } from './types.js';

/** Bumping this invalidates snapshots: readers rescan in the background (§23.7). */
export const SNAPSHOT_VERSION = 1;
export const STATE_FILE = 'state.json';
export const DEFAULT_RETENTION_DAYS = 90;

const KEY_SEP = '\u0000';
const DAY_LENGTH = 10; // YYYY-MM-DD

export class InvalidSinceError extends Error {
  readonly code = 'invalid_since';
  constructor(value: string) {
    super(
      `Invalid "since" value ${JSON.stringify(value)}: expected an ISO-8601 instant, ` +
        '"<N>d", "<N>h" or "today".',
    );
    this.name = 'InvalidSinceError';
  }
}

export interface ResolvedSince {
  instant: Date;
  /** UTC day of `instant`; aggregates are day-grained, so this is the real filter. */
  day: string;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, DAY_LENGTH);
}

/** `since` accepts an ISO-8601 instant, `<N>d`, `<N>h`, or `today` (UTC day). */
export function parseSince(since: string, now: Date): ResolvedSince {
  const value = since.trim();
  if (value === '') throw new InvalidSinceError(since);

  if (value.toLowerCase() === 'today') {
    const instant = new Date(`${utcDay(now)}T00:00:00.000Z`);
    return { instant, day: utcDay(instant) };
  }

  const duration = /^(\d+)([dh])$/i.exec(value);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = (duration[2] ?? 'd').toLowerCase();
    const ms = amount * (unit === 'h' ? 3_600_000 : 86_400_000);
    const instant = new Date(now.getTime() - ms);
    return { instant, day: utcDay(instant) };
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new InvalidSinceError(since);
  const instant = new Date(ms);
  return { instant, day: utcDay(instant) };
}

interface SessionMeta {
  projectKey: string;
  /** cwd of the first counted line of the session's *top-level* transcript (§23.6). */
  label: string;
  /** Timestamp that label came from, so out-of-order scans still pick the first line. */
  labelAt: string;
  /** Most recent top-level model; falls back to the most recent counted model. */
  model: string;
  modelAt: string;
  modelTopLevel: boolean;
  /** Earliest counted timestamp in the session. */
  startedAt: string;
  /** Latest counted timestamp — W3's `lastActivityAt` for transcript-discovered sessions. */
  lastAt?: string;
}

interface ProjectMeta {
  label: string;
  labelAt: string;
}

interface Snapshot {
  version: number;
  savedAt: string;
  offsets: Record<string, number>;
  /** `[aggKey, [input, output, cacheCreate, cacheRead, messages]]` */
  aggregates: [string, [number, number, number, number, number]][];
  /** Compact `YYYY-MM-DD` + dedup key strings. */
  dedup: string[];
  sessions: [string, SessionMeta][];
  /** `/rename` titles by sessionId (optional for pre-title snapshots). */
  titles?: [string, string][];
  projects: [string, ProjectMeta][];
}

export interface SnapshotLoadResult {
  loaded: boolean;
  versionMismatch: boolean;
}

export interface AggregateStoreOptions {
  stateDir: string;
  now?: () => Date;
  retentionDays?: number;
}

export interface QueryResult {
  since: string;
  groupBy: GroupBy;
  totals: TokenTotals;
  groups: TokensGroup[];
}

const GROUP_BYS: readonly GroupBy[] = ['project', 'session', 'model', 'day'];

function aggKey(day: string, projectKey: string, sessionId: string, model: string): string {
  return [day, projectKey, sessionId, model].join(KEY_SEP);
}

function splitAggKey(key: string): {
  day: string;
  projectKey: string;
  sessionId: string;
  model: string;
} {
  const [day = '', projectKey = '', sessionId = '', model = ''] = key.split(KEY_SEP);
  return { day, projectKey, sessionId, model };
}

function addInto(target: TokenTotals, event: UsageEvent): void {
  target.input += event.input;
  target.output += event.output;
  target.cacheCreate += event.cacheCreate;
  target.cacheRead += event.cacheRead;
  target.messages += 1;
}

function addTotals(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheCreate += source.cacheCreate;
  target.cacheRead += source.cacheRead;
  target.messages += source.messages;
}

export class AggregateStore {
  readonly #stateDir: string;
  readonly #now: () => Date;
  readonly #retentionDays: number;

  #aggregates = new Map<string, TokenTotals>();
  /**
   * `#aggregates` summed per session, so one session's totals never cost a walk over every
   * aggregate (§23.69). Derived: kept by `ingest`, rebuilt by `load` and `prune`, never saved.
   */
  #sessionTotals = new Map<string, TokenTotals>();
  /** dedup key → UTC day, so retention can prune the set without a scan per day. */
  #dedup = new Map<string, string>();
  #sessions = new Map<string, SessionMeta>();
  /** `/rename` titles by sessionId (§17.3 `title`). */
  #titles = new Map<string, string>();
  #projects = new Map<string, ProjectMeta>();
  #offsets: Record<string, number> = {};
  #dirty = false;

  constructor(options: AggregateStoreOptions) {
    this.#stateDir = options.stateDir;
    this.#now = options.now ?? (() => new Date());
    this.#retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get counts(): { dedupKeys: number; sessions: number; aggregates: number } {
    return {
      dedupKeys: this.#dedup.size,
      sessions: this.#sessions.size,
      aggregates: this.#aggregates.size,
    };
  }

  get offsets(): Record<string, number> {
    return { ...this.#offsets };
  }

  setOffsets(offsets: Readonly<Record<string, number>>): void {
    this.#offsets = { ...offsets };
    this.#dirty = true;
  }

  /** Returns `true` when the event was counted, `false` when it was a duplicate. */
  ingest(event: UsageEvent): boolean {
    if (this.#dedup.has(event.dedupKey)) return false;
    this.#dedup.set(event.dedupKey, event.day);

    const key = aggKey(event.day, event.projectKey, event.sessionId, event.model);
    let totals = this.#aggregates.get(key);
    if (!totals) {
      totals = emptyTotals();
      this.#aggregates.set(key, totals);
    }
    addInto(totals, event);
    addInto(this.#sessionTotalsEntry(event.sessionId), event);

    this.#touchSession(event);
    this.#touchProject(event);
    this.#dirty = true;
    return true;
  }

  ingestAll(events: Iterable<UsageEvent>): number {
    let counted = 0;
    for (const event of events) if (this.ingest(event)) counted += 1;
    return counted;
  }

  #sessionTotalsEntry(sessionId: string): TokenTotals {
    let totals = this.#sessionTotals.get(sessionId);
    if (!totals) {
      totals = emptyTotals();
      this.#sessionTotals.set(sessionId, totals);
    }
    return totals;
  }

  #rebuildSessionTotals(): void {
    this.#sessionTotals = new Map();
    for (const [key, value] of this.#aggregates) {
      addTotals(this.#sessionTotalsEntry(splitAggKey(key).sessionId), value);
    }
  }

  #touchSession(event: UsageEvent): void {
    if (event.sessionId === '') return;
    const existing = this.#sessions.get(event.sessionId);
    if (!existing) {
      this.#sessions.set(event.sessionId, {
        projectKey: event.projectKey,
        label: event.topLevel ? event.cwd : '',
        labelAt: event.topLevel ? event.timestamp : '',
        model: event.model,
        modelAt: event.timestamp,
        modelTopLevel: event.topLevel,
        startedAt: event.timestamp,
        lastAt: event.timestamp,
      });
      return;
    }
    if (event.timestamp !== '' && (existing.lastAt === undefined || event.timestamp > existing.lastAt)) {
      existing.lastAt = event.timestamp;
    }
    if (event.timestamp !== '' && (existing.startedAt === '' || event.timestamp < existing.startedAt)) {
      existing.startedAt = event.timestamp;
    }
    // Label: cwd of the *first* counted line of the top-level transcript.
    if (event.topLevel && (existing.labelAt === '' || event.timestamp < existing.labelAt)) {
      existing.label = event.cwd;
      existing.labelAt = event.timestamp;
    }
    // Model: most recent top-level line wins over any subagent line.
    const better = existing.modelTopLevel
      ? event.topLevel && event.timestamp >= existing.modelAt
      : event.topLevel || event.timestamp >= existing.modelAt;
    if (better) {
      existing.model = event.model;
      existing.modelAt = event.timestamp;
      existing.modelTopLevel = event.topLevel;
    }
  }

  #touchProject(event: UsageEvent): void {
    if (!event.topLevel || event.cwd === '') return;
    const existing = this.#projects.get(event.projectKey);
    if (!existing || existing.labelAt === '' || event.timestamp < existing.labelAt) {
      this.#projects.set(event.projectKey, { label: event.cwd, labelAt: event.timestamp });
    }
  }

  /** Drop aggregates and dedup entries older than the retention window. */
  prune(): number {
    const cutoff = new Date(this.#now().getTime() - this.#retentionDays * 86_400_000);
    const cutoffDay = utcDay(cutoff);

    let removed = 0;
    for (const key of [...this.#aggregates.keys()]) {
      if (splitAggKey(key).day < cutoffDay) {
        this.#aggregates.delete(key);
        removed += 1;
      }
    }
    for (const [key, day] of [...this.#dedup]) {
      if (day < cutoffDay) this.#dedup.delete(key);
    }
    if (removed > 0) {
      this.#rebuildSessionTotals();
      this.#dropOrphanedMeta();
      this.#dirty = true;
    }
    return removed;
  }

  #dropOrphanedMeta(): void {
    const sessions = new Set<string>();
    const projects = new Set<string>();
    for (const key of this.#aggregates.keys()) {
      const parts = splitAggKey(key);
      sessions.add(parts.sessionId);
      projects.add(parts.projectKey);
    }
    for (const id of [...this.#sessions.keys()]) {
      if (!sessions.has(id)) this.#sessions.delete(id);
    }
    for (const id of [...this.#projects.keys()]) {
      if (!projects.has(id)) this.#projects.delete(id);
    }
  }

  #labelFor(groupBy: GroupBy, key: string, sessionId: string, projectKey: string): string {
    if (groupBy === 'project') return this.#projects.get(key)?.label || key;
    if (groupBy === 'session') {
      const meta = this.#sessions.get(sessionId);
      return meta?.label || this.#projects.get(projectKey)?.label || key;
    }
    return key;
  }

  query(query: Partial<TokensQuery> = {}): QueryResult {
    const groupBy: GroupBy = GROUP_BYS.includes(query.groupBy as GroupBy)
      ? (query.groupBy as GroupBy)
      : 'project';
    const since = parseSince(query.since ?? 'today', this.#now());

    const totals = emptyTotals();
    const groups = new Map<string, TokensGroup>();

    for (const [key, value] of this.#aggregates) {
      const parts = splitAggKey(key);
      if (parts.day < since.day) continue;
      addTotals(totals, value);

      const groupKey =
        groupBy === 'project'
          ? parts.projectKey
          : groupBy === 'session'
            ? parts.sessionId
            : groupBy === 'model'
              ? parts.model
              : parts.day;

      let group = groups.get(groupKey);
      if (!group) {
        group = {
          key: groupKey,
          label: this.#labelFor(groupBy, groupKey, parts.sessionId, parts.projectKey),
          ...emptyTotals(),
        };
        groups.set(groupKey, group);
      }
      addTotals(group, value);
    }

    const ordered = [...groups.values()].sort((a, b) => {
      if (groupBy === 'day') return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
      const spend = b.input + b.output - (a.input + a.output);
      if (spend !== 0) return spend;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return { since: since.instant.toISOString(), groupBy, totals, groups: ordered };
  }

  sessionTotals(sessionId: string): TokenTotals | null {
    const totals = this.#sessionTotals.get(sessionId);
    return totals ? { ...totals } : null;
  }

  /** W3 §17.2: every session the transcripts know about, for the sessions back-fill. */
  /** Remember a `/rename` title; returns true when it changed. */
  setTitle(sessionId: string, title: string): boolean {
    if (this.#titles.get(sessionId) === title) return false;
    this.#titles.set(sessionId, title);
    this.#dirty = true;
    return true;
  }

  sessionTitle(sessionId: string): string | null {
    return this.#titles.get(sessionId) ?? null;
  }

  listSessions(): { sessionId: string; projectKey: string; lastActivityAt: string; cwd: string }[] {
    const out: { sessionId: string; projectKey: string; lastActivityAt: string; cwd: string }[] = [];
    for (const [sessionId, meta] of this.#sessions) {
      out.push({
        sessionId,
        projectKey: meta.projectKey,
        lastActivityAt: meta.lastAt ?? meta.modelAt ?? meta.startedAt,
        cwd: meta.label,
      });
    }
    return out;
  }

  sessionModel(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.model ?? null;
  }

  sessionStartedAt(sessionId: string): string | null {
    const startedAt = this.#sessions.get(sessionId)?.startedAt;
    return startedAt === undefined || startedAt === '' ? null : startedAt;
  }

  get statePath(): string {
    return join(this.#stateDir, STATE_FILE);
  }

  /**
   * Best-effort load. A version mismatch still loads the aggregates so they can keep
   * serving (marked `stale`) while a background rescan reconciles them (§23.7).
   */
  async load(): Promise<SnapshotLoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch {
      return { loaded: false, versionMismatch: false };
    }

    let parsed: Partial<Snapshot>;
    try {
      parsed = JSON.parse(raw) as Partial<Snapshot>;
    } catch {
      return { loaded: false, versionMismatch: false };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { loaded: false, versionMismatch: false };
    }

    const versionMismatch = parsed.version !== SNAPSHOT_VERSION;

    this.#aggregates = new Map();
    for (const entry of parsed.aggregates ?? []) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const [i = 0, o = 0, cc = 0, cr = 0, m = 0] = entry[1] ?? [];
      this.#aggregates.set(entry[0], {
        input: i,
        output: o,
        cacheCreate: cc,
        cacheRead: cr,
        messages: m,
      });
    }

    this.#rebuildSessionTotals();

    this.#dedup = new Map();
    for (const packed of parsed.dedup ?? []) {
      if (typeof packed !== 'string' || packed.length <= DAY_LENGTH) continue;
      this.#dedup.set(packed.slice(DAY_LENGTH), packed.slice(0, DAY_LENGTH));
    }

    this.#sessions = new Map(parsed.sessions ?? []);
    this.#titles = new Map(parsed.titles ?? []);
    this.#projects = new Map(parsed.projects ?? []);
    this.#offsets = { ...(parsed.offsets ?? {}) };
    this.#dirty = false;

    return { loaded: true, versionMismatch };
  }

  /** Atomic temp + rename; a no-op (returning `false`) when nothing changed. */
  async save(): Promise<boolean> {
    if (!this.#dirty) return false;

    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      savedAt: this.#now().toISOString(),
      offsets: this.#offsets,
      aggregates: [...this.#aggregates].map(([key, t]) => [
        key,
        [t.input, t.output, t.cacheCreate, t.cacheRead, t.messages],
      ]),
      dedup: [...this.#dedup].map(([key, day]) => `${day}${key}`),
      sessions: [...this.#sessions],
      titles: [...this.#titles],
      projects: [...this.#projects],
    };

    await mkdir(this.#stateDir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(tmp, this.statePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    this.#dirty = false;
    return true;
  }
}
