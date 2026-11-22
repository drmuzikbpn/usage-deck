// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
/**
 * Transcript scanner (spec §5.3, §23.4, §23.5, §23.7, §23.8).
 *
 * Every `*.jsonl` under the projects dir is walked recursively at any depth and read
 * through `fs.open` + positional 1 MB reads with a carry-over partial line, so a file is
 * never materialized whole and peak memory is O(chunk). The event loop is yielded between
 * chunks so HTTP stays responsive during the initial scan.
 */

import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { UsageEvent } from './types.js';

/** Positional read size. Peak scanner memory is a small multiple of this. */
export const CHUNK_SIZE = 1024 * 1024;

/** Files read concurrently during the initial scan (spec §23.7). */
export const MAX_FILES_IN_FLIGHT = 4;

export interface FileContext {
  /** `~/.claude/projects/<dir>` directory name, used verbatim as an opaque key. */
  projectKey: string;
  /** `true` for `<project>/<session>.jsonl`; `false` for nested subagent transcripts. */
  topLevel: boolean;
}

export interface TranscriptFile extends FileContext {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the projects dir — the key used in persisted offsets. */
  relPath: string;
  size: number;
}

export interface FileScanResult {
  /** Byte offset just past the last *complete* line consumed. */
  offset: number;
  parseErrors: number;
  /** Number of counted usage lines emitted. */
  events: number;
  /** `true` when the stored offset exceeded the file size and we restarted at 0. */
  restarted: boolean;
}

export type UsageSink = (event: UsageEvent) => void;

export interface ScanProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface ScanAllOptions {
  /** Called for every `custom-title` record (§17.3 `title`). */
  onTitle?: TitleSink;
  concurrency?: number;
  onProgress?: (progress: ScanProgress) => void;
  onFileStart?: (file: TranscriptFile) => void;
  onFileDone?: (file: TranscriptFile, result: FileScanResult) => void;
}

export interface ScanAllResult extends ScanProgress {
  /** Relative path → byte offset, for the next incremental pass. */
  offsets: Record<string, number>;
  parseErrors: number;
  events: number;
  /** Files actually opened; an unchanged file (size === offset) is skipped (§23.38). */
  filesRead: number;
  /** Relative paths that were truncated or replaced and restarted from 0 (§23.8). */
  restarted: string[];
}

interface RawLine {
  type?: unknown;
  customTitle?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  requestId?: unknown;
  isApiErrorMessage?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function utcDay(iso: string): string {
  const ms = Date.parse(iso);
  const date = Number.isNaN(ms) ? new Date(0) : new Date(ms);
  return date.toISOString().slice(0, 10);
}

export type LineResult =
  | { type: 'event'; event: UsageEvent }
  | { type: 'title'; sessionId: string; title: string }
  | { type: 'skip' }
  | { type: 'parseError' };

/** Receives `/rename` titles (`{"type":"custom-title"}` transcript records; last one wins). */
export type TitleSink = (sessionId: string, title: string) => void;

/**
 * Counted iff `type === "assistant"` and `message.model !== "<synthetic>"` and
 * `isApiErrorMessage !== true` and `message.usage` is an object (§23.5). Anything else is
 * skipped silently; only unparseable JSON is a parse error.
 */
export function parseLine(raw: string, ctx: FileContext): LineResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { type: 'skip' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: 'parseError' };
  }
  if (!isRecord(parsed)) return { type: 'skip' };

  const line = parsed as RawLine;
  if (line.type === 'custom-title') {
    const title = typeof line.customTitle === 'string' ? line.customTitle.trim() : '';
    const sessionId = typeof line.sessionId === 'string' ? line.sessionId : '';
    return title !== '' && sessionId !== '' ? { type: 'title', sessionId, title } : { type: 'skip' };
  }
  if (line.type !== 'assistant') return { type: 'skip' };
  if (line.isApiErrorMessage === true) return { type: 'skip' };
  if (!isRecord(line.message)) return { type: 'skip' };

  const message = line.message;
  const model = message['model'];
  if (typeof model !== 'string' || model === '<synthetic>') return { type: 'skip' };
  if (!isRecord(message['usage'])) return { type: 'skip' };

  const id = message['id'];
  if (typeof id !== 'string' || id === '') return { type: 'skip' };

  const usage = message['usage'];
  const requestId = typeof line.requestId === 'string' ? line.requestId : '';
  const timestamp = typeof line.timestamp === 'string' ? line.timestamp : '';
  const sessionId = typeof line.sessionId === 'string' ? line.sessionId : '';
  const cwd = typeof line.cwd === 'string' ? line.cwd : '';

  return {
    type: 'event',
    event: {
      dedupKey: `${id}:${requestId}`,
      day: utcDay(timestamp),
      timestamp,
      projectKey: ctx.projectKey,
      sessionId,
      model,
      cwd,
      topLevel: ctx.topLevel,
      input: num(usage['input_tokens']),
      output: num(usage['output_tokens']),
      cacheCreate: num(usage['cache_creation_input_tokens']),
      cacheRead: num(usage['cache_read_input_tokens']),
    },
  };
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Read one transcript from `startOffset` to EOF in 1 MB positional chunks.
 *
 * A trailing partial line is left unconsumed: the returned offset points at its first
 * byte, so the next pass re-reads it once the writer has finished it. If `startOffset`
 * exceeds the current size the file was truncated or replaced — restart at 0 and say so
 * (§23.8); the caller schedules a full background rescan.
 */
