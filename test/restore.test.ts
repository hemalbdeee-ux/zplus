// End to end: restore "The Old Bakery" from the fake archive, then request every original URL
// through the preview server (which follows the same rules as .htaccess and nginx.conf).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { scanHealth } from '../src/engine/health.ts';
import { restore, type RestoreResult } from '../src/engine/restore.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { startFakeArchive, type FakeArchive } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };

describe('restore oldbakery.example', () => {
  let archive: FakeArchive;
  let out: string;
  let result: RestoreResult;
  let preview: Server;
  let base: string;
  const site = (rel: string) => readFile(path.join(result.siteDir, rel), 'utf8');

  before(async () => {
    archive = await startFakeArchive(OLD_BAKERY);
    out = await mkdtemp(path.join(os.tmpdir(), 'wbd-'));
    result = await restore({ domain: 'oldbakery.example', outDir: out, archive: { base: archive.base, ...FAST } });
    preview = await createPreviewServer(result.siteDir);
    await new Promise<void>((r) => preview.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  });

  after(async () => {
    preview?.close();
    await archive?.close();
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('picks the last snapshot before the domain was parked', () => {
    const h = result.report.health!;
    assert.equal(h.lastGood?.timestamp, '20201114083015');
    assert.equal(h.window.to, '20210228235959');
    assert.equal(h.host, 'www.oldbakery.example');
    assert.ok(h.months.filter((m) => m.month >= '202103').every((m) => m.verdict === 'bad'));
    assert.equal(result.report.siteUrl, 'https://www.oldbakery.example');
  });

  it('never restores parked content', async () => {
    assert.match(await site('about.php'), /Maria and Paolo Rossi opened the bakery/);
    assert.match(await site('blog/2019/05/sourdough-starter/index.html'), /fed twice a day/);
    const files = (await readdir(result.siteDir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
    for (const f of files) {
      const text = await readFile(path.join(f.parentPath, f.name), 'latin1');
      assert.doesNotMatch(text, /for sale/i, f.name);
    }
  });

  it('serves every original URL at exactly the same address', async () => {
    const cases: Array<[string, number, RegExp]> = [
      ['/', 200, /Fresh bread every morning/],
      ['/about.php', 200, /About the Old Bakery/],
      ['/index.php?page=contact', 200, /12 Elm Street/],
      ['/?p=123', 200, /Holiday opening hours/],
      ['/blog/', 200, /Posts|Blog/],
      ['/blog/2019/05/sourdough-starter/', 200, /sourdough starter alive/],
      ['/blog/2020/03/rye-bread', 200, /crème fraîche/],
      ['/menu.html', 200, /focaccia/],
      ['/orphan.html', 200, /Wholesale orders/],
      ['/tag/bread/', 200, /Posts tagged Bread/],
      ['/feed/', 200, /<rss/],
      ['/css/style.css?ver=1.2', 200, /@import/],
    ];
    for (const [url, status, body] of cases) {
      const res = await fetch(base + url, { redirect: 'manual' });
      assert.equal(res.status, status, url);
      assert.match(await res.text(), body, url);
    }
  });

  it('serves odd URLs through rewrites with the right content type', async () => {
    const captcha = await fetch(base + '/captcha.php');
    assert.equal(captcha.status, 200);
    assert.equal(captcha.headers.get('content-type'), 'image/png');
    const pdf = await fetch(base + '/download');
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const php = await fetch(base + '/about.php');
    assert.match(php.headers.get('content-type') ?? '', /text\/html/);
  });

  it('puts back only the redirects the original site made', async () => {
    const old = await fetch(base + '/old-page.html', { redirect: 'manual' });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get('location'), '/about.php');
    const index = await fetch(base + '/index.php', { redirect: 'manual' });
    assert.equal(index.status, 301);
    assert.equal(index.headers.get('location'), '/');
    assert.equal(result.report.redirects.length, 2);
    const hidden = await fetch(base + '/__wbd/routes.json');
    assert.equal(hidden.status, 404);
    const missing = await fetch(base + '/nope.html');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /could not be found/);
  });

  it('adds the Ghost-style SEO block with canonical, Open Graph and JSON-LD', async () => {
    const home = await site('index.html');
    assert.match(home, /<link rel="canonical" href="https:\/\/www\.oldbakery\.example\/">/);
    assert.match(home, /"@type": "WebSite"/);
    assert.match(home, /<meta property="og:site_name" content="The Old Bakery">/);
    assert.doesNotMatch(home, /google-analytics|UA-123456/);
    assert.doesNotMatch(home, /EditURI|xmlrpc/);
    assert.match(home, /href="\/about\.php"/);
    assert.match(home, /href="\/menu\.html"/);
    assert.match(home, /href="\/index\.php\?page=contact"/);
    assert.match(home, /href="\/css\/style\.css\?ver=1\.2"/);
    assert.doesNotMatch(home, /og:image" content="[^"]*missing\.png/);

    const post = await site('blog/2019/05/sourdough-starter/index.html');
    assert.match(post, /<meta property="og:type" content="article">/);
    assert.match(post, /<meta property="article:published_time" content="2019-05-12T00:00:00Z">/);
    assert.match(post, /"@type": "Article"/);
    assert.match(post, /"name": "Maria Rossi"/);
    assert.match(post, /<link rel="canonical" href="https:\/\/www\.oldbakery\.example\/blog\/2019\/05\/sourdough-starter\/">/);
    assert.match(post, /srcset="\/wp-content\/uploads\/2019\/05\/starter-300x200\.jpg 300w, \/wp-content\/uploads\/2019\/05\/starter\.jpg 1024w"/);

    const contact = await site(await routeFile('/index.php', 'page=contact'));
    assert.match(contact, /<link rel="canonical" href="https:\/\/www\.oldbakery\.example\/index\.php\?page=contact">/);

    const rye = await site('blog/2020/03/rye-bread.html');
    assert.match(rye, /<meta charset="utf-8">/);
    assert.doesNotMatch(rye, /iso-8859-1/);

    const about = await site('about.php');
    assert.ok(about.startsWith('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"'), 'keeps the original doctype');
    assert.ok(!about.includes('<?'), 'no PHP open tags');
  });

  async function routeFile(p: string, q: string): Promise<string> {
    const rules = JSON.parse(await site('__wbd/routes.json')) as { routes: Array<{ path: string; query?: string; file: string }> };
    return rules.routes.find((r) => r.path === p && r.query === q)!.file;
  }

  it('writes Ghost-style sitemaps, RSS and robots.txt', async () => {
    const index = await site('sitemap.xml');
    for (const name of ['sitemap-pages.xml', 'sitemap-posts.xml', 'sitemap-tags.xml', 'sitemap-authors.xml']) {
      assert.match(index, new RegExp(`https://www\\.oldbakery\\.example/${name.replace('.', '\\.')}`));
    }
    const posts = await site('sitemap-posts.xml');
    assert.match(posts, /<loc>https:\/\/www\.oldbakery\.example\/blog\/2019\/05\/sourdough-starter\/<\/loc>/);
    assert.match(posts, /<loc>https:\/\/www\.oldbakery\.example\/blog\/2020\/03\/rye-bread<\/loc>/);
    assert.match(posts, /<loc>https:\/\/www\.oldbakery\.example\/\?p=123<\/loc>/);
    const pages = await site('sitemap-pages.xml');
    assert.match(pages, /index\.php\?page=contact/);
    assert.doesNotMatch(pages, /old-page\.html/);
    assert.match(await site('rss/index.xml'), /How we keep our sourdough starter alive/);
    assert.match(await site('robots.txt'), /Sitemap: https:\/\/www\.oldbakery\.example\/sitemap\.xml/);
  });

  it('writes server rules for Apache, nginx and Netlify', async () => {
    const ht = await site('.htaccess');
    assert.match(ht, /RewriteCond %\{QUERY_STRING\} "\^page=contact\$"/);
    assert.match(ht, /RewriteRule "\^old-page\\\.html\$" "\/about\.php" \[R=301,NE,L\]/);
    const nginx = await readFile(path.join(result.jobDir, 'server', 'nginx.conf'), 'utf8');
    assert.match(nginx, /"\/index\.php\?page=contact" "\/__wbd\/q\/[0-9a-f]{12}\.html";/);
    assert.match(nginx, /try_files \$uri \$uri\.html \$uri\/ =404;/);
    assert.match(await site('_redirects'), /\/old-page\.html {2}\/about\.php {2}301/);
  });

  it('reports what the archive did not have', () => {
    const urls = result.report.missing.map((m) => m.url);
    assert.ok(urls.includes('http://www.oldbakery.example/img/missing.png'));
    assert.ok(result.report.counts.pages >= 11);
  });

  it('packages the site as a ZIP', () => {
    assert.ok(result.zipFile && existsSync(result.zipFile));
    const list = execFileSync('unzip', ['-l', result.zipFile!], { encoding: 'utf8' });
    assert.match(list, /site\/\.htaccess/);
    assert.match(list, /server\/nginx\.conf/);
    assert.match(list, /report\.html/);
  });

  it('resumes without downloading again', async () => {
    const before = archive.requests.filter((r) => r.startsWith('/web/')).length;
    await restore({ domain: 'oldbakery.example', outDir: out, archive: { base: archive.base, ...FAST }, zip: false });
    const playback = archive.requests.filter((r) => r.startsWith('/web/')).length - before;
    // Only the health scan probes the homepage again; no page or file is downloaded twice.
    assert.ok(playback <= 14, `expected only health probes, got ${playback} playback requests`);
  });
});

describe('demo mode and retries', () => {
  it('restores only the first pages in demo mode', async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    const out = await mkdtemp(path.join(os.tmpdir(), 'wbd-'));
    try {
      const r = await restore({ domain: 'oldbakery.example', outDir: out, maxPages: 4, zip: false, archive: { base: archive.base, ...FAST } });
      assert.ok(r.report.counts.pages <= 5, `got ${r.report.counts.pages} pages`);
      assert.ok(existsSync(path.join(r.siteDir, 'index.html')));
    } finally {
      await archive.close();
      await rm(out, { recursive: true, force: true });
    }
  });

  it('waits and retries when the archive says 429 or 503', async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      archive.failNext(429, 2);
      const res = await client.fetchCapture('20201114083015', 'http://www.oldbakery.example/');
      assert.equal(res.kind, 'ok');
      archive.failNext(503, 1);
      const h = await scanHealth(client, 'oldbakery.example');
      assert.equal(h.lastGood?.timestamp, '20201114083015');
    } finally {
      await archive.close();
    }
  });
});
