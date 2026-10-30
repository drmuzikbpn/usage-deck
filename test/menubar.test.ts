// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { daemonFilePath } from '../src/clients/http.js';
import {
  PLUGIN_FILE,
  PLUGIN_MARKER,
  PLUGIN_RECORD,
  detailFor,
  pluginScript,
  removeMenubarPlugin,
  renderMenubar,
  runMenubar,
  type MenubarState,
} from '../src/menubar.js';
import type { SummaryBody } from '../src/hook.js';
import type { LimitsErrorInfo, NormalizedLimit } from '../src/limits/types.js';
import type { ServiceState } from '../src/service/index.js';
import { startFakeDaemon, tempConfigDir, type FakeDaemon } from './helpers/fake-daemon.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const PLUGIN = '/opt/swiftbar/claude-usage.1m.sh';

function limit(id: string, percent: number | null, extra: Partial<NormalizedLimit> = {}): NormalizedLimit {
  return {
    id,
    kind: id,
    group: null,
    percent,
    severity: null,
    resetsAt: null,
    scope: null,
    isActive: true,
    asOf: new Date(NOW - 2 * 60000).toISOString(),
    stale: false,
    ...extra,
  };
}

function summary(limits: NormalizedLimit[], overall: 'ok' | 'warn' | 'critical' = 'ok'): SummaryBody {
  return {
    limits: { limits },
    status: { byId: Object.fromEntries(limits.map((l) => [l.id, overall])), overall },
    thresholds: { warn: 80, critical: 95 },
  };
}

const daemons: FakeDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop();
});

function capture(): { io: { stdout: (t: string) => void; stderr: (t: string) => void }; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: { stdout: (t) => void (out += t), stderr: (t) => void (err += t) },
    out: () => out,
    err: () => err,
  };
}

