// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { appendFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CHUNK_SIZE, scanAll, scanChanged, scanFile, walkTranscripts } from '../../src/spend/scanner.js';
import type { UsageEvent } from '../../src/spend/types.js';
import {
  cleanupTempDirs,
  copyFixtures,
  MAIN_A,
  makeTempDir,
  PROJECT_A,
  SESSION_A,
  SUB_A,
} from './helpers.js';

afterEach(cleanupTempDirs);

function collector(): { events: UsageEvent[]; sink: (e: UsageEvent) => void } {
  const events: UsageEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

describe('walkTranscripts', () => {
  it('finds every *.jsonl at any depth and tags project key / top-level-ness', async () => {
    const projects = await copyFixtures();
    const files = await walkTranscripts(projects);
    const byRel = new Map(files.map((f) => [f.relPath, f]));

    expect([...byRel.keys()].sort()).toEqual([
      `${PROJECT_A}/${SESSION_A}.jsonl`,
      `${PROJECT_A}/${SESSION_A}/subagents/agent-fixtureagent01.jsonl`,
      `${PROJECT_A}/vercel-plugin/skill-injections.jsonl`,
      '-home-dev-beta/22222222-2222-4222-8222-222222222222.jsonl',
    ]);
    expect(byRel.get(MAIN_A)?.projectKey).toBe(PROJECT_A);
    expect(byRel.get(MAIN_A)?.topLevel).toBe(true);
    expect(byRel.get(SUB_A)?.projectKey).toBe(PROJECT_A);
    expect(byRel.get(SUB_A)?.topLevel).toBe(false);
    expect(byRel.get(MAIN_A)?.size).toBeGreaterThan(0);
  });

  it('returns an empty list for a missing projects dir', async () => {
    const dir = await makeTempDir();
    expect(await walkTranscripts(join(dir, 'nope'))).toEqual([]);
  });
});

describe('scanFile', () => {
  it('applies the line filter, dedups and counts only unparseable JSON as a parse error', async () => {
    const projects = await copyFixtures();
    const { events, sink } = collector();
    const res = await scanFile(
      join(projects, MAIN_A),
      { projectKey: PROJECT_A, topLevel: true },
      0,
      sink,
    );

    // A (once, despite the duplicate line) and B. Synthetic, api-error, usage-less,
    // user and summary lines are skipped silently.
    expect(events.map((e) => e.dedupKey)).toEqual([
      'msg_fixture_A:req_fixture_1',
      'msg_fixture_A:req_fixture_1',
      'msg_fixture_B:',
    ]);
    expect(res.parseErrors).toBe(1);
    expect(res.offset).toBe((await stat(join(projects, MAIN_A))).size);
    expect(res.restarted).toBe(false);

    const a = events[0] as UsageEvent;
    expect(a).toMatchObject({
      projectKey: PROJECT_A,
      sessionId: SESSION_A,
      model: 'claude-opus-5',
      day: '2026-09-13',
      cwd: '/home/dev/alpha',
      topLevel: true,
      input: 10,
      output: 20,
      cacheCreate: 30,
      cacheRead: 40,
    });
  });

  it('builds the dedup key from message.id alone when requestId is absent', async () => {
    const projects = await copyFixtures();
    const { events, sink } = collector();
    await scanFile(join(projects, MAIN_A), { projectKey: PROJECT_A, topLevel: true }, 0, sink);
    const b = events.find((e) => e.dedupKey.startsWith('msg_fixture_B'));
    expect(b?.dedupKey).toBe('msg_fixture_B:');
    expect(b?.dedupKey).not.toContain('undefined');
  });

  it('counts subagent lines and rolls them up under the parent sessionId', async () => {
    const projects = await copyFixtures();
    const { events, sink } = collector();
    await scanFile(join(projects, SUB_A), { projectKey: PROJECT_A, topLevel: false }, 0, sink);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: SESSION_A,
      topLevel: false,
      model: 'claude-sonnet-5',
      input: 5,
    });
  });

  it('resumes from a stored byte offset and only reads what was appended', async () => {
    const projects = await copyFixtures();
    const path = join(projects, MAIN_A);
    const first = await scanFile(path, { projectKey: PROJECT_A, topLevel: true }, 0, () => {});

    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-13T12:00:00.000Z',
      cwd: '/home/dev/alpha',
      sessionId: SESSION_A,
      requestId: 'req_fixture_9',
      message: {
        id: 'msg_fixture_Z',
        model: 'claude-opus-5',
        role: 'assistant',
        usage: {
          input_tokens: 9,
          output_tokens: 8,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 6,
        },
      },
    });
    await appendFile(path, `${line}\n`);

    const { events, sink } = collector();
    const res = await scanFile(
      path,
      { projectKey: PROJECT_A, topLevel: true },
      first.offset,
      sink,
    );
    expect(events.map((e) => e.dedupKey)).toEqual(['msg_fixture_Z:req_fixture_9']);
    expect(res.parseErrors).toBe(0);
    expect(res.offset).toBe((await stat(path)).size);
  });

  it('leaves the offset before a trailing partial line and picks it up once completed', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'partial.jsonl');
    const whole = `${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`;
    const half = '{"type":"assistant","message":{"id":"msg_fixture_P",';
    await writeFile(path, whole + half);

    const first = await scanFile(path, { projectKey: 'p', topLevel: true }, 0, () => {});
    expect(first.offset).toBe(Buffer.byteLength(whole));
    expect(first.parseErrors).toBe(0);

    const rest =
      '"model":"claude-opus-5","role":"assistant","usage":{"input_tokens":3,"output_tokens":0,' +
      '"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},' +
      '"requestId":"req_fixture_p","timestamp":"2026-09-13T10:00:00.000Z",' +
      '"cwd":"/home/dev/alpha","sessionId":"s1"}\n';
    await appendFile(path, rest);
    const { events, sink } = collector();
    const res = await scanFile(path, { projectKey: 'p', topLevel: true }, first.offset, sink);
    expect(events.map((e) => e.input)).toEqual([3]);
    expect(res.offset).toBe((await stat(path)).size);
  });

  it('parses a line that spans a 1 MB chunk boundary', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'big-line.jsonl');
    // Pad a preceding line so the next record straddles the chunk boundary, then
    // make that record itself longer than a chunk.
    const pad = `${JSON.stringify({ type: 'user', pad: 'x'.repeat(CHUNK_SIZE - 200) })}\n`;
    const wide = `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-13T10:00:00.000Z',
      cwd: '/home/dev/alpha',
      sessionId: 'span-session',
      requestId: 'req_fixture_span',
      filler: 'y'.repeat(CHUNK_SIZE + 1000),
      message: {
        id: 'msg_fixture_SPAN',
        model: 'claude-opus-5',
        role: 'assistant',
        usage: {
          input_tokens: 11,
          output_tokens: 12,
          cache_creation_input_tokens: 13,
          cache_read_input_tokens: 14,
        },
      },
    })}\n`;
    await writeFile(path, pad + wide);

    const { events, sink } = collector();
    const res = await scanFile(path, { projectKey: 'p', topLevel: true }, 0, sink);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dedupKey: 'msg_fixture_SPAN:req_fixture_span', input: 11 });
    expect(res.offset).toBe((await stat(path)).size);
  });

  it('restarts at 0 and reports it when the stored offset exceeds the file size', async () => {
    const projects = await copyFixtures();
    const { events, sink } = collector();
    const res = await scanFile(
      join(projects, SUB_A),
      { projectKey: PROJECT_A, topLevel: false },
      10_000_000,
      sink,
    );
    expect(res.restarted).toBe(true);
    expect(events).toHaveLength(1);
    expect(res.offset).toBe((await stat(join(projects, SUB_A))).size);
  });

  it('treats a vanished file as an empty scan', async () => {
    const dir = await makeTempDir();
    const res = await scanFile(join(dir, 'gone.jsonl'), { projectKey: 'p', topLevel: true }, 0, () => {
      throw new Error('should not emit');
    });
    expect(res).toMatchObject({ offset: 0, parseErrors: 0, events: 0 });
  });
});

