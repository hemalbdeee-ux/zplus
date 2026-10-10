// "The Old Bakery": a small bakery site that was fine from 2015 to late 2020, then expired and
// became a parking page. It has the URL shapes real old sites have: .php pages, a query-string
// page, extensionless blog URLs, a WordPress-style ?p= link, a dynamic image behind .php, a
// windows-1252 page, links wrapped in web.archive.org, and redirects the site itself made.

import type { FakeCapture } from '../fake-archive.ts';

const W = 'http://www.oldbakery.example';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%fake menu\n');

const LOREM =
  'Our bakers start at four in the morning. The dough for every loaf rests overnight, which gives the crust its colour and the crumb its open texture. ' +
  'We buy flour from two mills in the valley and use no improvers or preservatives. Bread that is left at closing time goes to the food bank on Main Street. ';

function homepage(year: number, extra = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The Old Bakery | Fresh bread in Springfield</title>
<meta name="description" content="Family bakery in Springfield since 1998. Sourdough, rye and pastries baked every morning.">
<link rel="stylesheet" href="/css/style.css?ver=1.2">
<link rel="canonical" href="http://www.oldbakery.example/">
<link rel="EditURI" type="application/rsd+xml" href="http://www.oldbakery.example/xmlrpc.php?rsd">
<link rel="alternate" type="application/rss+xml" title="Old Bakery feed" href="/feed/">
<script src="https://www.google-analytics.com/analytics.js"></script>
<script>window.ga=window.ga||function(){};ga('create','UA-123456-1','auto');ga('send','pageview');</script>
</head>
<body class="home">
<div id="logo"><img src="/img/logo.png" alt="The Old Bakery"></div>
<nav>
 <a href="/">Home</a>
 <a href="http://www.oldbakery.example/about.php">About</a>
 <a href="/index.php?page=contact">Contact</a>
 <a href="/blog/">Blog</a>
 <a href="https://web.archive.org/web/20190101000000/http://www.oldbakery.example/menu.html">Menu</a>
 <a href="/old-page.html">Our history</a>
</nav>
<main>
<h1>Fresh bread every morning (${year})</h1>
<p>We have been baking sourdough, rye and seasonal pastries in Springfield since 1998. Everything is made by hand in our wood-fired oven, from starters we have kept alive for over twenty years.</p>
<p>${LOREM}</p>
<p>${LOREM}</p>
<h2>Latest from the blog</h2>
<ul>
<li><a href="/blog/2019/05/sourdough-starter/">How we keep our sourdough starter alive</a></li>
<li><a href="/blog/2020/03/rye-bread">Why rye bread needs patience</a></li>
<li><a href="/?p=123">Holiday opening hours</a></li>
</ul>
${extra}
<p style="background:url('/img/wheat.png')">Follow us on <a href="https://twitter.com/oldbakery">Twitter</a>.</p>
<img src="/img/missing.png" alt="Shop front">
</main>
<footer>&copy; The Old Bakery</footer>
</body>
</html>`;
}

const PARKED = `<!DOCTYPE html><html><head><title>oldbakery.example</title></head>
<body><h1>oldbakery.example</h1><p>This domain may be for sale. Buy this domain today!</p>
<p>Related searches: bread recipes, bakery near me</p></body></html>`;

function page(title: string, body: string, head = ''): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title} | The Old Bakery</title>
<link rel="stylesheet" href="/css/style.css?ver=1.2">${head}</head>
<body><nav><a href="/">Home</a> <a href="/about.php">About</a> <a href="/blog/">Blog</a></nav>
<main>${body}</main></body></html>`;
}

const ABOUT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>About us | The Old Bakery</title></head>
<body><nav><a href="/">Home</a></nav><h1>About the Old Bakery</h1>
<p>Maria and Paolo Rossi opened the bakery in 1998 in the old post office building on Elm Street. ${LOREM}</p>
<p>Download our <a href="/download">menu (PDF)</a>.</p>
</body></html>`;

const RYE_1252 = Buffer.from(
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Why rye bread needs patience | The Old Bakery</title>
<meta property="og:type" content="article"><meta property="article:published_time" content="2020-03-18T09:00:00+00:00"></head>
<body><nav><a href="/">Home</a></nav><article><h1>Why rye bread needs patience</h1>
<p>Rye has almost no gluten, so the dough behaves more like clay than like wheat dough. Serve it with crème fraîche and smoked fish. ${LOREM}</p>
<p><a rel="tag" href="/tag/bread/">Bread</a></p></article></body></html>`,
  'latin1',
);

