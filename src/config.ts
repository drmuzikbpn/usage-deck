// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/** Thrown for unreadable / invalid configuration. `key` names the offending setting. */
export class ConfigError extends Error {
  readonly key: string | undefined;
  constructor(message: string, key?: string) {
    super(message);
    this.name = 'ConfigError';
    this.key = key;
  }
}

export interface Thresholds {
  warn: number;
  critical: number;
}

export interface Integrations {
  service: boolean;
  hook: boolean;
  mcp: boolean;
  statusline: boolean;
}

export interface AuthConfig {
  token: string;
}

export interface AutoUpdateConfig {
  enabled: boolean;
  intervalMs: number;
  repo: string;
}

export interface EventsConfig {
  maxClients: number;
}

/** §23.45: HTTPS listeners. */
export interface TlsConfig {
  /** `null` ⇒ `port + 1` (or `0` when `port` is `0`). */
  port: number | null;
  /** Also serve HTTPS on loopback — tests and the iOS contract job only. */
  loopback: boolean;
}

/**
 * Effective configuration. The index signature is what lets unknown keys from an
 * existing `config.json` survive a load/save round-trip (§9).
 */
export interface Config {
  name: string;
  port: number;
  bind: string[];
  auth: AuthConfig;
  pollIntervalMs: number;
  thresholds: Thresholds;
  hookDebounceMinutes: number;
  retentionDays: number;
  projectsDir: string;
  integrations: Integrations;
  autoUpdate: AutoUpdateConfig;
  events: EventsConfig;
  tls: TlsConfig;
  /**
   * §23.57: let `bind` name a wildcard (`0.0.0.0`, `::`) or a publicly routable address.
   * Off unless someone writes it into `config.json` by hand; nothing in the CLI sets it.
   */
  allowPublicBind: boolean;
  [key: string]: unknown;
}

export const CONFIG_FILE_MODE = 0o600;
export const CONFIG_DIR_MODE = 0o700;

/** `$XDG_CONFIG_HOME/claude-usage`, falling back to `~/.config/claude-usage`. */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'claude-usage');
}

