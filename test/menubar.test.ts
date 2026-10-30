// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import {
  PLUGIN_FILE,
  PLUGIN_MARKER,
  PLUGIN_RECORD,
  pluginScript,
  removeMenubarPlugin,
  renderMenubar,
  runMenubar,
} from '../src/menubar.js';
import type { SummaryBody } from '../src/hook.js';
import type { NormalizedLimit } from '../src/limits/types.js';
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
    const rows = text.split('\n').slice(2).filter((l) => l !== '' && l !== '---');
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) expect(row).toMatch(/\| (refresh=true|bash=)/);
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
    expect(text.split('\n')[0]).toBe('🟢 7d ?% ⚠︎');
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
    expect(body).toContain(`exec '/opt/node/bin/node' '/opt/o'\\''neil/.local/share/claude-usage/current/bin/claude-usage' menubar --plugin "$0"`);
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
    expect(pluginScript('/n', '/b')).toContain(`if [ "$#" -gt 0 ]; then exec '/n' '/b' "$@"; fi`);
  });
});

describe('claude-usage service', () => {
  it('rejects anything but start, stop or status', async () => {
    const c = capture();
    expect(await run(['service', 'restart'], { ...c.io, configDir: tempConfigDir() })).toBe(1);
    expect(c.err()).toContain('start, stop or status');
  });
});
