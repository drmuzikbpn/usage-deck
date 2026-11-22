// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../../src/cli.js';
import { saveConfig, defaultConfig } from '../../src/config.js';
import { currentLink, versionDir } from '../../src/paths.js';
import { repointSymlink } from '../../src/install/versions.js';
import { currentVersion } from '../../src/update/apply.js';
import { releasesLatestUrl } from '../../src/update/check.js';
import { createUpdater, runUpdateCli, type UpdateCliIo } from '../../src/update/index.js';
import { fakeFetch, makeSigner, makeTarball, releaseJson, seedVersion, TempDirs, type FakeResponseSpec } from './helpers.js';

/** §23.59: this file's own release key, generated in memory. */
const SIGNER = makeSigner();

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const REPO = 'drmuzikbpn/usage-deck';
const LATEST = releasesLatestUrl(REPO);
const CURRENT = '1.0.0+old';
const NEXT = '1.1.0+new';

interface Ctx {
  env: NodeJS.ProcessEnv;
  configDir: string;
  out: string[];
  err: string[];
  restarts: string[];
  io: Parameters<typeof run>[1];
}

function ctx(opts: { routes?: Record<string, FakeResponseSpec>; versions?: string[] } = {}): Ctx {
  const env = dirs.env();
  const configDir = dirs.make('claude-usage-cfg-');
  const c = defaultConfig();
  saveConfig({ ...c, autoUpdate: { ...c.autoUpdate, repo: REPO } }, configDir);
  for (const v of opts.versions ?? [CURRENT]) seedVersion(env, v);
  repointSymlink(currentLink(env), versionDir(opts.versions?.[opts.versions.length - 1] ?? CURRENT, env));

  const out: string[] = [];
  const err: string[] = [];
  const restarts: string[] = [];
  const updater = createUpdater({
    config: { ...c, autoUpdate: { ...c.autoUpdate, repo: REPO } },
    currentVersion: CURRENT,
    env,
    packageRoot: null,
    fetch: fakeFetch(opts.routes ?? {}).fetch,
    trustedKeys: SIGNER.keys,
    restart: (): void => {},
  });
  return {
    env,
    configDir,
    out,
    err,
    restarts,
    io: {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      configDir,
      env,
      // The CLI restarts the service rather than exiting; the fake records it.
      restartService: () => {
        restarts.push('restarted');
        return Promise.resolve('service: restarted (fake)');
      },
      updater,
    } as Parameters<typeof run>[1],
  };
}

/** Routes serving a real release built in-test. */
function routes(version = NEXT): Record<string, FakeResponseSpec> {
  const tarball = readFileSync(makeTarball(dirs, version));
  const digest = createHash('sha256').update(tarball).digest('hex');
  const sums = `${digest}  claude-usage-${version}.tgz\n`;
  return {
    [LATEST]: { body: releaseJson(version) },
    [`https://github.example/dl/claude-usage-${version}.tgz`]: { body: tarball },
    ['https://github.example/dl/SHA256SUMS']: { body: sums },
    ['https://github.example/dl/SHA256SUMS.sig']: { body: SIGNER.sign(sums) },
  };
}

describe('claude-usage update (§20)', () => {
  it('--check prints current and available without installing anything', async () => {
    const c = ctx({ routes: routes() });
    expect(await run(['update', '--check'], c.io)).toBe(0);
    expect(c.out.join('')).toContain(`current:   ${CURRENT}`);
    expect(c.out.join('')).toContain(`available: ${NEXT}`);
    expect(currentVersion(c.env)).toBe(CURRENT);
    expect(c.restarts).toEqual([]);
  });

  it('--check says so when there is nothing newer', async () => {
    const c = ctx({ routes: { [LATEST]: { body: releaseJson('0.0.1+ancient') } } });
    expect(await run(['update', '--check'], c.io)).toBe(0);
    expect(c.out.join('')).toContain('available: none — up to date');
  });

  it('--check exits 1 and says why when the check fails', async () => {
    const c = ctx({ routes: { [LATEST]: { throws: 'ENOTFOUND api.github.com' } } });
    expect(await run(['update', '--check'], c.io)).toBe(1);
    expect(c.err.join('')).toMatch(/check failed: network/);
  });

  it('installs the release, repoints current and restarts the service', async () => {
    const c = ctx({ routes: routes() });
    expect(await run(['update'], c.io)).toBe(0);
    expect(currentVersion(c.env)).toBe(NEXT);
    expect(c.out.join('')).toContain('state:     ready');
    expect(c.out.join('')).toContain(`installed: ${NEXT}`);
    expect(c.restarts).toEqual(['restarted']);
  });

  it('exits 1 without restarting when the download does not verify', async () => {
    const bad = routes();
    const wrong = `${'0'.repeat(64)}  claude-usage-${NEXT}.tgz\n`;
    bad['https://github.example/dl/SHA256SUMS'] = { body: wrong };
    // Correctly signed, wrong digest: this is the checksum failing, not the signature.
    bad['https://github.example/dl/SHA256SUMS.sig'] = { body: SIGNER.sign(wrong) };
    const c = ctx({ routes: bad });
    expect(await run(['update'], c.io)).toBe(1);
    expect(c.out.join('')).toContain('state:     error');
    expect(currentVersion(c.env)).toBe(CURRENT);
    expect(c.restarts).toEqual([]);
  });
});