describe('scanAll', () => {
  it('walks the whole tree, returns offsets per relative path and aggregate counters', async () => {
    const projects = await copyFixtures();
    const { events, sink } = collector();
    const res = await scanAll(projects, {}, sink);

    expect(res.filesTotal).toBe(4);
    expect(res.filesDone).toBe(4);
    expect(res.parseErrors).toBe(1);
    expect(res.bytesDone).toBe(res.bytesTotal);
    expect(Object.keys(res.offsets).sort()).toHaveLength(4);
    // A (twice, deduped later by the store), B, C, D and the 2025 line.
    expect(events).toHaveLength(6);
    expect(res.restarted).toEqual([]);
  });

  it('is incremental on a second pass and picks up an appended line', async () => {
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});

    const { events, sink } = collector();
    const second = await scanAll(projects, first.offsets, sink);
    expect(events).toHaveLength(0);
    expect(second.parseErrors).toBe(0);

    await appendFile(
      join(projects, MAIN_A),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-13T13:00:00.000Z',
        cwd: '/home/dev/alpha',
        sessionId: SESSION_A,
        requestId: 'req_fixture_new',
        message: {
          id: 'msg_fixture_NEW',
          model: 'claude-opus-5',
          role: 'assistant',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })}\n`,
    );
    const third = collector();
    await scanAll(projects, second.offsets, third.sink);
    expect(third.events.map((e) => e.dedupKey)).toEqual(['msg_fixture_NEW:req_fixture_new']);
  });

  it('does not open a file whose size still equals its offset', async () => {
    // The daemon re-scans on every transcript write. With thousands of transcripts, opening
    // (and buffering) each unchanged one per pass burned whole cores (§23.38).
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});
    expect(first.filesRead).toBe(4);

    const second = await scanAll(projects, first.offsets, () => {});
    expect(second.filesRead).toBe(0);
    expect(second.filesDone).toBe(4);
    expect(second.offsets).toEqual(first.offsets);

    await appendFile(join(projects, MAIN_A), '{"type":"user"}\n');
    const third = await scanAll(projects, second.offsets, () => {});
    expect(third.filesRead).toBe(1);
  });

  it('reports truncated files so a full background rescan can be scheduled', async () => {
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});
    await writeFile(join(projects, MAIN_A), '');
    const res = await scanAll(projects, first.offsets, () => {});
    expect(res.restarted).toEqual([MAIN_A]);
    expect(res.filesRead).toBe(1);
  });

  it('keeps at most `concurrency` files open at once', async () => {
    const projects = await copyFixtures();
    let inFlight = 0;
    let peak = 0;
    const realOpen = open;
    const res = await scanAll(projects, {}, () => {}, {
      concurrency: 2,
      onFileStart: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      },
      onFileDone: () => {
        inFlight -= 1;
      },
    });
    expect(realOpen).toBeTypeOf('function');
    expect(res.filesDone).toBe(4);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('reports progress as files complete', async () => {
    const projects = await copyFixtures();
    const seen: number[] = [];
    await scanAll(projects, {}, () => {}, { onProgress: (p) => seen.push(p.filesDone) });
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

describe('scanChanged', () => {
  const line = (id: string): string =>
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-13T13:00:00.000Z',
      cwd: '/home/dev/alpha',
      sessionId: SESSION_A,
      requestId: `req_${id}`,
      message: { id: `msg_${id}`, model: 'claude-opus-5', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n`;

  it('reads the named files and no others, keeping every other offset', async () => {
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});
    await appendFile(join(projects, MAIN_A), line('named'));
    await appendFile(join(projects, SUB_A), line('unnamed'));

    const { events, sink } = collector();
    const res = await scanChanged(projects, first.offsets, [MAIN_A], sink);
    expect(events.map((e) => e.dedupKey)).toEqual(['msg_named:req_named']);
    expect(res.filesTotal).toBe(1);
    expect(res.filesRead).toBe(1);
    expect(res.offsets).toEqual({ ...first.offsets, [MAIN_A]: (await stat(join(projects, MAIN_A))).size });

    // The one it was not told about is still there for the next full walk.
    const full = collector();
    await scanAll(projects, res.offsets, full.sink);
    expect(full.events.map((e) => e.dedupKey)).toEqual(['msg_unnamed:req_unnamed']);
  });

  it('tags a new file the way a full walk does', async () => {
    const projects = await copyFixtures();
    const rel = `${PROJECT_A}/${SESSION_A}/subagents/agent-new.jsonl`;
    await writeFile(join(projects, rel), line('new'));
    const { events, sink } = collector();
    await scanChanged(projects, {}, [rel], sink);
    expect(events).toMatchObject([{ projectKey: PROJECT_A, topLevel: false }]);
  });

  it('reads everything under a directory it is named', async () => {
    // A moved directory is reported by its own name only (macOS), as is a new one whose files
    // landed before the watch did (Linux).
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});
    await rename(join(projects, PROJECT_A), join(projects, 'moved'));
    const res = await scanChanged(projects, first.offsets, [PROJECT_A, 'moved'], () => {});
    expect(res.filesRead).toBe(3);
    expect(res.offsets[`moved/${SESSION_A}.jsonl`]).toBe(first.offsets[MAIN_A]);
  });

  it('forgets a deleted file, so one recreated under its name is read from the start', async () => {
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});
    await rm(join(projects, MAIN_A));
    const res = await scanChanged(projects, first.offsets, [MAIN_A], () => {});
    expect(MAIN_A in res.offsets).toBe(false);
    expect(Object.keys(res.offsets)).toHaveLength(3);
    expect(res.restarted).toEqual([]);
  });

  it('reads a file once when both it and its directory are named', async () => {
    const projects = await copyFixtures();
    const res = await scanChanged(projects, {}, [PROJECT_A, MAIN_A, MAIN_A], () => {});
    expect(res.filesTotal).toBe(3);
    expect(res.filesRead).toBe(3);
  });

  it('reports truncated files', async () => {
    const projects = await copyFixtures();
    const first = await scanAll(projects, {}, () => {});
    await writeFile(join(projects, MAIN_A), '');
    const res = await scanChanged(projects, first.offsets, [MAIN_A], () => {});
    expect(res.restarted).toEqual([MAIN_A]);
  });

  it('ignores what a full walk would: other extensions, stray files, paths outside the tree', async () => {
    const projects = await copyFixtures();
    await writeFile(join(projects, 'stray.jsonl'), line('stray'));
    await writeFile(join(projects, PROJECT_A, 'notes.txt'), line('txt'));
    await mkdir(join(projects, '..', 'outside'), { recursive: true });
    await writeFile(join(projects, '..', 'outside', 'x.jsonl'), line('outside'));
    const res = await scanChanged(
      projects,
      {},
      ['stray.jsonl', `${PROJECT_A}/notes.txt`, '../outside/x.jsonl', join(projects, MAIN_A), ''],
      () => {},
    );
    expect(res.filesTotal).toBe(0);
    expect(res.offsets).toEqual({});
  });
});

