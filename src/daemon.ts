// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { rmSync } from 'node:fs';
import { createTokenReader } from './credentials/index.js';
import { EventBus } from './events/bus.js';
import { LimitsPoller, effectivePollIntervalMs } from './limits/poller.js';
import { effectiveTlsPort, ensureConfigDir, expandHome, generateToken, loadConfig, resolveConfigDir, saveConfig, sweepTempFiles, writeJsonFile, type Config } from './config.js';
import { daemonFilePath, isOwnPidAlive, readAuthToken, readDaemonInfo } from './clients/http.js';
import { bindWants, LAN_KEYWORD, resolveBindAddresses, TAILSCALE_KEYWORD } from './net/bind.js';
import { resolveLanIPv4, resolveLocalHostName } from './net/lan.js';
import { resolveMagicDnsName, resolveTailscaleIPv4 } from './net/tailscale.js';
import { loadOrCreateTlsIdentity, type TlsIdentity } from './net/tls.js';
import { installCrashHandlers } from './crash.js';
import type { FreezeDeps } from './pause/freeze.js';
import { isLoopbackAddress } from './server/middleware.js';
import { startBusPublishers } from './server/events.js';
import { createSessionsSubsystem, type SessionsSubsystem } from './sessions/index.js';
import { createServer, type UsageServer } from './server/index.js';
import { orderPairingAddrs } from './server/pairing.js';
import { defaultInstallPaths, type InstallPaths } from './server/install-state.js';
import type { TokensSource } from './server/types.js';
import { createUpdater, defaultRestart, type UpdaterHandle } from './update/index.js';
import { getVersion } from './version.js';

/**
 * The network questions the daemon asks at startup and again on `SIGHUP` (§16, §23.44).
 * Injected in tests so nothing ever shells out to `tailscale` or `scutil`. The two LAN
 * questions are optional so a tailnet-only fake need not answer them; they are only asked
 * when `bind` contains `lan`, and fall back to the real lookups.
 */
export interface NetworkResolver {
  tailscaleIPv4(): Promise<string | null>;
  magicDnsName(): Promise<string | null>;
  lanIPv4?(): Promise<string | null>;
  localHostName?(): Promise<string | null>;
}

/**
 * How often to re-look for a tailnet address we want but do not have (§23.21). Only runs
 * while one is missing, so the steady-state cost is zero.
 */
export const TAILNET_RETRY_MS = 60_000;
/**
 * Cap for the tailnet retry backoff. Tailscale that is switched off on purpose is the
 * common case, not an emergency: `tailscale ip -4` still reports the last-known address, so
 * the resolve keeps succeeding and the bind keeps failing. Backing off to ten minutes keeps
 * a deliberately-offline machine from costing a subprocess a minute for ever.
 */
export const TAILNET_RETRY_MAX_MS = 600_000;
/**
 * How often the interface table is re-read while `bind` contains `lan` (§23.44). A Wi-Fi
 * change moves the LAN address; this is how the daemon follows it with nobody sending SIGHUP.
 * `os.networkInterfaces()` only — no subprocess — so the steady-state cost is negligible.
 */
export const LAN_WATCH_MS = 30_000;

/**
 * §23.45: which addresses get an HTTPS listener — every non-loopback one, and loopback too
 * only when `tls.loopback` asks (tests and the iOS contract job).
 */
export function wantsTls(host: string, loopback: boolean): boolean {
  return loopback || !isLoopbackAddress(host);
}

/**
 * §23.57: which addresses get a plain-HTTP listener — loopback, and nothing else. Anything
 * that leaves this machine is HTTPS with the pinned certificate or it is not served at all.
 */
export function wantsHttp(host: string): boolean {
  return isLoopbackAddress(host);
}

/** The loopback address the local clients (hook, CLI, MCP server) always use. */
export const LOCAL_HTTP_ADDRESS = '127.0.0.1';

/**
 * §23.57: the listeners for a resolved `bind` list. `127.0.0.1` is always first and always
 * plain HTTP, because every local client talks to it whatever `bind` says.
 */
