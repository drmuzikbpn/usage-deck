// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from '../../src/install/apply.js';
import type { InstallIO } from '../../src/install/context.js';
import { MCP_KEY } from '../../src/install/claude-json.js';
import { backupPathFor, hookCommand } from '../../src/install/settings-merge.js';
import { claudeJsonPath, currentBin, currentLink, settingsPath, versionDir } from '../../src/paths.js';
import { cleanupAllTempHomes, fakeExec, fakePackage, FakeService, scriptedPrompter, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'install');
const TOKEN = 'deterministic-token-for-tests';

interface Bed {
  env: NodeJS.ProcessEnv;
  home: string;
  configDir: string;
  service: FakeService;
  exec: ReturnType<typeof fakeExec>;
  out: string;
  err: string;
  io: InstallIO;
  run(argv: string[]): Promise<number>;
}

function bed(opts: { platform?: string; settings?: string; healthy?: boolean; prompt?: InstallIO['prompt']; isTTY?: boolean } = {}): Bed {
  const h = tempHome();
  if (opts.settings !== undefined) {
    const file = settingsPath(h.env);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(FIXTURES, opts.settings), file);
  }
  const service = new FakeService(opts.platform === 'linux' ? 'systemd' : 'launchd');
  const exec = fakeExec();
  const b: Bed = {
    env: h.env,
    home: h.home,
    configDir: h.configDir,
    service,
    exec,
    out: '',
    err: '',
    io: {} as InstallIO,
    run: async () => 0,
  };
  b.io = {
    stdout: (t) => {
      b.out += t;
    },
    stderr: (t) => {
      b.err += t;
    },
    env: h.env,
    platform: opts.platform ?? 'darwin',
    service,
    exec: exec.runner,
    nodePath: '/opt/node/v20/bin/node',
    sourceDir: fakePackage('1.2.3'),
    version: '1.2.3',
    readCredentials: () => Promise.resolve('never-printed'),
    health: () => Promise.resolve(opts.healthy ?? true),
    sleep: () => Promise.resolve(),
    randomToken: () => TOKEN,
    isTTY: opts.isTTY ?? false,
    findMenuBarApp: () => '/Applications/SwiftBar.app',
    ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
  };
  b.run = (argv) => runInstall(argv, b.io);
  return b;
}

function config(b: Bed): Record<string, never> & Record<string, unknown> {
  return JSON.parse(readFileSync(join(b.configDir, 'config.json'), 'utf8')) as Record<string, never>;
}

function settings(b: Bed): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(b.env), 'utf8')) as Record<string, unknown>;
}