export async function scanFile(
  path: string,
  ctx: FileContext,
  startOffset: number,
  sink: UsageSink,
  onTitle?: TitleSink,
): Promise<FileScanResult> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { offset: 0, parseErrors: 0, events: 0, restarted: false };
  }

  let parseErrors = 0;
  let events = 0;
  let restarted = false;

  try {
    const size = (await handle.stat()).size;
    let position = startOffset;
    if (position > size) {
      position = 0;
      restarted = true;
    }

    const decoder = new StringDecoder('utf8');
    // Sized to what is left: most incremental reads are a few KB, and a fresh 1 MB buffer per
    // file per pass was the bulk of the daemon's GC load (§23.38).
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_SIZE, size - position)));
    let carry = '';
    let offset = position;

    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      carry += decoder.write(buffer.subarray(0, bytesRead));
      let nl = carry.indexOf('\n');
      while (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        offset += Buffer.byteLength(line, 'utf8') + 1;

        const result = parseLine(line, ctx);
        if (result.type === 'event') {
          events += 1;
          sink(result.event);
        } else if (result.type === 'title') {
          onTitle?.(result.sessionId, result.title);
        } else if (result.type === 'parseError') {
          parseErrors += 1;
        }
        nl = carry.indexOf('\n');
      }

      if (position < size) await yieldToEventLoop();
    }

    // `decoder.end()` can only add replacement chars for a truncated multi-byte
    // sequence; that is part of the trailing partial line, which stays unconsumed.
    decoder.end();
    return { offset, parseErrors, events, restarted };
  } finally {
    await handle.close();
  }
}

/** Every `*.jsonl` under `projectsDir`, at any depth (§23.4). */
export async function walkTranscripts(projectsDir: string): Promise<TranscriptFile[]> {
  return sorted(await walkUnder(projectsDir, ''));
}

function sorted(files: TranscriptFile[]): TranscriptFile[] {
  return files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/** What a relative path is to the scanner, or null for one it does not read. */
function transcriptAt(projectsDir: string, relPath: string, size: number): TranscriptFile | null {
  const segments = relPath.split('/');
  // A stray *.jsonl directly in projects/ belongs to no project.
  if (segments.length < 2 || !relPath.endsWith('.jsonl')) return null;
  return {
    path: join(projectsDir, relPath),
    relPath,
    projectKey: segments[0] ?? '',
    topLevel: segments.length === 2,
    size,
  };
}

async function walkUnder(projectsDir: string, relDir: string): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile() || transcriptAt(projectsDir, rel, 0) === null) continue;
      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      const file = transcriptAt(projectsDir, rel, size);
      if (file !== null) found.push(file);
    }
  };

  await walk(join(projectsDir, relDir), relDir);
  return found;
}

