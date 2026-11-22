// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Transcript watcher (spec §5.3, §23.7).
 *
 * `fs.watch(projectsDir, { recursive: true })` with a 500 ms debounce, plus a 5-minute
 * safety sweep because recursive watching is unreliable on some Linux setups. The watcher
 * is started *before* the initial scan and stays paused until `resume()`, so appends that
 * land mid-scan are queued and drained afterwards instead of waiting for the sweep.
 *
 * A flush is handed the paths that changed, or `null` for "look at everything": an event
 * without a name, more paths than are worth listing, a flush that failed, and the sweep,
 * which also covers the events macOS drops without saying so (§23.70).
 */

import { watch, type FSWatcher } from 'node:fs';

export const DEFAULT_DEBOUNCE_MS = 500;
export const DEFAULT_SWEEP_MS = 5 * 60_000;
/** §23.38: floor between flush starts, so a busy tree does not scan near-continuously. */
export const DEFAULT_MIN_FLUSH_INTERVAL_MS = 5_000;

/** Past this many distinct paths, one walk is cheaper than looking each of them up. */
export const MAX_CHANGED_PATHS = 1_000;

/** Paths relative to the watched dir, or `null` for "anything may have changed". */
export type ChangedPaths = ReadonlySet<string> | null;

export interface WatcherOptions {
  dir: string;
  /** Re-scan callback. Never called concurrently with itself. */
  onFlush: (changed: ChangedPaths) => void | Promise<void>;
  debounceMs?: number;
  sweepMs?: number;
  minFlushIntervalMs?: number;
  /** Reported, never thrown: watching is best-effort and the sweep is the backstop. */
  onError?: (error: unknown) => void;
}

export class TranscriptWatcher {
  readonly #dir: string;
  readonly #onFlush: (changed: ChangedPaths) => void | Promise<void>;
  readonly #debounceMs: number;
  readonly #sweepMs: number;
  readonly #minFlushIntervalMs: number;
  readonly #onError: (error: unknown) => void;

  #watcher: FSWatcher | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #sweep: NodeJS.Timeout | null = null;
  #held: NodeJS.Timeout | null = null;
  #lastFlushAt = Number.NEGATIVE_INFINITY;
  #paused = true;
  #pending = 0;
  #changed = new Set<string>();
  #everything = false;
  #stopped = false;
  #flushing = false;
  #again = false;

  constructor(options: WatcherOptions) {
    this.#dir = options.dir;
    this.#onFlush = options.onFlush;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
    this.#minFlushIntervalMs = options.minFlushIntervalMs ?? DEFAULT_MIN_FLUSH_INTERVAL_MS;
    this.#onError = options.onError ?? (() => {});
  }

  /** Events seen since the last flush (non-zero only while paused, in practice). */
  get pending(): number {
    return this.#pending;
  }

  get watching(): boolean {
    return this.#watcher !== null;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Begin watching. Never rejects: an unwatchable directory (missing, EPERM, platform
   * without recursive support) degrades to the safety sweep.
   */
  async start(): Promise<void> {
    if (this.#stopped) return;
    try {
      this.#watcher = watch(this.#dir, { recursive: true, persistent: false }, (_event, name) => {
        this.notify(name);
      });
      this.#watcher.on('error', (err) => {
        this.#onError(err);
        this.#watcher?.close();
        this.#watcher = null;
      });
    } catch (err) {
      this.#onError(err);
      this.#watcher = null;
    }

    // The sweep does not touch `#pending`: while paused it is a no-op, because the
    // post-scan drain already covers everything written up to that point.
    this.#sweep = setInterval(() => {
      this.#everything = true;
      this.#fire();
    }, this.#sweepMs);
    this.#sweep.unref?.();
  }

  /** Record a change, to everything if unnamed. While paused the event only accumulates. */
  notify(path?: string | null): void {
    if (this.#stopped) return;
    this.#pending += 1;
    if (path === undefined || path === null || path === '') this.#everything = true;
    else if (!this.#everything) this.#changed.add(path);
    if (this.#changed.size > MAX_CHANGED_PATHS) this.#everything = true;
    if (this.#everything) this.#changed.clear();
    if (this.#paused) return;

    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.#fire();
    }, this.#debounceMs);
    this.#debounce.unref?.();
  }

  /** Drain anything queued during the initial scan and start delivering live events. */
  resume(): void {
    if (this.#stopped) return;
    this.#paused = false;
    if (this.#pending > 0) this.#fire();
  }

  stop(): void {
    this.#stopped = true;
    this.#paused = true;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    if (this.#held) clearTimeout(this.#held);
    this.#held = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  /**
   * `onFlush` is invoked synchronously so a synchronous callback is finished before this
   * returns; only a thenable result defers completion. Anything raised mid-flush queues a
   * single follow-up run rather than overlapping.
   */
  #fire(): void {
    if (this.#stopped || this.#paused) return;
    if (this.#flushing) {
      this.#again = true;
      return;
    }
    const wait = this.#lastFlushAt + this.#minFlushIntervalMs - Date.now();
    if (wait > 0) {
      // Held, not dropped: one flush runs when the floor lapses, covering everything since.
      this.#held ??= setTimeout(() => {
        this.#held = null;
        this.#fire();
      }, wait);
      this.#held.unref?.();
      return;
    }
    this.#lastFlushAt = Date.now();
    this.#pending = 0;
    this.#flushing = true;
    const changed = this.#everything ? null : this.#changed;
    this.#everything = false;
    this.#changed = new Set();

    let result: void | Promise<void>;
    try {
      result = this.#onFlush(changed);
    } catch (err) {
      this.#failed(err);
      return;
    }

    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).then(
        () => this.#finish(),
        (err: unknown) => {
          this.#failed(err);
        },
      );
      return;
    }
    this.#finish();
  }

  /** Its paths are spent, and some may not have been read: the next flush covers everything. */
  #failed(err: unknown): void {
    this.#everything = true;
    this.#onError(err);
    this.#finish();
  }

  #finish(): void {
    this.#flushing = false;
    if (!this.#again) return;
    this.#again = false;
    this.#pending = 0;
    this.#fire();
  }
}
