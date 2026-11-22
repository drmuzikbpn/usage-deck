// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Vitest global setup: every test's `tmpdir()` is one folder per run, removed when the run ends.
 * A run that was killed cannot remove its own, so the next one does.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN_DIR = /^cu-run-(\d+)-/;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Remove the folders of this user's runs whose process is gone. Never throws. */
export function sweepRunDirs(base: string): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(RUN_DIR.exec(name)?.[1] ?? 0);
    if (pid === 0 || isRunning(pid)) continue;
    try {
      const dir = join(base, name);
      const stat = lstatSync(dir);
      if (stat.isDirectory() && stat.uid === process.getuid?.()) rmSync(dir, { recursive: true, force: true });
    } catch {
      // another run got there first
    }
  }
}

export default function setup(): () => void {
  const before = process.env['TMPDIR'];
  sweepRunDirs(tmpdir());
  const run = mkdtempSync(join(tmpdir(), `cu-run-${process.pid}-`));
  process.env['TMPDIR'] = run;
  return () => {
    if (before === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = before;
    rmSync(run, { recursive: true, force: true, maxRetries: 3 });
  };
}