export function planListeners(addresses: readonly string[], tlsLoopback: boolean): { http: string[]; tls: string[] } {
  const http = [LOCAL_HTTP_ADDRESS, ...addresses.filter((a) => wantsHttp(a) && a !== LOCAL_HTTP_ADDRESS)];
  const all = [...http, ...addresses.filter((a) => !wantsHttp(a))];
  return { http, tls: all.filter((a) => wantsTls(a, tlsLoopback)) };
}

export function defaultNetworkResolver(): NetworkResolver {
  return {
    tailscaleIPv4: () => resolveTailscaleIPv4(),
    magicDnsName: () => resolveMagicDnsName(),
    lanIPv4: () => Promise.resolve(resolveLanIPv4()),
    localHostName: () => resolveLocalHostName(),
  };
}

export interface DaemonOptions {
  configDir?: string;
  /** Pre-loaded config; otherwise read from `configDir`. */
  config?: Config;
  /** How often to retry a missing tailnet bind (§23.21); defaults to `TAILNET_RETRY_MS`. */
  tailnetRetryMs?: number;
  /** Ceiling for the retry backoff; defaults to `TAILNET_RETRY_MAX_MS`. */
  tailnetRetryMaxMs?: number;
  /** Interface-table re-read interval while `bind` contains `lan` (§23.44); `LAN_WATCH_MS`. */
  lanWatchMs?: number;
  /**
   * The token store. Pass it explicitly (tests, and the orchestrator once W1 lands);
   * omit to let `createTokensSource` try the real `src/spend` module.
   */
  tokens?: TokensSource | null;
  createTokensSource?: (config: Config) => Promise<TokensSource | null>;
  verbose?: boolean;
  log?: (line: string) => void;
  version?: string;
  /** Start the limits poller (off in tests that do not want network timers). */
  poll?: boolean;
  port?: number;
  /** W3: shared event bus; created here when omitted. */
  bus?: EventBus;
  /** W3: start the sessions/pause subsystem (default `true`). */
  sessions?: boolean;
  /** W5: tailnet resolution seam (§16). */
  network?: NetworkResolver;
  /** §23.48: where `/health.install` looks; defaults to the real `~/.claude` paths. */
  install?: InstallPaths;
  /** W8: the auto-updater. Pass one to inject fakes; `null` leaves `/health.update` disabled. */
  updater?: UpdaterHandle | null;
  /** Process-table seam for the sessions subsystem (tests); the real one otherwise. */
  freezeDeps?: FreezeDeps;
}

export interface DaemonHandle {
  readonly port: number;
  readonly config: Config;
  readonly configDir: string;
  readonly server: UsageServer;
  readonly poller: LimitsPoller;
  /** Shared bus: `/v1/events` streams it, the daemon and W3 publish onto it (§19). */
  readonly bus: EventBus;
  readonly sessions: SessionsSubsystem | null;
  /** W8: the auto-updater feeding `/health.update`, or `null` when none runs (§20). */
  readonly updater: UpdaterHandle | null;
  /** The addresses currently listened on, in bind order. */
  readonly addresses: readonly string[];
  /** The MagicDNS name currently accepted in `Host`, or `null`. */
  readonly magicDnsName: string | null;
  /** The `.local` name currently accepted in `Host` while `bind` has `lan` (§23.46), or `null`. */
  readonly localHostName: string | null;
  /** The HTTPS port, or `null` while no HTTPS listener is up (§23.45). */
  readonly tlsPort: number | null;
  /** The pinned SPKI fingerprint, or `null` when this daemon has no TLS identity (§23.45). */
  readonly fingerprint: string | null;
  /** `SIGHUP`: re-resolve the keyword addresses and Host names, re-bind what changed (§16). */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

/** Thrown when the configured port is already taken (§6 → exit 1). */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`port ${port} is already in use — another claude-usage daemon may be running`);
    this.name = 'PortInUseError';
    this.port = port;
  }
}

