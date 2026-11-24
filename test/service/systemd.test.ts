// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderUnit, systemdQuote, SystemdService } from '../../src/service/systemd.js';
import {
  buildUnit,
  ServiceError,
  SIGTERM_EXIT_CODE,
  SYSTEMD_UNIT,
  UPDATE_RESTART_EXIT_CODE,
} from '../../src/service/index.js';
import { NoopService } from '../../src/service/noop.js';
import { absolutePath, SYSTEM_PATH, systemBin } from '../../src/service/bins.js';
import { createServiceManager } from '../../src/service/index.js';
import { cleanupAllTempHomes, fakeExec, tempHome } from '../install/helpers.js';

afterAll(cleanupAllTempHomes);

/**
 * Each call as `<program> <args…>`. The program is found by absolute path in whichever
 * system directory holds it on this machine (none on macOS, `/usr/bin` on Linux), so the
 * directory is checked once, in "runs … by absolute path", and dropped here.
 */
function commands(exec: ReturnType<typeof fakeExec>): string[] {
  return exec.calls.map((c) => [c.file.split('/').pop() ?? c.file, ...c.args].join(' '));
}

function unit(): ReturnType<typeof buildUnit> {
  return buildUnit({
    nodePath: '/usr/local/bin/node',
    binPath: '/data/claude-usage/current/bin/claude-usage',
    env: { PATH: '/usr/local/bin:/usr/bin', XDG_DATA_HOME: '/data' },
  });
}

describe('unit file', () => {
  it('has an absolute ExecStart, Environment=PATH, Restart=on-failure and WantedBy=default.target', async () => {
    const h = tempHome();
    const svc = new SystemdService({ env: h.env, exec: fakeExec().runner });
    await svc.install(unit());

    expect(svc.unitPath).toBe(join(h.home, '.config', 'systemd', 'user', 'claude-usage.service'));
    const text = readFileSync(svc.unitPath, 'utf8');
    expect(text).toContain(
      'ExecStart="/usr/local/bin/node" "/data/claude-usage/current/bin/claude-usage" "serve"',
    );
    expect(text).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(text).toContain('Environment="XDG_DATA_HOME=/data"');
    expect(text).toContain('Restart=on-failure');
    expect(text).toContain('[Install]\nWantedBy=default.target');
  });

  /**
   * §20 vs §23.9: §20 assumed a clean `exit(0)` would be relaunched, but
   * `Restart=on-failure` does not restart on exit 0 — and neither does launchd's
   * `KeepAlive: { SuccessfulExit: false }`. §23.9 wins, so the unit keeps
   * on-failure and the updater exits non-zero instead.
   */
  it('keeps Restart=on-failure — exit 0 stops the service, the updater exits non-zero', async () => {
    const h = tempHome();
    const svc = new SystemdService({ env: h.env, exec: fakeExec().runner });
    await svc.install(unit());
    const text = readFileSync(svc.unitPath, 'utf8');

    expect(text).toContain('Restart=on-failure');
    expect(text).not.toContain('Restart=always');
    // Nothing may declare the updater's exit code a success, or it would never restart.
    expect(text).not.toMatch(new RegExp(`^SuccessExitStatus=.*\\b${String(UPDATE_RESTART_EXIT_CODE)}\\b`, 'm'));
    // The policy is documented in the unit itself, naming the exit code.
    expect(text).toContain(`# ${String(UPDATE_RESTART_EXIT_CODE)} (EX_TEMPFAIL)`);
    expect(UPDATE_RESTART_EXIT_CODE).not.toBe(0);
  });

  /**
   * §23.74: the daemon exits 143 on any SIGTERM. `RestartForceExitStatus=` relaunches it
   * after a stray one; `SuccessExitStatus=` keeps a `systemctl stop` (configure service off,
   * uninstall, shutdown) reading "inactive", not "failed". A manual stop never restarts:
   * systemd checks that before either list.
   */
  it('relaunches after a stray SIGTERM, and a deliberate stop still reads inactive', async () => {
    const h = tempHome();
    const svc = new SystemdService({ env: h.env, exec: fakeExec().runner });
    await svc.install(unit());
    const text = readFileSync(svc.unitPath, 'utf8');

    expect(text).toMatch(new RegExp(`^SuccessExitStatus=${String(SIGTERM_EXIT_CODE)}$`, 'm'));
    expect(text).toMatch(new RegExp(`^RestartForceExitStatus=${String(SIGTERM_EXIT_CODE)}$`, 'm'));
    expect(SIGTERM_EXIT_CODE).not.toBe(UPDATE_RESTART_EXIT_CODE);
  });
});

