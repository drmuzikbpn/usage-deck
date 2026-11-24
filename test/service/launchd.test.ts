// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaunchdService } from '../../src/service/launchd.js';
import {
  buildUnit,
  LAUNCHD_LABEL,
  LOG_TRUNCATE_BYTES,
  ServiceError,
  SIGTERM_EXIT_CODE,
  UPDATE_RESTART_EXIT_CODE,
} from '../../src/service/index.js';
import { cleanupAllTempHomes, fakeExec, tempHome } from '../install/helpers.js';

afterAll(cleanupAllTempHomes);

function unit(): ReturnType<typeof buildUnit> {
  return buildUnit({
    nodePath: '/opt/node/v20/bin/node',
    binPath: '/data/claude-usage/current/bin/claude-usage',
    env: { PATH: '/opt/node/v20/bin:/usr/bin', XDG_CONFIG_HOME: '/tmp/cfg', XDG_DATA_HOME: '/tmp/data' },
  });
}

describe('plist', () => {
  it('writes the label, absolute ProgramArguments, env, RunAtLoad and KeepAlive', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());

    const plist = readFileSync(svc.unitPath, 'utf8');
    expect(svc.unitPath).toBe(join(h.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/node/v20/bin/node</string>');
    expect(plist).toContain('<string>/data/claude-usage/current/bin/claude-usage</string>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<key>PATH</key>\n\t\t<string>/opt/node/v20/bin:/usr/bin</string>');
    expect(plist).toContain('<key>XDG_CONFIG_HOME</key>\n\t\t<string>/tmp/cfg</string>');
    expect(plist).toContain('<key>XDG_DATA_HOME</key>\n\t\t<string>/tmp/data</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>');
    expect(plist).toContain(`<string>${join(h.home, 'Library', 'Logs', 'claude-usage', 'daemon.out.log')}</string>`);
    expect(plist).toContain(`<string>${join(h.home, 'Library', 'Logs', 'claude-usage', 'daemon.err.log')}</string>`);
  });

  /** Same restart contract as the systemd unit (§20, §23.9) — see that test. */
  it('keeps KeepAlive.SuccessfulExit=false, so only a non-zero exit relaunches', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    await svc.install(unit());
    const plist = readFileSync(svc.unitPath, 'utf8');

    expect(plist).toContain('<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>');
    // `KeepAlive: true` would relaunch after `configure service off`.
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\n\t<true\/>/);
    expect(plist).toContain(`exiting ${String(UPDATE_RESTART_EXIT_CODE)}`);
    // §23.74: a SIGTERM exits non-zero too, so a stray one is relaunched.
    expect(plist).toContain(`a SIGTERM exits ${String(SIGTERM_EXIT_CODE)}\n`);
  });

  it('omits XDG variables that are not set', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(buildUnit({ nodePath: '/n', binPath: '/b', env: { PATH: '/usr/bin' } }));
    const plist = readFileSync(svc.unitPath, 'utf8');
    expect(plist).not.toContain('XDG_CONFIG_HOME');
    expect(plist).not.toContain('XDG_DATA_HOME');
  });

  it('escapes XML metacharacters in paths', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    await svc.install(buildUnit({ nodePath: '/n&<>/node', binPath: '/b', env: { PATH: '' } }));
    expect(readFileSync(svc.unitPath, 'utf8')).toContain('<string>/n&amp;&lt;&gt;/node</string>');
  });
});

