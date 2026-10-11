// What the crawl takes from the archive index: revisit rows, the demo page limit, query-string
// variants, the index size limit, captures that replay outside the good window, and the archive's
// own redirects to a differently spelled URL.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex, crawl, type CrawlOptions, type Manifest } from '../src/engine/crawl.ts';
import { restore } from '../src/engine/restore.ts';
import { startFakeArchive, type FakeArchiveOptions, type FakeCapture } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const html = (body: string) => `<html><body>${body}</body></html>`;

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'wbd-index-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

async function run(captures: FakeCapture[], opts: Partial<CrawlOptions> & { domain: string; target: string }, fake: FakeArchiveOptions = {}) {
  const archive = await startFakeArchive(captures, fake);
  try {
    const client = new ArchiveClient({ base: archive.base, ...FAST });
    const full: CrawlOptions = { window: {}, workDir: await mkdtemp(path.join(work, 'w-')), maxUrls: 1000, orphans: true, workers: 3, ...opts };
    const index = await buildIndex(client, full);
    const manifest = await crawl(client, index, full);
    const playback = archive.requests.filter((r) => r.startsWith('/web/'));
    const body = async (p: string) => {
      const r = manifest.resources.find((x) => x.path === p);
      return r?.file ? readFile(path.join(full.workDir, 'raw', r.file), 'utf8') : undefined;
    };
    return { index, manifest, playback, body };
  } finally {
    await archive.close();
  }
}

const pagesOf = (m: Manifest) => m.resources.filter((r) => r.status === 200 && /html/.test(r.contentType ?? ''));

