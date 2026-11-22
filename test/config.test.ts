// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  configPath,
  defaultConfig,
  effectiveTlsPort,
  expandHome,
  jsonErrorPosition,
  loadConfig,
  tempNameFor,
  writeFileAtomic,
  redactConfig,
  resolveConfigDir,
  saveConfig,
  sweepTempFiles,
  TEMP_FILE_MAX_AGE_MS,
  validateConfig,
} from '../src/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cu-config-'));
}

describe('resolveConfigDir', () => {
  it('respects XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/claude-usage');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or empty', () => {
    expect(resolveConfigDir({})).toMatch(/\.config\/claude-usage$/);
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '' })).toMatch(/\.config\/claude-usage$/);
  });
});

describe('expandHome', () => {
  it('expands a leading tilde only', () => {
    expect(expandHome('~/x')).not.toContain('~');
    expect(expandHome('/abs/~/x')).toBe('/abs/~/x');
  });
});

describe('defaults', () => {
  it('matches the documented §9 + §21 defaults', () => {
    const d = defaultConfig();
    expect(d.port).toBe(47291);
    expect(d.pollIntervalMs).toBe(300_000);
    expect(d.thresholds).toEqual({ warn: 80, critical: 95 });
    expect(d.hookDebounceMinutes).toBe(10);
    expect(d.retentionDays).toBe(90);
    expect(d.projectsDir).toBe('~/.claude/projects');
    expect(d.integrations).toEqual({ service: true, hook: true, mcp: true, statusline: false });
    expect(d.bind).toEqual(['127.0.0.1']);
    expect(d.auth.token).toBe('');
    expect(d.events.maxClients).toBe(16);
    expect(d.autoUpdate.enabled).toBe(true);
    expect(typeof d.name).toBe('string');
  });

  it('loadConfig returns defaults when the file is missing', () => {
    const dir = tempDir();
    expect(loadConfig(dir).port).toBe(47291);
  });
});

describe('autoUpdate.repo', () => {
  it('moves a config saved under the old repository name to the new one', () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ autoUpdate: { repo: 'drmuzikbpn/claude-utilization-mcp' } }));
    expect(loadConfig(dir).autoUpdate.repo).toBe('drmuzikbpn/usage-deck');
  });

  it('leaves any other repository alone (forks)', () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ autoUpdate: { repo: 'someone/usage-deck-fork' } }));
    expect(loadConfig(dir).autoUpdate.repo).toBe('someone/usage-deck-fork');
  });

  it('defaults to the new name', () => {
    expect(loadConfig(tempDir()).autoUpdate.repo).toBe('drmuzikbpn/usage-deck');
  });
});

describe('unknown keys', () => {
  it('are preserved at the top level through a load/save round-trip', () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), JSON.stringify({ port: 1234, futureKey: { a: 1 } }));
    const cfg = loadConfig(dir);
    expect(cfg.port).toBe(1234);
    expect(cfg['futureKey']).toEqual({ a: 1 });
    saveConfig(cfg, dir);
    const reread: unknown = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    expect((reread as Record<string, unknown>)['futureKey']).toEqual({ a: 1 });
  });

  it('are preserved inside known sections', () => {
    const cfg = validateConfig({ thresholds: { warn: 50, futureThreshold: 7 }, integrations: { extra: 'x' } });
    expect(cfg.thresholds.warn).toBe(50);
    expect((cfg.thresholds as unknown as Record<string, unknown>)['futureThreshold']).toBe(7);
    expect((cfg.integrations as unknown as Record<string, unknown>)['extra']).toBe('x');
  });
});

describe('validation', () => {
  const cases: Array<[string, unknown, string]> = [
    ['port', { port: 'no' }, 'port'],
    ['port range', { port: 999_999 }, 'port'],
    ['pollIntervalMs', { pollIntervalMs: 10 }, 'pollIntervalMs'],
    ['thresholds.warn', { thresholds: { warn: 101 } }, 'thresholds.warn'],
    ['thresholds.critical', { thresholds: { critical: -1 } }, 'thresholds.critical'],
    ['warn > critical', { thresholds: { warn: 99, critical: 10 } }, 'thresholds.warn'],
    ['integrations.hook', { integrations: { hook: 'yes' } }, 'integrations.hook'],
    ['projectsDir', { projectsDir: 3 }, 'projectsDir'],
    ['bind', { bind: 'x' }, 'bind'],
    ['bind entry', { bind: [''] }, 'bind[0]'],
    ['retentionDays', { retentionDays: 0 }, 'retentionDays'],
    ['events.maxClients', { events: { maxClients: 0 } }, 'events.maxClients'],
    ['autoUpdate.enabled', { autoUpdate: { enabled: 1 } }, 'autoUpdate.enabled'],
    ['tls.port', { tls: { port: 70_000 } }, 'tls.port'],
    ['tls.loopback', { tls: { loopback: 'yes' } }, 'tls.loopback'],
    ['tls.port equal to port', { port: 47_291, tls: { port: 47_291 } }, 'tls.port'],
    ['tls.port defaulting past 65535', { port: 65_535 }, 'tls.port'],
  ];

  for (const [label, input, key] of cases) {
    it(`rejects ${label} and names the key`, () => {
      let thrown: unknown;
      try {
        validateConfig(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).key).toBe(key);
      expect((thrown as ConfigError).message).toContain(key);
    });
  }

  it('rejects a non-object config body', () => {
    expect(() => validateConfig([1, 2])).toThrow(ConfigError);
  });

  it('rejects invalid JSON naming the file', () => {
    const dir = tempDir();
    writeFileSync(configPath(dir), '{oops');
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
  });
});

