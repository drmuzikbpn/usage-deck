// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * `SpendStore` — the token-spend facade the daemon and the HTTP server consume
 * (spec §5.3, §6, §23.4–23.8).
 *
 * Startup order: load the snapshot → start the watcher (paused, queueing) → initial scan →
 * mark ready → drain the queued events → start the 5-minute snapshot timer. A snapshot whose
 * `version` does not match keeps serving its aggregates with `stale: true` while a full
 * rescan runs in the background, rather than cold-starting.
 *
 * After that a scan reads the files the watcher named; the tree is walked again only by the
 * watcher's sweep, and whenever what changed is not known (§23.70).
 */

import { scanAll, scanChanged } from './scanner.js';
import { AggregateStore, DEFAULT_RETENTION_DAYS, parseSince } from './store.js';
import type { ScanStats, TokensQuery, TokensResponse, TokenTotals, UsageEvent } from './types.js';
import { emptyTotals } from './types.js';
import { type ChangedPaths, TranscriptWatcher } from './watcher.js';

export { InvalidSinceError, parseSince, SNAPSHOT_VERSION, STATE_FILE } from './store.js';
export type {
  GroupBy,
  ScanStats,
  TokensGroup,
  TokensQuery,
  TokensResponse,
  TokenTotals,
  UsageEvent,
} from './types.js';

/** A crash costs re-reading what came after the last snapshot, which dedup makes exact (§23.71). */
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

export interface SpendStoreOptions {
  /** `~/.claude/projects` (or a fixture tree in tests). */
  projectsDir: string;
  /** Directory holding `state.json`. */
  stateDir: string;
  now?: () => Date;
  retentionDays?: number;
  /** Test seams; the defaults are the spec's values. */
  snapshotIntervalMs?: number;
  debounceMs?: number;
  sweepMs?: number;
  /** Diagnostics sink. Never throws into the caller. */
  onError?: (error: unknown) => void;
}

export class SpendStore {
  readonly #store: AggregateStore;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #snapshotIntervalMs: number;
  readonly #debounceMs: number | undefined;
  readonly #sweepMs: number | undefined;

  #projectsDir: string;
  #watcher: TranscriptWatcher | null = null;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #listeners = new Set<() => void>();

  #ready = false;
  #stale = false;
  #started = false;
  #stopped = false;
  #current: Promise<void> | null = null;
  /** A scan is wanted: of the whole tree, or else of the files in `#changed`. */
  #walkTree = false;
  #changed = new Set<string>();
  #progress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  #parseErrors = 0;
  #scans = 0;
  #lastScanAt: string | null = null;