describe('revisit rows and the demo limit', () => {
  const R = 'http://revisit.example';
  // Each article was captured once in 2019 and then again, unchanged, close to the target: the
  // CDX lists those repeat captures as "warc/revisit" with status "-".
  const articles = Array.from({ length: 30 }, (_, i) => i);
  const captures: FakeCapture[] = [
    { url: `${R}/`, ts: '20200601000000', body: html(articles.map((i) => `<a href="/a${i}.html">a${i}</a>`).join('')) },
    ...articles.flatMap((i): FakeCapture[] => [
      { url: `${R}/a${i}.html`, ts: '20190101000000', body: html(`article ${i}`) },
      { url: `${R}/a${i}.html`, ts: '20200601000000', body: html(`article ${i}`), revisit: true },
    ]),
    ...Array.from({ length: 40 }, (_, i): FakeCapture => ({ url: `${R}/files/doc${i}.pdf`, ts: '20200601000000', type: 'application/pdf', body: `%PDF ${i}` })),
  ];

  it('gives revisit picks the type of the original capture', async () => {
    const archive = await startFakeArchive(captures);
    try {
      const index = await buildIndex(new ArchiveClient({ base: archive.base, ...FAST }), { domain: 'revisit.example', target: '20200601000000', window: {} });
      const a0 = index.get('revisit.example/a0.html')!;
      assert.equal(a0.statuscode, '-');
      assert.equal(a0.mimetype, 'text/html');
    } finally {
      await archive.close();
    }
  });

  it('stops a demo at its page limit and leaves out unlinked files', async () => {
    const { manifest, playback } = await run(captures, { domain: 'revisit.example', target: '20200601000000', maxPages: 4 });
    assert.equal(pagesOf(manifest).length, 4);
    assert.equal(manifest.resources.filter((r) => r.path.endsWith('.pdf')).length, 0);
    assert.ok(playback.length <= 8, `${playback.length} playback requests`);
  });

  it('still downloads the files a kept demo page links to', async () => {
    const caps: FakeCapture[] = [
      { url: `${R}/`, ts: '20200601000000', body: html('<img src="/logo.png"><a href="/a.html">a</a>') },
      { url: `${R}/logo.png`, ts: '20200601000000', type: 'image/png', body: PNG },
      { url: `${R}/a.html`, ts: '20200601000000', body: html('<img src="/a.png">') },
      { url: `${R}/a.png`, ts: '20200601000000', type: 'image/png', body: PNG },
      { url: `${R}/unlinked.png`, ts: '20200601000000', type: 'image/png', body: PNG },
    ];
    const { manifest } = await run(caps, { domain: 'revisit.example', target: '20200601000000', maxPages: 1 });
    assert.deepEqual(manifest.resources.map((r) => r.path).sort(), ['/', '/logo.png']);
  });

  it('keeps the files of demo pages that are listed only as revisits', async () => {
    // window.from (after an outage) is later than the first capture of the unchanged CSS and
    // images, so all their rows in the window are revisits and the index cannot tell their type.
    const page = (b: string) => html(`<link rel="stylesheet" href="/style.css">${b}<img src="/logo.png"><img src="/pic">`);
    const twice = (url: string, type: string, body: string | Buffer): FakeCapture[] => [
      { url, ts: '20170101000000', type, body },
      { url, ts: '20200601000000', type, body, revisit: true },
    ];
    const caps: FakeCapture[] = [
      { url: `${R}/`, ts: '20200601000000', body: page(Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')) },
      ...Array.from({ length: 10 }, (_, i): FakeCapture => ({ url: `${R}/p${i}`, ts: '20200601000000', body: page(`page ${i}`) })),
      ...twice(`${R}/style.css`, 'text/css', 'body{}'),
      ...twice(`${R}/logo.png`, 'image/png', PNG),
      ...twice(`${R}/pic`, 'image/png', PNG),
    ];
    const { manifest } = await run(caps, { domain: 'revisit.example', target: '20200601000000', window: { from: '20190101000000' }, maxPages: 4 });
    assert.equal(pagesOf(manifest).length, 4);
    const files = manifest.resources.filter((r) => !/html/.test(r.contentType ?? '')).map((r) => r.path);
    assert.deepEqual(files.sort(), ['/logo.png', '/pic', '/style.css']);
  });

  it('puts unlinked pages listed as revisits ahead of images', async () => {
    const caps: FakeCapture[] = [
      { url: `${R}/`, ts: '20200601000000', body: html('home') },
      ...Array.from({ length: 5 }, (_, i): FakeCapture => ({ url: `${R}/a-img${i}.png`, ts: '20200601000000', type: 'image/png', body: PNG })),
      ...Array.from({ length: 3 }, (_, i): FakeCapture[] => [
        { url: `${R}/z-page${i}.html`, ts: '20190101000000', body: html(`page ${i}`) },
        { url: `${R}/z-page${i}.html`, ts: '20200601000000', body: html(`page ${i}`), revisit: true },
      ]).flat(),
    ];
    const { manifest } = await run(caps, { domain: 'revisit.example', target: '20200601000000', maxUrls: 4, workers: 1 });
    assert.deepEqual(manifest.resources.map((r) => r.path), ['/', '/z-page0.html', '/z-page1.html', '/z-page2.html']);
    assert.equal(manifest.truncated, true);
  });
});

describe('query-string variants', () => {
  const Q = 'http://www.qsite.example';
  it('keeps every archived variant and records the unarchived ones it caps', async () => {
    const posts = Array.from({ length: 250 }, (_, i) => i + 1);
    const links = [...posts.map((n) => `<a href="/?p=${n}">${n}</a>`), ...Array.from({ length: 210 }, (_, i) => `<a href="/search?q=${i}">s</a>`)];
    const caps: FakeCapture[] = [
      { url: `${Q}/`, ts: '20200101000000', body: html(links.join('\n')) },
      ...posts.map((n): FakeCapture => ({ url: `${Q}/?p=${n}`, ts: '20200101000000', body: html(`post ${n}`) })),
    ];
    const { manifest } = await run(caps, { domain: 'qsite.example', target: '20200101000000', maxUrls: 2000 });
    const restored = new Set(manifest.resources.map((r) => r.path));
    for (const n of posts) assert.ok(restored.has(`/?p=${n}`), `/?p=${n}`);
    const capped = manifest.missing.filter((m) => /query-string variants/.test(m.reason));
    assert.equal(capped.length, 10);
    assert.equal(manifest.missing.filter((m) => m.url.includes('/search?')).length, 210);
  });
});

describe('index size limit', () => {
  const S = 'http://cut.example';
  const target = '20190601000000';
  const window = { from: '20100101000000', to: '20191231235959' };
  const PARKED = html('<h1>DOMAIN FOR SALE</h1>');
  // The index is sorted by URL: the filler (and the junk before it) comes first, so a small index
  // stops before the pages the homepage links to.
  const caps: FakeCapture[] = [
    {
      url: `${S}/`,
      ts: target,
      body: html('<a href="/zz-deep">deep</a> <a href="/zz-forum?t=1">t1</a> <a href="/zz-About.html">about</a> <a href="/zz-gone">gone</a> <a href="/zz-news?utm_source=home">news</a>'),
    },
    ...Array.from({ length: 20 }, (_, i): FakeCapture => ({ url: `${S}/0/wp-json/x${i}`, ts: '20190101000000', type: 'application/json', body: '{}' })),
    ...Array.from({ length: 30 }, (_, i): FakeCapture => ({ url: `${S}/a-${String(i).padStart(3, '0')}.html`, ts: '20190101000000', body: html('filler') })),
    // The capture nearest the target is the parked domain; the in-window one is older.
    { url: `${S}/zz-deep`, ts: '20150101000000', body: html('REAL deep page') },
    { url: `${S}/zz-deep`, ts: '20200201000000', body: PARKED },
    { url: `${S}/zz-forum?t=1`, ts: '20150101000000', body: html('topic 1') },
    { url: `${S}/zz-forum?t=1`, ts: '20200201000000', body: PARKED },
    { url: `${S}/zz-news`, ts: '20150101000000', body: html('REAL news') },
    // A redirect the site made that only changes case: replay skips it.
    { url: `${S}/zz-About.html`, ts: '20190501000000', status: 301, location: `${S}/zz-about.html` },
    { url: `${S}/zz-about.html`, ts: '20190502000000', body: html('About') },
  ];

  it('stops reading at its limit, and junk it never downloads does not count', async () => {
    const archive = await startFakeArchive(caps);
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      const index = await buildIndex(client, { domain: 'cut.example', target, window, maxIndexUrls: 10 });
      assert.equal(index.size, 10);
      assert.equal(index.truncated, true);
      assert.ok(![...index.keys()].some((k) => k.includes('wp-json')));
      const all = await buildIndex(client, { domain: 'cut.example', target, window });
      assert.ok(!all.truncated && all.size === 36, String(all.size));
    } finally {
      await archive.close();
    }
  });

  it('looks up a linked URL past the cut on its own', async () => {
    const archive = await startFakeArchive(caps);
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      const opts: CrawlOptions = { domain: 'cut.example', target, window, workDir: await mkdtemp(path.join(work, 'w-')), maxUrls: 1000, orphans: true, workers: 2 };
      const index = await buildIndex(client, { ...opts, maxIndexUrls: 10 });
      const manifest = await crawl(client, index, opts);
      const get = (p: string) => manifest.resources.find((r) => r.path === p);
      for (const p of ['/zz-deep', '/zz-forum?t=1']) {
        assert.equal(get(p)?.timestamp, '20150101000000', p);
        assert.match(await readFile(path.join(opts.workDir, 'raw', get(p)!.file!), 'utf8'), /REAL deep page|topic 1/);
      }
      assert.deepEqual([get('/zz-About.html')?.status, get('/zz-About.html')?.location], [301, `${S}/zz-about.html`]);
      assert.equal(get('/zz-about.html')?.status, 200);
      // Looked up without its tracking parameter, like the index would have listed it.
      assert.equal(get('/zz-news')?.timestamp, '20150101000000');
      assert.ok(manifest.missing.some((m) => m.url.endsWith('/zz-gone') && /not archived in the good period/.test(m.reason)));
      assert.ok(archive.requests.some((r) => r.includes('matchType=exact')));
    } finally {
      await archive.close();
    }
  });

  it('does not tie the index size to the URL budget', async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const r = await restore({ domain: 'oldbakery.example', outDir: out, maxUrls: 2, zip: false, archive: { base: archive.base, ...FAST } });
      assert.equal(r.report.truncated, true);
      assert.ok(r.report.counts.indexUrls > 10, String(r.report.counts.indexUrls));
      assert.ok(!r.report.warnings.some((w) => /lists more than/.test(w)), r.report.warnings.join(' | '));
    } finally {
      await archive.close();
    }
  });

  it('restores the linked pages of a demo past the demo index size', async () => {
    const big: FakeCapture[] = [
      { url: `${S}/`, ts: target, body: html('<a href="/zz-deep">deep</a>') },
      ...Array.from({ length: 5_010 }, (_, i): FakeCapture => ({ url: `${S}/a-${String(i).padStart(5, '0')}.html`, ts: '20190101000000', body: 'x' })),
      ...caps.filter((c) => c.url.includes('/zz-deep')),
    ];
    const archive = await startFakeArchive(big);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const r = await restore({ domain: 'cut.example', outDir: out, target, from: '2010', to: '2019', skipHealth: true, maxPages: 4, zip: false, archive: { base: archive.base, ...FAST } });
      const manifest = JSON.parse(await readFile(path.join(r.jobDir, '.work', 'manifest.json'), 'utf8')) as Manifest;
      assert.equal(manifest.resources.find((x) => x.path === '/zz-deep')?.timestamp, '20150101000000');
      // Nothing is lost to the cut in a demo, which takes no unlinked URLs.
      assert.equal(r.report.truncated, false);
      assert.deepEqual(r.report.warnings, []);
    } finally {
      await archive.close();
    }
  });
});