describe('systemctl commands', () => {
  it('reloads then enables --now on install', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.install(unit());
    expect(commands(exec)).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
    ]);
  });

  it('disables --now, deletes the unit and reloads on uninstall — and never touches linger', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.install(unit());
    exec.calls.length = 0;
    await svc.uninstall();
    expect(commands(exec)).toEqual([
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      'systemctl --user daemon-reload',
    ]);
    expect(commands(exec).join(' ')).not.toContain('linger');
    expect(existsSync(svc.unitPath)).toBe(false);
  });

  it('restart reloads then restarts (configure port rewrites the unit first)', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.restart();
    expect(commands(exec)).toEqual(['systemctl --user daemon-reload', `systemctl --user restart ${SYSTEMD_UNIT}`]);
  });

  it('throws ServiceError when enable fails', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[1] === 'enable' ? { code: 1, stderr: 'Failed' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await expect(svc.install(unit())).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('status and logs', () => {
  it('is not-installed without a unit file, running when is-active says active', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[1] === 'is-active' ? { stdout: 'active\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.status()).toBe('not-installed');
    await svc.install(unit());
    expect(await svc.status()).toBe('running');
  });

  it('is stopped when is-active says inactive', async () => {
    const h = tempHome();
    const exec = fakeExec((f, a) => (a[1] === 'is-active' ? { code: 3, stdout: 'inactive\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    await svc.install(unit());
    expect(await svc.status()).toBe('stopped');
  });

  it('tails the journal', async () => {
    const h = tempHome();
    const exec = fakeExec((f) => (f.endsWith('/journalctl') ? { stdout: 'a\nb\nc\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.logTail(20)).toEqual(['a', 'b', 'c']);
    expect(commands(exec)).toContain('journalctl --user -u claude-usage -n 20 --no-pager -q');
  });

  it('returns no lines when journalctl is unavailable', async () => {
    const h = tempHome();
    const exec = fakeExec(() => ({ code: 127 }));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.logTail(20)).toEqual([]);
  });

  it('drops journalctl banner lines that would read as captured output', async () => {
    const h = tempHome();
    const exec = fakeExec((f) => (f.endsWith('/journalctl') ? { stdout: '-- No entries --\n' } : undefined));
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.logTail(20)).toEqual([]);
  });
});

describe('linger', () => {
  it('reports success', async () => {
    const h = tempHome();
    const exec = fakeExec();
    const svc = new SystemdService({ env: h.env, exec: exec.runner });
    expect(await svc.enableLinger()).toEqual({ ok: true, message: 'lingering enabled for testuser' });
    expect(commands(exec)).toEqual(['loginctl enable-linger testuser']);
  });

  it('reports — never throws — when loginctl is missing or fails', async () => {
    const h = tempHome();
    const missing = new SystemdService({ env: h.env, exec: fakeExec(() => ({ code: 127 })).runner });
    const r1 = await missing.enableLinger();
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain('loginctl not found');

    const failing = new SystemdService({
      env: h.env,
      exec: fakeExec(() => ({ code: 1, stderr: 'Access denied\n' })).runner,
    });
    const r2 = await failing.enableLinger();
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('Access denied');
  });
});

describe('createServiceManager', () => {
  it('picks launchd on darwin, systemd on linux and noop elsewhere', async () => {
    const h = tempHome();
    expect((await createServiceManager({ platform: 'darwin', env: h.env })).kind).toBe('launchd');
    expect((await createServiceManager({ platform: 'linux', env: h.env })).kind).toBe('systemd');
    expect((await createServiceManager({ platform: 'win32', env: h.env })).kind).toBe('noop');
  });
});

describe('noop', () => {
  it('does nothing and reports not-installed', async () => {
    const svc = new NoopService();
    await svc.install();
    await svc.start();
    await svc.stop();
    await svc.restart();
    await svc.uninstall();
    expect(await svc.status()).toBe('not-installed');
    expect(await svc.logTail()).toEqual([]);
    expect(svc.unitPath).toBe('');
  });
});

describe('unit-file quoting (§23.62)', () => {
  it('quotes every word so a space, quote, % or $ in a path cannot split it or expand', () => {
    const text = renderUnit({
      nodePath: '/opt/my node/bin/node',
      binPath: '/home/alice/we"ird/%h/$HOME/claude-usage',
      args: ['serve'],
      env: { PATH: '/usr/bin:/bin', XDG_DATA_HOME: '/home/alice/data dir' },
    });
    expect(text).toContain('ExecStart="/opt/my node/bin/node" "/home/alice/we\\"ird/%%h/$$HOME/claude-usage" "serve"');
    expect(text).toContain('Environment="XDG_DATA_HOME=/home/alice/data dir"');
    expect(systemdQuote('a\\b')).toBe('"a\\\\b"');
  });

  it('refuses a line break, which would end the directive and start another', () => {
    expect(() => systemdQuote('/x\nExecStartPre=/bin/evil')).toThrow(/line break/);
    expect(() => renderUnit({ nodePath: '/n', binPath: '/b', args: ['serve'], env: { PATH: '/x\r\n[Install]' } })).toThrow(/line break/);
  });

  it('runs systemctl, journalctl and loginctl by absolute path', async () => {
    const exec = fakeExec();
    const svc = new SystemdService({ env: tempHome().env, exec: exec.runner });
    await svc.restart().catch(() => undefined);
    await svc.logTail(5);
    await svc.enableLinger().catch(() => undefined);
    for (const c of exec.calls) {
      expect(c.file.startsWith('/')).toBe(true);
      expect(c.file).toBe(systemBin(c.file.split('/').pop() as string));
    }
    expect(exec.calls.map((c) => c.file.split('/').pop())).toEqual(expect.arrayContaining(['systemctl', 'journalctl', 'loginctl']));
  });

  it('systemBin finds a program in the system directories only, and buildUnit keeps only absolute PATH entries', () => {
    expect(systemBin('systemctl', (p) => p === '/bin/systemctl')).toBe('/bin/systemctl');
    expect(systemBin('systemctl', (p) => p.startsWith('/usr/bin/'))).toBe('/usr/bin/systemctl');
    // Never a bare name: a spawn would look that up through PATH.
    expect(systemBin('systemctl', () => false)).toBe('/usr/bin/systemctl');
    const unit = buildUnit({ nodePath: '/n', binPath: '/b', env: { PATH: '.:bin::/usr/local/bin:./x:/usr/bin:/usr/bin' } });
    expect(unit.env['PATH']).toBe('/usr/local/bin:/usr/bin');
    expect(absolutePath('')).toBe(SYSTEM_PATH);
    expect(absolutePath(undefined)).toBe(SYSTEM_PATH);
  });
});

