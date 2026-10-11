// Runs a health scan in which a weak month sits between the last good and the first parked one,
// and prints the result as JSON. test/health-scan.test.ts runs it in a child process with a timeout,
// because a scan that loops forever blocks the event loop and no in-process timer could stop it.

import { ArchiveClient } from '../../src/engine/archive.ts';
import { scanHealth } from '../../src/engine/health.ts';
import { startFakeArchive } from '../fake-archive.ts';

const links = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/p${i}.html">p${i}</a>`).join(' ');
const words = (n: number) => Array.from({ length: n }, (_, i) => `bread${i % 50}`).join(' ');
const good = `<html lang="en"><head><title>Bakery</title></head><body>${links(8)}<p>${words(300)}</p></body></html>`;
const weak = `<html lang="en"><head><title>Bakery</title></head><body>${links(1)}<p>${words(100)}</p></body></html>`;
const parked = '<html><body><h1>example.com</h1><p>This domain may be for sale!</p></body></html>';

const archive = await startFakeArchive([
  { url: 'http://example.com/', ts: '20190115000000', body: good },
  { url: 'http://example.com/', ts: '20190215000000', body: weak },
  { url: 'http://example.com/', ts: '20190315000000', body: parked },
]);
try {
  const h = await scanHealth(new ArchiveClient({ base: archive.base, minIntervalMs: 0, backoffMs: 1 }), 'example.com');
  console.log(JSON.stringify({ lastGood: h.lastGood?.month, window: h.window, verdicts: h.months.map((m) => m.verdict) }));
} finally {
  await archive.close();
}