export function configPath(dir: string = resolveConfigDir()): string {
  return join(dir, 'config.json');
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function defaultConfig(): Config {
  return {
    name: hostname(),
    port: 47291,
    bind: ['127.0.0.1'],
    auth: { token: '' },
    pollIntervalMs: 300_000,
    thresholds: { warn: 80, critical: 95 },
    hookDebounceMinutes: 10,
    retentionDays: 90,
    projectsDir: '~/.claude/projects',
    integrations: { service: true, hook: true, mcp: true, statusline: false },
    autoUpdate: { enabled: true, intervalMs: 600_000, repo: 'drmuzikbpn/usage-deck' },
    events: { maxClients: 16 },
    tls: { port: null, loopback: false },
    allowPublicBind: false,
  };
}

/** The HTTPS port for an HTTP port (§23.45): explicit `tls.port`, else `port + 1`; `0` stays `0`. */
export function effectiveTlsPort(config: Pick<Config, 'tls'>, httpPort: number): number {
  if (config.tls.port !== null) return config.tls.port;
  return httpPort === 0 ? 0 : httpPort + 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqInt(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ConfigError(`config key "${key}" must be an integer`, key);
  }
  if (v < min || v > max) {
    throw new ConfigError(`config key "${key}" must be between ${min} and ${max}`, key);
  }
  return v;
}

function reqBool(raw: Record<string, unknown>, key: string, path: string, fallback: boolean): boolean {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new ConfigError(`config key "${path}" must be a boolean`, path);
  return v;
}

function reqString(raw: Record<string, unknown>, key: string, path: string, fallback: string, allowEmpty = false): string {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw new ConfigError(`config key "${path}" must be a string`, path);
  if (!allowEmpty && v.length === 0) throw new ConfigError(`config key "${path}" must not be empty`, path);
  return v;
}

function reqSection(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  if (v === undefined) return {};
  if (!isRecord(v)) throw new ConfigError(`config key "${key}" must be an object`, key);
  return v;
}

function nestedInt(section: Record<string, unknown>, key: string, path: string, fallback: number, min: number, max: number): number {
  const v = section[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ConfigError(`config key "${path}" must be an integer`, path);
  }
  if (v < min || v > max) throw new ConfigError(`config key "${path}" must be between ${min} and ${max}`, path);
  return v;
}

/**
 * Validate a parsed `config.json` body against the defaults. Unknown keys — top level
 * and inside every known section — are preserved verbatim.
 */
export function validateConfig(input: unknown): Config {
  if (input === undefined || input === null) return defaultConfig();
  if (!isRecord(input)) throw new ConfigError('config must be a JSON object');
  const raw = input;
  const d = defaultConfig();

  const thresholdsRaw = reqSection(raw, 'thresholds');
  const warn = nestedInt(thresholdsRaw, 'warn', 'thresholds.warn', d.thresholds.warn, 0, 100);
  const critical = nestedInt(thresholdsRaw, 'critical', 'thresholds.critical', d.thresholds.critical, 0, 100);
  if (warn > critical) {
    throw new ConfigError('config key "thresholds.warn" must not exceed "thresholds.critical"', 'thresholds.warn');
  }

  const bindRaw = raw['bind'];
  let bind = d.bind;
  if (bindRaw !== undefined) {
    if (!Array.isArray(bindRaw)) throw new ConfigError('config key "bind" must be an array of strings', 'bind');
    bind = bindRaw.map((entry, i) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new ConfigError(`config key "bind[${i}]" must be a non-empty string`, `bind[${i}]`);
      }
      return entry;
    });
    if (bind.length === 0) throw new ConfigError('config key "bind" must list at least one address', 'bind');
  }

  const integrationsRaw = reqSection(raw, 'integrations');
  const authRaw = reqSection(raw, 'auth');
  const autoUpdateRaw = reqSection(raw, 'autoUpdate');
  const eventsRaw = reqSection(raw, 'events');
  const tlsRaw = reqSection(raw, 'tls');

  const config: Config = {
    ...raw,
    name: reqString(raw, 'name', 'name', d.name),
    port: reqInt(raw, 'port', d.port, 0, 65_535),
    bind,
    auth: { ...authRaw, token: reqString(authRaw, 'token', 'auth.token', d.auth.token, true) },
    pollIntervalMs: reqInt(raw, 'pollIntervalMs', d.pollIntervalMs, 1_000, 86_400_000),
    thresholds: { ...thresholdsRaw, warn, critical },
    hookDebounceMinutes: reqInt(raw, 'hookDebounceMinutes', d.hookDebounceMinutes, 0, 1_440),
    retentionDays: reqInt(raw, 'retentionDays', d.retentionDays, 1, 3_650),
    projectsDir: reqString(raw, 'projectsDir', 'projectsDir', d.projectsDir),
    integrations: {
      ...integrationsRaw,
      service: reqBool(integrationsRaw, 'service', 'integrations.service', d.integrations.service),
      hook: reqBool(integrationsRaw, 'hook', 'integrations.hook', d.integrations.hook),
      mcp: reqBool(integrationsRaw, 'mcp', 'integrations.mcp', d.integrations.mcp),
      statusline: reqBool(integrationsRaw, 'statusline', 'integrations.statusline', d.integrations.statusline),
    },
    autoUpdate: {
      ...autoUpdateRaw,
      enabled: reqBool(autoUpdateRaw, 'enabled', 'autoUpdate.enabled', d.autoUpdate.enabled),
      intervalMs: nestedInt(autoUpdateRaw, 'intervalMs', 'autoUpdate.intervalMs', d.autoUpdate.intervalMs, 1_000, 86_400_000),
      repo: renamedRepo(reqString(autoUpdateRaw, 'repo', 'autoUpdate.repo', d.autoUpdate.repo)),
    },
    events: {
      ...eventsRaw,
      maxClients: nestedInt(eventsRaw, 'maxClients', 'events.maxClients', d.events.maxClients, 1, 4_096),
    },
    tls: {
      ...tlsRaw,
      port: tlsRaw['port'] === undefined || tlsRaw['port'] === null ? null : nestedInt(tlsRaw, 'port', 'tls.port', 0, 0, 65_535),
      loopback: reqBool(tlsRaw, 'loopback', 'tls.loopback', d.tls.loopback),
    },
    allowPublicBind: reqBool(raw, 'allowPublicBind', 'allowPublicBind', d.allowPublicBind),
  };
  // §23.45: HTTPS needs a port of its own.
  if (config.tls.port !== null && config.port !== 0 && config.tls.port === config.port) {
    throw new ConfigError('config key "tls.port" must differ from "port" — HTTP and HTTPS cannot share a port', 'tls.port');
  }
  if (config.tls.port === null && config.port === 65_535) {
    throw new ConfigError('config key "tls.port" must be set when "port" is 65535 — the default port + 1 does not exist', 'tls.port');
  }
  return config;
}

