// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { saveConfig, defaultConfig } from '../../src/config.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planListeners, serve, startDaemon, PortInUseError, wantsHttp, wantsTls, type DaemonHandle, type DaemonOptions, type NetworkResolver } from '../../src/daemon.js';
import { FakeTokensSource } from '../helpers/fakes.js';
import { tempConfigDir } from '../helpers/fake-daemon.js';
import { rawRequest } from '../helpers/raw-request.js';
import { SIGTERM_EXIT_CODE } from '../../src/service/index.js';

const MAGIC_DNS = 'adams-mbp.tail1234.ts.net';
const handles: DaemonHandle[] = [];
const sockets: NetServer[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.stop();
  }
  while (sockets.length > 0) {
    const s = sockets.pop();
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A resolver whose answers can change between SIGHUPs. */
class FakeNetwork implements NetworkResolver {
  ip: string | null = null;
  dns: string | null = null;
  calls = { ip: 0, dns: 0 };
  async tailscaleIPv4(): Promise<string | null> {
    this.calls.ip += 1;
    return this.ip;
  }
  async magicDnsName(): Promise<string | null> {
    this.calls.dns += 1;
    return this.dns;
  }
}

/**
 * An address that is not on this machine and that the bind policy still allows (§23.57):
 * link-local, which nothing assigns unless DHCP has failed.
 */
const UNROUTABLE = '169.254.201.77'; // public-check:allow
/** §23.57: the only listener a non-loopback address ever gets is HTTPS. */
const HTTPS_BIND_FAILED = new RegExp(`https: could not bind ${UNROUTABLE.replaceAll('.', '\\.')}`);
const HTTP_BIND_ATTEMPT = new RegExp(`http: (could not bind|now also listening on) ${UNROUTABLE.replaceAll('.', '\\.')}`);

async function start(bind: string[], network: NetworkResolver, over: DaemonOptions = {}): Promise<DaemonHandle> {
  const configDir = tempConfigDir();
  const h = await startDaemon({
    configDir,
    config: { ...defaultConfig(), bind, auth: { token: 'test-bearer-token' } },
    port: 0,
    poll: false,
    sessions: false,
    tokens: new FakeTokensSource(),
    version: '9.9.9',
    network,
    log: () => undefined,
    ...over,
  });
  handles.push(h);
  return h;
}

describe('startDaemon binding (§16)', () => {
  it('binds loopback only and never asks Tailscale anything', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1'], net);
    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(net.calls).toEqual({ ip: 0, dns: 0 });
    expect(h.magicDnsName).toBeNull();
  });

  it('resolves the tailscale keyword and allows its MagicDNS Host', async () => {
    const net = new FakeNetwork();
    net.ip = '127.0.0.1'; // stands in for the tailnet address: bindable in a test
    net.dns = MAGIC_DNS;
    const h = await start(['tailscale'], net);

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(h.magicDnsName).toBe(MAGIC_DNS);
    const res = await rawRequest({ port: h.port, path: '/health', headers: { host: `${MAGIC_DNS}:${h.port}` } });
    expect(res.status).toBe(200);
  });

  it('warns and keeps serving when a non-loopback address cannot be bound', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    net.ip = UNROUTABLE;
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toMatch(HTTPS_BIND_FAILED);
    expect(lines.join('\n')).not.toMatch(HTTP_BIND_ATTEMPT);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
  });

  it('warns and falls back to loopback when there is no tailnet at all', async () => {
    const lines: string[] = [];
    const h = await start(['tailscale'], new FakeNetwork(), { log: (l) => lines.push(l) });
    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toMatch(/no Tailscale IPv4/);
  });

  it('stays fatal when the loopback port is taken', async () => {
    const taken = createNetServer();
    sockets.push(taken);
    const port = await new Promise<number>((resolve) => {
      taken.listen(0, '127.0.0.1', () => {
        const addr = taken.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });

    await expect(start(['127.0.0.1'], new FakeNetwork(), { port })).rejects.toBeInstanceOf(PortInUseError);
  });

  it('rejects an invalid bind entry with a ConfigError naming the key', async () => {
    await expect(start(['127.0.0.1', 'not-an-address'], new FakeNetwork())).rejects.toMatchObject({
      name: 'ConfigError',
      key: 'bind[1]',
    });
  });
});

describe('SIGHUP re-resolution (§16)', () => {
  it('binds a tailnet address that only appeared later, and its MagicDNS name', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    expect(h.addresses).toEqual(['127.0.0.1']);
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(421);

    // The tailnet comes up. `::1` stands in for the new address so the test can bind it.
    net.ip = '::1';
    net.dns = MAGIC_DNS;
    await h.reload();

    expect(h.magicDnsName).toBe(MAGIC_DNS);
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(200);
    if (h.addresses.includes('::1')) {
      expect(lines.join('\n')).toMatch(/now also listening on ::1/);
    }
  });

  it('drops an address that went away and forgets its MagicDNS name', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    net.ip = '::1';
    net.dns = MAGIC_DNS;
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    const hadIpv6 = h.addresses.includes('::1');

    net.ip = null;
    net.dns = null;
    await h.reload();

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(h.magicDnsName).toBeNull();
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: MAGIC_DNS } })).status).toBe(421);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
    if (hadIpv6) expect(lines.join('\n')).toMatch(/stopped listening on ::1/);
  });

  it('is a no-op when nothing changed, and never re-asks a loopback-only daemon', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1'], net);
    await h.reload();
    await h.reload();
    expect(net.calls).toEqual({ ip: 0, dns: 0 });
    expect(h.addresses).toEqual(['127.0.0.1']);
  });

  it('keeps serving when a newly resolved address cannot be bound', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    net.ip = UNROUTABLE;
    await h.reload();

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toMatch(HTTPS_BIND_FAILED);
    expect(lines.join('\n')).not.toMatch(HTTP_BIND_ATTEMPT);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
  });

  it('does nothing after stop()', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1', 'tailscale'], net);
    await h.stop();
    net.ip = '::1';
    await h.reload();
    expect(h.addresses).toEqual(['127.0.0.1']);
  });
});

