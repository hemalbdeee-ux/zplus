// What a run sees on a real network: a proxy that has to be used, an archive that drops connections
// from an address it throttles, and a proxy that refuses the archive with a line of text.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { needsProxyRelaunch, proxyEnv } from '../src/engine/proxy.ts';
import { startFakeArchive } from './fake-archive.ts';

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
