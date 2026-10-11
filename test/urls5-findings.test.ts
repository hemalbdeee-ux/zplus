// Fifth round of URL checks.
// - One archived URL too long for a rule of nginx.conf (4,095 bytes per parameter) or .htaccess
//   (8,191 bytes per line) is left out of that file and named in the warnings, instead of stopping
//   nginx from loading or making Apache answer 500 for every URL (finding 0).
// - A folder served from index.xml (WordPress /feed/, the generated /rss/) gets a _redirects line,
//   as Pages and Netlify only look for index.html, after the redirects and routes, so that past
//   2,000 lines Pages leaves out feeds, not pages (finding 1).
// - A path with an escaped slash (/tag/AC%2FDC) is a route keyed by the address nginx and Pages
//   read, not a file literally named "AC%2FDC"; next to another slash (/b/%2Fleading) the two are
//   merged once decoded, as nginx and Apache do (finding 2).
// - _headers names a .php page by its URL as archived (/Q%26A.asp, /caf%c3%a9.php) (finding 3).
// - Legacy-charset feeds and text files are converted to UTF-8, and nginx labels only pages and text
//   as UTF-8, as Apache does (findings 4 and 19). A UTF-16 label on bytes with no NUL is not taken.
// - A page served as application/xhtml+xml is read as XML (<script/> is empty) when it is well-formed,
//   as HTML otherwise (finding 21), and a doctype after a long comment, or after a commented-out
//   one, is kept (finding 25).
// nginx, Apache (APACHE2_ROOT as in urls-servers.test.ts) and `wrangler pages dev` run when installed.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildSite, type BuildResult } from '../src/engine/build.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { htaccess, netlifyRedirects, nginxConf, pagesOverflow, type Redirect, type Route } from '../src/engine/serverconfig.ts';
import { pathAndQuery, serverPath, urlKey } from '../src/engine/url.ts';