describe('renderMenubar', () => {
  it('titles a running daemon with the headline limits and offers Stop', () => {
    const text = renderMenubar(
      {
        running: true,
        version: '0.1.160',
        summary: summary([limit('session', 62, { resetsAt: new Date(NOW + 90 * 60000).toISOString() }), limit('weekly_all', 84)]),
      },
      NOW,
      PLUGIN,
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('🟢 5h 62% · 7d 84%');
    expect(lines[1]).toBe('---');
    expect(text).toContain('claude-usage: running (0.1.160)');
    expect(text).toContain('🟢 5h: 62% · resets in 1h 30m');
    expect(text).toContain('Updated 2m ago');
    expect(text).toContain(`Stop daemon | bash="${PLUGIN}" param1=service param2=stop terminal=false refresh=true`);
    expect(text).not.toContain('Start daemon');
  });

  it('marks the overall status with a dot, never by colouring the title text', () => {
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('session', 97)], 'critical') }, NOW, PLUGIN);
    expect(text.split('\n')[0]).toBe('🔴 5h 97%');
    const warn = renderMenubar({ running: true, version: '1', summary: summary([limit('session', 85)], 'warn') }, NOW, PLUGIN);
    expect(warn.split('\n')[0]).toBe('🟠 5h 85%');
    expect(text).toContain('🔴 5h: 97%');
    expect(text).not.toContain('color=red');
    expect(text).not.toContain('color=orange');
  });

  it('gives every info row an action, so none is drawn as a faint disabled row', () => {
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('session', 5), limit('weekly_scoped:fable', 7)]) }, NOW, PLUGIN);
    const rows = text.split('\n').slice(2).filter((l) => l !== '' && l !== '---' && !l.startsWith('About') && !l.startsWith('--'));
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(row).toMatch(/\| (refresh=true|bash=)/);
  });

  it('shows an unknown limit as waiting, not as a green ?%', () => {
    const text = renderMenubar(
      { running: true, version: '1', summary: summary([limit('session', 5), limit('weekly_scoped:fable', null, { stale: true })]) },
      NOW,
      PLUGIN,
    );
    expect(text).toContain('⚪ fable: waiting for a reading | bash=');
    expect(text).not.toContain('?%');
  });

  it('treats an unknown headline limit the same way', () => {
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('weekly_all', null, { stale: true })]) }, NOW, PLUGIN);
    expect(text).toContain('⚪ 7d: waiting for a reading | bash=');
  });

  it('never uses a submenu: every row opens one window', () => {
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('session', 5), limit('weekly_scoped:fable', null)]) }, NOW, PLUGIN);
    expect(text).not.toMatch(/^--[^-]/m);
    expect(text).toContain(`5h: 5% | bash="${PLUGIN}" param1=menubar param2=--detail param3=session terminal=false`);
    expect(text).toContain(`⚪ fable: waiting for a reading | bash="${PLUGIN}" param1=menubar param2=--detail param3=weekly_scoped:fable terminal=false`);
    expect(text).toContain(`About Usage Deck | bash="${PLUGIN}" param1=menubar param2=--detail param3=about terminal=false`);
  });

  it('never puts an odd limit id into a menu parameter', () => {
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('weird id" x', 5)]) }, NOW, PLUGIN);
    expect(text).toContain('weird id" x: 5% | refresh=true');
  });

  describe('the detail window', () => {
    const state = (error: LimitsErrorInfo | null): MenubarState => {
      const body = summary([limit('session', 62, { source: 'statusline', resetsAt: new Date(NOW + 90 * 60000).toISOString() }), limit('weekly_scoped:fable', null, { stale: true })]);
      body.limits.error = error;
      return { running: true, version: '0.1.170', summary: body };
    };

    it('gives a limit its status, reset, source and age', () => {
      const d = detailFor('session', state(null), NOW);
      expect(d?.title).toBe('5h: 62%');
      expect(d?.message).toMatch(/^Status: ok\nResets .+\nFrom Claude Code's status line\nRead 2m ago$/);
    });

    it('names the 429 and the next try', () => {
      const d = detailFor('weekly_scoped:fable', state({ code: 'rate_limited', message: 'x', retryAt: new Date(NOW + 600000).toISOString() }), NOW);
      expect(d?.title).toBe('fable: waiting for a reading');
      expect(d?.message).toContain('Anthropic is returning HTTP 429 when we try to read this limit\nNext try: ');
      expect(d?.message).not.toContain('Next try: soon');
    });

    it('says soon once the retry time has passed', () => {
      const d = detailFor('weekly_scoped:fable', state({ code: 'rate_limited', message: 'x', retryAt: new Date(NOW - 600000).toISOString() }), NOW);
      expect(d?.message).toContain('Next try: soon');
    });

    it('passes on any other error with its hint', () => {
      const d = detailFor('weekly_scoped:fable', state({ code: 'unauthorized', message: 'rejected with 401', hint: 'run claude' }), NOW);
      expect(d?.message).toBe("Can't read this limit: rejected with 401\nrun claude");
    });

    it('still says something with no error', () => {
      expect(detailFor('weekly_scoped:fable', state(null), NOW)?.message).toBe("No reading from Anthropic's usage endpoint yet");
    });

    it('is null for a limit that has gone', () => {
      expect(detailFor('nope', state(null), NOW)).toBeNull();
      expect(detailFor('session', { running: false }, NOW)).toBeNull();
    });

    it('has an About window with the disclaimer and links', () => {
      const d = detailFor('about', state(null), NOW);
      expect(d?.title).toBe('Usage Deck');
      expect(d?.message).toContain('claude-usage 0.1.170');
      expect(d?.message).toContain('Not affiliated with, endorsed by, or sponsored by Anthropic.');
      expect(d?.links.map((l) => l.url)).toEqual(['https://github.com/drmuzikbpn/usage-deck', 'https://apps.apple.com/us/app/usage-deck/id6818383053']);
    });

    it('opens through osascript with the text as argv, never inside the script', async () => {
      const calls: string[][] = [];
      const c = capture();
      const code = await runMenubar(['--detail', 'about'], {
        ...c.io,
        configDir: tempConfigDir(),
        exec: async (file, args) => {
          calls.push([file, ...args]);
          return { code: 0, stdout: 'GitHub\n', stderr: '' };
        },
      });
      expect(code).toBe(0);
      const [osa, open] = calls;
      expect(osa?.[0]).toBe('/usr/bin/osascript');
      const script = (osa ?? []).filter((_, i, a) => a[i - 1] === '-e').join('\n');
      expect(script).not.toContain('Anthropic');
      expect(osa?.slice(-3)).toEqual(['GitHub', 'App Store', 'OK']);
      expect(open).toEqual(['/usr/bin/open', 'https://github.com/drmuzikbpn/usage-deck']);
    });

    it('opens nothing else when the button is OK', async () => {
      const calls: string[][] = [];
      const c = capture();
      await runMenubar(['--detail', 'about'], {
        ...c.io,
        configDir: tempConfigDir(),
        exec: async (file, args) => {
          calls.push([file, ...args]);
          return { code: 0, stdout: 'OK\n', stderr: '' };
        },
      });
      expect(calls).toHaveLength(1);
    });
  });

  it("fills in the plugin's metadata for SwiftBar's About window", () => {
    const script = pluginScript('/n', '/b');
    expect(script).toContain('# <xbar.title>Usage Deck</xbar.title>');
    expect(script).toContain('# <xbar.author>Even Seal Productions</xbar.author>');
    expect(script).toContain('Not affiliated with, endorsed by, or sponsored by Anthropic.</xbar.desc>');
    expect(script).toContain('# <xbar.abouturl>https://github.com/drmuzikbpn/usage-deck</xbar.abouturl>');
  });

  it('lists the other limits, so a dot they cause is explained', () => {
    const body = summary([
      limit('session', 0),
      limit('weekly_all', 0),
      limit('weekly_scoped:fable', 81, { stale: true }),
    ]);
    body.status = { byId: { session: 'ok', weekly_all: 'ok', 'weekly_scoped:fable': 'warn' }, overall: 'warn' };
    const text = renderMenubar({ running: true, version: '1', summary: body }, NOW, PLUGIN);
    expect(text.split('\n')[0]).toBe('🟠 5h 0% · 7d 0%');
    expect(text).toContain('🟠 fable: 81% ⚠︎');
  });

  it('flags a reading older than 15 minutes as stale', () => {
    const old = new Date(NOW - 42 * 60000).toISOString();
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('session', 10, { asOf: old })]) }, NOW, PLUGIN);
    expect(text.split('\n')[0]).toBe('🟢 5h 10% ⚠︎');
    expect(text).toContain('⚠︎ Stale: updated 42m ago');
  });

  it('flags a row the daemon marked stale', () => {
    const text = renderMenubar({ running: true, version: '1', summary: summary([limit('weekly_all', null, { stale: true })]) }, NOW, PLUGIN);
    expect(text.split('\n')[0]).toBe('⚪ 7d — ⚠︎');
  });

  it('shows a stopped daemon in red with Start', () => {
    const text = renderMenubar({ running: false }, NOW, PLUGIN);
    expect(text.split('\n')[0]).toBe('🔴 Claude ⏹');
    expect(text).toContain('claude-usage: stopped');
    expect(text).toContain(`Start daemon | bash="${PLUGIN}" param1=service param2=start`);
  });

  it('says so when the daemon runs but does not answer', () => {
    const text = renderMenubar({ running: true, version: '1', summary: null }, NOW, PLUGIN);
    expect(text.split('\n')[0]).toBe('Claude …');
    expect(text).toContain('🔴 Not answering');
  });

  it('greys out the actions without a plugin path', () => {
    expect(renderMenubar({ running: false }, NOW, null)).toContain('Start daemon | color=gray');
  });
});