/** A path the watcher reported, if it stays inside the tree. */
function insideTree(relPath: string): boolean {
  return relPath.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Scan the whole tree, resuming each file from `offsets[relPath]`, with at most
 * `concurrency` files in flight (default 4, §23.7).
 */
export async function scanAll(
  projectsDir: string,
  offsets: Readonly<Record<string, number>>,
  sink: UsageSink,
  options: ScanAllOptions = {},
): Promise<ScanAllResult> {
  const files = await walkTranscripts(projectsDir);
  const result = await scanFiles(files, offsets, sink, options);

  // Files that disappeared since the last pass must not keep stale offsets around.
  const live = new Set(files.map((f) => f.relPath));
  for (const key of Object.keys(result.offsets)) {
    if (!live.has(key)) delete result.offsets[key];
  }
  return result;
}

/**
 * Scan only `changed` (paths relative to the projects dir, as the watcher reports them),
 * leaving every other offset alone (§23.70). A directory stands for everything under it: a
 * moved one is reported by its own name, and so is a new one whose files beat the watch.
 *
 * The totals in the result cover the named files only.
 */
export async function scanChanged(
  projectsDir: string,
  offsets: Readonly<Record<string, number>>,
  changed: Iterable<string>,
  sink: UsageSink,
  options: ScanAllOptions = {},
): Promise<ScanAllResult> {
  const files = new Map<string, TranscriptFile>();
  const gone: string[] = [];
  for (const relPath of new Set(changed)) {
    if (!insideTree(relPath)) continue;
    let info;
    try {
      info = await lstat(join(projectsDir, relPath));
    } catch {
      gone.push(relPath);
      continue;
    }
    if (info.isDirectory()) {
      for (const file of await walkUnder(projectsDir, relPath)) files.set(file.relPath, file);
    } else if (info.isFile()) {
      const file = transcriptAt(projectsDir, relPath, info.size);
      if (file !== null) files.set(relPath, file);
    }
  }

  const result = await scanFiles(sorted([...files.values()]), offsets, sink, options);
  for (const relPath of gone) delete result.offsets[relPath];
  return result;
}

async function scanFiles(
  files: readonly TranscriptFile[],
  offsets: Readonly<Record<string, number>>,
  sink: UsageSink,
  options: ScanAllOptions,
): Promise<ScanAllResult> {
  const next: Record<string, number> = { ...offsets };
  const restarted: string[] = [];
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0);

  const result: ScanAllResult = {
    offsets: next,
    parseErrors: 0,
    events: 0,
    filesRead: 0,
    restarted,
    filesDone: 0,
    filesTotal: files.length,
    bytesDone: 0,
    bytesTotal,
  };

  const concurrency = Math.max(1, options.concurrency ?? MAX_FILES_IN_FLIGHT);
  let cursor = 0;

  const fileDone = (file: TranscriptFile): void => {
    result.filesDone += 1;
    result.bytesDone += file.size;
    options.onProgress?.({
      filesDone: result.filesDone,
      filesTotal: result.filesTotal,
      bytesDone: result.bytesDone,
      bytesTotal: result.bytesTotal,
    });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      if (!file) return;

      const start = next[file.relPath] ?? 0;
      // §23.38: the walk already stat'ed it. Nothing new to read, and a size below the offset
      // (truncation) still goes through `scanFile` so it is reported as restarted.
      if (file.size === start) {
        next[file.relPath] = start;
        fileDone(file);
        continue;
      }

      options.onFileStart?.(file);
      result.filesRead += 1;
      const scanned = await scanFile(file.path, file, start, sink, options.onTitle);
      options.onFileDone?.(file, scanned);

      next[file.relPath] = scanned.offset;
      result.parseErrors += scanned.parseErrors;
      result.events += scanned.events;
      if (scanned.restarted) restarted.push(file.relPath);
      fileDone(file);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () => worker()),
  );
  return result;
}
