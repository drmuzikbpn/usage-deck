// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { systemdUserDir } from '../paths.js';
import {
  defaultExec,
  ServiceError,
  SYSTEMD_UNIT,
  SYSTEMD_UNIT_NAME,
  tailLines,
  SIGTERM_EXIT_CODE,
  UPDATE_RESTART_EXIT_CODE,
  type ExecRunner,
  type ServiceManager,
  type ServiceManagerOptions,
  type ServiceState,
  type ServiceUnit,
} from './index.js';
import { systemBin } from './bins.js';

/** Result of `loginctl enable-linger` — reported, never fatal (§23.9). */
export interface LingerReport {
  ok: boolean;
  message: string;
}

/** Render the systemd user unit (§23.9). Deterministic — tests compare it verbatim. */
/**
 * One word of a unit-file command line or `Environment=` assignment, quoted the way
 * systemd.syntax(7) reads it (§23.62): double quotes, `\\` and `"` escaped, `%` and `$`
 * doubled so neither a specifier nor a variable is expanded. A line break cannot be
 * represented safely — it would end the directive and start another — so it is refused.
 */
export function systemdQuote(word: string): string {
  if (/[\r\n]/.test(word)) throw new Error('a unit-file value cannot contain a line break');
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export function renderUnit(unit: ServiceUnit): string {
  const envLines = Object.keys(unit.env)
    .map((k) => `Environment=${systemdQuote(`${k}=${unit.env[k] ?? ''}`)}`)
    .join('\n');
  const exec = [unit.nodePath, unit.binPath, ...unit.args].map(systemdQuote).join(' ');
  return `[Unit]
Description=claude-usage — local usage service for Claude Code sessions
After=network.target

[Service]
Type=simple
ExecStart=${exec}
${envLines}
# Restart policy (§20, §23.9): exit 0 means "stay down" — that is what
# "configure service off" relies on. The auto-updater asks for its relaunch by exiting
# ${String(UPDATE_RESTART_EXIT_CODE)} (EX_TEMPFAIL), which on-failure restarts, exactly like launchd's
# KeepAlive.SuccessfulExit=false on macOS.
Restart=on-failure
RestartSec=5
# A SIGTERM exits ${String(SIGTERM_EXIT_CODE)} (§23.74). A stray one is restarted; a systemctl stop is
# never restarted, and the success status keeps it from reading "failed".
SuccessExitStatus=${String(SIGTERM_EXIT_CODE)}
RestartForceExitStatus=${String(SIGTERM_EXIT_CODE)}

[Install]
WantedBy=default.target
`;
}

/** Linux `systemctl --user` implementation of `ServiceManager`. */
export class SystemdService implements ServiceManager {
  readonly kind = 'systemd' as const;
  readonly unitPath: string;
  readonly unitName = SYSTEMD_UNIT;
  private readonly exec: ExecRunner;
  private readonly user: string;

  constructor(opts: ServiceManagerOptions & { user?: string } = {}) {
    const env = opts.env ?? process.env;
    this.unitPath = join(systemdUserDir(env), SYSTEMD_UNIT);
    this.exec = opts.exec ?? defaultExec;
    this.user = opts.user ?? env['USER'] ?? safeUsername();
  }

  private async systemctl(args: readonly string[], tolerate = false): Promise<string> {
    const result = await this.exec(systemBin('systemctl'), ['--user', ...args]);
    if (result.code !== 0 && !tolerate) {
      throw new ServiceError(`systemctl --user ${args.join(' ')} failed (exit ${String(result.code)})`, result);
    }
    return result.stdout;
  }

  async install(unit: ServiceUnit): Promise<void> {
    mkdirSync(join(this.unitPath, '..'), { recursive: true });
    writeFileSync(this.unitPath, renderUnit(unit), { mode: 0o644 });
    await this.systemctl(['daemon-reload']);
    await this.systemctl(['enable', '--now', SYSTEMD_UNIT]);
  }

  async uninstall(): Promise<void> {
    await this.systemctl(['disable', '--now', SYSTEMD_UNIT], true);
    rmSync(this.unitPath, { force: true });
    await this.systemctl(['daemon-reload'], true);
  }

  async start(): Promise<void> {
    await this.systemctl(['start', SYSTEMD_UNIT]);
  }

  async stop(): Promise<void> {
    await this.systemctl(['stop', SYSTEMD_UNIT], true);
  }

  async restart(): Promise<void> {
    await this.systemctl(['daemon-reload']);
    await this.systemctl(['restart', SYSTEMD_UNIT]);
  }

  async status(): Promise<ServiceState> {
    if (!existsSync(this.unitPath)) return 'not-installed';
    const result = await this.exec(systemBin('systemctl'), ['--user', 'is-active', SYSTEMD_UNIT]);
    return result.stdout.trim() === 'active' ? 'running' : 'stopped';
  }

  /** Journal, not files — systemd has no log paths (§23.9). */
  async logTail(n: number): Promise<string[]> {
    // `-q` drops journalctl's informational banners ("-- No entries --", "-- Journal begins…"),
    // which would otherwise read as captured daemon output; the filter below is belt-and-braces.
    const result = await this.exec(systemBin('journalctl'), [
      '--user',
      '-u',
      SYSTEMD_UNIT_NAME,
      '-n',
      String(n),
      '--no-pager',
      '-q',
    ]);
    if (result.code !== 0) return [];
    return tailLines(result.stdout, n).filter((line) => !line.startsWith('-- '));
  }

  /**
   * `install --linger`: keep the unit alive outside a login session. Reports, never
   * fails — and uninstall never touches it.
   */
  async enableLinger(): Promise<LingerReport> {
    const result = await this.exec(systemBin('loginctl'), ['enable-linger', this.user]);
    if (result.code === 0) return { ok: true, message: `lingering enabled for ${this.user}` };
    if (result.code === 127) {
      return { ok: false, message: 'loginctl not found — lingering not enabled (the daemon stops at logout)' };
    }
    const detail = result.stderr.trim() || `exit ${String(result.code)}`;
    return { ok: false, message: `loginctl enable-linger ${this.user} failed: ${detail}` };
  }
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}