describe('claude-usage menubar', () => {
  it('prints the plugin output from a live daemon and exits 0', async () => {
    const d = await startFakeDaemon();
    daemons.push(d);
    d.setPercents({ session: 42 });
    const c = capture();
    const code = await run(['menubar', '--plugin', PLUGIN], { ...c.io, configDir: d.configDir });
    expect(code).toBe(0);
    expect(c.out()).toMatch(/^🟢 5h 42%/);
    expect(c.out()).toContain('param2=stop');
  });

  it('exits 0 with the stopped menu when no daemon runs', async () => {
    const c = capture();
    const code = await run(['menubar'], { ...c.io, configDir: tempConfigDir() });
    expect(code).toBe(0);
    expect(c.out()).toContain('claude-usage: stopped');
    expect(c.out()).toContain('Start daemon | color=gray');
  });

  it('ignores a relative --plugin path', async () => {
    const c = capture();
    await run(['menubar', '--plugin', 'x.sh'], { ...c.io, configDir: tempConfigDir() });
    expect(c.out()).toContain('Start daemon | color=gray');
  });
});

describe('menubar --install / --uninstall', () => {
  it('writes an executable plugin that runs node and the current bin by absolute path', async () => {
    const configDir = tempConfigDir();
    const dir = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const c = capture();
    const code = await runMenubar(['--install', '--dir', dir], {
      ...c.io,
      configDir,
      nodePath: '/opt/node/bin/node',
      binPath: "/opt/o'neil/.local/share/claude-usage/current/bin/claude-usage",
    });
    expect(code).toBe(0);
    const file = join(dir, PLUGIN_FILE);
    const body = readFileSync(file, 'utf8');
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(body).toContain(PLUGIN_MARKER);
    expect(body).toContain("node='/opt/node/bin/node'");
    expect(body).toContain(`exec "$node" '/opt/o'\\''neil/.local/share/claude-usage/current/bin/claude-usage' menubar --plugin "$0"`);
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(configDir, PLUGIN_RECORD), 'utf8').trim()).toBe(file);
    expect(c.out()).toContain(`menubar: installed ${file}`);

    const u = capture();
    expect(await runMenubar(['--uninstall'], { ...u.io, configDir })).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(u.out()).toContain(`menubar: removed ${file}`);
  });

  it('asks for SwiftBar when it has no plugin folder', async () => {
    const c = capture();
    const code = await runMenubar(['--install'], {
      ...c.io,
      configDir: tempConfigDir(),
      exec: async () => ({ code: 1, stdout: '', stderr: 'does not exist' }),
    });
    expect(code).toBe(1);
    expect(c.err()).toContain('brew install swiftbar');
  });

  it("uses SwiftBar's configured plugin folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const calls: string[][] = [];
    const c = capture();
    const code = await runMenubar(['--install'], {
      ...c.io,
      configDir: tempConfigDir(),
      nodePath: '/n',
      binPath: '/b',
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return { code: 0, stdout: `${dir}\n`, stderr: '' };
      },
    });
    expect(code).toBe(0);
    expect(calls[0]).toEqual(['/usr/bin/defaults', 'read', 'com.ameba.SwiftBar', 'PluginDirectory']);
    expect(existsSync(join(dir, PLUGIN_FILE))).toBe(true);
  });

  it('refuses --dir without a folder', async () => {
    const c = capture();
    expect(await runMenubar(['--install', '--dir'], { ...c.io, configDir: tempConfigDir() })).toBe(1);
    expect(await runMenubar(['--install', '--dir', '--foo'], { ...c.io, configDir: tempConfigDir() })).toBe(1);
    expect(c.err()).toContain('--dir needs a folder');
  });

  it('keeps the existing plugin when a reinstall cannot write', async () => {
    const configDir = tempConfigDir();
    const dir = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const c = capture();
    await runMenubar(['--install', '--dir', dir], { ...c.io, configDir, nodePath: '/n', binPath: '/b' });
    const blocked = join(dir, 'a-file');
    writeFileSync(blocked, '');
    const f = capture();
    expect(await runMenubar(['--install', '--dir', join(blocked, 'sub')], { ...f.io, configDir, nodePath: '/n', binPath: '/b' })).toBe(1);
    expect(f.err()).toContain('could not write the plugin');
    expect(existsSync(join(dir, PLUGIN_FILE))).toBe(true);
    expect(readFileSync(join(configDir, PLUGIN_RECORD), 'utf8').trim()).toBe(join(dir, PLUGIN_FILE));
  });

  it('a reinstall to the same folder keeps the plugin; to another moves it', async () => {
    const configDir = tempConfigDir();
    const a = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const b = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const c = capture();
    const opts = { ...c.io, configDir, nodePath: '/n', binPath: '/b' };
    await runMenubar(['--install', '--dir', a], opts);
    await runMenubar(['--install', '--dir', a], opts);
    expect(existsSync(join(a, PLUGIN_FILE))).toBe(true);
    await runMenubar(['--install', '--dir', b], opts);
    expect(existsSync(join(a, PLUGIN_FILE))).toBe(false);
    expect(existsSync(join(b, PLUGIN_FILE))).toBe(true);
  });

  it('the script survives its node path going away', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const file = join(dir, PLUGIN_FILE);
    writeFileSync(file, pluginScript('/gone/node', '/gone/bin'), { mode: 0o755 });
    const noNode = spawnSync(file, [], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(noNode.status).toBe(0);
    expect(noNode.stdout).toContain('run claude-usage menubar --install');
    const fake = join(dir, 'node');
    writeFileSync(fake, '#!/bin/sh\necho "ran $1 $2"\n', { mode: 0o755 });
    const fallback = spawnSync(file, ['service', 'stop'], { env: { PATH: `${dir}:/bin:/usr/bin` }, encoding: 'utf8' });
    expect(fallback.stdout).toBe('ran /gone/bin service\n');
  });

  it('never removes a file that is not ours', () => {
    const configDir = tempConfigDir();
    const dir = mkdtempSync(join(tmpdir(), 'swiftbar-'));
    const other = join(dir, PLUGIN_FILE);
    writeFileSync(other, '#!/bin/sh\necho someone else\n');
    writeFileSync(join(configDir, PLUGIN_RECORD), `${other}\n`);
    expect(removeMenubarPlugin(configDir)).toBeNull();
    expect(existsSync(other)).toBe(true);
  });

  it('the script passes arguments through, so menu actions reach the CLI', () => {
    expect(pluginScript('/n', '/b')).toContain(`if [ "$#" -gt 0 ]; then exec "$node" '/b' "$@"; fi`);
  });
});

