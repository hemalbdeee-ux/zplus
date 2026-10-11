// The demo page limit with URLs whose type the index does not know (revisit rows, no extension).
// Past the limit only what a kept page uses (images, stylesheets) is downloaded; a page it links to
// is not, so those links cost no downloads and do not crowd the kept pages' files out of the budget.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex, crawl, type CrawlOptions } from '../src/engine/crawl.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const R = 'http://rv.example';
const OLD = '20170101000000';
const NEW = '20200601000000';
// First captured before the window (after an outage), then again unchanged inside it: the index
// only has the revisit row, which does not say what the URL is.
const revisitOnly = (url: string, type: string, body: string | Buffer): FakeCapture[] => [
  { url, ts: OLD, type, body },
  { url, ts: NEW, type, body, revisit: true },
];

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'zp-demo-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

async function demo(captures: FakeCapture[], opts: Partial<CrawlOptions> = {}) {
  const archive = await startFakeArchive(captures);
  try {
    const client = new ArchiveClient({ base: archive.base, ...FAST });
    const full: CrawlOptions = { domain: 'rv.example', target: NEW, window: { from: '20190101000000' }, workDir: await mkdtemp(path.join(work, 'w-')), maxUrls: 200, maxPages: 4, orphans: false, ...opts };
    const manifest = await crawl(client, await buildIndex(client, full), full);
    const pages = manifest.resources.filter((r) => /html/.test(r.contentType ?? '')).map((r) => r.path);
    const files = manifest.resources.filter((r) => !pages.includes(r.path)).map((r) => r.path);
    return { manifest, pages, files, playback: archive.requests.filter((r) => r.startsWith('/web/')).length };
  } finally {
    await archive.close();
  }
}

describe('demo limit with pages of unknown type', () => {
  for (const workers of [1, 3]) {
    it(`does not download linked pages past the limit (${workers} workers)`, async () => {
      // Every page links 300 tag pages; the kept ones need their stylesheet and images.
      const N = 300;
      const nav = Array.from({ length: N }, (_, i) => `<li><a href="/tag/t${i}/">t${i}</a></li>`).join('');
      const page = (b: string) => `<html><head><link rel="stylesheet" href="/s.css"><link rel="canonical" href="/canon/"></head><body><img src="/logo.png"><ul>${nav}</ul>${b}</body></html>`;
      const caps: FakeCapture[] = [
        { url: `${R}/`, ts: NEW, body: page('') },
        ...Array.from({ length: N }, (_, i) => revisitOnly(`${R}/tag/t${i}/`, 'text/html', page(`<img src="/img/${i}">`))).flat(),
        ...revisitOnly(`${R}/canon/`, 'text/html', page('')),
        { url: `${R}/s.css`, ts: NEW, type: 'text/css', body: 'body{background:url(/bg)}' },
        ...revisitOnly(`${R}/bg`, 'image/png', PNG),
        { url: `${R}/logo.png`, ts: NEW, type: 'image/png', body: PNG },
        ...Array.from({ length: N }, (_, i) => revisitOnly(`${R}/img/${i}`, 'image/png', PNG)).flat(),
      ];
      const { manifest, pages, files, playback } = await demo(caps, { workers });
      assert.equal(pages.length, 4, pages.join(' '));
      const kept = pages.filter((p) => p.startsWith('/tag/')).map((p) => `/img/${/t(\d+)/.exec(p)![1]}`);
      assert.deepEqual(files.sort(), ['/bg', '/logo.png', '/s.css', ...kept].sort());
      assert.equal(manifest.truncated, false);
      // 4 pages, their files, and at most one page per extra worker fetched and then dropped.
      assert.ok(playback <= 4 + files.length + workers, `${playback} playback requests`);
    });
  }

  it('still downloads a file that one page links to and another shows as an image', async () => {
    // /a is the last page the demo keeps; /photo, queued as a link, is reached after it.
    const caps: FakeCapture[] = [
      { url: `${R}/`, ts: NEW, body: '<html><body><a href="/a">a</a><a href="/photo">photo</a></body></html>' },
      { url: `${R}/a`, ts: NEW, body: '<html><body><img src="/photo"></body></html>' },
      ...revisitOnly(`${R}/photo`, 'image/png', PNG),
    ];
    const { pages, files } = await demo(caps, { maxPages: 2, workers: 1 });
    assert.deepEqual(pages, ['/', '/a']);
    assert.deepEqual(files, ['/photo']);
  });
});
