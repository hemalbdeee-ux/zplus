// What a run sees on a real network: a proxy that has to be used, an archive that drops connections
// from an address it throttles, and a proxy that refuses the archive with a line of text.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ArchiveClient, networkError } from '../src/engine/archive.ts';
import { needsProxyRelaunch, proxyEnv } from '../src/engine/proxy.ts';
import { startFakeArchive } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
/** Node can turn the proxy on (22.21 and later); the relaunch tests need it. */
const CAN_PROXY = needsProxyRelaunch({ HTTPS_PROXY: 'http://proxy' });

/** This process's environment without any proxy settings, plus the given ones. */
function envWith(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: undefined };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS']) delete env[k];
  return { ...env, ...extra };
}

/** A port nothing listens on: requests sent to it as a proxy fail at once. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function run(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out })));
}

async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** A regression here would leave a process running; fail instead of hanging. */
function within<T>(p: Promise<T>, what: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };
const site = [{ url: 'http://example.com/', ts: '20200101000000', body: '<html><body>hi</body></html>' }];

describe('network', () => {
  it('relaunches with the proxy on only when a proxy is set and Node can use it', () => {
    assert.equal(needsProxyRelaunch({ HTTPS_PROXY: 'http://127.0.0.1:3128' }, '22.22.0'), true);
    assert.equal(needsProxyRelaunch({ http_proxy: 'http://127.0.0.1:3128' }, '24.1.0'), true);
    assert.equal(needsProxyRelaunch({ HTTPS_PROXY: 'http://127.0.0.1:3128', NODE_USE_ENV_PROXY: '1' }, '22.22.0'), false);
    assert.equal(needsProxyRelaunch({}, '22.22.0'), false);
    // Older Node ignores NODE_USE_ENV_PROXY: a relaunch would only run everything twice.
    assert.equal(needsProxyRelaunch({ HTTPS_PROXY: 'http://127.0.0.1:3128' }, '22.18.0'), false);
  });

  it('starts job processes with the proxy turned on', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:3128', PATH: '/bin' };
    assert.equal(proxyEnv(env).NODE_USE_ENV_PROXY, needsProxyRelaunch(env) ? '1' : undefined);
    assert.equal(proxyEnv(env).PATH, '/bin');
    assert.deepEqual(proxyEnv({ PATH: '/bin' }), { PATH: '/bin' });
  });

  it('keeps loopback off the proxy, as it was before the proxy was used', { skip: !CAN_PROXY }, () => {
    const env = proxyEnv({ HTTP_PROXY: 'http://corp:3128', NO_PROXY: 'localhost,.corp.example', NODE_OPTIONS: '--max-old-space-size=512' });
    assert.equal(env.NO_PROXY, 'localhost,.corp.example,127.0.0.1,::1');
    // undici reads no_proxy first: it must not hide the hosts in NO_PROXY.
    assert.equal(env.no_proxy, env.NO_PROXY);
    assert.equal(proxyEnv({ HTTP_PROXY: 'http://corp:3128', no_proxy: 'a.example', NO_PROXY: 'b.example,a.example' }).no_proxy, 'a.example,b.example,localhost,127.0.0.1,::1');
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=512 --disable-warning=UNDICI-EHPA');
    assert.equal(proxyEnv({ HTTP_PROXY: 'http://corp:3128', NO_PROXY: '*' }).NO_PROXY, '*');
    assert.equal(proxyEnv({ HTTP_PROXY: 'http://corp:3128', NO_PROXY: '*' }).no_proxy, undefined);
  });

  it('names the reason a fetch failed, however deep it sits', () => {
    const fetchFailed = (cause: unknown) => Object.assign(new TypeError('fetch failed'), { cause });
    assert.equal(networkError(fetchFailed(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))), 'fetch failed: ECONNRESET');
    // undici's refused proxy tunnel: a DOMException (numeric code 0) around the real reason.
    const tunnel = Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' });
    const cancelled = Object.assign(new Error('Request was cancelled.'), { code: 0, cause: tunnel });
    assert.equal(networkError(fetchFailed(cancelled)), 'fetch failed: UND_ERR_ABORTED (Proxy response (403) !== 200 when HTTP Tunneling)');
    assert.equal(networkError(fetchFailed(new Error('getaddrinfo failed'))), 'fetch failed: getaddrinfo failed');
    assert.equal(networkError(new Error('plain')), 'plain');
  });

  it('keeps the error of a request that cannot be sent at all', async () => {
    const client = new ArchiveClient({ base: 'web.archive.org', ...FAST });
    await assert.rejects(client.cdx({ url: 'example.com' }).next(), /Failed to parse URL from web\.archive\.org\/cdx/);
  });

  it('says that the proxy refused the tunnel to the archive', { skip: !CAN_PROXY }, async () => {
    const proxy = http.createServer();
    proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 24\r\n\r\nBlocked by egress policy'));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    try {
      const { port } = proxy.address() as AddressInfo;
      const code = `import { ArchiveClient } from ${JSON.stringify(path.join(ROOT, 'src/engine/archive.ts'))};
        const c = new ArchiveClient({ base: 'https://web.archive.org', minIntervalMs: 0, backoffMs: 1, retries: 0 });
        c.cdx({ url: 'example.com' }).next().catch((e) => console.log(e.message));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: proxyEnv(envWith({ HTTPS_PROXY: `http://127.0.0.1:${port}` })) });
      const { out } = await run(child);
      assert.match(out, /web\.archive\.org: fetch failed: UND_ERR_ABORTED \(Proxy response \(403\) !== 200 when HTTP Tunneling\)/);
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });

  it('reaches a local archive directly when a proxy is set', { skip: !CAN_PROXY }, async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    try {
      const dead = `http://127.0.0.1:${await closedPort()}`;
      const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.ts'), 'scan', 'oldbakery.example', '--archive', archive.base, '--delay', '0'], {
        env: envWith({ HTTP_PROXY: dead, HTTPS_PROXY: dead, NO_PROXY: 'localhost' }),
      });
      const { code, out } = await run(child);
      assert.equal(code, 0, out);
      assert.match(out, /Last good snapshot/);
      assert.doesNotMatch(out, /UNDICI-EHPA|ExperimentalWarning/);
    } finally {
      await archive.close();
    }
  });

  describe('the relaunched CLI', { skip: !CAN_PROXY }, () => {
    async function serve() {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-relaunch-'));
      const port = await closedPort();
      const dead = `http://127.0.0.1:${await closedPort()}`;
      const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.ts'), 'serve', dir, '--port', String(port)], { env: envWith({ HTTPS_PROXY: dead }) });
      const done = run(child);
      await until('the preview server', () => answers(port));
      const cleanup = async () => {
        s.child.kill('SIGKILL');
        await rm(dir, { recursive: true, force: true });
      };
      const s = { child, port, done, cleanup };
      return s;
    }

    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      it(`stops on ${sig} sent to its pid and ends the way a direct run would`, async () => {
        const s = await serve();
        try {
          s.child.kill(sig);
          const { code, signal } = await within(s.done, 'the CLI to stop');
          assert.deepEqual({ code, signal }, { code: null, signal: sig });
          await until('the server to stop', async () => !(await answers(s.port)));
        } finally {
          await s.cleanup();
        }
      });
    }

    it('does not leave the relaunched process running when it is killed', async () => {
      const s = await serve();
      try {
        s.child.kill('SIGKILL');
        await within(s.done, 'the CLI to stop');
        await until('the relaunched process to stop', async () => !(await answers(s.port)));
      } finally {
        await s.cleanup();
      }
    });
  });

  it('names a dropped connection instead of "fetch failed", and retries it', async () => {
    const archive = await startFakeArchive(site);
    try {
      archive.resetNext(1);
      const ok = new ArchiveClient({ base: archive.base, ...FAST });
      const pages = [];
      for await (const p of ok.cdx({ url: 'example.com/', matchType: 'prefix' })) pages.push(...p);
      assert.equal(pages.length, 1);

      archive.resetNext(2);
      const logs: string[] = [];
      const client = new ArchiveClient({ base: archive.base, ...FAST, log: (m) => logs.push(m) });
      await assert.rejects(client.fetchCapture('20200101000000', 'http://example.com/'), /127\.0\.0\.1:\d+: fetch failed: (ECONNRESET|UND_ERR_SOCKET)/);
      assert.match(logs.join('\n'), /request failed \(fetch failed: (ECONNRESET|UND_ERR_SOCKET)\)/);
    } finally {
      await archive.close();
    }
  });

  it('says why a CDX query was refused', async () => {
    const proxy = http.createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Blocked by egress policy\n');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    try {
      const { port } = proxy.address() as AddressInfo;
      const client = new ArchiveClient({ base: `http://127.0.0.1:${port}`, ...FAST });
      await assert.rejects(client.cdx({ url: 'example.com' }).next(), /CDX query failed with HTTP 403: Blocked by egress policy$/);
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });
});