  constructor(options: SpendStoreOptions) {
    this.#projectsDir = options.projectsDir;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
    this.#snapshotIntervalMs = options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.#debounceMs = options.debounceMs;
    this.#sweepMs = options.sweepMs;
    this.#store = new AggregateStore({
      stateDir: options.stateDir,
      now: this.#now,
      retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
    });
  }

  /** `false` until aggregates are available — a cold initial scan, in practice. */
  get ready(): boolean {
    return this.#ready;
  }

  /** `true` while a background rescan is reconciling the aggregates being served. */
  get stale(): boolean {
    return this.#stale;
  }

  get stats(): ScanStats {
    const counts = this.#store.counts;
    return {
      filesDone: this.#progress.filesDone,
      filesTotal: this.#progress.filesTotal,
      bytesDone: this.#progress.bytesDone,
      bytesTotal: this.#progress.bytesTotal,
      parseErrors: this.#parseErrors,
      scans: this.#scans,
      dedupKeys: counts.dedupKeys,
      sessions: counts.sessions,
      lastScanAt: this.#lastScanAt,
      scanning: this.#current !== null,
    };
  }

  /**
   * Answer a spend query. Until `ready`, totals and groups are empty (spec §4).
   * Throws `InvalidSinceError` for an unparseable `since`; callers map it to the
   * `{ error: { code, message } }` envelope.
   */
  query(query: Partial<TokensQuery> = {}): TokensResponse {
    if (!this.#ready) {
      const since = parseSince(query.since ?? 'today', this.#now());
      const groupBy = query.groupBy ?? 'project';
      return {
        ready: false,
        stale: this.#stale,
        since: since.instant.toISOString(),
        groupBy,
        totals: emptyTotals(),
        groups: [],
      };
    }
    const result = this.#store.query(query);
    return { ready: true, stale: this.#stale, ...result };
  }

  sessionTotals(sessionId: string): TokenTotals | null {
    return this.#store.sessionTotals(sessionId);
  }

  /** W3 §17.2: transcript-known sessions, for `/v1/sessions`' back-fill. */
  listSessions(): { sessionId: string; projectKey: string; lastActivityAt: string; cwd: string }[] {
    return this.#store.listSessions();
  }

  /** The session's `/rename` title, or null when never renamed (§17.3). */
  sessionTitle(sessionId: string): string | null {
    return this.#store.sessionTitle(sessionId);
  }

  sessionModel(sessionId: string): string | null {
    return this.#store.sessionModel(sessionId);
  }

  sessionStartedAt(sessionId: string): string | null {
    return this.#store.sessionStartedAt(sessionId);
  }

  /** Subscribe to "aggregates changed"; returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(projectsDir?: string): Promise<void> {
    if (projectsDir !== undefined) this.#projectsDir = projectsDir;
    if (this.#started) {
      await this.whenIdle();
      return;
    }
    this.#started = true;
    this.#stopped = false;

    const loaded = await this.#store.load();
    if (loaded.loaded) this.#ready = true;

    this.#watcher = new TranscriptWatcher({
      dir: this.#projectsDir,
      onFlush: (changed) => this.#scan(changed),
      onError: this.#onError,
      ...(this.#debounceMs === undefined ? {} : { debounceMs: this.#debounceMs }),
      ...(this.#sweepMs === undefined ? {} : { sweepMs: this.#sweepMs }),
    });
    await this.#watcher.start();

    if (loaded.versionMismatch) {
      // §23.7: keep serving the loaded aggregates, reconcile in the background.
      this.#stale = true;
      this.#store.setOffsets({});
      void this.#scan();
    } else {
      await this.#scan();
    }

    this.#ready = true;
    this.#watcher.resume();

    const save = (): void => void this.#store.save().catch(this.#onError);
    if (!loaded.loaded) save(); // a first scan is the one worth not repeating after a crash
    this.#snapshotTimer = setInterval(save, this.#snapshotIntervalMs);
    this.#snapshotTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#watcher?.stop();
    this.#watcher = null;
    if (this.#snapshotTimer) clearInterval(this.#snapshotTimer);
    this.#snapshotTimer = null;
    await this.whenIdle();
    if (this.#started) await this.#store.save().catch(this.#onError);
    this.#started = false;
  }

  /** Force a scan now and wait for it (the watcher path is debounced). */
  async refresh(): Promise<void> {
    await this.#scan();
  }

  /** Feed the watcher a synthetic change, as an `fs.watch` event would. */
  notifyChanged(path?: string): void {
    this.#watcher?.notify(path);
  }

  /** Resolves when no scan — foreground or background — is in flight. */
  async whenIdle(): Promise<void> {
    while (this.#current) {
      await this.#current.catch(() => {});
    }
  }

  #scan(changed: ChangedPaths = null): Promise<void> {
    if (changed === null) this.#walkTree = true;
    else for (const path of changed) this.#changed.add(path);
    if (this.#current) return this.#current;
    const run = this.#runScans().finally(() => {
      this.#current = null;
    });
    this.#current = run;
    return run;
  }

  async #runScans(): Promise<void> {
    try {
      do {
        await this.#scanOnce();
      } while ((this.#walkTree || this.#changed.size > 0) && !this.#stopped);
    } finally {
      this.#stale = false;
    }
  }

  async #scanOnce(): Promise<void> {
    const walkTree = this.#walkTree;
    const changed = this.#changed;
    this.#walkTree = false;
    this.#changed = new Set();

    let counted = 0;
    const sink = (event: UsageEvent): void => {
      if (this.#store.ingest(event)) counted += 1;
    };
    const onTitle = (sessionId: string, title: string): void => {
      if (this.#store.setTitle(sessionId, title)) counted += 1;
    };

    let result;
    try {
      result = walkTree
        ? await scanAll(this.#projectsDir, this.#store.offsets, sink, {
            onTitle,
            onProgress: (progress) => {
              this.#progress = progress;
            },
          })
        : await scanChanged(this.#projectsDir, this.#store.offsets, changed, sink, { onTitle });
    } catch (err) {
      this.#walkTree = true; // whatever this scan was for is still unread
      throw err;
    }

    this.#store.setOffsets(result.offsets);
    this.#parseErrors += result.parseErrors;
    this.#lastScanAt = this.#now().toISOString();
    this.#scans += 1;
    if (walkTree) {
      // Progress and retention are about the whole tree, which a few files say nothing of.
      this.#progress = {
        filesDone: result.filesDone,
        filesTotal: result.filesTotal,
        bytesDone: result.bytesDone,
        bytesTotal: result.bytesTotal,
      };
      this.#store.prune();
    }

    if (result.restarted.length > 0) {
      // §23.8: a truncated or replaced file cannot be rolled back out of pre-summed
      // counters, so re-read everything; the dedup set makes the re-read idempotent.
      this.#stale = true;
      this.#store.setOffsets({});
      this.#walkTree = true;
    }

    if (counted > 0) this.#emitChange();
  }

  #emitChange(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        this.#onError(err);
      }
    }
  }
}
