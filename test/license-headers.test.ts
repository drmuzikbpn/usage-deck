// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SPDX = 'SPDX-License-Identifier: MIT';
const COPYRIGHT = 'Copyright (c) 2026 Even Seal Productions';

/** Directories whose every source file carries the header; `vendor/` and fixtures keep their own. */
const TREES = ['src', 'test', 'scripts', 'bin', '.github/workflows', 'windows'];
const SINGLE = ['lefthook.yml', 'eslint.config.js', 'vitest.config.ts', '.github/dependabot.yml', '.gitleaks.toml'];
// `Fixtures` is the Windows tests' copy; `obj`/`bin` below windows/ are .NET build output.
const SKIP_DIRS = new Set(['fixtures', 'Fixtures', 'node_modules', 'obj', 'bin']);
const SOURCE = /\.(ts|mjs|js|sh|ya?ml|cs|ps1|csproj|props)$/;
/** XML files (csproj, props) carry the lines inside `<!-- … -->`. */
const line = (s: string | undefined) => (s ?? '').replace(/\s*-->\s*$/, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (SOURCE.test(name) || dir.endsWith('bin')) {
      out.push(full);
    }
  }
  return out;
}

describe('licence headers', () => {
  const files = [...TREES.flatMap((t) => walk(join(ROOT, t))), ...SINGLE.map((f) => join(ROOT, f))];

  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every owned source file starts with the SPDX and copyright lines (after any shebang)', () => {
    const missing: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const start = lines[0]?.startsWith('#!') ? 1 : 0;
      if (!line(lines[start]).endsWith(SPDX) || !line(lines[start + 1]).endsWith(COPYRIGHT)) {
        missing.push(relative(ROOT, file));
      }
    }
    expect(missing).toEqual([]);
  });

  it('LICENSE names the same copyright holder', () => {
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toContain(COPYRIGHT);
  });
});
