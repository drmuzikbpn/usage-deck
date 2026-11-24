// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { execFile } from 'node:child_process';
import { absolutePath } from './bins.js';

/**
 * Service manager abstraction (§8 "Service manager interface", §23.9).
 *
 * Every implementation takes an injected `exec` runner so tests assert the exact
 * commands without touching launchctl/systemctl, and every file path is derived
 * from an injected environment so tests stay inside a temp HOME.
 */

export type ServiceState = 'running' | 'stopped' | 'not-installed';

/** A `launchctl` / `systemctl` invocation that failed; the message names the command. */
export class ServiceError extends Error {
  readonly result: { code: number; stderr: string };
  constructor(message: string, result: { code: number; stderr: string }) {
    super(message);
    this.name = 'ServiceError';
    this.result = result;
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner. `code: 127` means "command not found". */
export type ExecRunner = (file: string, args: readonly string[]) => Promise<ExecResult>;

/** The unit description a `ServiceManager` renders into a plist / systemd unit. */
export interface ServiceUnit {
  /** Absolute path to the node binary (nvm/volta/fnm paths are not on launchd's PATH). */
  nodePath: string;
  /** Absolute path to `<data>/claude-usage/current/bin/claude-usage`. */
  binPath: string;
  /** Subcommand arguments — always `['serve']`. */
  args: readonly string[];
  /** Environment baked into the unit: PATH plus XDG_CONFIG_HOME/XDG_DATA_HOME when set. */
  env: Readonly<Record<string, string>>;
}

export interface ServiceManager {
  readonly kind: 'launchd' | 'systemd' | 'noop';
  /** Absolute path of the unit file this manager writes (`''` for noop). */
  readonly unitPath: string;
  install(unit: ServiceUnit): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Restart in place — used by `configure port` after rewriting the unit. */
  restart(): Promise<void>;
  /** launchd only: a detached witness that relaunches the job if a self-restart strands it (§23.50). */
  armRestartWatchdog?(): void;
  status(): Promise<ServiceState>;
  logTail(n: number): Promise<string[]>;
}

/** launchd label and systemd unit name both keep the `claude-usage` name (§23.1). */
export const LAUNCHD_LABEL = 'com.github.drmuzikbpn.claude-usage';
export const SYSTEMD_UNIT = 'claude-usage.service';
export const SYSTEMD_UNIT_NAME = 'claude-usage';

/** Logs bigger than this are truncated at install time; no rotation otherwise (§23.9). */
export const LOG_TRUNCATE_BYTES = 10 * 1024 * 1024;

/**
 * The restart contract both unit builders encode (§20, §23.9).
 *
 * Both supervisors are configured as "exit 0 means stay down" — launchd
 * `KeepAlive: { SuccessfulExit: false }`, systemd `Restart=on-failure`. Neither of them
 * relaunches on exit 0, so the auto-updater asks for its relaunch by exiting non-zero
 * instead: 75, `EX_TEMPFAIL` from `sysexits.h`. A SIGTERM exits non-zero as well
 * (`SIGTERM_EXIT_CODE`, §23.74); `configure service off` and `uninstall` stop the daemon
 * through the supervisor, which does not relaunch it. Both codes live here, next to the
 * unit renderers, because the two must never drift apart.
 */
export const UPDATE_RESTART_EXIT_CODE = 75;

/**
 * What `serve` exits with after a SIGTERM (§23.74): 143, the shell's 128 + 15.
 *
 * Exit 0 here kept a daemon down after a stray `pkill`, because both supervisors read
 * exit 0 as "stay down". Every deliberate stop goes through the supervisor — `bootout`
 * for launchd, `systemctl stop` for systemd, and shutdown or logout for both — and none
 * of those relaunches whatever the exit code says. So a SIGTERM can always exit non-zero:
 * launchd relaunches it through `SuccessfulExit: false`, systemd through
 * `RestartForceExitStatus=`, and `SuccessExitStatus=` keeps a `systemctl stop` from
 * leaving the unit marked failed.
 */
export const SIGTERM_EXIT_CODE = 143;

/** Default runner. A missing executable surfaces as `code: 127`, never a throw. */
export const defaultExec: ExecRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: unknown };
        code = e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export interface ServiceManagerOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecRunner;
  platform?: NodeJS.Platform | string;
  /** launchd domain target uses the real uid unless overridden (tests). */
  uid?: number;
  /** Pause between launchd bootstrap retries (§23.26); 0 in tests. */
  retryWaitMs?: number;
}

/** Pick the manager for the platform; anything but darwin/linux gets the noop. */
export async function createServiceManager(opts: ServiceManagerOptions = {}): Promise<ServiceManager> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const { LaunchdService } = await import('./launchd.js');
    return new LaunchdService(opts);
  }
  if (platform === 'linux') {
    const { SystemdService } = await import('./systemd.js');
    return new SystemdService(opts);
  }
  const { NoopService } = await import('./noop.js');
  return new NoopService();
}

/** Build the unit description from resolved absolute paths (§20, §23.9). */
export function buildUnit(opts: {
  nodePath: string;
  binPath: string;
  env?: NodeJS.ProcessEnv;
}): ServiceUnit {
  const env = opts.env ?? process.env;
  // §23.62: the installer's PATH minus every relative or empty entry, which would be
  // resolved against whatever directory the service manager starts the daemon in.
  const unitEnv: Record<string, string> = { PATH: absolutePath(env['PATH']) };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const) {
    const v = env[key];
    if (typeof v === 'string' && v.length > 0) unitEnv[key] = v;
  }
  return { nodePath: opts.nodePath, binPath: opts.binPath, args: ['serve'], env: unitEnv };
}

/** Last `n` lines of a blob, empty lines at the end dropped. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return n <= 0 ? [] : lines.slice(-n);
}