describe('replay that lands outside the good window', () => {
  const S = 'http://moved.example';
  const target = '20190430000000';
  const window = { to: '20190510235959' };
  const PARKED = html('<h1>THIS DOMAIN IS FOR SALE</h1>');

  it('fetches the in-window page when the archive skips a self-redirect into the parked period', async () => {
    const caps: FakeCapture[] = [
      { url: `${S}/`, ts: '20190425000000', body: html('<a href="/page">page</a> <a href="/promo">promo</a>') },
      // The site moved to https while it was healthy; Wayback skips the http -> https 301 and
      // serves the nearest other capture, the parked page from after the window.
      { url: 'https://moved.example/page', ts: '20190301000000', body: html('<h1>The real article</h1>') },
      { url: `${S}/page`, ts: '20190423000000', status: 301, location: 'https://moved.example/page' },
      { url: 'https://moved.example/page', ts: '20190521000000', body: PARKED },
      // No in-window page at all: only a self-redirect and, later, the new owner's spam redirect.
      { url: `${S}/promo`, ts: '20190424000000', status: 301, location: 'https://moved.example/promo' },
      { url: 'https://moved.example/promo', ts: '20190601000000', status: 302, location: 'http://spam.example/' },
    ];
    const { index, manifest, body } = await run(caps, { domain: 'moved.example', target, window });
    assert.equal(index.get('moved.example/page')!.statuscode, '301');
    const page = manifest.resources.find((r) => r.path === '/page')!;
    assert.equal(page.status, 200);
    assert.ok(page.timestamp <= window.to, page.timestamp);
    assert.match((await body('/page'))!, /The real article/);
    assert.equal(manifest.resources.find((r) => r.path === '/promo'), undefined);
    assert.ok(manifest.missing.some((m) => m.url.endsWith('/promo') && /outside the good period/.test(m.reason)));
    assert.ok(!manifest.resources.some((r) => r.location?.includes('spam.example')));
  });
});