describe('/bin/launchctl commands', () => {
  it('boots out then bootstraps on install', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());
    expect(exec.lines()).toEqual([
      `/bin/launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `/bin/launchctl bootstrap gui/501 ${svc.unitPath}`,
      // RunAtLoad does not fire reliably when bootstrapping from a non-GUI session.
      `/bin/launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`,
      // …and confirm launchd actually kept the job (§23.28).
      `/bin/launchctl print gui/501/${LAUNCHD_LABEL}`,
    ]);
  });

  it('tolerates a bootout for a service that is not loaded', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[0] === 'bootout' ? { code: 3, stderr: 'No such process' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
  });

  it('still starts the job when bootstrap reports it already loaded', async () => {
    const h = tempHome();
    // A bootstrap failure used to abort install *after* bootout, leaving the daemon down.
    const exec = fakeExec((f, a) => (a[0] === 'bootstrap' ? { code: 5, stderr: 'Load failed' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
    expect(exec.lines()).toContain(`/bin/launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`);
  });

  /**
   * §23.26. `/bin/launchctl bootout` returns before the job is actually gone, and anything that
   * lands in that window fails with `EALREADY` (errno 37). Observed on the Mac Studio during
   * the very install that was meant to repair it: `bootout` succeeded, the re-`bootstrap`
   * failed silently into the tolerate branch, `kickstart -k` then died with exit 37, and the
   * install aborted leaving **nothing loaded** — the daemon down and the LaunchAgent
   * unregistered. Tolerating the bootstrap is not enough when the failure is a race we can
   * simply wait out.
   */
  it('retries a bootstrap that lost the race with its own bootout', async () => {
    const h = tempHome();
    let bootstraps = 0;
    const exec = fakeExec((f, a) => {
      if (a[0] !== 'bootstrap') return undefined;
      bootstraps += 1;
      // EIO (5) is what launchctl actually returns here — see the §23.28 measurement. The
      // first version of this fix retried only EALREADY (37) and therefore never fired.
      return bootstraps < 3 ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : undefined;
    });
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
    expect(bootstraps).toBe(3);
    // And it still went on to start the job rather than stopping at the successful bootstrap.
    expect(exec.lines()).toContain(`/bin/launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`);
  });

  it('gives up retrying rather than looping forever', async () => {
    const h = tempHome();
    let bootstraps = 0;
    const exec = fakeExec((f, a) => {
      if (a[0] !== 'bootstrap') return undefined;
      bootstraps += 1;
      return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    });
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    // Still tolerated when the job is loaded regardless: aborting after the bootout is what
    // leaves the daemon down, which is the §23.9 rule this must not undo.
    await expect(svc.install(unit())).resolves.toBeUndefined();
    expect(bootstraps).toBeGreaterThan(1);
    expect(bootstraps).toBeLessThanOrEqual(8);
  });

  /**
   * §23.28. Every launchctl step in `install` tolerates something, so the only honest report
   * is the end state. On the Studio the bootstrap failed EIO, the kickstart failed EALREADY,
   * both were tolerated, and `install` announced success on a machine whose LaunchAgent had
   * been booted out and never replaced.
   */
  it('throws when launchd did not keep the job, however the steps exited', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => {
      if (a[0] === 'bootstrap') return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
      if (a[0] === 'kickstart') return { code: 37, stderr: 'Operation already in progress' };
      if (a[0] === 'print') return { code: 113, stdout: '', stderr: 'Could not find service' };
      return undefined;
    });
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    await expect(svc.install(unit())).rejects.toThrow(/did not keep the service/);
  });

  /**
   * In a GUI session `RunAtLoad` fires on its own, so the explicit `kickstart -k` can arrive
   * while launchd is already starting the job and come back `EALREADY`. That is the job
   * starting, not failing — treating it as failure is what aborted the Studio's install.
   */
  it('accepts EALREADY from kickstart: the job is already on its way up', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) =>
      a[0] === 'kickstart' ? { code: 37, stderr: 'Operation already in progress' } : undefined,
    );
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501, retryWaitMs: 0 });
    await expect(svc.install(unit())).resolves.toBeUndefined();
  });

  it('throws ServiceError when the job cannot be started at all', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[0] === 'kickstart' ? { code: 3, stderr: 'No such process' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await expect(svc.install(unit())).rejects.toBeInstanceOf(ServiceError);
  });

  it('uninstall boots out and removes the plist', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());
    exec.calls.length = 0;
    await svc.uninstall();
    expect(exec.lines()).toEqual([`/bin/launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(existsSync(svc.unitPath)).toBe(false);
  });

  it('restart uses kickstart -k', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.restart();
    expect(exec.lines()).toEqual([`/bin/launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`]);
  });

  it('stop boots out', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.stop();
    expect(exec.lines()).toEqual([`/bin/launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
  });
});

describe('status', () => {
  it('is not-installed without a plist', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    expect(await svc.status()).toBe('not-installed');
  });

  it('is running when launchctl print reports a pid', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[0] === 'print' ? { stdout: 'state = running\n\tpid = 4242\n' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: exec.runner, uid: 501 });
    await svc.install(unit());
    expect(await svc.status()).toBe('running');
  });

  it('is stopped when print succeeds without a pid, and when print fails', async () => {
    const h = tempHome();
    const noPid = fakeExec((f, a) => (a[0] === 'print' ? { stdout: 'state = not running\n' } : undefined));
    const svc = new LaunchdService({ env: h.env, exec: noPid.runner, uid: 501 });
    await svc.install(unit());
    expect(await svc.status()).toBe('stopped');

    const failing = fakeExec((f, a) => (a[0] === 'print' ? { code: 113 } : undefined));
    const svc2 = new LaunchdService({ env: h.env, exec: failing.runner, uid: 501 });
    expect(await svc2.status()).toBe('stopped');
  });
});

describe('logs', () => {
  it('creates the log directory 0700 and truncates logs over 10 MB at install', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    mkdirSync(svc.logDir, { recursive: true });
    writeFileSync(svc.stderrLog, 'x'.repeat(LOG_TRUNCATE_BYTES + 10));
    writeFileSync(svc.stdoutLog, 'small');

    await svc.install(unit());

    expect(statSync(svc.stderrLog).size).toBe(0);
    expect(statSync(svc.stdoutLog).size).toBe(5);
    expect(statSync(svc.logDir).mode & 0o777).toBe(0o700);
  });

  it('tails the stderr log, and returns [] when there is none', async () => {
    const h = tempHome();
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    expect(await svc.logTail(20)).toEqual([]);
    mkdirSync(svc.logDir, { recursive: true });
    writeFileSync(svc.stderrLog, Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n') + '\n');
    const tail = await svc.logTail(20);
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe('line 10');
    expect(tail[19]).toBe('line 29');
  });
});

describe('restart watchdog (§23.50)', () => {
  it('spawns a detached shell that kickstarts the job (without -k) once launchd shows no pid', () => {
    const h = tempHome();
    const calls: Array<{ file: string; args: readonly string[]; detached: unknown; stdio: unknown }> = [];
    let unrefed = false;
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    svc.armRestartWatchdog((file, args, options) => {
      calls.push({ file, args, detached: options.detached, stdio: options.stdio });
      return { unref: () => { unrefed = true; } };
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe('/bin/sh');
    expect(call.detached).toBe(true);
    expect(call.stdio).toBe('ignore');
    expect(unrefed).toBe(true);
    const script = call.args[1]!;
    expect(call.args[0]).toBe('-c');
    // §23.62: launchctl by absolute path, as $2, under a PATH of system directories only.
    expect(call.args.slice(-2)).toEqual([`gui/501/${LAUNCHD_LABEL}`, '/bin/launchctl']);
    expect(script).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin');
    expect(script).toContain('"$2" print "$1"');
    expect(script).toContain('"$2" kickstart "$1"');
    expect(script).not.toMatch(/(^|\s)launchctl /m);
    expect(script).not.toContain('kickstart -k');
  });

  it('the watchdog script restarts a job with no pid and leaves a running one alone', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const h = tempHome();
    let script = '';
    const svc = new LaunchdService({ env: h.env, exec: fakeExec().runner, uid: 501 });
    svc.armRestartWatchdog((_file, args) => {
      script = args[1]!;
      return { unref: () => {} };
    });
    // Run the real script against a fake `launchctl` on PATH, with the poll made instant.
    const bin = mkdtempSync(join(tmpdir(), 'wd-'));
    const log = join(bin, 'calls.txt');
    const fake = (printOut: string) =>
      writeFileSync(
        join(bin, 'launchctl'),
        `#!/bin/sh\necho "$@" >> ${log}\n[ "$1" = print ] && printf '%s\\n' '${printOut}'\nexit 0\n`,
        { mode: 0o755 },
      );
    // The fake is handed over as $2, exactly as the real absolute path is; the PATH given
    // here is ignored by the script, which sets its own.
    const run = () =>
      execFileSync('/bin/sh', ['-c', script.replace(/sleep \d+/g, 'sleep 0'), 'watchdog', 'gui/501/x', join(bin, 'launchctl')], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
      });

    fake('\tstate = not running');
    run();
    expect(readFileSync(log, 'utf8')).toContain('kickstart gui/501/x');

    writeFileSync(log, '');
    fake('\tpid = 4242');
    run();
    expect(readFileSync(log, 'utf8')).not.toContain('kickstart');
  });
});
