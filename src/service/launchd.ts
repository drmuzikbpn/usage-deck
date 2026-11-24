// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { launchAgentsDir, macLogDir } from '../paths.js';
import {
  defaultExec,
  ServiceError,
  LAUNCHD_LABEL,
  LOG_TRUNCATE_BYTES,
  tailLines,
  SIGTERM_EXIT_CODE,
  UPDATE_RESTART_EXIT_CODE,
  type ExecRunner,
  type ServiceManager,
  type ServiceManagerOptions,
  type ServiceState,
  type ServiceUnit,
} from './index.js';
import { LAUNCHCTL_BIN, SYSTEM_PATH } from './bins.js';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

export interface PlistPaths {
  stdout: string;
  stderr: string;
}

/** Render the LaunchAgent plist (§23.9). Deterministic — tests compare it verbatim. */
export function renderPlist(unit: ServiceUnit, logs: PlistPaths, label = LAUNCHD_LABEL): string {
  const args = [unit.nodePath, unit.binPath, ...unit.args];
  const envKeys = Object.keys(unit.env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((a) => `\t\t<string>${xml(a)}</string>`).join('\n')}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envKeys.map((k) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(unit.env[k] ?? '')}</string>`).join('\n')}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<!-- Exit 0 means "stay down"; the auto-updater asks for a relaunch by
\t     exiting ${String(UPDATE_RESTART_EXIT_CODE)}, mirroring systemd's Restart=on-failure, and a SIGTERM exits ${String(SIGTERM_EXIT_CODE)}
\t     so a stray one is relaunched. configure service off boots the job out first. -->
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${xml(logs.stdout)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logs.stderr)}</string>
</dict>
</plist>
`;
}

/** errno 37, `EALREADY` — launchctl's answer while a previous operation is still settling. */
const EALREADY = 37;
/** How many times to re-attempt a bootstrap that raced its own bootout (§23.26, §23.28). */
const BOOTSTRAP_ATTEMPTS = 8;
/** Pause between those attempts — 8 × 500 ms covers a daemon that takes a moment to exit. */
const BOOTSTRAP_RETRY_WAIT_MS = 500;

/** macOS `launchctl` (per-user GUI domain) implementation of `ServiceManager`. */
/** `child_process.spawn`, narrowed to what the restart watchdog needs (tests inject a fake). */
export type WatchdogSpawn = (
  file: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore' },
) => { unref(): void };

export class LaunchdService implements ServiceManager {
  readonly kind = 'launchd' as const;
  readonly label: string;
  readonly unitPath: string;
  readonly logDir: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  private readonly exec: ExecRunner;
  private readonly uid: number;
  /** Pause between bootstrap retries; 0 in tests. */
  private readonly retryWaitMs: number;

  constructor(opts: ServiceManagerOptions & { label?: string } = {}) {
    const env = opts.env ?? process.env;
    this.label = opts.label ?? LAUNCHD_LABEL;
    this.unitPath = join(launchAgentsDir(env), `${this.label}.plist`);
    this.logDir = macLogDir(env);
    this.stdoutLog = join(this.logDir, 'daemon.out.log');
    this.stderrLog = join(this.logDir, 'daemon.err.log');
    this.exec = opts.exec ?? defaultExec;
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    this.retryWaitMs = opts.retryWaitMs ?? BOOTSTRAP_RETRY_WAIT_MS;
  }

  /** `gui/<uid>` — the domain target. */
  get domain(): string {
    return `gui/${String(this.uid)}`;
  }

  /** `gui/<uid>/<label>` — the service target. */
  get target(): string {
    return `${this.domain}/${this.label}`;
  }

  private async run(args: readonly string[], tolerate = false): Promise<void> {
    const result = await this.exec(LAUNCHCTL_BIN, args);
    if (result.code !== 0 && !tolerate) {
      throw new ServiceError(`launchctl ${args.join(' ')} failed (exit ${String(result.code)})`, result);
    }
  }