describe('serve() wiring', () => {
  it('re-resolves on SIGHUP and removes the handler on shutdown', async () => {
    const dir = tempConfigDir();
    saveConfig({ ...defaultConfig(), bind: ['127.0.0.1', 'tailscale'], auth: { token: 'test-bearer-token' } }, dir);
    const net = new FakeNetwork();
    const lines: string[] = [];
    const before = process.listenerCount('SIGHUP');

    const promise = serve({
      configDir: dir,
      port: 0,
      poll: false,
      sessions: false,
      tokens: null,
      network: net,
      log: (l) => lines.push(l),
    });

    for (let i = 0; i < 200 && process.listenerCount('SIGHUP') === before; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);

    net.dns = MAGIC_DNS;
    process.emit('SIGHUP', 'SIGHUP');
    for (let i = 0; i < 200 && net.calls.dns < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(net.calls.dns).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).toMatch(/SIGHUP received/);

    process.emit('SIGTERM', 'SIGTERM');
    expect(await promise).toBe(SIGTERM_EXIT_CODE);
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});

describe('tailnet bind retry (§23.21)', () => {
  it('keeps looking for a tailnet address that is not up yet, with no SIGHUP', async () => {
    // Tailscale is down at boot — the Mac Studio's actual situation. The daemon used to
    // serve loopback for ever and only notice on a SIGHUP nobody was there to send.
    const net = new FakeNetwork();
    net.ip = null;
    const h = await start(['127.0.0.1', 'tailscale'], net, { tailnetRetryMs: 20 });
    expect(h.addresses).toEqual(['127.0.0.1']);

    // Tailscale comes up. `127.0.0.1` stands in for the tailnet address, as elsewhere in
    // this file: macOS aliases no other loopback address, so nothing else is bindable here.
    net.ip = '127.0.0.1';
    net.dns = MAGIC_DNS;
    for (let i = 0; i < 100 && h.magicDnsName === null; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.magicDnsName).toBe(MAGIC_DNS);
    expect(net.calls.ip).toBeGreaterThan(1);
  });

  it('does not poll at all once the tailnet address is bound', async () => {
    const net = new FakeNetwork();
    net.ip = '127.0.0.1';
    const h = await start(['127.0.0.1', 'tailscale'], net, { tailnetRetryMs: 20 });
    expect(h.addresses).toEqual(['127.0.0.1']);
    const after = net.calls.ip;
    await new Promise((r) => setTimeout(r, 120));
    // Steady state is free: SIGHUP takes over once everything we want is listening.
    expect(net.calls.ip).toBe(after);
  });

  it('does not poll when the config never asked for a tailnet address', async () => {
    const net = new FakeNetwork();
    const h = await start(['127.0.0.1'], net, { tailnetRetryMs: 20 });
    const after = net.calls.ip;
    await new Promise((r) => setTimeout(r, 120));
    expect(net.calls.ip).toBe(after);
    expect(h.addresses).toEqual(['127.0.0.1']);
  });
});

describe('a tailnet that is off on purpose (§23.21)', () => {
  it('reports the bind failure once, not once per retry', async () => {
    // `tailscale ip -4` keeps reporting the last-known address after Tailscale is switched
    // off, so the resolve succeeds and the bind fails, every single time. Adam runs both
    // Macs this way, on LAN, deliberately — it must not fill the log.
    const lines: string[] = [];
    const net = new FakeNetwork();
    net.ip = UNROUTABLE;
    await start(['127.0.0.1', 'tailscale'], net, {
      tailnetRetryMs: 10,
      tailnetRetryMaxMs: 10,
      log: (l) => lines.push(l),
    });

    for (let i = 0; i < 60 && net.calls.ip < 4; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(net.calls.ip).toBeGreaterThanOrEqual(4); // it really did keep retrying
    expect(lines.filter((l) => l.includes('could not bind'))).toHaveLength(1);
  });

  it('backs off so a permanently-offline tailnet costs almost nothing', async () => {
    const net = new FakeNetwork();
    net.ip = UNROUTABLE;
    await start(['127.0.0.1', 'tailscale'], net, { tailnetRetryMs: 10, tailnetRetryMaxMs: 40, log: () => undefined });
    await new Promise((r) => setTimeout(r, 300));
    // Without backoff, 300ms at a 10ms interval would be ~30 attempts.
    expect(net.calls.ip).toBeLessThan(15);
  });
});

/** A resolver that also answers the §23.44 LAN questions. */
class FakeLanNetwork extends FakeNetwork {
  lan: string | null = null;
  local: string | null = null;
  lanCalls = 0;
  /** When set, every lookup runs this first — lets a test hold a reload mid-resolve. */
  beforeLan: (() => Promise<void>) | null = null;
  async lanIPv4(): Promise<string | null> {
    this.lanCalls += 1;
    if (this.beforeLan !== null) await this.beforeLan();
    return this.lan;
  }
  async localHostName(): Promise<string | null> {
    return this.local;
  }
}

async function until(cond: () => boolean, tries = 100, ms = 10): Promise<void> {
  for (let i = 0; i < tries && !cond(); i += 1) await new Promise((r) => setTimeout(r, ms));
}

describe('the lan keyword (§23.44, §23.46)', () => {
  it('binds the LAN address and accepts the .local Host name', async () => {
    const net = new FakeLanNetwork();
    net.lan = '127.0.0.1'; // stands in for the LAN address: bindable in a test
    net.local = 'studio.local';
    const h = await start(['lan'], net);

    expect(h.addresses).toEqual(['127.0.0.1']);
    expect(h.localHostName).toBe('studio.local');
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: `studio.local:${h.port}` } })).status).toBe(200);
    // Tailscale is never consulted for a LAN-only config.
    expect(net.calls).toEqual({ ip: 0, dns: 0 });
  });

  it('does not accept the .local name when lan is not configured', async () => {
    const net = new FakeLanNetwork();
    net.local = 'studio.local';
    const h = await start(['127.0.0.1'], net, { lanWatchMs: 10 });
    expect(h.localHostName).toBeNull();
    expect((await rawRequest({ port: h.port, path: '/health', headers: { host: 'studio.local' } })).status).toBe(421);
    await new Promise((r) => setTimeout(r, 60));
    expect(net.lanCalls).toBe(0);
  });

  it('keeps looking for a LAN address that is not bindable yet', async () => {
    const net = new FakeLanNetwork();
    net.lan = UNROUTABLE;
    const lines: string[] = [];
    const h = await start(['127.0.0.1', 'lan'], net, { tailnetRetryMs: 10, lanWatchMs: 60_000, log: (l) => lines.push(l) });
    expect(h.addresses).toEqual(['127.0.0.1']);
    const before = net.lanCalls;
    await until(() => net.lanCalls > before + 1);
    expect(net.lanCalls).toBeGreaterThan(before + 1);
    expect(lines.filter((l) => l.includes('could not bind'))).toHaveLength(1);
  });

  it('notices a moved LAN address on the interface watch and rebinds, with no SIGHUP', async () => {
    const net = new FakeLanNetwork();
    net.lan = '127.0.0.1';
    const lines: string[] = [];
    const h = await start(['lan'], net, { lanWatchMs: 10, log: (l) => lines.push(l) });
    expect(h.addresses).toEqual(['127.0.0.1']);

    // Wi-Fi changed. `::1` may or may not be bindable here; either way a reload must run.
    net.lan = '::1';
    await until(() => /(now also listening on|could not bind) ::1/.test(lines.join('\n')));
    expect(lines.join('\n')).toMatch(/(now also listening on|could not bind) ::1/);
    // §23.57: the local clients' address stays whatever `lan` resolves to.
    expect(h.addresses).toContain('127.0.0.1');
  });

  it('stops watching interfaces on stop()', async () => {
    const net = new FakeLanNetwork();
    net.lan = '127.0.0.1';
    const h = await start(['lan'], net, { lanWatchMs: 10 });
    await h.stop();
    const after = net.lanCalls;
    await new Promise((r) => setTimeout(r, 60));
    expect(net.lanCalls).toBe(after);
  });
});

