// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * The auto-updater (§20): a check loop, a state machine and the two CLI verbs.
 *
 * ## Restart policy — why the updater exits **non-zero**
 *
 * §20 says "`process.exit(0)` → `KeepAlive`/`Restart=always` relaunches"; §23.9 pins
 * launchd to `KeepAlive: { SuccessfulExit: false }` and systemd to `Restart=on-failure`.
 * Those two cannot both be true: under either of the §23.9 policies a clean `exit(0)` is
 * *not* relaunched — that is exactly what makes `configure service off` work, on both
 * platforms, without racing the supervisor.
 *
 * §23.9 wins (Part III supersedes Part II on unit details), so the units keep
 * "exit 0 means stay down" and the updater asks for a relaunch the only other way
 * available: it exits `UPDATE_RESTART_EXIT_CODE` (75, `EX_TEMPFAIL`). launchd sees a
 * non-successful exit and relaunches; systemd's `Restart=on-failure` does the same.
 * One policy, both platforms, and a deliberate restart stays distinguishable from a
 * crash in the logs.
 *
 * ## …and why the exit is no longer enough on its own (§23.18)
 *
 * That contract assumes the supervisor actually acts on the exit. On the Mac Studio it
 * did not: a job bootstrapped over SSH lands in a `gui/<uid>` domain the SSH session
 * cannot drive, `launchctl print` reports `pended nondemand spawn = speculative`, and
 * **`KeepAlive` never fires** — reproduced directly with `kill -9` on a job that had
 * been up well past `minimum runtime = 10`, which stayed down indefinitely. The daemon
 * updated itself to a new version and simply never came back.
 *
 * So the updater now *asks* the supervisor to restart it (`launchctl kickstart -k`,
 * `systemctl --user restart`) and only falls back to the bare exit when there is no
 * service manager or the request fails. The exit code stays exactly as it was, so a
 * healthy machine behaves identically and the logs still say "deliberate restart".
 */
import { rmSync } from 'node:fs';
import { DaemonClient } from '../clients/http.js';
import { loadConfig, resolveConfigDir, type Config } from '../config.js';
import type { EventBus } from '../events/bus.js';
import { realTimers, type Timers } from '../limits/poller.js';
import { resolvePackageRoot } from '../install/versions.js';
import { UPDATE_RESTART_EXIT_CODE, type ExecRunner } from '../service/index.js';
import type { UpdateStatus } from '../server/snapshot.js';
import { getVersion } from '../version.js';
import { check, type ReleaseInfo, type UpdateFetch } from './check.js';
import { download, UpdateError } from './download.js';
import { apply, currentVersion, listVersions, rollback, runningUnderCurrent } from './apply.js';
import { verify } from './verify.js';
import type { TrustedKey } from './trusted-keys.js';
import { isNewerVersion } from './version.js';

export type UpdateState = UpdateStatus['state'];

/** Re-exported from `src/service` so callers never have to know where it is defined. */
export { UPDATE_RESTART_EXIT_CODE };

/** First check runs a minute after startup, so boot never races the network (§20). */
export const FIRST_CHECK_DELAY_MS = 60_000;
/** While deferred by a hard freeze, re-check this often (§20 "Deferral"). */
export const DEFERRED_RECHECK_MS = 30_000;
/** ±10 % jitter on every scheduled interval (§20 "Loop"). */
export const JITTER_FRACTION = 0.1;

export const REASON_HARD_FROZEN = 'hard_frozen_sessions';
export const REASON_CONFIG_OFF = 'disabled_by_config';
export const REASON_NOT_INSTALLED = 'not_installed';

export interface UpdaterOptions {
  config: Config;
  /** The version we are running; defaults to `package.json`. */
  currentVersion?: string;
  bus?: EventBus | null;
  env?: NodeJS.ProcessEnv;
  timers?: Timers;
  /** `[0, 1)` — injected so jitter is deterministic in tests. */
  random?: () => number;
  fetch?: UpdateFetch;
  exec?: ExecRunner;
  nodePath?: string;
  /**
   * The package root to compare against `current`. `null` skips the check entirely
   * (tests, and `claude-usage update` run from anywhere against an installed layout).
   */
  packageRoot?: string | null;
  /** `true` while any session holds a hard freeze — never restart then (§18.3, §20). */
  hardFrozen?: () => boolean;
  /** What "restart now" means; defaults to `process.exit(UPDATE_RESTART_EXIT_CODE)`. */
  restart?: () => void | Promise<void>;
  /** §23.59: the keys a release must be signed with; the compiled-in list outside tests. */
  trustedKeys?: readonly TrustedKey[];
  log?: (line: string) => void;
  /** Verbose-only lines (why the updater is off); defaults to `log`. */
  debug?: (line: string) => void;
}