  /** Create the log dir 0700 and truncate anything already over 10 MB (§23.9). */
  private prepareLogs(): void {
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.logDir, 0o700);
    } catch {
      // best effort — a pre-existing directory we do not own
    }
    for (const file of [this.stdoutLog, this.stderrLog]) {
      try {
        if (statSync(file).size > LOG_TRUNCATE_BYTES) truncateSync(file, 0);
      } catch {
        // no log yet, or not ours — launchd creates it on first run
      }
    }
  }

  async install(unit: ServiceUnit): Promise<void> {
    this.prepareLogs();
    mkdirSync(join(this.unitPath, '..'), { recursive: true });
    writeFileSync(this.unitPath, renderPlist(unit, { stdout: this.stdoutLog, stderr: this.stderrLog }, this.label), {
      mode: 0o644,
    });
    // bootout first so a re-run picks up the rewritten plist; not being loaded is fine.
    await this.run(['bootout', this.target], true);
    await this.bootstrapWithRetry();
    // RunAtLoad does not reliably start the job when bootstrapping from a non-GUI session
    // (e.g. over SSH), so ask for it explicitly; this is also what makes install idempotent.
    // In a GUI session RunAtLoad *does* fire, so this can arrive while launchd is already
    // starting the job and come back EALREADY — that is the job starting, not failing.
    const kick = await this.exec(LAUNCHCTL_BIN, ['kickstart', '-k', this.target]);
    if (kick.code !== 0 && kick.code !== EALREADY) {
      throw new ServiceError(`launchctl kickstart -k ${this.target} failed (exit ${String(kick.code)})`, kick);
    }
    // Everything above tolerates something, so confirm the end state rather than inferring it
    // from exit codes: the Studio's install reported success three times while leaving the
    // LaunchAgent unregistered (§23.28).
    const loaded = await this.exec(LAUNCHCTL_BIN, ['print', this.target]);
    if (loaded.code !== 0) {
      throw new ServiceError(
        `launchd did not keep the service after bootstrap (launchctl print exit ${String(loaded.code)}) — ` +
          'the job was booted out and never came back',
        loaded,
      );
    }
  }

  /**
   * Bootstrap the job, waiting out the tail of our own `bootout` (§23.26).
   *
   * `launchctl bootout` returns before launchd has finished tearing the job down, and
   * anything landing in that window fails. Measured on the Mac Studio, booting out a
   * *running* job and bootstrapping immediately:
   *
   * ```
   * bootout   rc=0
   * bootstrap → "Bootstrap failed: 5: Input/output error"   (EIO, not EALREADY)
   * kickstart rc=37                                          (EALREADY)
   * 3 s later → not loaded
   * ```
   *
   * So the errno differs by verb, and keying the retry on one of them (§23.26 keyed it on 37)
   * misses the other. Retry on **any** failure instead: a bootstrap that fails is worth
   * re-attempting whatever it says, because the cost of being wrong is a machine with no
   * LaunchAgent at all. `install` verifies the job is really loaded afterwards, so a genuine
   * failure is reported rather than swallowed.
   *
   * Note that `launchctl print` keeps succeeding throughout this window — the dying job is
   * still listed — so "is it loaded?" cannot be used to detect the race, only to confirm the
   * end state once the retries are done.
   */
  private async bootstrapWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt += 1) {
      const result = await this.exec(LAUNCHCTL_BIN, ['bootstrap', this.domain, this.unitPath]);
      if (result.code === 0) return;
      if (attempt < BOOTSTRAP_ATTEMPTS - 1 && this.retryWaitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.retryWaitMs);
        });
      }
    }
  }

  async uninstall(): Promise<void> {
    await this.run(['bootout', this.target], true);
    rmSync(this.unitPath, { force: true });
  }

  async start(): Promise<void> {
    if (existsSync(this.unitPath)) await this.run(['bootstrap', this.domain, this.unitPath], true);
    await this.run(['kickstart', this.target]);
  }

  async stop(): Promise<void> {
    await this.run(['bootout', this.target], true);
  }

  async restart(): Promise<void> {
    await this.run(['kickstart', '-k', this.target]);
  }

  /**
   * §23.50: the auto-updater restarts the daemon by asking launchd to `kickstart -k` the very
   * job it runs in. On 2026-10-01 the Studio's update to 0.1.107 got the SIGTERM and never came
   * back (`last exit code = -9`, no new process) until a manual kickstart. The restart request
   * dies with the job it is restarting, so it needs a witness that outlives the job: a detached
   * shell, in its own session, that polls `launchctl print` and kickstarts the job (without
   * `-k`, so a running daemon is never touched) once launchd shows no pid. It gives up after
   * 90 s; a job that came back on its own is simply seen running and left alone.
   */
  armRestartWatchdog(spawnFn: WatchdogSpawn = spawn): void {
    // §23.62: launchctl by absolute path ($2), and nothing else from the caller's PATH.
    const script = [
      `PATH=${SYSTEM_PATH}`,
      'export PATH',
      'i=0',
      'while [ "$i" -lt 45 ]; do',
      '  sleep 2',
      '  i=$((i + 1))',
      '  if ! "$2" print "$1" 2>/dev/null | grep -Eq "^[[:space:]]*pid = [0-9]+"; then',
      '    "$2" kickstart "$1" >/dev/null 2>&1',
      '    exit 0',
      '  fi',
      'done',
    ].join('\n');
    try {
      spawnFn('/bin/sh', ['-c', script, 'claude-usage-restart-watchdog', this.target, LAUNCHCTL_BIN], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      // Best effort: the restart request and the exit-75 fallback still stand.
    }
  }

  async status(): Promise<ServiceState> {
    if (!existsSync(this.unitPath)) return 'not-installed';
    const result = await this.exec(LAUNCHCTL_BIN, ['print', this.target]);
    if (result.code !== 0) return 'stopped';
    return /^\s*pid\s*=\s*\d+/m.test(result.stdout) ? 'running' : 'stopped';
  }

  /**
   * Problems that leave a *loaded, running* job unable to look after itself (§23.20, §23.30).
   *
   * The fault is real and measured. On one Mac, `kill -9` on a job up well past
   * `minimum runtime = 10` left it down for a full 60 s watch with `runs` frozen, while the
   * same job on a second Mac came back unattended in 5 s (`runs` 15 → 16). `kickstart` works
   * on both, which is why it hides behind every manual fix and every install.
   *
   * ## What it is not (§23.30)
   *
   * This function used to warn that the cause was an install from a non-GUI session, and to
   * prescribe re-running `install` from the machine's own desktop. **Both were wrong.** The
   * affected machine was then installed from its own desktop, as the console user, in an
   * `Aqua` session — and the service stayed pended. launchd's own log gives the real reason:
   *
   * ```
   * pending spawn, domain in on-demand-only mode: com.github.drmuzikbpn.claude-usage
   * ```
   *
   * That is a property of the `gui/<uid>` **domain**, not of the installing session. Ruled
   * out with evidence: the launchd disabled database (`print-disabled` lists it on neither
   * machine), session type (`Aqua` on both), console ownership (`/dev/console` owned by the
   * logged-in user on both), screen lock, plist contents (identical), and install-before-login
   * ordering (true on both).
   *
   * Three candidate install-time detectors were tested and all three are unusable:
   * `launchctl managername` (the old one — false positive for an ssh install on a healthy
   * domain, false negative for the case that actually bit), `immediate reason` (reports only
   * how the current instance was started; a `kickstart` flips a healthy Mac to `non-ipc
   * demand` and it still self-heals) and the domain's `on-demand count` (unchanged across
   * bootout, bootstrap and kickstart of this job).
   *
   * So the only honest signal left is the symptom itself, and it is only printed while the
   * job is **not running** — which an install never is, having just kickstarted it. This
   * therefore stays quiet during a healthy-looking install rather than guessing. A check that
   * cannot fire is worse than one that can; a check that fires with the wrong remedy is worse
   * than both, and that is what shipped.
   *
   * Returns human-readable warnings, empty when nothing is wrong. Never throws: a
   * diagnostic that fails must not fail an install.
   */
  async diagnose(): Promise<string[]> {
    let out: string;
    try {
      const result = await this.exec(LAUNCHCTL_BIN, ['print', this.target]);
      if (result.code !== 0) return [];
      out = result.stdout;
    } catch {
      return [];
    }
    // Match the whole phrase: `pended` is a substring of `started suspended = 0`, which every
    // healthy job prints twice, so a loose grep reports a fault on a perfectly good machine.
    if (/pended nondemand spawn/.test(out)) {
      return [
        'launchd has pended this service\'s spawns: it is registered, but launchd will NOT ' +
          'start it on its own after a crash or a reboot. The daemon runs when started, and ' +
          'auto-update restarts it, so everything works until the process dies unattended. ' +
          'The cause is a state of the `gui/<uid>` domain and is still under investigation — ' +
          're-running `install` does not clear it. See docs/smoke-test.md section 8.',
      ];
    }
    return [];
  }

  async logTail(n: number): Promise<string[]> {
    try {
      return tailLines(readFileSync(this.stderrLog, 'utf8'), n);
    } catch {
      return [];
    }
  }
}