const H = 'http://example.com';
const page = (mark: string) => `<!doctype html><html><head><title>${mark} | Example</title></head><body><p>MARK[${mark}]</p></body></html>`;
const rss = (mark: string) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>MARK[${mark}]</title></channel></rss>`;
const latin1 = (s: string) => Buffer.from(s, 'latin1');
/** Under the 8 KB request line of nginx and Apache, over what one rule of nginx.conf holds. */
const longQ = 'q=' + 'a.b'.repeat(1000);
/** Also over what one line of .htaccess holds. */
const longerQ = 'q=' + 'a.b'.repeat(2600);
const longTarget = 'http://other.example/' + 'x'.repeat(4200);

interface Capture {
  url: string;
  type?: string;
  body?: string | Buffer;
  status?: number;
  location?: string;
}

const captures: Capture[] = [
  { url: `${H}/`, body: page('home') },
  { url: `${H}/about`, body: page('about') },
  // Finding 0.
  { url: `${H}/search.php?${longQ}`, body: page('long') },
  { url: `${H}/search.php?${longerQ}`, body: page('longer') },
  { url: `${H}/out.php?u=1`, status: 302, location: longTarget },
  // Finding 1.
  { url: `${H}/feed/`, type: 'application/rss+xml; charset=UTF-8', body: rss('feed') },
  { url: `${H}/category/news/feed/`, type: 'application/rss+xml', body: rss('catfeed') },
  { url: `${H}/caf%c3%a9/feed/`, type: 'application/rss+xml', body: rss('cafefeed') },
  // Finding 2.
  { url: `${H}/tag/AC%2FDC`, body: page('acdc') },
  { url: `${H}/files/a%2Fb.pdf`, type: 'application/pdf', body: 'PDF MARK[pdf]' },
  // Next to another slash, which nginx and Apache merge with it once decoded.
  { url: `${H}/share/http%3A%2F%2Fexample.org%2Fpage`, body: page('share') },
  { url: `${H}/b/%2Fleading`, body: page('leading') },
  // Finding 3.
  { url: `${H}/caf%c3%a9.php`, body: page('cafe') },
  { url: `${H}/Q%26A.asp`, body: page('qa') },
  { url: `${H}/c%23.php`, body: page('hash') },
  { url: `${H}/d%2C.php`, body: page('comma') },
  // Findings 4 and 19.
  { url: `${H}/feed.xml`, type: 'text/xml', body: latin1('<?xml version="1.0" encoding="ISO-8859-1"?>\n<rss version="2.0"><channel><title>Caf\xe9 MARK[latin1feed]</title></channel></rss>\n') },
  { url: `${H}/news.rss`, type: 'application/rss+xml; charset=ISO-8859-1', body: latin1('<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Caf\xe9 MARK[news]</title></channel></rss>\n') },
  { url: `${H}/u8.xml`, type: 'text/xml; charset=utf-8', body: Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf\u00e9 MARK[u8]</title></channel></rss>') },
  { url: `${H}/notes.txt`, type: 'text/plain', body: latin1('Caf\xe9 au lait MARK[notes]\n') },
  // What .NET writes: UTF-8 bytes under a UTF-16 declaration, which browsers read as UTF-8.
  { url: `${H}/u16.xml`, type: 'text/xml', body: Buffer.from('<?xml version="1.0" encoding="utf-16"?>\n<rss><channel><title>Caf\u00e9 MARK[u16]</title></channel></rss>\n') },
  { url: `${H}/u16b.xml`, type: 'text/xml', body: latin1('<?xml version=\'1.0\' encoding=\'UTF-16\'?><rss><channel><title>Caf\xe9 MARK[u16b]</title></channel></rss>') },
  { url: `${H}/report.docx`, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xe9, 0x00, 0xff]) },
];

/** [request exactly as sent, "status MARK" or "status Location"] on every host. */
const expected: Array<[string, string]> = [
  ['/', '200 home'],
  ['/about', '200 about'],
  ['/feed/', '200 feed'],
  ['/category/news/feed/', '200 catfeed'],
  ['/caf%c3%a9/feed/', '200 cafefeed'],
  ['/caf%C3%A9/feed/', '200 cafefeed'],
  ['/tag/AC%2FDC', '200 acdc'],
  ['/files/a%2Fb.pdf', '200 pdf'],
  ['/share/http%3A%2F%2Fexample.org%2Fpage', '200 share'],
  ['/b/%2Fleading', '200 leading'],
  ['/caf%c3%a9.php', '200 cafe'],
  ['/Q%26A.asp', '200 qa'],
  ['/feed.xml', '200 latin1feed'],
  ['/notes.txt', '200 notes'],
];

async function build(list: Capture[], work: string): Promise<BuildResult> {
  mkdirSync(path.join(work, 'raw'), { recursive: true });
  const resources: Resource[] = [];
  for (const c of list) {
    const u = new URL(c.url);
    const body = Buffer.isBuffer(c.body) ? c.body : Buffer.from(c.body ?? '');
    const sha1 = createHash('sha1').update(body).digest('hex');
    const status = c.status ?? 200;
    if (status === 200) writeFileSync(path.join(work, 'raw', sha1), body);
    resources.push({
      key: urlKey(u),
      url: c.url,
      path: pathAndQuery(u),
      timestamp: '20200101000000',
      status,
      contentType: c.type ?? 'text/html',
      ...(status === 200 ? { file: sha1, sha1 } : { location: c.location }),
      via: 'link',
    });
  }
  const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
  return buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: work, outDir: path.join(work, 'site'), serverDir: path.join(work, 'server'), stripTracking: false });
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

interface Answer {
  /** "status MARK" for a page or file, "status Location" for a redirect. */
  got: string;
  type: string;
  body: Buffer;
}

/** The path is sent as is. */
const probe = (port: number, p: string) =>
  new Promise<Answer>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: 'example.com' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const s = res.statusCode!;
        const body = Buffer.concat(chunks);
        const got = s >= 300 && s < 400 ? `${s} ${String(res.headers.location).replace(/^https?:\/\/example\.com/, '')}` : `${s} ${/MARK\[([^\]]+)\]/.exec(body.toString('latin1'))?.[1] ?? '-'}`;
        resolve({ got, type: String(res.headers['content-type'] ?? ''), body });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`no answer for ${p.slice(0, 80)}`)));
    req.end();
  });

async function waitFor(port: number) {
  for (let i = 0; i < 200; i++) {
    if (await probe(port, '/').then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing answers on port ${port}`);
}