export interface UpdaterHandle {
  status(): UpdateStatus;
  start(): void;
  stop(): void;
  /** One check (+ download/apply when a newer release exists). Never throws. */
  runOnce(opts?: { force?: boolean }): Promise<UpdateStatus>;
  /** Check only — no download, no state beyond `available`. */
  checkOnly(): Promise<{ current: string; available: string | null; error: string | null }>;
  /** Delay of the currently scheduled check, or `null` when nothing is pending. */
  readonly pendingDelayMs: number | null;
}

/** The jittered delay for the next check: `intervalMs` ±10 %. */
export function jitteredInterval(intervalMs: number, random: () => number): number {
  const spread = (random() * 2 - 1) * JITTER_FRACTION;
  return Math.max(1, Math.round(intervalMs * (1 + spread)));
}

class Updater implements UpdaterHandle {
  private readonly opts: UpdaterOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private readonly debug: (line: string) => void;
  private readonly current: string;

  private state: UpdateState = 'idle';
  private available: string | null = null;
  private deferredReason: string | null = null;
  private etag: string | null = null;
  private lastRelease: ReleaseInfo | null = null;
  private handle: unknown = null;
  private nextDelay: number | null = null;
  private stopped = false;
  private running = false;

  constructor(opts: UpdaterOptions) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? ((): void => {});
    this.debug = opts.debug ?? this.log;
    this.current = opts.currentVersion ?? getVersion();
  }

  get pendingDelayMs(): number | null {
    return this.handle === null ? null : this.nextDelay;
  }

  status(): UpdateStatus {
    return {
      channel: 'stable',
      current: this.current,
      available: this.available,
      state: this.state,
      deferredReason: this.deferredReason,
    };
  }

  /** Why the updater is off, or `null` when it may run (§20 "Off switch"). */
  private disabledReason(): string | null {
    if (this.opts.config.autoUpdate.enabled === false) return REASON_CONFIG_OFF;
    const root = this.opts.packageRoot === undefined ? safePackageRoot() : this.opts.packageRoot;
    if (root === null) return null; // explicitly skipped, or we cannot tell — do not block
    return runningUnderCurrent(root, this.env) ? null : REASON_NOT_INSTALLED;
  }

  private transition(state: UpdateState, deferredReason: string | null = null): UpdateStatus {
    this.state = state;
    this.deferredReason = deferredReason;
    const status = this.status();
    this.opts.bus?.publish('update', status);
    return status;
  }

  start(): void {
    this.stopped = false;
    const reason = this.disabledReason();
    if (reason !== null) {
      this.debug(`update: disabled (${reason})`);
      this.transition('disabled', reason);
      return;
    }
    this.transition('idle');
    this.schedule(FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
    this.nextDelay = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.nextDelay = ms;
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      void this.runOnce().then(() => {
        if (this.stopped) return;
        const next =
          this.state === 'deferred'
            ? DEFERRED_RECHECK_MS
            : jitteredInterval(this.opts.config.autoUpdate.intervalMs, this.random);
        this.schedule(next);
      });
    }, ms);
  }

  async checkOnly(): Promise<{ current: string; available: string | null; error: string | null }> {
    const result = await check({
      repo: this.opts.config.autoUpdate.repo,
      currentVersion: this.current,
      ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
      ...(this.etag === null ? {} : { etag: this.etag }),
    });
    if (result.etag !== null) this.etag = result.etag;
    const release = result.release ?? (result.notModified ? this.lastRelease : null);
    if (release !== null) this.lastRelease = release;
    const available = release !== null && isNewerVersion(release.version, this.current) ? release.version : null;
    this.available = available;
    return { current: this.current, available, error: result.error };
  }

  async runOnce(opts: { force?: boolean } = {}): Promise<UpdateStatus> {
    if (this.running) return this.status();
    const reason = this.disabledReason();
    if (reason !== null && opts.force !== true) return this.transition('disabled', reason);
    this.running = true;
    try {
      return await this.cycle();
    } catch (err) {
      this.log(`update: ${(err as Error).message}`);
      return this.transition('error');
    } finally {
      this.running = false;
    }
  }

  private async cycle(): Promise<UpdateStatus> {
    this.transition('checking');
    const probe = await this.checkOnly();
    if (probe.error !== null) {
      this.log(`update: check failed — ${probe.error}`);
      return this.transition('error');
    }
    if (probe.available === null || this.lastRelease === null) return this.transition('idle');
    const release = this.lastRelease;

    // §20: a hard freeze blocks the restart, so it blocks the whole apply. Re-checked
    // every 30 s until the freeze clears; soft pauses never defer.
    if (this.opts.hardFrozen?.() === true) {
      this.log(`update: ${release.version} is available but a session is hard-frozen — deferring`);
      return this.transition('deferred', REASON_HARD_FROZEN);
    }

    this.transition('downloading');
    let dir: string | null = null;
    try {
      const downloaded = await download(release, {
        currentVersion: this.current,
        env: this.env,
        ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
      });
      dir = downloaded.dir;
      this.transition('verifying');
      await verify({
        tarballPath: downloaded.tarballPath,
        shasumsPath: downloaded.shasumsPath,
        signaturePath: downloaded.signaturePath,
        tarballFile: downloaded.tarballFile,
        ...(this.opts.trustedKeys === undefined ? {} : { trustedKeys: this.opts.trustedKeys }),
      });
      await apply({
        version: release.version,
        tarballPath: downloaded.tarballPath,
        env: this.env,
        ...(this.opts.exec === undefined ? {} : { exec: this.opts.exec }),
        ...(this.opts.nodePath === undefined ? {} : { nodePath: this.opts.nodePath }),
      });
    } catch (err) {
      const code = err instanceof UpdateError ? err.code : 'failed';
      this.log(`update: ${release.version} not installed (${code}): ${(err as Error).message}`);
      return this.transition('error');
    } finally {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    }

    this.log(`update: ${release.version} installed — restarting`);
    const status = this.transition('ready');
    await this.restart();
    return status;
  }

  private async restart(): Promise<void> {
    const restart = this.opts.restart ?? defaultRestart;
    await restart();
  }
}