describe('--yes accepts the defaults', () => {
  it('installs the service, hooks and MCP, and never edits an existing status line', async () => {
    const b = bed({ settings: 'settings-populated.json' });
    expect(await b.run(['--yes'])).toBe(0);

    expect(b.service.calls).toContain('install');
    const cfg = config(b);
    expect(cfg['integrations']).toEqual({ service: true, hook: true, mcp: true, statusline: true });

    const hooks = settings(b)['hooks'] as Record<string, unknown[]>;
    expect(JSON.stringify(hooks)).toContain(hookCommand(currentBin(b.env)));
    expect(hooks['UserPromptSubmit']).toHaveLength(1);

    expect(b.exec.lines()).toContain(`claude mcp add --scope user ${MCP_KEY} -- ${currentBin(b.env)} mcp`);
    // the user's own statusLine is never edited; install prints the one line to add (§23.54)
    expect(settings(b)['statusLine']).toMatchObject({ command: '/home/example/.claude/statusline.sh' });
    expect(b.out).toContain(`| ${currentBin(b.env)} observe >/dev/null 2>&1 &`);
    expect(b.out).toMatch(/limits\s+needs one line in your own status line/);
  });

  it('mints a 32-byte bearer token into a 0600 config inside a 0700 directory', async () => {
    const b = bed();
    await b.run(['--yes']);
    const cfg = config(b) as unknown as { auth: { token: string } };
    expect(cfg.auth.token).toBe(TOKEN);
    expect(statSync(join(b.configDir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(b.configDir).mode & 0o777).toBe(0o700);
  });

  it('does not rotate an existing token on a re-run', async () => {
    const b = bed();
    await b.run(['--yes']);
    b.io.randomToken = () => 'a-different-token';
    await b.run(['--yes']);
    expect((config(b) as unknown as { auth: { token: string } }).auth.token).toBe(TOKEN);
  });

  it('builds the unit from the absolute node path and the current symlink', async () => {
    const b = bed();
    await b.run(['--yes']);
    expect(b.service.unit).toEqual({
      nodePath: '/opt/node/v20/bin/node',
      binPath: currentBin(b.env),
      args: ['serve'],
      env: {
        PATH: '/usr/bin:/bin',
        XDG_CONFIG_HOME: join(b.home, '.config'),
        XDG_DATA_HOME: join(b.home, '.local', 'share'),
      },
    });
  });

  it('lays out versions/<v>/ and points current at it before installing the service', async () => {
    const b = bed();
    await b.run(['--yes']);
    expect(existsSync(versionDir('1.2.3', b.env))).toBe(true);
    expect(existsSync(currentLink(b.env))).toBe(true);
    expect(existsSync(currentBin(b.env))).toBe(true);
    expect(b.out).not.toContain('already installed');
  });

  it('re-copies the package on a second run so a rebuilt checkout actually lands', async () => {
    const b = bed();
    await b.run(['--yes']);
    b.out = '';
    await b.run(['--yes']);
    expect(b.out).not.toContain('already installed');
    expect(b.out).toContain('package:');
  });

  it('is idempotent — a second run changes nothing in settings.json', async () => {
    const b = bed({ settings: 'settings-populated.json' });
    await b.run(['--yes']);
    const after = readFileSync(settingsPath(b.env), 'utf8');
    await b.run(['--yes']);
    expect(readFileSync(settingsPath(b.env), 'utf8')).toBe(after);
  });

  it('writes the .bak exactly once', async () => {
    const b = bed({ settings: 'settings-populated.json' });
    const original = readFileSync(join(FIXTURES, 'settings-populated.json'), 'utf8');
    await b.run(['--yes']);
    await b.run(['--yes']);
    expect(readFileSync(backupPathFor(settingsPath(b.env)), 'utf8')).toBe(original);
  });
});

describe('opt-outs', () => {
  it('--no-service --no-hook --no-mcp --no-statusline leaves every integration alone', async () => {
    const b = bed({ settings: 'settings-populated.json' });
    const before = readFileSync(settingsPath(b.env), 'utf8');
    expect(await b.run(['--yes', '--no-service', '--no-hook', '--no-mcp', '--no-statusline'])).toBe(0);

    expect(b.service.calls).toEqual([]);
    expect(b.exec.lines()).toEqual([]);
    expect(readFileSync(settingsPath(b.env), 'utf8')).toBe(before);
    expect(config(b)['integrations']).toEqual({ service: false, hook: false, mcp: false, statusline: false });
    expect(b.out).toContain('run `claude-usage serve` yourself');
  });

  it('wires the silent limits feed when there is no statusLine (§23.54)', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await b.run(['--yes']);
    expect(settings(b)['statusLine']).toEqual({ type: 'command', command: `${currentBin(b.env)} observe` });
    expect(b.out).toMatch(/limits\s+live, from Claude Code/);
    // and a re-run changes nothing
    const before = readFileSync(settingsPath(b.env), 'utf8');
    await b.run(['--yes']);
    expect(readFileSync(settingsPath(b.env), 'utf8')).toBe(before);
  });

  it('leaves a statusLine that already forwards to us alone, and says so', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    const file = settingsPath(b.env);
    const mine = { statusLine: { type: 'command', command: "bash -c 'tee >(claude-usage observe) | mine'" } };
    writeFileSync(file, JSON.stringify(mine));
    await b.run(['--yes']);
    expect(settings(b)['statusLine']).toEqual(mine.statusLine);
    expect(b.out).toMatch(/limits\s+live, from Claude Code/);
    expect(b.out).not.toContain('needs one line');
  });

  it('--no-statusline never touches statusLine', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await b.run(['--yes', '--no-statusline']);
    expect(settings(b)['statusLine']).toBeUndefined();
    expect(config(b)['integrations']).toMatchObject({ statusline: false });
    expect(b.out).toMatch(/limits\s+off/);
  });

  it('--statusline sets statusLine when there is none', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    await b.run(['--yes', '--statusline']);
    expect(settings(b)['statusLine']).toEqual({ type: 'command', command: `${currentBin(b.env)} statusline` });
  });

  it('--statusline prints the snippet instead of overwriting an existing statusLine (§7.3)', async () => {
    const b = bed({ settings: 'settings-populated.json' });
    await b.run(['--yes', '--statusline']);
    expect(settings(b)['statusLine']).toMatchObject({ command: '/home/example/.claude/statusline.sh' });
    expect(b.out).toContain(`| ${currentBin(b.env)} observe >/dev/null 2>&1 &`);
    expect(b.out).toContain('add this line to your own status line script');
  });

  it('--lan appends the bind entry once (§23.44)', async () => {
    const b = bed();
    await b.run(['--yes', '--lan']);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'lan']);
    await b.run(['--yes', '--lan']);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'lan']);
  });

  it('--yes alone does not widen reachability to the LAN, nor offer pairing', async () => {
    let paired = 0;
    const b = bed();
    b.io.pair = async () => {
      paired += 1;
      return 0;
    };
    await b.run(['--yes']);
    expect(config(b)['bind']).toEqual(['127.0.0.1']);
    expect(paired).toBe(0);
  });

  it('--tailscale appends the bind entry once', async () => {
    const b = bed();
    await b.run(['--yes', '--tailscale']);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'tailscale']);
    await b.run(['--yes', '--tailscale']);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'tailscale']);
  });

  it('rejects unknown options before doing anything', async () => {
    const b = bed();
    expect(await b.run(['--nope'])).toBe(1);
    expect(b.err).toContain('unknown option "--nope"');
    expect(existsSync(join(b.configDir, 'config.json'))).toBe(false);
  });
});

