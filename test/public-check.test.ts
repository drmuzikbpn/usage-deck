// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'public-check.sh');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'public-check');
const PROJECT_EMAIL = 'support@evensealproductions.com';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'public-check-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stderr: string;
}

function check(args: string[], opts: { env?: Record<string, string>; cwd?: string; input?: string } = {}): Result {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    input: opts.input ?? '',
    env: { PATH: process.env['PATH'] ?? '', HOME: tempDir(), GIT_CONFIG_NOSYSTEM: '1', ...(opts.env ?? {}) },
  });
  return { code: res.status, stderr: res.stderr };
}

/** A one-file diff adding `lines` to `path`. */
function diffOf(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 0000000..1111111 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const cases = readFileSync(join(FIXTURES, 'cases.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => {
    const tab = l.indexOf('\t');
    return { rule: l.slice(0, tab), line: l.slice(tab + 1) };
  });

/** A line that trips `home-path`; kept in the fixture so this file never spells one out. */
const HOME_CASE = cases.find((c) => c.rule === 'home-path')?.line ?? '';

describe('scripts/public-check.sh', () => {
  it('rejects the fixture diff that carries one of everything', () => {
    const res = check(['--diff', join(FIXTURES, 'bad.diff')]);
    expect(res.code).toBe(1);
    for (const rule of ['credential', 'email', 'home-path', 'ipv4', 'cgnat', 'tailnet']) {
      expect(res.stderr).toContain(`public-check: ${rule}:`);
    }
  });

  it('accepts the fixture diff made of allowlisted lookalikes', () => {
    const res = check(['--diff', join(FIXTURES, 'good.diff')]);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
  });

  it('has a case for every content rule', () => {
    expect(new Set(cases.map((c) => c.rule))).toEqual(new Set(['credential', 'email', 'home-path', 'ipv4', 'cgnat', 'tailnet']));
  });

  it.each(cases)('$rule: blocks `$line` on its own', ({ rule, line }) => {
    const res = check(['--diff', '-'], { input: diffOf('src/example.ts', [line]) });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`public-check: ${rule}:`);
    expect(res.stderr).toContain('1 problem(s)');
  });

  it('never prints a credential in full', () => {
    const res = check(['--diff', join(FIXTURES, 'bad.diff')]);
    for (const c of cases.filter((x) => x.rule === 'credential')) {
      const secret = /[A-Za-z0-9_-]{24,}/.exec(c.line)?.[0];
      if (secret !== undefined) expect(res.stderr).not.toContain(secret);
    }
  });

  it('ignores removed and context lines', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,1 @@', `-${HOME_CASE}`, ` ${HOME_CASE}`, ''].join('\n');
    expect(check(['--diff', '-'], { input: diff }).code).toBe(0);
  });

  it('the allow marker waives an address but never a credential', () => {
    const waived = check(['--diff', '-'], { input: diffOf('src/a.ts', ['const a = "198.18.0.1"; // public-check:allow']) });
    expect(waived.code).toBe(0);
    const key = check(['--diff', '-'], { input: diffOf('src/a.ts', [`${['-----BEGIN EC', 'PRIVATE KEY-----'].join(' ')} public-check:allow`]) });
    expect(key.code).toBe(1);
  });

  it('leaves opaque strings in tests and lockfiles alone, but not vendor tokens', () => {
    const opaque = cases.find((c) => c.line.includes('opaque'))?.line ?? '';
    expect(check(['--diff', '-'], { input: diffOf('test/a.test.ts', [opaque]) }).code).toBe(0);
    expect(check(['--diff', '-'], { input: diffOf('package-lock.json', [opaque]) }).code).toBe(0);
    const vendor = cases.find((c) => c.line.includes('sk-ant-'))?.line ?? '';
    expect(check(['--diff', '-'], { input: diffOf('test/a.test.ts', [vendor]) }).code).toBe(1);
  });

  it('skips its own fixture directory', () => {
    const lines = cases.map((c) => c.line);
    expect(check(['--diff', '-'], { input: diffOf('test/fixtures/public-check/bad.diff', lines) }).code).toBe(0);
  });

  it('blocks a literal from the private blocklist without printing it', () => {
    const dir = tempDir();
    const list = join(dir, 'blocklist');
    writeFileSync(list, '# private words\n\nZanzibar Widgets\n');
    const diff = diffOf('README.md', ['Built at zanzibar widgets HQ. public-check:allow']);
    const res = check(['--diff', '-'], { input: diff, env: { PUBLIC_CHECK_LOCAL: list } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('public-check: blocklist: entry 1');
    expect(res.stderr.toLowerCase()).not.toContain('zanzibar');
    expect(check(['--diff', '-'], { input: diff }).code).toBe(0);
  });

  it('checks an injected identity', () => {
    const diff = diffOf('a.txt', ['hello']);
    expect(check(['--diff', '-'], { input: diff, env: { PUBLIC_CHECK_AUTHOR: PROJECT_EMAIL, PUBLIC_CHECK_COMMITTER: PROJECT_EMAIL } }).code).toBe(0);
    const res = check(['--diff', '-'], { input: diff, env: { PUBLIC_CHECK_AUTHOR: 'dev@example.test', PUBLIC_CHECK_COMMITTER: PROJECT_EMAIL } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('public-check: identity: the author e-mail');
  });

  describe('against a real index', () => {
    function repo(email: string): { dir: string; env: Record<string, string> } {
      const dir = tempDir();
      const env = { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PATH: process.env['PATH'] ?? '', HOME: dir };
      writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = ${email}\n`);
      execFileSync('git', ['init', '-q', dir], { env });
      return { dir, env };
    }
    const git = (r: { dir: string; env: Record<string, string> }, ...args: string[]): void => {
      execFileSync('git', ['-C', r.dir, ...args], { env: r.env });
    };

    it('passes a clean staged change made under the project identity', () => {
      const r = repo(PROJECT_EMAIL);
      writeFileSync(join(r.dir, 'a.txt'), 'listening on 127.0.0.1\n');
      git(r, 'add', 'a.txt');
      const res = check([], { cwd: r.dir, env: r.env });
      expect(res.stderr).toBe('');
      expect(res.code).toBe(0);
    });

    it('blocks a staged private path, and only what is staged', () => {
      const r = repo(PROJECT_EMAIL);
      writeFileSync(join(r.dir, 'a.txt'), `${HOME_CASE}\n`);
      writeFileSync(join(r.dir, 'b.txt'), 'fine\n');
      git(r, 'add', 'b.txt');
      expect(check([], { cwd: r.dir, env: r.env }).code).toBe(0);
      git(r, 'add', 'a.txt');
      const res = check([], { cwd: r.dir, env: r.env });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('home-path');
      expect(res.stderr).toContain('a.txt');
    });

    it('blocks a commit made under any other identity', () => {
      const r = repo('dev@example.test');
      writeFileSync(join(r.dir, 'a.txt'), 'fine\n');
      git(r, 'add', 'a.txt');
      const res = check([], { cwd: r.dir, env: r.env });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('public-check: identity: the author e-mail');
      expect(res.stderr).toContain('public-check: identity: the committer e-mail');
    });

    it('reads .public-check.local from the worktree', () => {
      const r = repo(PROJECT_EMAIL);
      writeFileSync(join(r.dir, '.public-check.local'), 'quux-internal\n');
      writeFileSync(join(r.dir, 'a.txt'), 'the QUUX-internal host\n');
      git(r, 'add', 'a.txt');
      expect(check([], { cwd: r.dir, env: r.env }).code).toBe(1);
    });
  });

  it('lefthook requires the ggshield secret scan, with no skip when it is missing', () => {
    const hook = readFileSync(join(ROOT, 'lefthook.yml'), 'utf8');
    expect(hook).toMatch(/^\s+run: ggshield secret scan pre-commit$/m);
    expect(hook).not.toContain('command -v ggshield');
    expect(hook).not.toMatch(/skipped/);
  });

  it('is wired into lefthook and its blocklist is git-ignored', () => {
    expect(readFileSync(join(ROOT, 'lefthook.yml'), 'utf8')).toContain('scripts/public-check.sh');
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n')).toContain('.public-check.local');
  });
});
