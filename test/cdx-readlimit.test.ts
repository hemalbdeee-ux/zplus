// archive.org's CDX server reads at most 150000 rows per request and counts rows that from/to,
// filter or collapse drop; it prints a resume key only after writing a full page. A query that
// narrows on the server can therefore end early with no resume key, and look complete. These tests
// run against a fake with a tiny read cap, so the same thing happens with a small fixture.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex } from '../src/engine/crawl.ts';
import { scanHealth } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };

// Busy homepage: every homepage capture is taken three times that day (redirect first, then the
// page twice), and the site has dozens of junk URLs the archive answered with 404.
function busySite(): FakeCapture[] {
  const out: FakeCapture[] = [...OLD_BAKERY];
  for (const c of OLD_BAKERY) {
    if (c.url !== 'http://www.oldbakery.example/') continue;
    const day = c.ts.slice(0, 8);
    out.push({ url: 'http://oldbakery.example/', ts: `${day}000001`, status: 301, location: 'http://www.oldbakery.example/' });
    out.push({ ...c, ts: `${day}235958` });
  }
  for (let i = 0; i < 80; i++) {
    out.push({ url: `http://www.oldbakery.example/a-junk-${String(i).padStart(3, '0')}.html`, ts: '20190101000000', status: 404, body: 'not found' });
  }
  return out;
}

describe('CDX read cap', () => {
  it('the health scan still sees the whole homepage history', async () => {
    const archive = await startFakeArchive(busySite(), { readLimit: 12 });
    try {
      const h = await scanHealth(new ArchiveClient({ base: archive.base, ...FAST }), 'oldbakery.example');
      assert.equal(h.lastGood?.month, '202011');
      assert.equal(h.window.to, '20210228235959');
      assert.ok(h.months.some((m) => m.month === '202303'), 'reads to the last capture');
    } finally {
      await archive.close();
    }
  });

  it('the restore index lists URLs past a run of 404 rows', async () => {
    const archive = await startFakeArchive(busySite(), { readLimit: 12 });
    try {
      const index = await buildIndex(new ArchiveClient({ base: archive.base, ...FAST }), {
        domain: 'oldbakery.example',
        target: '20201114083015',
        window: { to: '20210228235959' },
      });
      for (const key of ['oldbakery.example/tag/bread/', 'oldbakery.example/orphan.html', 'oldbakery.example/wp-content/uploads/2019/05/starter.jpg']) {
        assert.ok(index.has(key), `${key} is in the index`);
      }
      assert.ok(![...index.keys()].some((k) => k.includes('a-junk-')), '404 rows stay out');
    } finally {
      await archive.close();
    }
  });
});