describe('confirmation', () => {
  it('asks about each item and honours scripted answers', async () => {
    const scripted = scriptedPrompter([true, false, false, true, true, false]);
    const b = bed({ settings: 'settings-empty.json', prompt: scripted.prompt, isTTY: true });
    expect(await b.run([])).toBe(0);
    expect(scripted.questions).toEqual([
      'background service?',
      'Claude Code hooks?',
      'MCP server?',
      'live limits?',
      'Let phones on this network reach the daemon? (HTTPS only, pinned certificate; pairing still needs a one-time code)',
      'Open the pairing page now?',
    ]);
    expect(config(b)['integrations']).toEqual({ service: true, hook: false, mcp: false, statusline: true });
    expect(settings(b)['hooks']).toBeUndefined();
    expect(settings(b)['statusLine']).toBeDefined();
  });

  it('LAN defaults to yes interactively, and the pairing page is offered and opened', async () => {
    const scripted = scriptedPrompter([true, true, true, false]); // LAN + pairing: defaults
    const b = bed({ settings: 'settings-empty.json', prompt: scripted.prompt, isTTY: true });
    let paired = 0;
    b.io.pair = async () => {
      paired += 1;
      return 0;
    };
    expect(await b.run([])).toBe(0);
    expect(config(b)['bind']).toEqual(['127.0.0.1', 'lan']);
    expect(paired).toBe(1);
  });

  it('declining LAN skips the pairing offer — loopback-only cannot pair', async () => {
    const scripted = scriptedPrompter([true, true, true, false, false]);
    const b = bed({ settings: 'settings-empty.json', prompt: scripted.prompt, isTTY: true });
    let paired = 0;
    b.io.pair = async () => {
      paired += 1;
      return 0;
    };
    expect(await b.run([])).toBe(0);
    expect(config(b)['bind']).toEqual(['127.0.0.1']);
    expect(scripted.questions).not.toContain('Open the pairing page now?');
    expect(paired).toBe(0);
  });

  it('links claude-usage onto the PATH and says how to pair later (§23.51)', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    expect(await b.run(['--yes'])).toBe(0);
    const link = join(b.home, '.local', 'bin', 'claude-usage');
    expect(readlinkSync(link)).toBe(currentBin(b.env));
    expect(b.out).toContain(`path:    linked ${link}`);
    expect(b.out).toContain('is not on your PATH'); // the test PATH is /usr/bin:/bin
    expect(b.out).toContain('pair a phone: claude-usage configure lan on, then claude-usage pair');
  });

  it('with --lan the closing hint is just `claude-usage pair`', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    expect(await b.run(['--yes', '--lan'])).toBe(0);
    expect(b.out.trimEnd().endsWith('pair a phone: claude-usage pair')).toBe(true);
  });

  it('fails on a non-TTY without --yes, and changes nothing', async () => {
    const b = bed({ isTTY: false });
    expect(await b.run([])).toBe(1);
    expect(b.err).toContain('--yes');
    expect(b.service.calls).toEqual([]);
    expect(existsSync(join(b.configDir, 'config.json'))).toBe(false);
  });
});