/**
 * How long to let the supervisor kill us after it accepts the restart request, before
 * falling back to the bare exit. `kickstart -k` kills this process, so on a healthy
 * machine this timer never fires.
 */
export const RESTART_GRACE_MS = 5_000;

/**
 * Ask the supervisor for a relaunch; see the restart-policy notes at the top.
 *
 * Belt (an explicit restart request) and braces (the non-zero exit). Either alone has
 * been observed to fail: the exit does nothing on a job whose `KeepAlive` never fires,
 * and the request does nothing when the daemon is running in the foreground with no
 * service manager at all.
 */
export async function defaultRestart(
  env: NodeJS.ProcessEnv = process.env,
  graceMs: number = RESTART_GRACE_MS,
): Promise<void> {
  try {
    const { createServiceManager } = await import('../service/index.js');
    const service = await createServiceManager({ env });
    if (service.kind !== 'noop') {
      // §23.50: arm the witness first — the restart request below can die with this process.
      service.armRestartWatchdog?.();
      await service.restart();
      // The supervisor SIGKILLs us inside this window on any healthy machine.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, graceMs).unref();
      });
    }
  } catch {
    // No service manager, a launchctl/systemctl that is not there, a domain we cannot
    // reach — all mean "fall back to the exit", never "skip the restart".
  }
  process.exit(UPDATE_RESTART_EXIT_CODE);
}

function safePackageRoot(): string | null {
  try {
    return resolvePackageRoot();
  } catch {
    return null;
  }
}

export function createUpdater(opts: UpdaterOptions): UpdaterHandle {
  return new Updater(opts);
}

// ───────────────────────────── CLI verbs (§20) ─────────────────────────────

export interface UpdateCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so nothing touches launchctl/systemctl. */
  restartService?: () => Promise<string>;
  updater?: UpdaterHandle;
  /** Session ids the running daemon reports as hard-frozen; injected in tests (§23.22). */
  hardFrozenSessions?: () => Promise<string[]>;
  /** §23.73: injected in tests; the real platform and lookup by default. */
  platform?: string;
  findMenuBarApp?: () => string | null;
}

/**
 * Ask the running daemon which sessions are hard-frozen (§23.22).
 *
 * A daemon we cannot reach reports none: there is then nothing running for the update to
 * disturb, and a manual update must never be blocked by a dead daemon.
 */