describe('claude-usage rollback (§20)', () => {
  it('repoints current at the previous version and restarts', async () => {
    const c = ctx({ versions: ['1.0.0+a', '1.1.0+b'] });
    expect(await run(['rollback'], c.io)).toBe(0);
    expect(c.out.join('')).toContain('rolled back: 1.1.0+b → 1.0.0+a');
    expect(currentVersion(c.env)).toBe('1.0.0+a');
    expect(c.restarts).toEqual(['restarted']);
  });

  it('exits 1 and lists what is installed when there is nothing to roll back to', async () => {
    const c = ctx({ versions: ['1.0.0+a'] });
    expect(await run(['rollback'], c.io)).toBe(1);
    expect(c.err.join('')).toMatch(/no previous version/);
    expect(c.err.join('')).toContain('installed versions: 1.0.0+a');
    expect(c.restarts).toEqual([]);
  });
});

describe('help', () => {
  it('lists update and rollback', async () => {
    const out: string[] = [];
    await run(['help'], { stdout: (t) => out.push(t) });
    expect(out.join('')).toMatch(/^\s+update \[--check\]/m);
    expect(out.join('')).toMatch(/^\s+rollback\s+/m);
    expect(out.join('')).not.toMatch(/Not implemented yet:.*update/);
  });
});

/**
 * §23.22: a manual `update` gets the same hard-freeze protection the daemon's loop has.
 *
 * Measured by the Android session: a restart under a hard rule thaws the frozen tree on
 * shutdown, the session gets one tool boundary it was not supposed to get, and the new
 * daemon's sweep re-freezes. The daemon's own updater defers for exactly this reason; the
 * CLI path did not, and a manual `claude-usage update` leaked a tick.
 */
describe('update --force and the hard-freeze guard (§23.22)', () => {
  const io = (over: Partial<UpdateCliIo> = {}): UpdateCliIo & { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      configDir: dirs.make(),
      restartService: async () => 'service: restarted (test)',
      ...over,
    };
  };

  it('refuses, names the sessions, and installs nothing', async () => {
    let ran = false;
    const o = io({
      hardFrozenSessions: async () => ['sess-a', 'sess-b'],
      updater: {
        runOnce: async () => {
          ran = true;
          throw new Error('must not run');
        },
      } as never,
    });
    expect(await runUpdateCli('update', [], o)).toBe(1);
    expect(ran).toBe(false);
    const err = o.err.join('');
    expect(err).toMatch(/2 session\(s\) are hard-frozen/);
    expect(err).toMatch(/sess-a/);
    expect(err).toMatch(/sess-b/);
    expect(err).toMatch(/--force/);
  });

  it('--force goes ahead anyway — the operator may well mean it', async () => {
    let ran = false;
    const o = io({
      hardFrozenSessions: async () => ['sess-a'],
      updater: {
        runOnce: async () => {
          ran = true;
          return { state: 'idle', current: '1.0.0', available: null, deferredReason: null, channel: 'stable' };
        },
      } as never,
    });
    expect(await runUpdateCli('update', ['--force'], o)).toBe(0);
    expect(ran).toBe(true);
  });

  it('does not ask at all for --check, which restarts nothing', async () => {
    let asked = false;
    const o = io({
      hardFrozenSessions: async () => {
        asked = true;
        return ['sess-a'];
      },
      updater: { checkOnly: async () => ({ current: '1.0.0', available: null, error: null }) } as never,
    });
    expect(await runUpdateCli('update', ['--check'], o)).toBe(0);
    expect(asked).toBe(false);
  });

  it('proceeds when the daemon is unreachable — nothing is running to disturb', async () => {
    let ran = false;
    const o = io({
      hardFrozenSessions: async () => [],
      updater: {
        runOnce: async () => {
          ran = true;
          return { state: 'idle', current: '1.0.0', available: null, deferredReason: null, channel: 'stable' };
        },
      } as never,
    });
    expect(await runUpdateCli('update', [], o)).toBe(0);
    expect(ran).toBe(true);
  });
});

describe('update mentions the menu bar app when it is missing (§23.73)', () => {
  const run = async (
    argv: string[],
    over: { platform?: string; app?: string | null; state?: string } = {},
  ): Promise<{ code: number; out: string }> => {
    let out = '';
    const code = await runUpdateCli('update', argv, {
      stdout: (t) => (out += t),
      stderr: () => undefined,
      configDir: dirs.make(),
      restartService: async () => 'service: restarted (test)',
      hardFrozenSessions: async () => [],
      platform: over.platform ?? 'darwin',
      findMenuBarApp: () => (over.app === undefined ? null : over.app),
      updater: {
        checkOnly: async () => ({ current: '1.0.0', available: null, error: null }),
        runOnce: async () => ({ state: over.state ?? 'idle', current: '1.0.0', available: null, deferredReason: null, channel: 'stable' }),
      } as never,
    });
    return { code, out };
  };
  const HINT = 'claude-usage menubar --install';

  it.each(['idle', 'ready'])('one line on macOS, state %s', async (state) => {
    const r = await run([], { state });
    expect(r.code).toBe(0);
    expect(r.out.split('\n').filter((l) => l.includes(HINT))).toHaveLength(1);
  });

  it('nothing when an app is there, off macOS, for --check, or after a failed update', async () => {
    expect((await run([], { app: '/Applications/xbar.app' })).out).not.toContain(HINT);
    expect((await run([], { platform: 'linux' })).out).not.toContain(HINT);
    expect((await run(['--check'])).out).not.toContain(HINT);
    expect((await run([], { state: 'error' })).out).not.toContain(HINT);
  });
});