describe('preflight gate', () => {
  it('stops on an unsupported platform without writing anything', async () => {
    const b = bed({ platform: 'win32' });
    expect(await b.run(['--yes'])).toBe(1);
    expect(b.err).toContain('nothing was changed');
    expect(existsSync(join(b.configDir, 'config.json'))).toBe(false);
    expect(existsSync(claudeJsonPath(b.env))).toBe(false);
    expect(b.service.calls).toEqual([]);
  });

  it('continues with a warning when credentials are unreadable', async () => {
    const b = bed();
    b.io.readCredentials = () => Promise.reject(new Error('Keychain item not readable'));
    expect(await b.run(['--yes'])).toBe(0);
    expect(b.out).toContain('[warn] credentials');
    expect(b.service.calls).toContain('install');
  });
});

describe('health verification', () => {
  it('reports the daemon healthy in the status table', async () => {
    const b = bed({ healthy: true });
    await b.run(['--yes']);
    expect(b.out).toContain('daemon');
    expect(b.out).toContain('healthy on port 47291');
  });

  it('notes the failure and still exits 0 when /health never answers', async () => {
    const b = bed({ healthy: false });
    expect(await b.run(['--yes'])).toBe(0);
    expect(b.out).toContain('did not answer GET /health within 5s');
  });

  it('retries until /health answers', async () => {
    const b = bed();
    let calls = 0;
    b.io.health = () => {
      calls += 1;
      return Promise.resolve(calls >= 3);
    };
    await b.run(['--yes']);
    expect(calls).toBe(3);
    expect(b.out).toContain('healthy on port');
  });
});

describe('linger (systemd only)', () => {
  it('reports the result and never fails install', async () => {
    const b = bed({ platform: 'linux' });
    const systemd = Object.assign(b.service, {
      kind: 'systemd' as const,
      enableLinger: () => Promise.resolve({ ok: false, message: 'loginctl not found — lingering not enabled' }),
    });
    b.io.service = systemd;
    expect(await b.run(['--yes', '--linger'])).toBe(0);
    expect(b.out).toContain('loginctl not found');
  });

  it('is ignored on launchd', async () => {
    const b = bed({ platform: 'darwin' });
    expect(await b.run(['--yes', '--linger'])).toBe(0);
    expect(b.out).toContain('--linger only applies to systemd');
  });
});