export const OLD_BAKERY: FakeCapture[] = [
  // Homepage over the years: good until 2020-11, parked from 2021.
  { url: `${W}/`, ts: '20150310120000', body: homepage(2015) },
  { url: `${W}/`, ts: '20160612120000', body: homepage(2016) },
  { url: `${W}/`, ts: '20170704120000', body: homepage(2017) },
  { url: `${W}/`, ts: '20180815120000', body: homepage(2018) },
  { url: `${W}/`, ts: '20190920120000', body: homepage(2019) },
  { url: `${W}/`, ts: '20200406120000', body: homepage(2020) },
  { url: `${W}/`, ts: '20201114083015', body: homepage(2020, '<p>We are closed on 25 December.</p>') },
  { url: `${W}/`, ts: '20210320101010', body: PARKED },
  { url: `${W}/`, ts: '20210915101010', body: PARKED },
  { url: `${W}/`, ts: '20220610101010', body: PARKED },
  { url: `${W}/`, ts: '20230301101010', body: PARKED },

  // Pages
  { url: `${W}/about.php`, ts: '20190921120000', body: ABOUT },
  { url: `${W}/about.php`, ts: '20210321101010', body: PARKED },
  { url: `${W}/index.php?page=contact`, ts: '20200407120000', body: page('Contact', '<h1>Contact</h1><p>12 Elm Street, Springfield. Call 555-0100.</p><img src="/captcha.php" alt="captcha">') },
  { url: `${W}/index.php`, ts: '20200407120000', status: 301, location: `${W}/` },
  { url: `${W}/menu.html`, ts: '20190102120000', body: page('Menu', `<h1>Menu</h1><p>Sourdough, rye, focaccia and croissants. ${LOREM}</p>`) },
  { url: `${W}/old-page.html`, ts: '20180101120000', status: 301, location: `${W}/about.php` },
  { url: `${W}/orphan.html`, ts: '20180505120000', body: page('Wholesale', `<h1>Wholesale orders</h1><p>We supply cafés and restaurants. ${LOREM}</p>`) },
  { url: `${W}/blog/`, ts: '20200410120000', body: page('Blog', '<h1>Blog</h1><ul><li><a href="/blog/2019/05/sourdough-starter/">Sourdough</a></li><li><a href="/blog/2020/03/rye-bread">Rye</a></li><li><a href="/tag/bread/">Bread</a></li><li><a href="/author/maria/">Maria</a></li></ul>') },
  {
    url: `${W}/blog/2019/05/sourdough-starter/`,
    ts: '20190513120000',
    body: page(
      'How we keep our sourdough starter alive',
      `<article><h1>How we keep our sourdough starter alive</h1>
<p class="meta"><time datetime="2019-05-12">12 May 2019</time> by <a rel="author" href="/author/maria/">Maria Rossi</a></p>
<img src="/wp-content/uploads/2019/05/starter.jpg" srcset="/wp-content/uploads/2019/05/starter-300x200.jpg 300w, http://www.oldbakery.example/wp-content/uploads/2019/05/starter.jpg 1024w" alt="Starter">
<p>Our starter is fed twice a day with equal parts flour and water, at a temperature of 24 degrees. ${LOREM}</p>
<p>Tags: <a rel="tag" href="/tag/bread/">Bread</a>, <a rel="tag" href="/tag/sourdough/">Sourdough</a></p>
</article>`,
      '<meta property="og:image" content="http://www.oldbakery.example/wp-content/uploads/2019/05/starter.jpg">',
    ),
  },
  { url: `${W}/blog/2019/05/sourdough-starter/`, ts: '20220101101010', body: PARKED },
  { url: `${W}/blog/2020/03/rye-bread`, ts: '20200320120000', type: 'text/html', body: RYE_1252 },
  {
    url: `${W}/?p=123`,
    ts: '20191202120000',
    body: page(
      'Holiday opening hours',
      `<article><h1>Holiday opening hours</h1><p>Open 8 to 14 on 24 December, closed on 25 and 26 December. ${LOREM}</p></article>`,
      '<meta property="article:published_time" content="2019-12-01T08:00:00Z"><meta property="og:type" content="article">',
    ),
  },
  { url: `${W}/tag/bread/`, ts: '20200410120000', body: page('Bread', '<h1>Posts tagged Bread</h1><a href="/blog/2019/05/sourdough-starter/">Sourdough</a>') },
  { url: `${W}/author/maria/`, ts: '20200410120000', body: page('Maria Rossi', '<h1>Maria Rossi</h1><p>Head baker.</p>') },

  // Assets
  {
    url: `${W}/css/style.css?ver=1.2`,
    ts: '20200406120000',
    type: 'text/css',
    body: `@import url("/css/print.css");\nbody{background:url(../img/bg.png)}\n.hero{background:url(http://www.oldbakery.example/img/wheat.png)}\n`,
  },
  { url: `${W}/css/print.css`, ts: '20200406120000', type: 'text/css', body: 'nav{display:none}' },
  { url: `${W}/img/bg.png`, ts: '20200406120000', type: 'image/png', body: PNG },
  { url: `${W}/img/wheat.png`, ts: '20200406120000', type: 'image/png', body: PNG },
  { url: `${W}/img/logo.png`, ts: '20200406120000', type: 'image/png', body: PNG },
  { url: `${W}/captcha.php`, ts: '20200407120000', type: 'image/png', body: PNG },
  { url: `${W}/download`, ts: '20190921120000', type: 'application/pdf', body: PDF },
  { url: `${W}/wp-content/uploads/2019/05/starter.jpg`, ts: '20190513120000', type: 'image/jpeg', body: JPG },
  { url: `${W}/wp-content/uploads/2019/05/starter-300x200.jpg`, ts: '20190513120000', type: 'image/jpeg', body: JPG },
  {
    url: `${W}/feed/`,
    ts: '20200410120000',
    type: 'application/rss+xml',
    body: `<?xml version="1.0"?><rss version="2.0"><channel><title>The Old Bakery</title><link>http://www.oldbakery.example/</link></channel></rss>`,
  },
];
