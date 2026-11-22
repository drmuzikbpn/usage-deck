// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, defaultConfig, saveConfig } from '../src/config.js';
import { DaemonClient, daemonFilePath, readDaemonInfo } from '../src/clients/http.js';
import { PortInUseError, serve, startDaemon, type DaemonHandle } from '../src/daemon.js';
import { FakeTokensSource } from './helpers/fakes.js';
import { tempConfigDir } from './helpers/fake-daemon.js';
import { authFetch, TEST_TOKEN } from './helpers/raw-request.js';

const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.stop();
  }
});

async function start(configDir: string, over: Parameters<typeof startDaemon>[0] = {}, fakeTokens = true): Promise<DaemonHandle> {
  // Every request needs the bearer (§23.55); a test that wrote no config gets the test token.
  if (!existsSync(configPath(configDir))) saveConfig({ ...defaultConfig(), auth: { token: TEST_TOKEN } }, configDir);
  const h = await startDaemon({
    configDir,
    port: 0,
    poll: false,
    ...(fakeTokens ? { tokens: new FakeTokensSource() } : {}),
    version: '9.9.9',
    log: () => undefined,
    ...over,
  });
  handles.push(h);
  return h;
}

describe('daemon lifecycle', () => {
  it('writes daemon.json 0600 with pid, port, startedAt and version', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    const file = daemonFilePath(dir);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const info = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(info['pid']).toBe(process.pid);
    expect(info['port']).toBe(h.port);
    expect(info['version']).toBe('9.9.9');
    expect(String(info['startedAt'])).toMatch(/Z$/);
  });

  it('creates the config dir 0700 when it does not exist', async () => {
    const dir = `${tempConfigDir()}/nested/claude-usage`;
    await start(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('removes temp files a killed process left behind (§23.72)', async () => {
    const dir = tempConfigDir();
    const left = join(dir, 'observe-last.json.0123456789abcdef.tmp');
    writeFileSync(left, '');
    utimesSync(left, new Date(0), new Date(0));
    await start(dir);
    expect(existsSync(left)).toBe(false);
  });

  it('serves /health on the bound port', async () => {
    const h = await start(tempConfigDir());
    const res = await authFetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe('9.9.9');
  });

  it('removes daemon.json on stop', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    await h.stop();
    expect(existsSync(daemonFilePath(dir))).toBe(false);
  });

  it('is idempotent on repeated stop', async () => {
    const h = await start(tempConfigDir());
    await h.stop();
    await expect(h.stop()).resolves.toBeUndefined();
  });

  it('loads config from the config dir', async () => {
    const dir = tempConfigDir();
    const cfg = defaultConfig();
    cfg.name = 'configured-host';
    cfg.thresholds = { warn: 50, critical: 70 };
    cfg.auth = { token: TEST_TOKEN };
    saveConfig(cfg, dir);
    const h = await start(dir);
    expect(h.config.name).toBe('configured-host');
    const summary = (await (await authFetch(`http://127.0.0.1:${h.port}/v1/summary`)).json()) as {
      thresholds: unknown;
    };
    expect(summary.thresholds).toMatchObject({ warn: 50, critical: 70 });
  });

  it('reports an invalid config by key rather than starting', async () => {
    const dir = tempConfigDir();
    writeFileSync(configPath(dir), JSON.stringify({ thresholds: { warn: 900 } }));
    await expect(startDaemon({ configDir: dir, port: 0, poll: false, log: () => undefined })).rejects.toThrow(
      /thresholds\.warn/,
    );
  });

  it('throws PortInUseError when the port is taken', async () => {
    const dir = tempConfigDir();
    const first = await start(dir);
    await expect(
      startDaemon({ configDir: tempConfigDir(), port: first.port, poll: false, log: () => undefined }),
    ).rejects.toBeInstanceOf(PortInUseError);
  });

  it('attaches a tokens source built by createTokensSource', async () => {
    const dir = tempConfigDir();
    const tokens = new FakeTokensSource({ stats: { filesTracked: 77 } });
    const h = await start(dir, { createTokensSource: async () => tokens }, false);
    handles.push(h);
    const health = (await (await authFetch(`http://127.0.0.1:${h.port}/health`)).json()) as {
      stats: { filesTracked: number; spendReady: boolean };
    };
    expect(health.stats.filesTracked).toBe(77);
    expect(health.stats.spendReady).toBe(true);
  });

  it('still serves with no tokens source at all', async () => {
    const h = await start(tempConfigDir(), { createTokensSource: async () => null }, false);
    const tokens = (await (await authFetch(`http://127.0.0.1:${h.port}/v1/tokens`)).json()) as { ready: boolean };
    expect(tokens.ready).toBe(false);
  });

  it('serves /v1/limits before the first poll completes', async () => {
    const h = await start(tempConfigDir());
    const body = (await (await authFetch(`http://127.0.0.1:${h.port}/v1/limits`)).json()) as { fetchedAt: null };
    expect(body.fetchedAt).toBeNull();
  });
});

describe('readDaemonInfo', () => {
  it('reads what startDaemon wrote', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    expect(readDaemonInfo(dir)).toMatchObject({ pid: process.pid, port: h.port, version: '9.9.9' });
  });

  it('returns null for a missing, malformed or portless file', () => {
    const dir = tempConfigDir();
    expect(readDaemonInfo(dir)).toBeNull();
    writeFileSync(daemonFilePath(dir), 'not json');
    expect(readDaemonInfo(dir)).toBeNull();
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: 1 }));
    expect(readDaemonInfo(dir)).toBeNull();
  });
});

