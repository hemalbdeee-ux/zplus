import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanDocument } from '../src/engine/clean.ts';
import { loadHtml, visibleText } from '../src/engine/html.ts';
import { extractMeta } from '../src/engine/meta.ts';
import { applySeo, type SiteContext } from '../src/engine/seo.ts';

const SITE: SiteContext = { siteUrl: 'https://www.example.com', siteName: 'Example' };

function ldTypes($: ReturnType<typeof loadHtml>): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['@type'] === 'string') out.push(o['@type']);
      if (o['@graph']) walk(o['@graph']);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).html() ?? ''));
    } catch {
      // the page's own broken block
    }
  });
  return out;
}

describe('frameset pages read their <noframes> text (finding 31)', () => {
  it('describes a frameset page by its noframes text, not its markup', () => {
    const $ = loadHtml(`<html><head><title>Frames</title></head><frameset cols="20%,*"><frame src="menu.html"><frame src="main.html">
<noframes><body><p>This site uses <b>frames</b>. Go to <a href="main.html">main</a>.</p></body></noframes></frameset></html>`);
    assert.equal(visibleText($), 'This site uses frames. Go to main.');
    const meta = extractMeta($, new URL('http://example.com/'), 'example.com');
    assert.equal(meta.description, 'This site uses frames. Go to main.');
    applySeo($, meta, SITE);
    assert.doesNotMatch($.html(), /content="&lt;body|content="<body|"description": "<body/);
  });

  it('takes a long noframes paragraph as the description', () => {
    const para = 'Fresh bread, cakes and pastries baked every morning in our wood-fired oven since 1952.';
    const $ = loadHtml(`<frameset rows="80,*"><frame src="top.htm"><frame src="home.htm"></frameset><noframes><h1>Bakery</h1><p>${para}</p></noframes>`);
    assert.equal(extractMeta($, new URL('http://example.com/'), 'example.com').description, para);
  });

  it('leaves noframes and noembed out of a normal page', () => {
    const $ = loadHtml('<body><div>Hi</div><noembed><p>No <b>plugin</b></p></noembed><noframes><p>x</p></noframes></body>');
    assert.equal(visibleText($), 'Hi');
  });
});

describe("the page's own structured data survives the SEO layer (finding 32)", () => {
  it('keeps Recipe, Product and FAQPage blocks and replaces Article, WebPage and BreadcrumbList', () => {
    const recipe = { '@context': 'https://schema.org', '@type': 'Recipe', name: 'Sourdough', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', ratingCount: '31' } };
    const yoast = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': 'https://example.com/#website', url: 'https://example.com/' },
        { '@type': ['WebPage', 'ItemPage'], '@id': 'https://example.com/r/#webpage' },
        { '@type': 'BlogPosting', headline: 'Old article' },
        { '@type': 'Product', name: 'Starter kit', offers: { '@type': 'Offer', price: '9.00' } },
        { '@type': 'BreadcrumbList', itemListElement: [] },
      ],
    };
    const webpage = { '@context': 'https://schema.org', '@type': 'WebPage', mainEntity: { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] } };
    const $ = loadHtml(`<html><head><title>Sourdough | Bakery</title>
<script type="application/ld+json">${JSON.stringify(recipe)}</script>
<script type="application/ld+json">${JSON.stringify(yoast)}</script>
<script type="application/ld+json">{ broken json </script>
</head><body><article><h1>Sourdough</h1><p>${'Our sourdough needs a lively starter and a long, cool overnight rise. '.repeat(2)}</p>
<script type="application/ld+json">${JSON.stringify(webpage)}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Sourdough"}</script></article></body></html>`);
    const meta = extractMeta($, new URL('http://example.com/recipes/sourdough.php'), 'example.com');
    applySeo($, meta, SITE);
    const types = ldTypes($);
    for (const t of ['Recipe', 'Product', 'FAQPage']) assert.ok(types.includes(t), t);
    assert.equal(types.filter((t) => t === 'BreadcrumbList').length, 1, 'only the seo-head breadcrumb');
    assert.ok(!types.includes('BlogPosting') && !types.includes('WebSite'));
    assert.equal(types.filter((t) => t === 'Article' || t === 'WebPage').length, 1, 'only the seo-head block');
    assert.match($.html(), /"ratingValue": ?"4\.8"/);
    assert.match($.html(), /\{ broken json <\/script>/, 'unreadable JSON-LD is left as it was');
    const faq = $('script[type="application/ld+json"]')
      .toArray()
      .map((el) => $(el).html() ?? '')
      .find((s) => s.includes('"FAQPage"'));
    assert.equal(JSON.parse(faq!)['@context'], 'https://schema.org');
  });

  it('keeps a Yoast FAQ page node, typed ["WebPage","FAQPage"], with its questions', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': 'https://example.com/#website', url: 'https://example.com/' },
        {
          '@type': ['WebPage', 'FAQPage'],
          '@id': 'https://example.com/faq/',
          name: 'FAQ',
          isPartOf: { '@id': 'https://example.com/#website' },
          breadcrumb: { '@id': 'https://example.com/faq/#breadcrumb' },
          mainEntity: [{ '@id': 'https://example.com/faq/#q1' }],
        },
        { '@type': 'BreadcrumbList', '@id': 'https://example.com/faq/#breadcrumb', itemListElement: [] },
        { '@type': 'Question', '@id': 'https://example.com/faq/#q1', name: 'Can I freeze bread?', acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } },
      ],
    };
    const video = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'Shaping', video: { '@type': 'VideoObject', name: 'Shaping a boule' } };
    const $ = loadHtml(`<html><head><title>FAQ</title><script type="application/ld+json">${JSON.stringify(graph)}</script>
<script type="application/ld+json">${JSON.stringify(video)}</script></head><body><h1>FAQ</h1></body></html>`);
    applySeo($, extractMeta($, new URL('http://example.com/faq/'), 'example.com'), SITE);
    const blocks = $('script[type="application/ld+json"]').toArray().map((el) => JSON.parse($(el).html() ?? ''));
    const faq = blocks[0]['@graph'];
    assert.deepEqual(faq[0], { '@type': 'FAQPage', '@id': 'https://example.com/faq/', name: 'FAQ', mainEntity: [{ '@id': 'https://example.com/faq/#q1' }] });
    assert.equal(faq[1]['@type'], 'Question');
    assert.equal(faq.length, 2, 'WebSite and BreadcrumbList nodes go, and so do the references to them');
    assert.deepEqual(blocks[1], { '@context': 'https://schema.org', '@type': 'VideoObject', name: 'Shaping a boule' });
  });
});

