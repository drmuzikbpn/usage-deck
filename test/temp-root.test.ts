// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { sweepRunDirs } from './helpers/temp-root.js';

const DEAD_PID = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
const real = process.env['TMPDIR'];

afterEach(() => {
  if (real === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = real;
});

describe('the temp folder tests write to', () => {
  it('is one folder for the whole run', () => {
    expect(basename(tmpdir())).toMatch(/^cu-run-\d+-/);
  });

  it('goes away with everything in it when the run ends', () => {
    const base = mkdtempSync(join(tmpdir(), 'cu-root-'));
    process.env['TMPDIR'] = base;
    const teardown = setup();
    const run = tmpdir();
    expect(dirname(run)).toBe(base);
    mkdirSync(join(run, 'cu-x', 'y'), { recursive: true });
    writeFileSync(join(run, 'cu-x', 'y', 'f'), 'x');

    teardown();
    expect(existsSync(run)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
    expect(process.env['TMPDIR']).toBe(base);
  });

  it('puts an unset TMPDIR back to unset', () => {
    delete process.env['TMPDIR'];
    const teardown = setup();
    const run = tmpdir();
    expect(process.env['TMPDIR']).toBe(run);
    teardown();
    expect(process.env['TMPDIR']).toBeUndefined();
    expect(existsSync(run)).toBe(false);
  });

  it('is cleaned up by the next run when the process was killed', () => {
    const base = mkdtempSync(join(tmpdir(), 'cu-root-'));
    const dead = join(base, `cu-run-${DEAD_PID}-abc`);
    mkdirSync(join(dead, 'cu-x'), { recursive: true });
    process.env['TMPDIR'] = base;
    const teardown = setup();
    expect(existsSync(dead)).toBe(false);
    teardown();
  });
});

describe('sweepRunDirs', () => {
  it("keeps a running run's folder, and anything that is not a run's folder", () => {
    const base = mkdtempSync(join(tmpdir(), 'cu-root-'));
    const target = mkdtempSync(join(tmpdir(), 'cu-target-'));
    const kept = [`cu-run-${process.pid}-a`, `cu-run-${DEAD_PID}`, 'cu-run-x-a', `my-cu-run-${DEAD_PID}-a`];
    for (const name of kept) mkdirSync(join(base, name));
    writeFileSync(join(base, `cu-run-${DEAD_PID}-file`), 'x');
    symlinkSync(target, join(base, `cu-run-${DEAD_PID}-link`));

    sweepRunDirs(base);
    expect(readdirSync(base).sort()).toEqual(
      [...kept, `cu-run-${DEAD_PID}-file`, `cu-run-${DEAD_PID}-link`].sort(),
    );
    expect(existsSync(target)).toBe(true);
    rmSync(base, { recursive: true });
  });
});