describe('MCP fallback', () => {
  it('merges ~/.claude.json directly and warns when claude is missing', async () => {
    const h = tempHome();
    const service = new FakeService();
    let out = '';
    const code = await runInstall(['--yes'], {
      stdout: (t) => {
        out += t;
      },
      stderr: () => undefined,
      env: h.env,
      platform: 'darwin',
      service,
      exec: fakeExec(() => ({ code: 127 })).runner,
      nodePath: '/usr/bin/node',
      sourceDir: fakePackage('1.2.3'),
      version: '1.2.3',
      readCredentials: () => Promise.resolve('x'),
      health: () => Promise.resolve(true),
      sleep: () => Promise.resolve(),
      randomToken: () => TOKEN,
      isTTY: false,
    });
    expect(code).toBe(0);
    const json = JSON.parse(readFileSync(claudeJsonPath(h.env), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(json['mcpServers']?.[MCP_KEY]).toEqual({ type: 'stdio', command: currentBin(h.env), args: ['mcp'] });
    expect(statSync(claudeJsonPath(h.env)).mode & 0o777).toBe(0o600);
    expect(out).toContain('quit running Claude Code sessions');
  });

  /**
   * §23.29. A failing MCP registration used to abort `runInstall` by exception — after the
   * service was installed, before the status table and every note. On the Mac Studio that
   * swallowed the "launchd will not supervise this service" warning, which was the entire
   * reason the user had walked over to the machine.
   */
  it('finishes the install and reports the failure when MCP registration throws', async () => {
    const h = tempHome();
    const service = new FakeService();
    let out = '';
    const code = await runInstall(['--yes'], {
      stdout: (t) => {
        out += t;
      },
      stderr: () => undefined,
      env: h.env,
      platform: 'darwin',
      service,
      // Not 127 (that is the documented fallback) and not "already exists": a real failure.
      exec: fakeExec((f, a) =>
        f === 'claude' && a[0] === 'mcp' ? { code: 1, stderr: 'error: config is read-only' } : undefined,
      ).runner,
      nodePath: '/usr/bin/node',
      sourceDir: fakePackage('1.2.3'),
      version: '1.2.3',
      readCredentials: () => Promise.resolve('x'),
      health: () => Promise.resolve(true),
      sleep: () => Promise.resolve(),
      randomToken: () => TOKEN,
      isTTY: false,
    });
    expect(code).toBe(0);
    // The service still went in...
    expect(service.calls).toContain('install');
    // ...the status table still printed...
    expect(out).toContain('installed');
    // ...and the failure is reported rather than thrown away.
    expect(out).toContain('config is read-only');
  });
});


describe('the menu bar app', () => {
  it('is offered by an interactive install when it is missing, before pairing', async () => {
    const scripted = scriptedPrompter([true, true, true, false, true, false, false]);
    const b = bed({ settings: 'settings-empty.json', prompt: scripted.prompt, isTTY: true });
    b.io.findMenuBarApp = () => null;
    b.io.findBrew = () => '/opt/homebrew/bin/brew';
    expect(await b.run([])).toBe(0);
    expect(scripted.questions.slice(-2)).toEqual([
      "SwiftBar isn't installed. Install it with Homebrew to see your limits in the menu bar?",
      'Open the pairing page now?',
    ]);
    expect(b.exec.lines().join('\n')).not.toContain('swiftbar');
  });

  it('is never installed by --yes, which only says how', async () => {
    const b = bed({ settings: 'settings-empty.json' });
    b.io.findMenuBarApp = () => null;
    b.io.findBrew = () => '/opt/homebrew/bin/brew';
    expect(await b.run(['--yes'])).toBe(0);
    expect(b.exec.lines().join('\n')).not.toContain('swiftbar');
    expect(b.out).toContain('brew install --cask swiftbar');
  });

  it('is never installed by --yes even when a prompt is available', async () => {
    const scripted = scriptedPrompter([true, true]);
    const b = bed({ settings: 'settings-empty.json', prompt: scripted.prompt, isTTY: true });
    b.io.findMenuBarApp = () => null;
    b.io.findBrew = () => '/opt/homebrew/bin/brew';
    expect(await b.run(['--yes'])).toBe(0);
    expect(scripted.questions).toEqual([]);
    expect(b.exec.lines().join('\n')).not.toContain('swiftbar');
  });
});