async function hardFrozenViaDaemon(configDir: string): Promise<string[]> {
  try {
    const body = await new DaemonClient({ configDir, timeoutMs: 2_000 }).get('/v1/sessions');
    const sessions = (body as { sessions?: unknown }).sessions;
    if (!Array.isArray(sessions)) return [];
    return sessions
      .filter((s) => (s as { pause?: { mode?: unknown } }).pause?.mode === 'hard')
      .map((s) => String((s as { sessionId?: unknown }).sessionId ?? ''))
      .filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

/** Restart the installed service, if there is one. Reports, never throws. */
async function restartInstalledService(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { createServiceManager } = await import('../service/index.js');
    const service = await createServiceManager({ env });
    const state = await service.status();
    if (state === 'not-installed') return 'service: not installed — restart claude-usage yourself';
    await service.restart();
    return `service: restarted (${service.kind})`;
  } catch (err) {
    return `service: could not restart — ${(err as Error).message}`;
  }
}

/** `claude-usage update [--check]` and `claude-usage rollback`. */
export async function runUpdateCli(cmd: string, argv: readonly string[], io: UpdateCliIo): Promise<number> {
  const env = io.env ?? process.env;
  const configDir = io.configDir ?? resolveConfigDir();
  const config = loadConfig(configDir);
  const version = getVersion();

  if (cmd === 'rollback') {
    try {
      const result = rollback(env);
      io.stdout(`rolled back: ${result.from ?? 'unknown'} → ${result.to}\n`);
      io.stdout(`${await (io.restartService ?? (() => restartInstalledService(env)))()}\n`);
      return 0;
    } catch (err) {
      io.stderr(`claude-usage: ${(err as Error).message}\n`);
      const installed = listVersions(env);
      if (installed.length > 0) io.stderr(`installed versions: ${installed.join(', ')}\n`);
      return 1;
    }
  }

  const updater =
    io.updater ??
    createUpdater({
      config,
      currentVersion: version,
      env,
      // A manual run works from anywhere, so the "am I under `current`?" gate is skipped;
      // `apply` still refuses to do anything useful without the versions layout.
      packageRoot: null,
      log: (line: string) => {
        io.stdout(`${line}\n`);
      },
      restart: () => {
        /* the CLI restarts the service below rather than exiting this process */
      },
    });

  if (argv.includes('--check')) {
    const result = await updater.checkOnly();
    io.stdout(`current:   ${result.current}\n`);
    io.stdout(`available: ${result.available ?? 'none — up to date'}\n`);
    if (result.error !== null) {
      io.stderr(`check failed: ${result.error}\n`);
      return 1;
    }
    return 0;
  }

  // The daemon defers an update while a session is hard-frozen, because the restart thaws
  // the tree and hands that session a tool boundary it was not supposed to get (§23.22).
  // A manual run deserves the same protection — it is the same restart — but as a question
  // rather than a refusal, since the operator may well mean it.
  if (!argv.includes('--force')) {
    const frozen = await (io.hardFrozenSessions ?? (() => hardFrozenViaDaemon(configDir)))();
    if (frozen.length > 0) {
      io.stderr(
        `claude-usage: ${String(frozen.length)} session(s) are hard-frozen — updating now would ` +
          'restart the daemon, which thaws them for one tool call before the new daemon re-freezes.\n',
      );
      io.stderr(`  ${frozen.join('\n  ')}\n`);
      io.stderr('resume them first, or re-run with --force.\n');
      return 1;
    }
  }

  const status = await updater.runOnce({ force: true });
  io.stdout(`current:   ${status.current}\n`);
  io.stdout(`available: ${status.available ?? 'none — up to date'}\n`);
  io.stdout(`state:     ${status.state}${status.deferredReason === null ? '' : ` (${status.deferredReason})`}\n`);
  if (status.state === 'error') return 1;
  if (status.state === 'ready') {
    io.stdout(`installed: ${currentVersion(env) ?? 'unknown'}\n`);
    io.stdout(`${await (io.restartService ?? (() => restartInstalledService(env)))()}\n`);
  }
  // §23.73: an update cannot ask, so name the command that can.
  if ((io.platform ?? process.platform) === 'darwin') {
    const find = io.findMenuBarApp ?? (await import('../menubar.js')).findMenuBarApp.bind(null, env);
    if (find() === null) io.stdout("menu bar: SwiftBar isn't installed (optional); to add it, run claude-usage menubar --install\n");
  }
  return 0;
}

export { check, download, verify, apply, rollback, currentVersion, listVersions };
export type { ReleaseInfo, UpdateStatus };