describe('HTTPS listeners in the daemon (§23.45)', () => {
  it('adds HTTPS on loopback with tls.loopback, records tlsPort and exposes the pin', async () => {
    const configDir = tempConfigDir();
    const h = await start(['127.0.0.1'], new FakeNetwork(), {
      configDir,
      config: { ...defaultConfig(), bind: ['127.0.0.1'], auth: { token: 'test-bearer-token' }, tls: { port: null, loopback: true } },
    });
    expect(h.tlsPort).not.toBeNull();
    expect(h.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const tlsPort = h.tlsPort as number;
    const res = await rawRequest({ port: tlsPort, tls: true, path: '/health', headers: { host: `127.0.0.1:${tlsPort}` } });
    expect(res.status).toBe(200);
    const info = JSON.parse(readFileSync(join(configDir, 'daemon.json'), 'utf8')) as { tlsPort: number };
    expect(info.tlsPort).toBe(tlsPort);
  });

  it('a loopback-only daemon has no TLS listener and creates no key', async () => {
    const configDir = tempConfigDir();
    const h = await start(['127.0.0.1'], new FakeNetwork(), { configDir });
    expect(h.tlsPort).toBeNull();
    expect(h.fingerprint).toBeNull();
    expect(existsSync(join(configDir, 'tls-key.pem'))).toBe(false);
    const info = JSON.parse(readFileSync(join(configDir, 'daemon.json'), 'utf8')) as { tlsPort: unknown };
    expect(info.tlsPort).toBeNull();
  });

  it('a TLS port that is taken is logged, never fatal', async () => {
    const taken = createNetServer();
    sockets.push(taken);
    const port = await new Promise<number>((resolve) => {
      taken.listen(0, '127.0.0.1', () => resolve((taken.address() as { port: number }).port));
    });
    const lines: string[] = [];
    const h = await start(['127.0.0.1'], new FakeNetwork(), {
      config: { ...defaultConfig(), bind: ['127.0.0.1'], auth: { token: 'test-bearer-token' }, tls: { port, loopback: true } },
      log: (l) => lines.push(l),
    });
    expect(h.tlsPort).toBeNull();
    expect(lines.join('\n')).toMatch(/https: could not bind 127\.0\.0\.1/);
    expect((await rawRequest({ port: h.port, path: '/health' })).status).toBe(200);
  });

  it('wantsTls: every non-loopback address, loopback only when asked', () => {
    expect(wantsTls('192.168.1.20', false)).toBe(true);
    expect(wantsTls('100.101.102.103', false)).toBe(true);
    expect(wantsTls('127.0.0.1', false)).toBe(false);
    expect(wantsTls('::1', false)).toBe(false);
    expect(wantsTls('127.0.0.1', true)).toBe(true);
  });
});

describe('pairing end to end (§23.47)', () => {
  it('mints over loopback HTTP with the bearer and redeems over HTTPS for the token', async () => {
    const net = new FakeLanNetwork();
    net.lan = '127.0.0.1';
    net.local = 'studio.local';
    const h = await start(['lan'], net, {
      config: { ...defaultConfig(), bind: ['lan'], auth: { token: 'test-bearer-token' }, tls: { port: null, loopback: true } },
    });
    const minted = await rawRequest({ port: h.port, method: 'POST', path: '/v1/pair/code', headers: { authorization: 'Bearer test-bearer-token' } });
    expect(minted.status).toBe(200);
    const body = JSON.parse(minted.body) as { code: string; addrs: string[]; port: number; fp: string; link: string };
    expect(body.addrs).toEqual(['127.0.0.1', 'studio.local']);
    expect(body.port).toBe(h.tlsPort);
    expect(body.fp).toBe(h.fingerprint);

    const tlsPort = h.tlsPort as number;
    const redeemed = await rawRequest({
      port: tlsPort,
      tls: true,
      method: 'POST',
      path: '/v1/pair',
      headers: { host: `studio.local:${tlsPort}` },
      body: JSON.stringify({ code: body.code }),
    });
    expect(redeemed.status).toBe(200);
    expect(JSON.parse(redeemed.body)).toMatchObject({ token: 'test-bearer-token', fp: h.fingerprint });
  });
});

describe('reload racing stop() (review fix)', () => {
  it('a reload whose resolve finishes after stop() opens nothing and does not hang shutdown', async () => {
    const net = new FakeLanNetwork();
    net.lan = '127.0.0.1';
    const h = await start(['lan'], net, {
      lanWatchMs: 60_000,
      config: { ...defaultConfig(), bind: ['lan'], auth: { token: 'test-bearer-token' }, tls: { port: null, loopback: true } },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inResolve = new Promise<void>((resolve) => {
      entered = resolve;
    });
    net.beforeLan = async () => {
      entered();
      await gate;
    };
    net.lan = '::1';
    const reloading = h.reload();
    await inResolve; // the reload is now mid-resolve
    const stopping = h.stop();
    release();
    await reloading;
    await stopping;
    expect(h.server.listeners).toEqual([]);
    expect(h.server.servers).toHaveLength(0);
  });
});

describe('a failed HTTPS bind keeps the keyword retry going (review fix)', () => {
  it('retries until the TLS listener is up', async () => {
    const taken = createNetServer();
    const port = await new Promise<number>((resolve) => {
      taken.listen(0, '127.0.0.1', () => resolve((taken.address() as { port: number }).port));
    });
    const net = new FakeLanNetwork();
    net.lan = '127.0.0.1';
    const h = await start(['lan'], net, {
      tailnetRetryMs: 10,
      tailnetRetryMaxMs: 10,
      lanWatchMs: 60_000,
      config: { ...defaultConfig(), bind: ['lan'], auth: { token: 'test-bearer-token' }, tls: { port, loopback: true } },
    });
    expect(h.tlsPort).toBeNull();
    // The port frees up; the retry, not a SIGHUP, must notice.
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    await until(() => h.tlsPort !== null);
    expect(h.tlsPort).toBe(port);
  });
});

describe('plain HTTP never leaves the machine (§23.57)', () => {
  it('wantsHttp is loopback and nothing else', () => {
    for (const a of ['127.0.0.1', '127.0.0.53', '::1']) expect(wantsHttp(a), a).toBe(true);
    for (const a of ['192.168.0.1', '10.0.0.1', UNROUTABLE, '0.0.0.0', '::', 'fd00::1', '203.0.113.9']) expect(wantsHttp(a), a).toBe(false);
  });

  it('plans HTTP for loopback only, HTTPS for everything else, and always keeps 127.0.0.1', () => {
    expect(planListeners(['127.0.0.1'], false)).toEqual({ http: ['127.0.0.1'], tls: [] });
    expect(planListeners(['127.0.0.1', '192.168.0.1'], false)).toEqual({ http: ['127.0.0.1'], tls: ['192.168.0.1'] });
    expect(planListeners(['192.168.0.1'], false)).toEqual({ http: ['127.0.0.1'], tls: ['192.168.0.1'] });
    expect(planListeners(['::1', '192.168.0.1'], true)).toEqual({ http: ['127.0.0.1', '::1'], tls: ['127.0.0.1', '::1', '192.168.0.1'] });
  });

  it('a non-loopback address gets an HTTPS listener attempt and no HTTP one, at startup and on reload', async () => {
    const lines: string[] = [];
    const net = new FakeNetwork();
    net.ip = UNROUTABLE;
    const h = await start(['127.0.0.1', 'tailscale'], net, { log: (l) => lines.push(l) });
    await h.reload();
    expect(lines.join('\n')).toMatch(HTTPS_BIND_FAILED);
    expect(lines.join('\n')).not.toMatch(HTTP_BIND_ATTEMPT);
    expect(h.server.listeners).toEqual([{ addr: '127.0.0.1', port: h.port, tls: false }]);
  });

  it('refuses a wildcard or public bind outright, and nothing is left listening', async () => {
    for (const entry of ['0.0.0.0', '::', '203.0.113.9']) {
      await expect(start(['127.0.0.1', entry], new FakeNetwork()), entry).rejects.toMatchObject({ name: 'ConfigError', key: 'bind[1]' });
    }
  });

  it('with allowPublicBind the wildcard is served, over HTTPS only', async () => {
    const configDir = tempConfigDir();
    const h = await startDaemon({
      configDir,
      config: { ...defaultConfig(), bind: ['127.0.0.1', '0.0.0.0'], allowPublicBind: true, auth: { token: 'test-bearer-token' } },
      port: 0,
      poll: false,
      sessions: false,
      tokens: new FakeTokensSource(),
      version: '9.9.9',
      network: new FakeNetwork(),
      log: () => undefined,
    });
    handles.push(h);
    expect(h.server.listeners.filter((l) => !l.tls)).toEqual([{ addr: '127.0.0.1', port: h.port, tls: false }]);
    expect(h.server.listeners.filter((l) => l.tls).map((l) => l.addr)).toEqual(['0.0.0.0']);
    expect(h.tlsPort).not.toBeNull();
    const res = await rawRequest({ port: h.tlsPort as number, tls: true, path: '/health', headers: { host: `127.0.0.1:${String(h.tlsPort)}` } });
    expect(res.status).toBe(200);
  });
});