describe('archive navigation to a differently spelled URL', () => {
  const C = 'http://www.casesite.example';
  it('serves the content at the linked URL instead of inventing a redirect', async () => {
    const caps: FakeCapture[] = [
      { url: `${C}/`, ts: '20200101000000', body: html('<a href="/About-Us.html">About</a> <a href="/blog/">Blog</a> <a href="/old.html">Old</a>') },
      { url: `${C}/about-us.html`, ts: '20191201000000', body: html('About us') },
      { url: `${C}/blog`, ts: '20191201000000', body: html('Blog') },
      { url: `${C}/old.html`, ts: '20191201000000', status: 301, location: `${C}/new.html` },
      { url: `${C}/new.html`, ts: '20191201000000', body: html('New') },
    ];
    const { manifest, body } = await run(caps, { domain: 'casesite.example', target: '20200101000000', orphans: false }, { stripTrailingSlash: true });
    const about = manifest.resources.find((r) => r.path === '/About-Us.html')!;
    assert.equal(about.status, 200);
    assert.match((await body('/About-Us.html'))!, /About us/);
    assert.equal(manifest.resources.find((r) => r.path === '/blog/')?.status, 200);
    // A redirect the site itself made is still kept.
    const redirects = manifest.resources.filter((r) => r.status !== 200).map((r) => `${r.path} ${r.status} ${r.location}`);
    assert.deepEqual(redirects, [`/old.html 301 ${C}/new.html`]);
  });
});