/** Build the real token store (§23.7: the store owns watcher-before-scan ordering). */
async function loadSpendStore(config: Config, configDir: string, log: (line: string) => void): Promise<TokensSource | null> {
  try {
    const { createSpendTokensSource } = await import('./spend/adapter.js');
    const store = createSpendTokensSource({
      projectsDir: expandHome(config.projectsDir),
      stateDir: configDir,
      onError: (err: unknown) => log(`spend: ${(err as Error).message ?? String(err)}`),
    });
    await store.start();
    return store;
  } catch (err) {
    log(`spend: store unavailable (${(err as Error).message}) — /v1/tokens will report ready:false`);
    return null;
  }
}

/**
 * Start the daemon (§6).
 *
 * Order: load config → start HTTP (so `/v1/limits` answers immediately) → start the
 * poller → attach the token store (its own watcher-before-scan ordering, §23.7).
 * Writes `daemon.json` 0600 once the port is known.
 */
export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const configDir = opts.configDir ?? resolveConfigDir();
  const verbose = opts.verbose ?? false;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const debug = (line: string): void => {
    if (verbose) log(line);
  };
  const version = opts.version ?? getVersion();

  const config = opts.config ?? loadConfig(configDir);
  ensureConfigDir(configDir);
  debug(`config: loaded from ${configDir}`);
  // §23.55: every request needs the bearer, so a daemon with none would answer nothing —
  // not even its own hooks. `install` mints one; a bare `serve` on a fresh machine does too.
  if (opts.config === undefined && config.auth.token.length === 0) {
    config.auth = { ...config.auth, token: generateToken() };
    saveConfig(config, configDir);
    log('auth: generated a bearer token (config.json, mode 0600)');
  }

  const poller = new LimitsPoller({
    getToken: createTokenReader(),
    intervalMs: effectivePollIntervalMs(config.pollIntervalMs),
    notice: log,
    // Serve the last good numbers straight away rather than an empty list until the first
    // poll lands — which matters now that auto-update restarts the daemon regularly, and
    // more still when that first poll comes back 429 (§23.19).
    configDir,
    log: debug,
  });

  // One bus per daemon: the SSE endpoint consumes it, sessions/pause + the daemon publish onto it (§19).
  const bus = opts.bus ?? new EventBus();
  let tokensSource: TokensSource | null = opts.tokens ?? null;
  // W3: sessions/pause subsystem — loads sessions.json / pause.json, runs the §18.3 orphan sweep,
  // starts the 15 s liveness timer. Token source is attached once the store is ready (below).
  const sessions =
    opts.sessions === false
      ? null
      : createSessionsSubsystem({
          configDir,
          bus,
          tokens: tokensSource,
          // §23.56: a transcript path is only believed inside the directory Claude Code writes them to.
          transcriptRoots: [expandHome(config.projectsDir)],
          ...(opts.freezeDeps === undefined ? {} : { freezeDeps: opts.freezeDeps }),
        });
  sessions?.start();
  try {
    return await bringUp();
  } catch (err) {
    // §23.56: the startup sweep above may already have stopped processes. A daemon that
    // then fails to come up — port taken, bad bind — must not leave them stopped.
    sessions?.stop();
    throw err;
  }

  async function bringUp(): Promise<DaemonHandle> {
    // §23.61: a daemon.json left by a daemon that died must not outlive this start attempt,
    // even if the bind below fails. One whose process is alive and ours is left alone — it
    // is the daemon that holds the port, and its clients still need the file.
    const recorded = readDaemonInfo(configDir);
    if (recorded !== null && !isOwnPidAlive(recorded.pid)) {
      try {
        rmSync(daemonFilePath(configDir), { force: true });
      } catch {
        // best effort
      }
    }

    // --- §16: which addresses, and under which Host names ----------------------
    const network = opts.network ?? defaultNetworkResolver();
    // The MagicDNS name only matters when we are actually reachable over the tailnet, so a
    // loopback-only daemon never shells out to `tailscale` at all. Likewise the `.local` name
    // and the interface watch only exist when `bind` asks for `lan` (§23.44).
    const wantsTailnet = bindWants(config.bind, TAILSCALE_KEYWORD);
    const wantsLan = bindWants(config.bind, LAN_KEYWORD);
    const wantedKeywords = [...(wantsTailnet ? [TAILSCALE_KEYWORD] : []), ...(wantsLan ? [LAN_KEYWORD] : [])];
    const lanIPv4 = network.lanIPv4?.bind(network) ?? (() => Promise.resolve(resolveLanIPv4()));
    const localHostNameOf = network.localHostName?.bind(network) ?? (() => resolveLocalHostName());
    /**
     * The address each keyword's resolver last handed back, recorded as it goes past. Asking
     * "is the keyword's address listening?" needs both halves — whether one was found at all,
     * and whether the bind for it took — and only this callback sees the first (§23.21).
     */
    const keywordAddress = new Map<string, string | null>();
    /** Hosts with an HTTPS listener (§23.45). Declared here, ahead of every closure that reads it. */
    const tlsHosts = new Set<string>();
    /**
     * Every wanted keyword resolved to an address *and* we are listening on it — over HTTPS too
     * when that address should have it, so a failed TLS bind keeps the retry going (§23.45).
     */
    const keywordsBound = (): boolean =>
      wantedKeywords.every((k) => {
        const a = keywordAddress.get(k) ?? null;
        if (a === null) return false;
        // §23.57: a non-loopback address is served over HTTPS or not at all.
        if (wantsHttp(a) && !boundHosts.includes(a)) return false;
        return !wantsTls(a, tlsLoopback) || tlsHosts.has(a);
      });
    const resolveTailscale = async (): Promise<string | null> => {
      const a = await network.tailscaleIPv4();
      keywordAddress.set(TAILSCALE_KEYWORD, a);
      return a;
    };
    const resolveLan = async (): Promise<string | null> => {
      const a = await lanIPv4();
      keywordAddress.set(LAN_KEYWORD, a);
      return a;
    };
    const resolvers = { resolveTailscale, resolveLan, log, allowPublicBind: config.allowPublicBind };
    const addresses = await resolveBindAddresses(config.bind, resolvers);
    let magicDnsName = wantsTailnet ? await network.magicDnsName() : null;
    if (magicDnsName !== null) debug(`net: MagicDNS name ${magicDnsName}`);
    let localHostName = wantsLan ? await localHostNameOf() : null;
    if (localHostName !== null) debug(`net: local name ${localHostName}`);
    const hostNames = (): string[] => [magicDnsName, localHostName].filter((n): n is string => n !== null);

    // --- §23.45: the TLS identity, only when some listener could want it ----------
    const tlsLoopback = config.tls.loopback;
    const mayNeedTls =
      tlsLoopback ||
      config.bind.some((entry) => {
        const e = entry.trim().toLowerCase();
        return e === TAILSCALE_KEYWORD || e === LAN_KEYWORD || !isLoopbackAddress(e);
      });
    let tlsIdentity: TlsIdentity | null = null;
    if (mayNeedTls) {
      try {
        tlsIdentity = loadOrCreateTlsIdentity({ configDir, name: config.name, localHostName });
        if (tlsIdentity.created) log('tls: generated a new key — apps paired with an earlier key must pair again');
        else if (tlsIdentity.reissued) debug('tls: certificate re-issued for the existing key');
      } catch (err) {
        log(`tls: no HTTPS listeners — ${(err as Error).message}`);
      }
    }

    // --- §20: the auto-updater ------------------------------------------------
    // Built before the server so `/health.update` reads live state from the first
    // request; started after the listener is up so the first check never races boot.
    // `stopEverything` is filled in below — the updater restarts the process, and a
    // restart must run the same shutdown path as SIGTERM (SIGCONT'd pids, daemon.json).
    let stopEverything: () => Promise<void> = async () => {};
    const updater =
      opts.updater === undefined
        ? createUpdater({
            config,
            currentVersion: version,
            bus,
            log,
            debug,
            // §20: a hard freeze blocks the restart, so it blocks the update.
            hardFrozen: () => sessions?.registry.list().some((s) => s.pause?.mode === 'hard') ?? false,
            restart: async () => {
              await stopEverything();
              // Ask the supervisor, then exit non-zero — `defaultRestart` is the shared
              // implementation of both halves (§23.18). The exit alone is not enough: a
              // LaunchAgent bootstrapped from a non-GUI session never acts on it, and the
              // daemon that updated itself simply never came back (§23.20).
              await defaultRestart(process.env);
            },
          })
        : opts.updater;

    const server = createServer({
      config,
      limits: poller,
      tokens: tokensSource,
      ...(updater === null ? {} : { update: () => updater.status() }),
      version,
      bus,
      sessions,
      extraHostNames: hostNames(),
      install: opts.install ?? defaultInstallPaths(),
      log,
      tls: tlsIdentity === null ? null : { key: tlsIdentity.key, cert: tlsIdentity.cert },
      // §23.47: what `POST /v1/pair/code` offers. Read per request, so it follows rebinds.
      pairing: {
        info: () => ({
          addrs: orderPairingAddrs([...tlsHosts], {
            lan: keywordAddress.get(LAN_KEYWORD) ?? null,
            tailnet: keywordAddress.get(TAILSCALE_KEYWORD) ?? null,
            localHostName,
          }),
          port: server.tlsPort,
          fp: tlsIdentity?.fingerprint ?? null,
        }),
      },
      // §19: SSE snapshot carries the live sessions + pause rules.
      ...(sessions ? { snapshots: { sessions: () => sessions.registry.list(), rules: () => sessions.rules.list() } } : {}),
    });

    const port = opts.port ?? config.port;
    const boundHosts: string[] = [];
    /**
     * Bind failures already reported, so the §23.21 retry does not repeat the same line every
     * time it looks. Cleared for a host once it binds, so a later failure is reported again.
     */
    const reportedBindFailures = new Set<string>();
    function logBindFailure(host: string, port: number, err: unknown, scheme = 'http'): void {
      const line = `${scheme}: could not bind ${host}:${String(port)} — ${(err as Error).message}`;
      if (reportedBindFailures.has(line)) return;
      reportedBindFailures.add(line);
      log(line);
    }
    // The first address decides the port and is fatal if it cannot be bound; every further
    // address is best-effort, because a tailnet that is down must not stop the daemon (§16).
    // §23.57: plain HTTP is for loopback only; the rest of `bind` is reached over HTTPS below.
    const plan = planListeners(addresses, tlsLoopback);
    /** Non-loopback addresses we are asked to serve; each has an HTTPS listener or nothing. */
    const remoteHosts: string[] = addresses.filter((a) => !wantsHttp(a));
    if (remoteHosts.length > 0 && tlsIdentity === null) {
      log(`net: not listening on ${remoteHosts.join(', ')} — there is no TLS identity, and plain HTTP never leaves this machine`);
    }
    const [primary, ...secondary] = plan.http as [string, ...string[]];
    let bound: number;
    try {
      bound = await server.listen(port, [primary]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(port);
      throw err;
    }
    boundHosts.push(primary);

    for (const host of secondary) {
      try {
        await server.bind(host, bound);
        boundHosts.push(host);
      } catch (err) {
        // A loopback alias that is taken means the port itself is contested — still fatal.
        if (isLoopbackAddress(host) && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          await server.close();
          throw new PortInUseError(bound);
        }
        logBindFailure(host, bound, err);
      }
    }
    debug(`http: listening on ${boundHosts.map((h) => `${h}:${bound}`).join(', ')}`);

    /** §23.45: the HTTPS port asked for; once one TLS listener is up, the rest share its port. */
    const requestedTlsPort = effectiveTlsPort(config, port);
    /** Adds `host` to `tlsHosts`. Best-effort, like every secondary HTTP bind. */
    async function bindTls(host: string): Promise<void> {
      if (tlsIdentity === null || !wantsTls(host, tlsLoopback) || tlsHosts.has(host)) return;
      const target = server.tlsPort ?? requestedTlsPort;
      try {
        const actual = await server.bind(host, target, { tls: true });
        tlsHosts.add(host);
        debug(`https: listening on ${host}:${actual}`);
      } catch (err) {
        logBindFailure(host, target, err, 'https');
      }
    }
    for (const host of [...boundHosts, ...remoteHosts]) await bindTls(host);

    const startedAtIso = new Date().toISOString();
    let recordedTlsPort: number | null = server.tlsPort;
    const writeDaemonFile = (): void => {
      recordedTlsPort = server.tlsPort;
      writeJsonFile(daemonFilePath(configDir), {
        pid: process.pid,
        port: bound,
        tlsPort: recordedTlsPort,
        startedAt: startedAtIso,
        version,
      });
    };
    writeDaemonFile();
    sweepTempFiles(configDir);

    if (opts.poll !== false) {
      poller.start();
      if (poller.intervalMs !== config.pollIntervalMs) {
        log(`limits: pollIntervalMs ${config.pollIntervalMs} is below the floor — polling every ${poller.intervalMs}ms`);
      }
      debug(`limits: polling every ${poller.intervalMs}ms`);
    }

    // §20: disables itself when `autoUpdate.enabled` is false or we are not running out
    // of the `current` symlink, and schedules nothing in that case.
    updater?.start();

    // Token store last: HTTP is already answering, and the store reports ready:false
    // until its initial scan finishes.
    if (opts.tokens === undefined) {
      const make = opts.createTokensSource ?? ((c: Config) => loadSpendStore(c, configDir, debug));
      const source = await make(config);
      if (source !== null) {
        server.setTokensSource(source);
        sessions?.setTokensSource(source);
        tokensSource = source;
        debug('spend: store attached');
      }
    }

    // W4: feed the bus — `limits` on every poll that changed something, machine-wide
    // `spend` on every token-store change, coalesced to at most one per second (§19).
    const stopPublishers = startBusPublishers({ bus, limits: poller, tokens: () => tokensSource });

    let stopped = false;

    /**
     * `SIGHUP` (§16): the keyword addresses and Host names can appear, change or vanish while
     * the daemon runs. Re-resolve them, bind whatever is newly available, drop what is gone —
     * and never let any of it be fatal. Of `config.json`, only `auth.token` is re-read
     * (§23.58). Runs are
     * serialised: SIGHUP, the §23.21 retry and the §23.44 interface watch can all ask at once.
     */
    let reloading: Promise<void> = Promise.resolve();
    function reload(): Promise<void> {
      reloading = reloading.then(reloadOnce, reloadOnce);
      return reloading;
    }
    /**
     * §23.58: `configure rotate-token` writes the new token and signals us. Until this runs
     * the old token keeps working, so it is the first thing a reload does — and every open
     * event stream was authenticated with the old one, so they are all dropped.
     */
    function adoptToken(): void {
      const onDisk = readAuthToken(configDir);
      if (onDisk.length === 0 || onDisk === config.auth.token) return;
      config.auth = { ...config.auth, token: onDisk };
      server.events.close();
      log('auth: bearer token re-read from config.json — devices paired with the old one must pair again');
    }
    async function reloadOnce(): Promise<void> {
      if (stopped) return;
      adoptToken();
      let next: string[];
      try {
        next = await resolveBindAddresses(config.bind, resolvers);
      } catch (err) {
        log(`reload: keeping the current addresses — ${(err as Error).message}`);
        return;
      }
      // stop() may have run while we were resolving: open nothing after it (review fix).
      if (stopped) return;

      for (const host of next) {
        if (stopped) return;
        // §23.57: only loopback gets plain HTTP.
        if (!wantsHttp(host)) {
          if (!remoteHosts.includes(host)) remoteHosts.push(host);
          continue;
        }
        if (boundHosts.includes(host)) continue;
        try {
          await server.bind(host, bound);
          boundHosts.push(host);
          reportedBindFailures.clear();
          log(`http: now also listening on ${host}:${bound}`);
        } catch (err) {
          logBindFailure(host, bound, err);
        }
      }

      for (const host of [...boundHosts]) {
        // The local clients' address stays whatever `bind` resolves to.
        if (next.includes(host) || host === LOCAL_HTTP_ADDRESS) continue;
        await server.unbind(host);
        boundHosts.splice(boundHosts.indexOf(host), 1);
        tlsHosts.delete(host);
        log(`http: stopped listening on ${host}:${bound}`);
      }
      for (const host of [...remoteHosts]) {
        if (next.includes(host)) continue;
        remoteHosts.splice(remoteHosts.indexOf(host), 1);
        if (!tlsHosts.has(host)) continue;
        await server.unbind(host);
        tlsHosts.delete(host);
        log(`https: stopped listening on ${host}`);
      }

      // New hosts get their HTTPS listener, and an earlier failure gets another try.
      for (const host of [...boundHosts, ...remoteHosts]) {
        if (stopped) return;
        const had = tlsHosts.has(host);
        await bindTls(host);
        if (!had && tlsHosts.has(host)) {
          reportedBindFailures.clear();
          if (!wantsHttp(host)) log(`https: now also listening on ${host}:${String(server.tlsPort)}`);
        }
      }
      if (stopped) return;
      if (server.tlsPort !== recordedTlsPort) writeDaemonFile();

      const magic = wantsTailnet ? await network.magicDnsName() : null;
      const local = wantsLan ? await localHostNameOf() : null;
      if (stopped) return;
      if (magic !== magicDnsName) {
        log(magic === null ? 'net: MagicDNS name is no longer available' : `net: MagicDNS name is now ${magic}`);
      }
      if (local !== localHostName) {
        log(local === null ? 'net: local name is no longer available' : `net: local name is now ${local}`);
      }
      if (magic !== magicDnsName || local !== localHostName) {
        magicDnsName = magic;
        localHostName = local;
        server.setExtraHostNames(hostNames());
      }
    }

    /**
     * Retry the keyword binds until they take (§23.21, generalised by §23.44).
     *
     * Keyword addresses are resolved once at startup, and on a machine where Tailscale
     * starts *after* the daemon — or is down at boot — that resolve fails and nothing ever
     * tries again: a test machine logged `could not bind <its tailnet address> — EADDRNOTAVAIL` and
     * then served loopback and LAN only, with no tailnet listener, indefinitely. `SIGHUP`
     * fixes it, but only if a human knows to send one, and the whole point of the tailnet
     * address is to be reachable when nobody is at the machine. A laptop that boots before
     * joining Wi-Fi has the same problem with `lan`.
     *
     * So: while a wanted address is missing, re-resolve on a timer. Once everything is bound
     * the timer stops and `SIGHUP` (plus the LAN watch) takes over, so the steady-state cost
     * is zero.
     */
    let tailnetRetry: ReturnType<typeof setTimeout> | null = null;
    let tailnetRetryMs = opts.tailnetRetryMs ?? TAILNET_RETRY_MS;
    const tailnetRetryMaxMs = Math.max(tailnetRetryMs, opts.tailnetRetryMaxMs ?? TAILNET_RETRY_MAX_MS);
    function scheduleTailnetRetry(): void {
      if (stopped || wantedKeywords.length === 0 || keywordsBound() || tailnetRetry !== null) return;
      tailnetRetry = setTimeout(() => {
        tailnetRetry = null;
        void (async () => {
          if (stopped) return;
          await reload().catch(() => undefined);
          if (keywordsBound()) {
            log(`net: ${wantedKeywords.join(' and ')} address now available`);
            tailnetRetryMs = opts.tailnetRetryMs ?? TAILNET_RETRY_MS;
            return;
          }
          tailnetRetryMs = Math.min(tailnetRetryMs * 2, tailnetRetryMaxMs);
          scheduleTailnetRetry();
        })();
      }, tailnetRetryMs);
      tailnetRetry.unref();
    }

    /**
     * §23.44: follow the LAN address across network changes. Each tick re-reads the interface
     * table; a different answer than the one bound triggers `reload()`, after which the retry
     * covers the case where the new address cannot be bound yet.
     */
    let lanWatch: ReturnType<typeof setInterval> | null = null;
    if (wantsLan) {
      lanWatch = setInterval(() => {
        void (async () => {
          if (stopped) return;
          const current = await lanIPv4().catch(() => null);
          if (current === (keywordAddress.get(LAN_KEYWORD) ?? null)) return;
          log(`net: LAN address changed to ${current ?? 'none'} — rebinding`);
          await reload().catch(() => undefined);
          scheduleTailnetRetry();
        })();
      }, opts.lanWatchMs ?? LAN_WATCH_MS);
      lanWatch.unref();
    }

    async function stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (tailnetRetry !== null) {
        clearTimeout(tailnetRetry);
        tailnetRetry = null;
      }
      if (lanWatch !== null) {
        clearInterval(lanWatch);
        lanWatch = null;
      }
      // §18.3: SIGCONT every hard-frozen pid before anything else shuts down.
      sessions?.stop();
      updater?.stop();
      stopPublishers();
      poller.stop();
      // A reload in flight must finish (it re-checks `stopped` after every await) before the
      // listeners close, or it could re-open one behind close() and hold the process up.
      await reloading.catch(() => undefined);
      await server.close();
      try {
        rmSync(daemonFilePath(configDir), { force: true });
      } catch {
        // best effort
      }
      debug('daemon: stopped');
    }
    stopEverything = stop;

    // Tailscale or Wi-Fi may not be up yet — keep trying rather than serving loopback for ever (§23.21).
    if (wantedKeywords.length > 0 && !keywordsBound()) {
      log(`net: no ${wantedKeywords.join('/')} address bound yet — will keep looking`);
      scheduleTailnetRetry();
    }

    return {
      port: bound,
      config,
      configDir,
      server,
      poller,
      bus,
      sessions,
      updater,
      get addresses() {
        // Loopback (HTTP) first, then whatever is being served over HTTPS only (§23.57).
        return [...boundHosts, ...remoteHosts.filter((h) => tlsHosts.has(h))];
      },
      get magicDnsName() {
        return magicDnsName;
      },
      get localHostName() {
        return localHostName;
      },
      get tlsPort() {
        return server.tlsPort;
      },
      fingerprint: tlsIdentity?.fingerprint ?? null,
      reload,
      stop,
    };
  }
}