/** Load `config.json` from `dir`. Missing file → defaults. */
export function loadConfig(dir: string = resolveConfigDir()): Config {
  const file = configPath(dir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return defaultConfig();
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // §23.62: never the parser's own message — on Node ≥ 20 it quotes the text around the
    // error, which here can be part of `auth.token`.
    throw new ConfigError(`${file} is not valid JSON${jsonErrorPosition(err)}`);
  }
  return validateConfig(parsed);
}

/** Create the config directory with mode 0700 (idempotent). */
export function ensureConfigDir(dir: string = resolveConfigDir()): string {
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  try {
    chmodSync(dir, CONFIG_DIR_MODE);
  } catch {
    // best effort — a pre-existing dir we do not own
  }
  return dir;
}

/**
 * ` (at position N)` from a `JSON.parse` error, or `''` — and nothing else from it: the
 * message itself quotes the input (§23.62).
 */
export function jsonErrorPosition(err: unknown): string {
  const m = /position (\d+)/.exec(err instanceof Error ? err.message : '');
  return m === null ? '' : ` (at position ${m[1] as string})`;
}

/**
 * A temp name nobody can guess, created exclusively (§23.62): another process can neither
 * pre-create it as a symlink nor race us to it.
 */
export function tempNameFor(file: string): string {
  return `${file}.${randomBytes(8).toString('hex')}.tmp`;
}

/** A temp file this old belongs to no write still going on. */
export const TEMP_FILE_MAX_AGE_MS = 60 * 60_000;

/** `<file>.json.<hex>.tmp` (`tempNameFor`) or `state.json.<pid>.tmp` (the spend snapshot). */
const TEMP_FILE = /\.(?:json|pem)\.(?:[0-9a-f]{16}|\d+)\.tmp$/;

/** Remove temp files left by writers that were killed before they could (§23.72). Never throws. */
export function sweepTempFiles(dir: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue;
    try {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) unlinkSync(file);
    } catch {
      // gone already, or not ours to remove
    }
  }
}

/** Atomic write (temp file in the same directory + rename) at `mode`, default 0600. */
export function writeFileAtomic(file: string, contents: string, mode: number = CONFIG_FILE_MODE): void {
  const tmp = tempNameFor(file);
  try {
    writeFileSync(tmp, contents, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

/** Write JSON atomically at 0600, creating the parent directory at 0700. */
export function writeJsonFile(file: string, value: unknown, mode: number = CONFIG_FILE_MODE): void {
  ensureConfigDir(dirname(file));
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Persist config atomically: dir 0700, file 0600 (§23.2). */
export function saveConfig(config: Config, dir: string = resolveConfigDir()): void {
  ensureConfigDir(dir);
  writeFileAtomic(configPath(dir), `${JSON.stringify(config, null, 2)}\n`, CONFIG_FILE_MODE);
}

/** 32 random bytes, base64url — the §16 bearer token. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Copy of the config with the bearer token redacted, for `/v1/config`. */
export function redactConfig(config: Config): Config {
  const token = config.auth.token;
  return {
    ...config,
    auth: { ...config.auth, token: token.length > 0 ? '<redacted>' : '' },
  };
}

/** The repository's old name. GitHub redirects it, but a saved config is moved to the new one. */
const LEGACY_REPO = 'drmuzikbpn/claude-utilization-mcp';

function renamedRepo(repo: string): string {
  return repo === LEGACY_REPO ? 'drmuzikbpn/usage-deck' : repo;
}