describe('scanner memory budget', () => {
  it('scans a ~50 MB transcript without materializing it (heap delta < 64 MB)', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'huge.jsonl');
    const target = 50 * 1024 * 1024;

    const fh = await open(path, 'w');
    try {
      const block: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        block.push(
          JSON.stringify({
            type: i % 40 === 0 ? 'assistant' : 'user',
            timestamp: '2026-09-13T10:00:00.000Z',
            cwd: '/home/dev/alpha',
            sessionId: 'huge-session',
            requestId: `req_fixture_h${i}`,
            filler: 'z'.repeat(2000),
            message: {
              id: `msg_fixture_h${i}`,
              model: 'claude-opus-5',
              role: 'assistant',
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          }),
        );
      }
      const chunk = Buffer.from(`${block.join('\n')}\n`, 'utf8');
      for (let written = 0; written < target; written += chunk.length) {
        await fh.write(chunk);
      }
    } finally {
      await fh.close();
    }
    expect((await stat(path)).size).toBeGreaterThan(target);

    let counted = 0;
    const before = process.memoryUsage().heapUsed;
    const res = await scanFile(path, { projectKey: 'p', topLevel: true }, 0, () => {
      counted += 1;
    });
    const delta = process.memoryUsage().heapUsed - before;

    expect(counted).toBeGreaterThan(0);
    expect(res.offset).toBe((await stat(path)).size);
    expect(delta).toBeLessThan(64 * 1024 * 1024);
  });
});