describe('WordPress static pages are pages, not posts (finding 50)', () => {
  const page = (extra: string) => `<html lang="en"><head><title>About us | Bakery</title><meta property="og:type" content="article">${extra}</head>
<body class="page-template-default page page-id-2 wp-custom-logo">
<main><article id="post-2" class="post-2 page type-page status-publish hentry"><h1>About us</h1>
<p>Maria and Paolo Rossi opened the bakery in 1952 and still bake every loaf by hand before dawn.</p></article></main>
<aside><h2>Recent posts</h2><ul><li><a href="/2019/05/rye/">Rye</a> <time datetime="2019-05-03">May 3, 2019</time></li></ul></aside></body></html>`;
  const yoast = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://example.com/about-us/","datePublished":"2018-03-01T10:00:00+00:00","dateModified":"2020-01-01T10:00:00+00:00"}]}</script>`;

  it('classifies a Yoast page with og:type article and a dated WebPage as a page', () => {
    const $ = loadHtml(page(yoast));
    cleanDocument($, { stripTracking: true });
    const meta = extractMeta($, new URL('http://example.com/about-us/'), 'example.com');
    assert.equal(meta.type, 'page');
    assert.equal(meta.modifiedAt, '2020-01-01T10:00:00Z');
    applySeo($, meta, SITE);
    assert.match($.html(), /<meta property="og:type" content="website">/);
  });

  it('does not take the date of a sidebar widget', () => {
    const $ = loadHtml(page('').replace('page-template-default page page-id-2 ', '').replace('page type-page', 'type-post'));
    const meta = extractMeta($, new URL('http://example.com/about-us/'), 'example.com');
    assert.equal(meta.publishedAt, undefined);
    assert.equal(meta.type, 'page');
  });

  it('still recognizes a WordPress post', () => {
    const $ = loadHtml(`<html><head><title>Rye | Bakery</title><meta property="og:type" content="article">
<meta property="article:published_time" content="2019-05-03T08:00:00+00:00"></head>
<body class="post-template-default single single-post postid-7"><article class="post-7 post type-post"><h1>Rye</h1>
<p>Rye has almost no gluten, so the dough behaves more like clay than like wheat dough does.</p></article></body></html>`);
    const meta = extractMeta($, new URL('http://example.com/rye/'), 'example.com');
    assert.equal(meta.type, 'post');
    assert.equal(meta.publishedAt, '2019-05-03T08:00:00Z');
  });
});
