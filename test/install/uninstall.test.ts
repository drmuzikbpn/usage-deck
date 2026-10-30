// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from '../../src/install/apply.js';
import { runUninstall } from '../../src/install/uninstall.js';
import type { InstallIO } from '../../src/install/context.js';
import { MCP_KEY } from '../../src/install/claude-json.js';
import { pathLinkFile } from '../../src/install/path-link.js';
import { backupPathFor } from '../../src/install/settings-merge.js';
import { claudeJsonPath, currentBin, dataDir, settingsPath } from '../../src/paths.js';
import { daemonFilePath } from '../../src/clients/http.js';
import { PLUGIN_FILE, runMenubar } from '../../src/menubar.js';
import { cleanupAllTempHomes, fakeExec, fakePackage, FakeService, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'install');

interface Bed {
  env: NodeJS.ProcessEnv;
  configDir: string;
  service: FakeService;
  exec: ReturnType<typeof fakeExec>;
  out: string;
  err: string;
  io: InstallIO;
}

function bed(fixture: 'settings-empty.json' | 'settings-populated.json'): Bed {
  const h = tempHome();
  const file = settingsPath(h.env);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(join(FIXTURES, fixture), file);
  writeFileSync(claudeJsonPath(h.env), `${JSON.stringify({ numStartups: 3 }, null, 2)}\n`, { mode: 0o600 });

  const service = new FakeService();
  const exec = fakeExec(() => ({ code: 127 })); // no `claude` on PATH → fallback everywhere
  const b: Bed = { env: h.env, configDir: h.configDir, service, exec, out: '', err: '', io: {} as InstallIO };
  b.io = {
    stdout: (t) => {
      b.out += t;
    },
    stderr: (t) => {
      b.err += t;
    },
    env: h.env,
    platform: 'darwin',
    service,
    exec: exec.runner,
    nodePath: '/usr/bin/node',
    sourceDir: fakePackage('1.2.3'),
    version: '1.2.3',
    readCredentials: () => Promise.resolve('x'),
    health: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
    randomToken: () => 'token',
    isTTY: false,
  };
  return b;
}

describe('install → uninstall round-trip (§23.12)', () => {
  it.each(['settings-empty.json', 'settings-populated.json'] as const)(
    'restores %s byte-for-byte except the once-written .bak',
    async (fixture) => {
      const b = bed(fixture);
      const original = readFileSync(join(FIXTURES, fixture), 'utf8');
      const claudeJsonBefore = readFileSync(claudeJsonPath(b.env), 'utf8');

      await runInstall(['--yes', '--statusline'], b.io);
      expect(readFileSync(settingsPath(b.env), 'utf8')).not.toBe(original);

      expect(await runUninstall([], b.io)).toBe(0);
      expect(readFileSync(settingsPath(b.env), 'utf8')).toBe(original);
      expect(readFileSync(claudeJsonPath(b.env), 'utf8')).toBe(claudeJsonBefore);
      expect(readFileSync(backupPathFor(settingsPath(b.env)), 'utf8')).toBe(original);
    },
  );

  it('stops and removes the service and drops daemon.json', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    writeFileSync(daemonFilePath(b.configDir), '{"pid":1,"port":47291}\n');
    b.service.calls.length = 0;

    await runUninstall([], b.io);
    expect(b.service.calls).toEqual(['stop', 'uninstall']);
    expect(existsSync(daemonFilePath(b.configDir))).toBe(false);
  });

  it('removes the PATH link it made (§23.51)', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    expect(readlinkSync(pathLinkFile(b.env))).toBe(currentBin(b.env));
    await runUninstall([], b.io);
    expect(() => readlinkSync(pathLinkFile(b.env))).toThrow();
    expect(b.out).toContain(`path:    removed ${pathLinkFile(b.env)}`);
  });

  it('removes the menu-bar plugin it installed (§23.66)', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    const dir = join(b.env['HOME'] ?? '', 'SwiftBar');
    expect(await runMenubar(['--install', '--dir', dir], { ...b.io, configDir: b.configDir })).toBe(0);
    await runUninstall([], b.io);
    expect(existsSync(join(dir, PLUGIN_FILE))).toBe(false);
    expect(b.out).toContain(`menubar: removed ${join(dir, PLUGIN_FILE)}`);
  });

  it('removes the MCP entry', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    expect(readFileSync(claudeJsonPath(b.env), 'utf8')).toContain(MCP_KEY);
    await runUninstall([], b.io);
    expect(readFileSync(claudeJsonPath(b.env), 'utf8')).not.toContain(MCP_KEY);
  });

  it('never touches linger', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    b.exec.calls.length = 0;
    await runUninstall([], b.io);
    expect(b.exec.lines().join(' ')).not.toContain('linger');
  });
});

describe('--purge', () => {
  it('keeps config, state and the versions layout without it', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    await runUninstall([], b.io);
    expect(existsSync(join(b.configDir, 'config.json'))).toBe(true);
    expect(existsSync(dataDir(b.env))).toBe(true);
    expect(b.out).toContain('re-run with --purge');
  });

  it('deletes them with it, but leaves the .bak alone', async () => {
    const b = bed('settings-populated.json');
    await runInstall(['--yes'], b.io);
    await runUninstall(['--purge'], b.io);
    expect(existsSync(b.configDir)).toBe(false);
    expect(existsSync(dataDir(b.env))).toBe(false);
    expect(existsSync(backupPathFor(settingsPath(b.env)))).toBe(true);
  });

  it('rejects unknown options', async () => {
    const b = bed('settings-empty.json');
    expect(await runUninstall(['--nuke'], b.io)).toBe(1);
    expect(b.err).toContain('unknown option "--nuke"');
  });
});

describe('hard-frozen sessions', () => {
  it('is a no-op when there is no pause.json (W3 is concurrent)', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    b.out = '';
    expect(await runUninstall([], b.io)).toBe(0);
    expect(b.out).not.toContain('SIGCONT');
  });

  it('tolerates pause.json with no freeze module present', async () => {
    const b = bed('settings-empty.json');
    await runInstall(['--yes'], b.io);
    writeFileSync(join(b.configDir, 'pause.json'), '{"frozen":[]}\n');
    expect(await runUninstall([], b.io)).toBe(0);
  });
});
