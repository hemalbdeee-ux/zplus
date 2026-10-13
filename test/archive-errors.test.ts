// When archive.org cannot be reached, the error must say why: a firewall's own 403 and a dropped
// connection otherwise read as archive.org refusing, with nothing to tell them apart.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5, retries: 1 };

async function serve(handler: http.RequestListener): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function firstPage(client: ArchiveClient): Promise<void> {
  for await (const _ of client.cdx({ url: 'example.com' })) break;
}

describe('archive errors', () => {
  it('quotes a plain-text refusal from whatever answered the CDX query', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain', 'x-block-reason': 'hostname_blocked' });
      res.end('Blocked by egress policy');
    });
    try {
      await assert.rejects(firstPage(new ArchiveClient({ base: s.base, ...FAST })), { message: 'CDX query failed with HTTP 403: Blocked by egress policy' });
    } finally {
      await s.close();
    }
  });

  it('leaves an HTML error page out of the message', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>Service Unavailable</body></html>');
    });
    try {
      await assert.rejects(firstPage(new ArchiveClient({ base: s.base, ...FAST, retries: 0 })), { message: 'CDX query failed with HTTP 503' });
    } finally {
      await s.close();
    }
  });

  it('names the network error behind "fetch failed", in the log and the final error', async () => {
    const s = await serve((req) => req.socket.destroy());
    const log: string[] = [];
    try {
      const client = new ArchiveClient({ base: s.base, ...FAST, log: (m) => log.push(m) });
      await assert.rejects(firstPage(client), (err: Error) => {
        assert.match(err.message, /^fetch failed: \S/);
        assert.ok(err.cause instanceof Error, 'keeps the original error as the cause');
        return true;
      });
      assert.match(log[0], /^request failed \(fetch failed: \S.*\); retrying in \d+s$/);
    } finally {
      await s.close();
    }
  });
});