describe('claude-usage service', () => {
  const quiet = () => ({ configDir: tempConfigDir(), serviceWaitMs: 0 });

  it('waits for a stopped daemon to go, so the menu refresh is not stale', async () => {
    const configDir = tempConfigDir();
    const child = spawn('/bin/sleep', ['5']);
    writeFileSync(daemonFilePath(configDir), JSON.stringify({ pid: child.pid, port: 1, version: '1' }));
    const service = { ...fake('running'), stop: async () => void setTimeout(() => child.kill(), 150) };
    const c = capture();
    const t0 = Date.now();
    await run(['service', 'stop'], { ...c.io, service, configDir, serviceWaitMs: 2000 });
    expect(child.killed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1900);
  });

  const fake = (initial: ServiceState) => {
    const f = {
      state: initial,
      calls: [] as string[],
      start: async () => {
        f.calls.push('start');
        f.state = 'running' as ServiceState;
      },
      stop: async () => {
        f.calls.push('stop');
        f.state = 'stopped' as ServiceState;
      },
      status: async () => f.state,
    };
    return f;
  };

  it('starts and stops the service and reports the new state', async () => {
    const service = fake('stopped');
    const c = capture();
    expect(await run(['service', 'start'], { ...c.io, service, ...quiet() })).toBe(0);
    expect(await run(['service', 'stop'], { ...c.io, service, ...quiet() })).toBe(0);
    expect(service.calls).toEqual(['start', 'stop']);
    expect(c.out()).toBe('service: running\nservice: stopped\n');
  });

  it('exits non-zero from status unless it is running', async () => {
    const c = capture();
    expect(await run(['service', 'status'], { ...c.io, service: fake('running'), ...quiet() })).toBe(0);
    expect(await run(['service', 'status'], { ...c.io, service: fake('stopped'), ...quiet() })).toBe(1);
  });

  it('points at install when no service is installed, and touches nothing', async () => {
    const service = fake('not-installed');
    const c = capture();
    expect(await run(['service', 'start'], { ...c.io, service, ...quiet() })).toBe(1);
    expect(service.calls).toEqual([]);
    expect(c.err()).toContain('claude-usage install');
  });

  it('reports a failed start without throwing', async () => {
    const service = { ...fake('stopped'), start: async () => Promise.reject(new Error('kickstart failed')) };
    const c = capture();
    expect(await run(['service', 'start'], { ...c.io, service, ...quiet() })).toBe(1);
    expect(c.err()).toContain('service start failed: kickstart failed');
  });

  it('rejects anything but start, stop or status', async () => {
    const c = capture();
    expect(await run(['service', 'restart'], { ...c.io, configDir: tempConfigDir() })).toBe(1);
    expect(c.err()).toContain('start, stop or status');
  });
});