/**
 * `claude-usage serve` — start and keep running until SIGTERM/SIGINT, then flush,
 * remove `daemon.json` and exit 0. Port in use → exit 1 with a clear message.
 */
export async function serve(opts: DaemonOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let handle: DaemonHandle | null = null;
  // §23.56: installed before anything is started, so it also covers a crash during startup.
  const uninstall = installCrashHandlers({
    configDir: opts.configDir ?? resolveConfigDir(),
    thawLive: () => {
      handle?.sessions?.pause.thawEverything();
    },
    log,
  });
  try {
    return await run();
  } finally {
    uninstall();
  }

  async function run(): Promise<number> {
  let h: DaemonHandle;
  try {
    h = await startDaemon(opts);
    handle = h;
  } catch (err) {
    if (err instanceof PortInUseError) {
      log(`claude-usage: ${err.message}`);
      return 1;
    }
    log(`claude-usage: failed to start — ${(err as Error).message}`);
    return 1;
  }

  for (const listener of h.server.listeners.filter((l) => !l.tls)) {
    const host = listener.addr.includes(':') ? `[${listener.addr}]` : listener.addr;
    log(`claude-usage ${h.config.name} listening on http://${host}:${listener.port}`);
  }
  for (const listener of h.server.listeners.filter((l) => l.tls)) {
    const host = listener.addr.includes(':') ? `[${listener.addr}]` : listener.addr;
    log(`claude-usage ${h.config.name} listening on https://${host}:${listener.port}`);
  }

  // §16: re-resolve the tailnet on SIGHUP; a reload never brings the daemon down.
  const reload = (): void => {
    log('claude-usage: SIGHUP received, re-resolving network addresses');
    void h.reload().catch((err: unknown) => {
      log(`claude-usage: reload failed — ${(err as Error).message}`);
    });
  };
  process.on('SIGHUP', reload);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      log(`claude-usage: ${signal} received, shutting down`);
      process.removeListener('SIGHUP', reload);
      void h.stop().then(resolve, resolve);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
  return 0;
  }
}