const check = async (port: number, list: Array<[string, string]>) => {
  const wrong: string[] = [];
  for (const [url, want] of list) {
    const { got } = await probe(port, url);
    if (got !== want) wrong.push(`${url.slice(0, 80)}: ${got}, expected ${want}`);
  }
  assert.deepEqual(wrong, []);
};

const work = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls5-'));
const siteDir = path.join(work, 'site');
const serverDir = path.join(work, 'server');
let result: BuildResult;
const stops: Array<() => void> = [];

before(async () => {
  result = await build(captures, work);
  // Apache drops root rights to read the site.
  const open = (p: string) => {
    chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) open(path.join(p, f));
  };
  open(work);
});

after(async () => {
  for (const stop of stops) stop();
  await rm(work, { recursive: true, force: true });
});

const site = (rel: string) => readFile(path.join(siteDir, rel));

describe('a rule too long for a server file', () => {
  it('is left out of that file only, and named in the warnings', async () => {
    const nginx = await readFile(path.join(serverDir, 'nginx.conf'), 'utf8');
    // Every quoted parameter fits in nginx's 4,096-byte buffer, every .htaccess line in 8,191 bytes.
    for (const token of nginx.match(/"(?:[^"\\]|\\.)*"/g) ?? []) assert.ok(token.length <= 4095, `${token.length}-byte parameter`);
    for (const line of (await site('.htaccess')).toString('utf8').split('\n')) assert.ok(line.length <= 8191, `${line.length}-byte line`);
    assert.doesNotMatch(nginx, /a\\\\\.ba/);
    assert.doesNotMatch(nginx, /other\.example/);
    const apache = (await site('.htaccess')).toString('utf8');
    assert.ok(apache.includes('a\\.ba\\.b'), 'the rule for the shorter URL stays in .htaccess');
    assert.ok(apache.includes(longTarget), 'so does the redirect');
    const nginxWarning = result.warnings.find((w) => w.includes('nginx.conf'));
    assert.match(nginxWarning ?? '', /^3 original URL\(s\) such as \/out\.php\?u=1 /);
    const apacheWarning = result.warnings.find((w) => w.includes('.htaccess ('));
    assert.match(apacheWarning ?? '', /^1 original URL\(s\) such as \/search\.php\?q=a\.ba/);
    // Both still in routes.json: the preview serves them.
    assert.equal(result.routes.filter((x) => x.path === '/search.php').length, 2);
  });

  it('is reported by the generators themselves', () => {
    const routes: Route[] = [
      { path: '/s.php', rawPath: '/s.php', query: longQ, file: '__wbd/q/a.html' },
      { path: '/t.php', rawPath: '/t.php', query: 'x=1', file: '__wbd/q/b.html' },
    ];
    const redirects: Redirect[] = [{ path: '/out.php', rawPath: '/out.php', to: longTarget, status: 302 }];
    const skipped: Array<Route | Redirect> = [];
    const conf = nginxConf({ domain: 'example.com', host: 'example.com', routes, redirects, types: [] }, skipped);
    assert.deepEqual(skipped, [redirects[0], routes[0]]);
    assert.match(conf, /"~\^\/t\\\\\.php\\\\\?&x=1&\$" "\/__wbd\/q\/b\.html";/);
    const lines: Array<Route | Redirect> = [];
    htaccess({ domain: 'example.com', host: 'example.com', routes: [{ ...routes[0], query: longerQ }, routes[1]], redirects, types: [] }, lines);
    assert.deepEqual(lines, [{ ...routes[0], query: longerQ }]);
  });
});

