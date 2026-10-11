// A page whose original canonical names an address the restored site does not answer keeps its
// own address as canonical, so no page points search engines at a 404 (review finding 23).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { restore } from '../src/engine/restore.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const W = 'http://www.shop.example';
const words = Array.from({ length: 300 }, (_, i) => `bread${i % 40}`).join(' ');
const page = (title: string, head = '', body = '') =>
  `<!DOCTYPE html><html lang="en"><head><title>${title}</title>${head}</head><body>` +
  `<a href="/">Home</a> <a href="/item.php?id=5&amp;sid=8f2a">Item</a> <a href="/blog/?page=2">Older</a> <a href="/a.html">A</a> <a href="/b.html">B</a>` +
  `<p>${words}</p>${body}</body></html>`;

const SITE: FakeCapture[] = [
  { url: `${W}/`, ts: '20190601000000', body: page('Shop') },
  { url: `${W}/item.php?id=5&sid=8f2a`, ts: '20190601000000', body: page('Item 5', '<link rel="canonical" href="http://www.shop.example/item.php">') },
  { url: `${W}/blog/?page=2`, ts: '20190601000000', body: page('Older posts', '<link rel="canonical" href="http://www.shop.example/blog/">') },
  { url: `${W}/a.html`, ts: '20190601000000', body: page('A', '<link rel="canonical" href="http://www.shop.example/b.html">') },
  { url: `${W}/b.html`, ts: '20190601000000', body: page('B') },
];

describe('canonical only to an address the site answers', () => {
  it('drops a canonical to a never-captured bare path, keeps one to a restored page', async () => {
    const archive = await startFakeArchive(SITE);
    const out = await mkdtemp(path.join(os.tmpdir(), 'zp-canon-'));
    try {
      const r = await restore({ domain: 'shop.example', outDir: out, zip: false, archive: { base: archive.base, ...FAST } });
      const rules = JSON.parse(await readFile(path.join(r.siteDir, '__wbd', 'routes.json'), 'utf8')) as { routes: Array<{ rawPath: string; query?: string; file: string }> };
      const file = (p: string, q: string) => path.join(r.siteDir, rules.routes.find((x) => x.rawPath === p && x.query === q)!.file);
      const item = await readFile(file('/item.php', 'id=5&sid=8f2a'), 'utf8');
      assert.match(item, /<link rel="canonical" href="https:\/\/www\.shop\.example\/item\.php\?id=5&amp;sid=8f2a">/);
      const older = await readFile(file('/blog/', 'page=2'), 'utf8');
      assert.match(older, /<link rel="canonical" href="https:\/\/www\.shop\.example\/blog\/\?page=2">/);
      const a = await readFile(path.join(r.siteDir, 'a.html'), 'utf8');
      assert.match(a, /<link rel="canonical" href="https:\/\/www\.shop\.example\/b\.html">/);
      const sitemap = await readFile(path.join(r.siteDir, 'sitemap-pages.xml'), 'utf8');
      assert.match(sitemap, /item\.php\?id=5&amp;sid=8f2a/);
    } finally {
      await archive.close();
      await rm(out, { recursive: true, force: true });
    }
  });
});