describe('file modes', () => {
  it('writes config 0600 inside a 0700 directory', () => {
    const base = tempDir();
    const dir = join(base, 'nested', 'claude-usage');
    saveConfig(defaultConfig(), dir);
    expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens the mode of a pre-existing loose directory', () => {
    const base = tempDir();
    const dir = join(base, 'loose');
    mkdirSync(dir, { mode: 0o755 });
    saveConfig(defaultConfig(), dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('redactConfig', () => {
  it('never exposes the bearer token', () => {
    const cfg = defaultConfig();
    cfg.auth.token = 'super-secret-value';
    const red = redactConfig(cfg);
    expect(red.auth.token).toBe('<redacted>');
    expect(JSON.stringify(red)).not.toContain('super-secret-value');
  });

  it('leaves an unset token empty', () => {
    expect(redactConfig(defaultConfig()).auth.token).toBe('');
  });
});

describe('tls (§23.45)', () => {
  it('defaults to port + 1, and to 0 when the HTTP port is 0', () => {
    const c = validateConfig({});
    expect(c.tls).toEqual({ port: null, loopback: false });
    expect(effectiveTlsPort(c, 47_291)).toBe(47_292);
    expect(effectiveTlsPort(c, 0)).toBe(0);
  });

  it('honours an explicit port and keeps unknown keys', () => {
    const c = validateConfig({ tls: { port: 9443, loopback: true, future: 1 } });
    expect(effectiveTlsPort(c, 47_291)).toBe(9443);
    expect(c.tls).toMatchObject({ loopback: true, future: 1 });
  });
});

describe('writing and reading config.json safely (§23.62)', () => {
  it('a malformed file is reported by position, never with any of its text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-cfg-'));
    const secret = ['token', 'that', 'must', 'not', 'leak'].join('-');
    writeFileSync(join(dir, 'config.json'), `{"auth":{"token":"${secret}"} oops`);
    let message = '';
    try {
      loadConfig(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/is not valid JSON/);
    expect(message).not.toContain(secret.slice(0, 8));
    expect(message).not.toContain('oops');
    expect(jsonErrorPosition(new SyntaxError('Unexpected token o in JSON at position 42'))).toBe(' (at position 42)');
    expect(jsonErrorPosition(new Error('no position here'))).toBe('');
  });

  it('writes through an unguessable temp name, exclusively, and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-cfg-'));
    const file = join(dir, 'x.json');
    const a = tempNameFor(file);
    const b = tempNameFor(file);
    expect(a).not.toBe(b);
    expect(a.startsWith(`${file}.`)).toBe(true);
    writeFileAtomic(file, '{}');
    expect(readFileSync(file, 'utf8')).toBe('{}');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('refuses to write through a temp path that already exists (a planted symlink)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-cfg-'));
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'untouched');
    const file = join(dir, 'x.json');
    const fixedName = `${file}.planted.tmp`;
    symlinkSync(victim, fixedName);
    expect(() => writeFileSync(fixedName, 'evil', { flag: 'wx' })).toThrow(/EEXIST/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });
});

// A process killed mid-write cannot remove its own temp file (§23.72).
describe('sweepTempFiles', () => {
  const NOW = Date.parse('2026-11-22T12:00:00.000Z');
  const age = (file: string, ms: number): void => {
    const at = new Date(NOW - ms);
    utimesSync(file, at, at);
  };

  it('removes what a killed write left, and nothing else', () => {
    const dir = tempDir();
    const old = (name: string): void => {
      writeFileSync(join(dir, name), 'x');
      age(join(dir, name), TEMP_FILE_MAX_AGE_MS + 1);
    };
    const leftovers = [tempNameFor(join(dir, 'observe-last.json')), tempNameFor(join(dir, 'tls-key.pem'))].map((f) => f.slice(dir.length + 1));
    for (const name of [...leftovers, 'state.json.4242.tmp']) old(name);
    const kept = ['config.json', 'state.json', 'notes.tmp', 'config.json.bak.tmp', 'observe-last.json.0123.tmp.txt', 'mine.txt.4242.tmp', 'pause.json.backup.tmp', 'pause.json.abc.tmp', 'hook-state.json.0123456789abcdeg.tmp'];
    for (const name of kept) old(name);

    sweepTempFiles(dir, NOW);
    expect(readdirSync(dir).sort()).toEqual([...kept].sort());
  });

  it('leaves a write that may still be going on', () => {
    const dir = tempDir();
    const file = tempNameFor(join(dir, 'sessions.json'));
    writeFileSync(file, 'x');
    age(file, TEMP_FILE_MAX_AGE_MS - 1000);
    sweepTempFiles(dir, NOW);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('leaves a directory or a symlink with such a name, and goes on', () => {
    const dir = tempDir();
    const target = join(tempDir(), 'target');
    writeFileSync(target, 'x');
    age(target, TEMP_FILE_MAX_AGE_MS + 1);
    mkdirSync(join(dir, 'a.json.1.tmp'));
    age(join(dir, 'a.json.1.tmp'), TEMP_FILE_MAX_AGE_MS + 1);
    symlinkSync(target, join(dir, 'b.json.2.tmp'));
    writeFileSync(join(dir, 'c.json.3.tmp'), 'x');
    age(join(dir, 'c.json.3.tmp'), TEMP_FILE_MAX_AGE_MS + 1);
    sweepTempFiles(dir, Date.now() + 10 * TEMP_FILE_MAX_AGE_MS);
    expect(readdirSync(dir).sort()).toEqual(['a.json.1.tmp', 'b.json.2.tmp']);
    expect(readFileSync(target, 'utf8')).toBe('x');
  });

  it('does not throw when the directory is missing', () => {
    expect(() => sweepTempFiles(join(tempDir(), 'none'), NOW)).not.toThrow();
  });
});