describe('serve', () => {
  it('returns exit code 1 with a message when the port is in use', async () => {
    const dir = tempConfigDir();
    const first = await start(dir);
    const lines: string[] = [];
    const code = await serve({
      configDir: tempConfigDir(),
      port: first.port,
      poll: false,
      tokens: null,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/already in use/);
  });

  it('returns exit code 1 when config is invalid', async () => {
    const dir = tempConfigDir();
    writeFileSync(configPath(dir), JSON.stringify({ port: 'nope' }));
    const lines: string[] = [];
    const code = await serve({ configDir: dir, poll: false, tokens: null, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/port/);
  });

  it('shuts down on SIGTERM, removing daemon.json, and exits 0', async () => {
    const dir = tempConfigDir();
    const lines: string[] = [];
    const promise = serve({ configDir: dir, port: 0, poll: false, tokens: null, log: (l) => lines.push(l) });
    // Wait until daemon.json exists, then signal ourselves.
    for (let i = 0; i < 100 && !existsSync(daemonFilePath(dir)); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(daemonFilePath(dir))).toBe(true);
    process.emit('SIGTERM', 'SIGTERM');
    expect(await promise).toBe(0);
    expect(existsSync(daemonFilePath(dir))).toBe(false);
    expect(lines.join('\n')).toMatch(/SIGTERM received/);
  });
});

describe('the bearer token on a bare `serve` (§23.55)', () => {
  it('mints and persists a token when config.json has none, so its own clients can reach it', async () => {
    const dir = tempConfigDir();
    const lines: string[] = [];
    const h = await startDaemon({ configDir: dir, port: 0, poll: false, tokens: new FakeTokensSource(), version: '9.9.9', log: (l) => lines.push(l) });
    handles.push(h);
    const saved = JSON.parse(readFileSync(configPath(dir), 'utf8')) as { auth: { token: string } };
    expect(saved.auth.token.length).toBeGreaterThanOrEqual(43);
    expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).toContain('generated a bearer token');
    expect(lines.join('\n')).not.toContain(saved.auth.token);
    expect((await fetch(`http://127.0.0.1:${h.port}/v1/summary`)).status).toBe(401);
    expect(await new DaemonClient({ configDir: dir }).get('/v1/summary')).toHaveProperty('limits');
  });

  it('never replaces a token that is already there', async () => {
    const dir = tempConfigDir();
    const h = await start(dir);
    expect(h.config.auth.token).toBe(TEST_TOKEN);
    expect((JSON.parse(readFileSync(configPath(dir), 'utf8')) as { auth: { token: string } }).auth.token).toBe(TEST_TOKEN);
  });
});

describe('a stale daemon.json (§23.61)', () => {
  it('is removed before binding, so a start that fails leaves nothing pointing at the port', async () => {
    const dir = tempConfigDir();
    writeFileSync(daemonFilePath(dir), JSON.stringify({ pid: 2 ** 30, port: 1 }));
    const blocker = await start(tempConfigDir());
    await expect(start(dir, { port: blocker.port })).rejects.toBeInstanceOf(PortInUseError);
    expect(existsSync(daemonFilePath(dir))).toBe(false);
  });

  it('a live daemon’s file is left alone by a second start that fails', async () => {
    const dir = tempConfigDir();
    const first = await start(dir);
    const before = readFileSync(daemonFilePath(dir), 'utf8');
    await expect(start(dir, { port: first.port })).rejects.toBeInstanceOf(PortInUseError);
    expect(readFileSync(daemonFilePath(dir), 'utf8')).toBe(before);
  });
});