describe('a folder served from index.xml', () => {
  it('gets a _redirects line, the generated /rss/ too', async () => {
    const lines = (await site('_redirects')).toString('utf8').split('\n');
    for (const want of [
      '/feed/  /feed/index.xml  200',
      '/category/news/feed/  /category/news/feed/index.xml  200',
      '/caf%C3%A9/feed/  /caf%C3%A9/feed/index.xml  200',
      '/caf%c3%a9/feed/  /caf%C3%A9/feed/index.xml  200',
      '/rss/  /rss/index.xml  200',
    ]) {
      assert.ok(lines.includes(want), want);
    }
    // After the redirects and routes, which lead to pages, before the patterns: past 2,000 plain
    // lines, Pages leaves out a feed rather than a page.
    const at = (l: string) => lines.indexOf(l);
    assert.ok(lines.findLastIndex((l) => l.includes('/__wbd/')) < at('/feed/  /feed/index.xml  200'));
    assert.ok(at('/caf%c3%a9/feed/  /caf%C3%A9/feed/index.xml  200') < at('/*/index.html  /:splat/  200'));
    assert.ok(at('/rss/  /rss/index.xml  200') < at('/*/index.html  /:splat/  200'));
  });

  it('comes after every redirect and route, so Pages leaves out feeds first', () => {
    const files = ['index.html', ...Array.from({ length: 2100 }, (_, i) => [`post-${i}/index.html`, `post-${i}/feed/index.xml`]).flat()];
    const redirects: Redirect[] = Array.from({ length: 5 }, (_, i) => ({ path: `/old-${i}/`, rawPath: `/old-${i}/`, to: `/post-${i}/`, status: 301 }));
    const routes: Route[] = [{ path: '/tag/AC/DC', rawPath: '/tag/AC%2FDC', file: '__wbd/f/a.html' }];
    const text = netlifyRedirects({ domain: 'example.com', host: 'example.com', routes, redirects, types: [], files });
    const plain = text.split('\n').filter((l) => l.startsWith('/') && !l.includes('*'));
    for (const d of redirects) assert.ok(plain.indexOf(`${d.rawPath}  ${d.to}  301`) < 2000, d.rawPath);
    assert.ok(plain.indexOf('/tag/AC%2FDC  /__wbd/f/a  200') < 2000);
    assert.ok(plain.indexOf('/post-0/feed/  /post-0/feed/index.xml  200') < 2000);
    assert.equal(pagesOverflow(text, ''), plain.length - 2000);
  });

  it('does not get one next to an index.html', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls5-xml-'));
    try {
      await build(
        [
          { url: `${H}/`, body: page('home') },
          { url: `${H}/news/`, body: page('news') },
          { url: `${H}/news/index.xml`, type: 'application/rss+xml', body: rss('news') },
        ],
        dir,
      );
      const text = readFileSync(path.join(dir, 'site', '_redirects'), 'utf8');
      assert.doesNotMatch(text, /^\/news\//m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('an escaped slash in a path', () => {
  it('is served from a route, not a file named "%2F"', () => {
    const find = (p: string) => result.routes.find((x) => x.rawPath === p);
    assert.match(find('/tag/AC%2FDC')?.file ?? '', /^__wbd\/f\/\w+\.html$/);
    assert.match(find('/files/a%2Fb.pdf')?.file ?? '', /^__wbd\/f\/\w+\.pdf$/);
    assert.ok(!existsSync(path.join(siteDir, 'tag')));
    assert.ok(!existsSync(path.join(siteDir, 'files')));
    assert.ok(result.warnings.some((w) => w.startsWith('4 original URL(s) such as http://example.com/tag/AC%2FDC') && w.includes('AllowEncodedSlashes On')));
  });

  it('is keyed by the address nginx and Apache read, with the slashes merged once decoded', async () => {
    assert.equal(serverPath('/b/%2Fleading'), '/b/leading');
    assert.equal(serverPath('//share/http%3A%2F%2Fexample.org'), '/share/http:/example.org');
    const conf = await readFile(path.join(serverDir, 'nginx.conf'), 'utf8');
    assert.match(conf, /"~\^\/b\/leading\$"/);
    assert.match(conf, /"~\^\/share\/http:\/example\\\\\.org\/page\$"/);
  });

  it('has a raw-path line for Cloudflare Pages', async () => {
    assert.match((await site('_redirects')).toString('utf8'), /^\/tag\/AC%2FDC {2}\/__wbd\/f\/\w+ {2}200$/m);
  });
});

describe('a .php page whose URL is not spelled as its file name', () => {
  it('gets a _headers rule for the URL as archived', async () => {
    const rules = (await site('_headers'))
      .toString('utf8')
      .split('\n')
      .filter((l) => l.startsWith('/'));
    for (const want of ['/caf%c3%a9.php', '/caf%C3%A9.php', '/Q%26A.asp', '/Q&A.asp', '/c%23.php', '/d%2C.php', '/d,.php']) assert.ok(rules.includes(want), want);
    assert.ok(!rules.includes('/c#.php'), 'a "#" ends the path for Pages');
  });
});

describe('legacy-charset feeds and text files', () => {
  it('are written as UTF-8, with a declaration that says so', async () => {
    assert.equal((await site('feed.xml')).toString('utf8'), '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Café MARK[latin1feed]</title></channel></rss>\n');
    assert.equal((await site('news.rss')).toString('utf8'), '<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Café MARK[news]</title></channel></rss>\n');
    // Read as UTF-8 under its Content-Type: the declaration that said otherwise is corrected.
    assert.equal((await site('u8.xml')).toString('utf8'), '<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Café MARK[u8]</title></channel></rss>');
    assert.equal((await site('notes.txt')).toString('utf8'), 'Café au lait MARK[notes]\n');
    // A UTF-16 label on bytes with no NUL cannot be true: UTF-8 stays as it is, other bytes are windows-1252.
    assert.equal((await site('u16.xml')).toString('utf8'), '<?xml version="1.0" encoding="UTF-8"?>\n<rss><channel><title>Café MARK[u16]</title></channel></rss>\n');
    assert.equal((await site('u16b.xml')).toString('utf8'), "<?xml version='1.0' encoding='UTF-8'?><rss><channel><title>Café MARK[u16b]</title></channel></rss>");
    assert.deepEqual(await site('report.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xe9, 0x00, 0xff]));
  });

  it('are not labelled UTF-8 by nginx unless they are pages or text', async () => {
    assert.match(await readFile(path.join(serverDir, 'nginx.conf'), 'utf8'), /^ {4}charset utf-8;\n(?: {4}#.*\n)* {4}charset_types text\/plain;$/m);
  });
});

describe('a page served as application/xhtml+xml', () => {
  it('is read as XML, as browsers read it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls5-xhtml-'));
    try {
      const r = await build(
        [
          { url: `${H}/`, body: page('home') },
          {
            url: `${H}/notes`,
            type: 'application/xhtml+xml; charset=utf-8',
            body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><title>Notes | Example</title>
<script type="text/javascript" src="/js/site.js"/>
<style type="text/css"><![CDATA[ p > a { color: #333 } ]]></style>
<meta name="description" content="Notes on things &amp; more"/>
</head>
<body><div id="sidebar"/><h1>My notes</h1><p>Visible &amp; text&nbsp;here.<![CDATA[ 1 < 2 ]]></p>
<script type="text/javascript">if (1 &lt; 2 &amp;&amp; true) document.title += '!';</script>
<script type="text/javascript"><![CDATA[ if (1 < 2) document.title += '?'; ]]></script>
</body></html>`,
          },
          { url: `${H}/js/site.js`, type: 'application/javascript', body: 'window.site = 1;' },
        ],
        dir,
      );
      const html = readFileSync(path.join(dir, 'site', 'notes.html'), 'utf8');
      // XML always renders in standards mode.
      assert.ok(html.startsWith('<!DOCTYPE html><html'), html.slice(0, 80));
      assert.match(html, /<script type="text\/javascript" src="\/js\/site\.js"><\/script>/);
      assert.match(html, /<style type="text\/css"> p > a \{ color: #333 \} <\/style>/);
      assert.match(html, /<body><div id="sidebar"><\/div><h1>My notes<\/h1><p>Visible &amp; text&nbsp;here\. 1 &lt; 2 <\/p>/);
      assert.match(html, /<script type="text\/javascript">if \(1 < 2 && true\) document\.title \+= '!';<\/script>/);
      assert.match(html, /<script type="text\/javascript"> if \(1 < 2\) document\.title \+= '\?'; <\/script>/);
      assert.equal(r.pages.find((pg) => pg.path === '/notes')?.description, 'Notes on things & more');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is read as HTML when it is no XML, as browsers that got it as text/html read it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls5-xhtml2-'));
    const xhtml = (head: string, body: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T | Example</title>${head}</head><body>${body}</body></html>`;
    const loop = 'for (var i=0;i<n;i++) { if (a&&b) x(i); }';
    const pages: Record<string, string> = {
      // Each <br> left open would hold the rest of the page in XML: thousands of levels.
      breaks: xhtml('', `<p>${'line<br>'.repeat(3000)}MARK[breaks]</p>`),
      paras: xhtml('', '<div><p>one<p>two<p>three</div><p>MARK[paras]</p>'),
      loop: xhtml(`<script type="text/javascript">${loop}</script><style type="text/css">p { color: red }</style>`, '<p>MARK[loop]</p>'),
      deep: xhtml('', `${'<div>'.repeat(600)}MARK[deep]${'</div>'.repeat(600)}`),
      // XML: the script is empty, the comments in a script and a style keep what they hold.
      hidden: xhtml(
        '<script type="text/javascript" src="/a.js"/><style type="text/css"><!-- p { color: red } --></style><script type="text/javascript"><!--\nwindow.a = 1;\n//--></script>',
        '<p>MARK[hidden]</p>',
      ),
    };
    try {
      await build([{ url: `${H}/`, body: page('home') }, ...Object.entries(pages).map(([name, body]) => ({ url: `${H}/${name}`, type: 'application/xhtml+xml', body }))], dir);
      const out = (name: string) => readFileSync(path.join(dir, 'site', `${name}.html`), 'utf8');
      assert.equal(out('breaks').match(/<br>/g)?.length, 3000);
      assert.match(out('breaks'), /<br>MARK\[breaks\]<\/p>/);
      assert.match(out('paras'), /<div><p>one<\/p><p>two<\/p><p>three<\/p><\/div><p>MARK\[paras\]<\/p>/);
      assert.ok(out('loop').includes(`<script type="text/javascript">${loop}</script><style type="text/css">p { color: red }</style>`), out('loop'));
      assert.match(out('deep'), /MARK\[deep\]/);
      const hidden = out('hidden');
      assert.match(hidden, /<script type="text\/javascript" src="\/a\.js"><\/script><style type="text\/css"><!-- p \{ color: red \} --><\/style>/);
      assert.match(hidden, /<script type="text\/javascript"><!--\nwindow\.a = 1;\n\/\/--><\/script>/);
      assert.match(hidden, /<body><p>MARK\[hidden\]<\/p>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the doctype of a page', () => {
  it('is kept after any number of comments, and only the real one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls5-dt-'));
    const body = '<html><head><title>t</title></head><body><table height="100%"><tr><td>x</td></tr></table></body></html>';
    const dt = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">';
    // [source, how the written page starts, how many doctypes it holds (copies in comments included)]
    const pages: Record<string, [string, string, number]> = {
      longcomment: [`<!--\n${'  Copyright notice and change log.\n'.repeat(140)}-->\n${dt}\n${body}`, `<!--\n  Copyright`, 1],
      longspace: [`${' '.repeat(5000)}\n${dt}\n${body}`, dt, 1],
      commented: [`<!-- <!DOCTYPE html> -->\n${dt}\n${body}`, `<!-- <!DOCTYPE html> -->${dt}<html>`, 2],
      bogus: [`<?php echo 1 ?>${dt}${body}`, `<!--?php echo 1 ?-->${dt}<html>`, 1],
      // Text before a doctype makes it no doctype at all, and one in a script is just text.
      textfirst: [`x<!DOCTYPE html>${body}`, '<html>', 0],
      inscript: [`<html><head><script>var d = '${dt}';</script></head><body></body></html>`, '<html>', 1],
    };
    try {
      await build([{ url: `${H}/`, body: page('home') }, ...Object.entries(pages).map(([name, [source]]) => ({ url: `${H}/${name}.html`, body: source }))], dir);
      for (const [name, [, start, count]] of Object.entries(pages)) {
        const html = readFileSync(path.join(dir, 'site', `${name}.html`), 'utf8');
        assert.ok(html.startsWith(start), `${name}: ${html.slice(0, 120)}`);
        assert.equal(html.match(/<!doctype[^>]*>/gi)?.length ?? 0, count, name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the fifth-round site on the preview server', () => {
  it('answers every original URL', async () => {
    const server = await createPreviewServer(siteDir);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    stops.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    await check(port, [...expected, [`/search.php?${longQ}`, '200 long'], [`/search.php?${longerQ}`, '200 longer'], ['/out.php?u=1', `302 ${longTarget}`]]);
  });
});

const nginxProbe = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
describe('the fifth-round site on nginx', { skip: nginxProbe.error || nginxProbe.status !== 0 ? 'nginx is not installed' : false }, () => {
  it('loads and answers every URL its rules hold', async () => {
    const dir = path.join(work, 'nginx');
    mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    const port = await freePort();
    const conf = (await readFile(path.join(serverDir, 'nginx.conf'), 'utf8')).replace('listen 80;', `listen 127.0.0.1:${port};`).replace(/root [^;]+;/, `root ${siteDir};`);
    writeFileSync(path.join(dir, 'site.conf'), conf);
    writeFileSync(path.join(dir, 'mime.types'), 'types { text/html html; text/plain txt; text/xml xml; application/rss+xml rss; application/pdf pdf; }\n');
    writeFileSync(
      path.join(dir, 'nginx.conf'),
      `daemon off; master_process off; pid ${dir}/nginx.pid; error_log ${dir}/error.log;\nevents {}\n` +
        `http {\n  access_log off;\n  client_body_temp_path ${dir}/tmp;\n  include ${dir}/site.conf;\n}\n`,
    );
    const t = spawnSync('nginx', ['-t', '-p', dir, '-c', path.join(dir, 'nginx.conf')], { encoding: 'utf8' });
    assert.equal(t.status, 0, t.stderr);
    const nginx = spawn('nginx', ['-p', dir, '-c', path.join(dir, 'nginx.conf')], { stdio: 'ignore' });
    stops.push(() => nginx.kill());
    await waitFor(port);
    await check(port, expected);
    // Left out of nginx.conf: they do not answer as archived, and nothing else breaks.
    assert.equal((await probe(port, `/search.php?${longQ}`)).got, '404 -');
    assert.equal((await probe(port, '/out.php?u=1')).got, '404 -');
    assert.equal((await probe(port, '/feed.xml')).type, 'text/xml');
    assert.equal((await probe(port, '/news.rss')).type, 'application/rss+xml');
    assert.equal((await probe(port, '/notes.txt')).type, 'text/plain; charset=utf-8');
    assert.equal((await probe(port, '/')).type, 'text/html; charset=utf-8');
  });
});

// Apache: APACHE2_ROOT (an unpacked package), or apache2 / httpd on the PATH.
const apacheRoot = process.env.APACHE2_ROOT;
const apacheBin = apacheRoot ? path.join(apacheRoot, 'usr/sbin/apache2') : ['apache2', 'httpd'].find((b) => !spawnSync(b, ['-v']).error);
const apacheModules = apacheRoot
  ? path.join(apacheRoot, 'usr/lib/apache2/modules')
  : ['/usr/lib/apache2/modules', '/usr/lib64/httpd/modules', '/usr/lib/httpd/modules'].find((d) => existsSync(d));
const apacheEnv = { ...process.env, ...(apacheRoot ? { LD_LIBRARY_PATH: path.join(apacheRoot, 'usr/lib/x86_64-linux-gnu') } : {}) };
const apacheOk = apacheBin && apacheModules && !spawnSync(apacheBin, ['-v'], { env: apacheEnv }).error;

describe('the fifth-round site on Apache', { skip: apacheOk ? false : 'Apache is not installed (set APACHE2_ROOT)' }, () => {
  // An escaped slash needs "AllowEncodedSlashes On", which the build warning asks for.
  for (const encodedSlashes of [false, true]) {
    it(`answers every URL its rules hold${encodedSlashes ? ', with AllowEncodedSlashes On' : ''}`, async () => {
      const dir = path.join(work, `apache-${encodedSlashes}`);
      mkdirSync(dir, { recursive: true });
      const port = await freePort();
      writeFileSync(path.join(dir, 'mime.types'), 'text/html html\ntext/plain txt\napplication/xml xml\napplication/pdf pdf\n');
      const root = process.getuid?.() === 0;
      writeFileSync(
        path.join(dir, 'httpd.conf'),
        [
          `ServerRoot "${dir}"`,
          'ServerName localhost',
          `Listen 127.0.0.1:${port}`,
          `PidFile ${dir}/httpd.pid`,
          `ErrorLog ${dir}/error.log`,
          ...['mpm_prefork', 'authz_core', 'mime', 'dir', 'rewrite', 'headers', 'alias']
            .filter((m) => existsSync(path.join(apacheModules!, `mod_${m}.so`)))
            .map((m) => `LoadModule ${m}_module ${apacheModules}/mod_${m}.so`),
          ...(root ? ['User nobody', 'Group nogroup'] : []),
          ...(encodedSlashes ? ['AllowEncodedSlashes On'] : []),
          `TypesConfig ${dir}/mime.types`,
          `DocumentRoot "${siteDir}"`,
          `<Directory "${siteDir}">`,
          '  AllowOverride All',
          '  Require all granted',
          '</Directory>',
        ].join('\n') + '\n',
      );
      const apache = spawn(apacheBin!, ['-f', path.join(dir, 'httpd.conf'), '-X'], { env: apacheEnv, stdio: 'ignore' });
      stops.push(() => apache.kill());
      await waitFor(port);
      const slashed = (u: string) => u.includes('%2F');
      await check(port, encodedSlashes ? expected : expected.filter(([u]) => !slashed(u)));
      if (!encodedSlashes) for (const [u] of expected.filter(([x]) => slashed(x))) assert.equal((await probe(port, u)).got, '404 -');
      // The shorter long URL fits in .htaccess, the longer one is left out of it.
      assert.equal((await probe(port, `/search.php?${longQ}`)).got, '200 long');
      assert.notEqual((await probe(port, `/search.php?${longerQ}`)).got, '200 longer');
      assert.equal((await probe(port, '/out.php?u=1')).got, `302 ${longTarget}`);
      assert.equal((await probe(port, '/feed.xml')).type, 'application/xml');
    });
  }
});

// The real Cloudflare Pages emulator: wrangler on the PATH, or the binary WRANGLER names.
const wranglerBin = process.env.WRANGLER ?? 'wrangler';
const wranglerProbe = spawnSync(wranglerBin, ['--version'], { encoding: 'utf8' });
describe('the fifth-round site on wrangler pages dev', { skip: wranglerProbe.error || wranglerProbe.status !== 0 ? 'wrangler is not installed' : false }, () => {
  it('answers every URL without a query string, .php pages as HTML', async () => {
    const port = await freePort();
    const wrangler = spawn(wranglerBin, ['pages', 'dev', siteDir, '--ip', '127.0.0.1', '--port', String(port)], {
      cwd: work,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: 'ignore',
    });
    stops.push(() => wrangler.kill());
    for (let i = 0; i < 600; i++) {
      if (await probe(port, '/').then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await check(port, expected);
    for (const u of ['/caf%c3%a9.php', '/Q%26A.asp', '/c%23.php', '/d%2C.php']) assert.match((await probe(port, u)).type, /^text\/html/, u);
    const feed = await probe(port, '/rss/');
    assert.match(feed.got, /^200 /);
    assert.match(feed.body.toString('utf8'), /^<\?xml[^>]*\?>\s*<rss /);
  });
});
