// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { DaemonClient } from '../clients/http.js';
import { generateToken, loadConfig, resolveConfigDir, saveConfig, type Config } from '../config.js';
import { currentBin, claudeJsonPath, settingsPath } from '../paths.js';
import { createServiceManager, type ExecRunner, type ServiceManager } from '../service/index.js';
import type { LaunchdService } from '../service/launchd.js';
import type { SystemdService } from '../service/systemd.js';
import { getVersion } from '../version.js';
import type { Prompter } from './plan.js';

/** Shared plumbing for `install`, `uninstall` and `configure`. */

export interface InstallIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Drives every path: HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, PATH. */
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  platform?: NodeJS.Platform | string;
  exec?: ExecRunner;
  /** Injected in tests so no launchctl/systemctl ever runs. */
  service?: ServiceManager;
  prompt?: Prompter;
  /** Free-text prompt for the interactive `configure` menu (numbers). */
  ask?: (question: string, defaultValue: string) => Promise<string>;
  isTTY?: boolean;
  /** Absolute node binary baked into the unit (§23.9). */
  nodePath?: string;
  /** Package directory to copy into the versions layout. */
  sourceDir?: string;
  version?: string;
  readCredentials?: () => Promise<string>;
  /** Resolves true once `GET /health` answers. */
  health?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  randomToken?: () => string;
  uid?: number;
  /** `claude-usage pair`, offered at the end of an interactive install (§23.48). */
  pair?: () => Promise<number>;
  /** §23.73: the menu-bar app and Homebrew, if they are there; real lookups by default. */
  findMenuBarApp?: () => string | null;
  findBrew?: () => string | null;
  /** §23.58: make an unsupervised running daemon take a rotated token; real one by default. */
  adoptToken?: (configDir: string) => Promise<{ state: 'no-daemon' } | { state: 'adopted'; pid: number } | { state: 'failed'; pid: number; why: string }>;
}

export interface ResolvedContext {
  env: NodeJS.ProcessEnv;
  configDir: string;
  platform: string;
  version: string;
  nodePath: string;
  binPath: string;
  settingsFile: string;
  claudeJsonFile: string;
  service: ServiceManager;
  exec: ExecRunner | undefined;
}

export async function resolveContext(io: InstallIO): Promise<ResolvedContext> {
  const env = io.env ?? process.env;
  const platform = String(io.platform ?? process.platform);
  const service =
    io.service ??
    (await createServiceManager({
      env,
      platform,
      ...(io.exec === undefined ? {} : { exec: io.exec }),
      ...(io.uid === undefined ? {} : { uid: io.uid }),
    }));
  return {
    env,
    configDir: io.configDir ?? resolveConfigDir(env),
    platform,
    version: io.version ?? getVersion(),
    nodePath: io.nodePath ?? process.execPath,
    binPath: currentBin(env),
    settingsFile: settingsPath(env),
    claudeJsonFile: claudeJsonPath(env),
    service,
    exec: io.exec,
  };
}

/** Does this manager know how to enable lingering? Only systemd does (§23.9). */
/**
 * The launchd manager, when that is what we have — for `diagnose()`, which is launchd's
 * own problem and does not belong on the cross-platform interface (§23.20).
 */
export function asLaunchd(service: ServiceManager): LaunchdService | null {
  // Structural, not `kind === 'launchd'`: fakes in tests (and any future partial
  // implementation) declare the kind without carrying the launchd-only methods.
  if (service.kind !== 'launchd') return null;
  return typeof (service as Partial<LaunchdService>).diagnose === 'function' ? (service as LaunchdService) : null;
}

export function asSystemd(service: ServiceManager): SystemdService | null {
  return service.kind === 'systemd' ? (service as SystemdService) : null;
}

export { generateToken };

/** Load config, minting `auth.token` if it is missing. Never rotates an existing one. */
export function loadConfigWithToken(configDir: string, mint: () => string = generateToken): { config: Config; minted: boolean } {
  const config = loadConfig(configDir);
  if (config.auth.token.length > 0) return { config, minted: false };
  config.auth = { ...config.auth, token: mint() };
  return { config, minted: true };
}

/** Persist: directory 0700, file 0600 (§21). */
export function persistConfig(config: Config, configDir: string): void {
  saveConfig(config, configDir);
}

export const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_INTERVAL_MS = 250;

/**
 * The retry pause inside `verifyHealth`. The timer is deliberately **not** unref'd (§23.27).
 *
 * When the daemon has not finished starting, the health probe fails fast — a refused
 * connection leaves no lingering handle — so this timer is the only thing on the event loop.
 * Unref'd, it let Node exit 0 in the middle of the install: no status table, and none of the
 * collected notes, including the warning that says launchd will not supervise the service.
 * Holding a reference for a few hundred milliseconds is the entire cost of not doing that.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll `GET /health` until it answers or the 5 s budget runs out (§8 step 4). */
export async function verifyHealth(io: InstallIO, configDir: string): Promise<boolean> {
  const sleep = io.sleep ?? defaultSleep;
  const probe =
    io.health ??
    (async (): Promise<boolean> => {
      try {
        await new DaemonClient({ configDir, timeoutMs: 1_000 }).get('/health');
        return true;
      } catch {
        return false;
      }
    });
  // Attempt-budgeted rather than wall-clock-budgeted: with the real sleep this is
  // the 5 s of §8 step 4, and with an injected sleep the tests do not burn 5 s.
  const attempts = Math.ceil(HEALTH_TIMEOUT_MS / HEALTH_INTERVAL_MS);
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return true;
    if (i < attempts - 1) await sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}
