// The SEO layer, modelled on what Ghost's {{ghost_head}} helper prints: one block just before
// </head> with canonical, description, Open Graph, Twitter card, JSON-LD and the RSS link.
// URLs are never changed here; the canonical of a page is its own original URL on the new host.

import type { AnyNode } from 'domhandler';
import { removeNode, type Doc } from './html.ts';
import type { PageMeta, PageType } from './meta.ts';

export interface SiteContext {
  siteUrl: string;
  siteName: string;
  siteDescription?: string;
  logo?: string;
  rssPath?: string;
}

export function absolute(siteUrl: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  return siteUrl + (href.startsWith('/') ? href : '/' + href);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsonLd(data: unknown): string {
  return JSON.stringify(data, null, 4).replace(/</g, '\\u003c');
}

export function canonicalFor(meta: PageMeta, site: SiteContext): string {
  return absolute(site.siteUrl, meta.canonicalPath ?? meta.path);
}

/** What the page is called when it is shared: like Ghost, the homepage by the site title, everything else by its own headline. */
function shareTitle(meta: PageMeta, site: SiteContext): string {
  return (meta.type === 'home' ? meta.title : meta.headline) || meta.title || site.siteName;
}

export function buildJsonLd(meta: PageMeta, site: SiteContext): Record<string, unknown>[] {
  const url = canonicalFor(meta, site);
  const home = site.siteUrl + '/';
  const image = meta.image ? absolute(site.siteUrl, meta.image) : undefined;
  const publisher: Record<string, unknown> = { '@type': 'Organization', name: site.siteName, url: home };
  if (site.logo) publisher.logo = { '@type': 'ImageObject', url: absolute(site.siteUrl, site.logo) };

  const out: Record<string, unknown>[] = [];
  if (meta.type === 'home') {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      url: home,
      name: site.siteName,
      description: site.siteDescription ?? meta.description,
      publisher,
      ...(image ? { image: { '@type': 'ImageObject', url: image } } : {}),
      ...(meta.lang ? { inLanguage: meta.lang } : {}),
    });
    return out;
  }
  // A page with no title or heading of its own (a frame, a menu) goes by the site's name, as in og:title.
  const name = shareTitle(meta, site);
  if (meta.type === 'post') {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: name,
      url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      description: meta.description,
      ...(meta.publishedAt ? { datePublished: meta.publishedAt } : {}),
      ...(meta.modifiedAt || meta.publishedAt ? { dateModified: meta.modifiedAt ?? meta.publishedAt } : {}),
      ...(image ? { image: { '@type': 'ImageObject', url: image } } : {}),
      ...(meta.tags.length ? { keywords: meta.tags.join(', ') } : {}),
      ...(meta.author ? { author: { '@type': 'Person', name: meta.author } } : {}),
      publisher,
      ...(meta.lang ? { inLanguage: meta.lang } : {}),
    });
  } else {
    const type = meta.type === 'author' ? 'ProfilePage' : meta.type === 'page' ? 'WebPage' : 'CollectionPage';
    out.push({
      '@context': 'https://schema.org',
      '@type': type,
      name,
      url,
      description: meta.description,
      ...(image ? { primaryImageOfPage: { '@type': 'ImageObject', url: image } } : {}),
      isPartOf: { '@type': 'WebSite', url: home, name: site.siteName },
      ...(meta.lang ? { inLanguage: meta.lang } : {}),
    });
  }
  // Every crumb needs a name; one that would only repeat the site's says nothing, so such a page has no trail.
  if (meta.headline || meta.title) {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: site.siteName, item: home },
        { '@type': 'ListItem', position: 2, name: meta.headline || meta.title, item: url },
      ],
    });
  }
  return out;
}

/** The seo-head block (what Ghost's {{ghost_head}} prints), as HTML lines. */
export function seoHead(meta: PageMeta, site: SiteContext, opts: { rssLink?: boolean; indent?: string } = {}): string {
  const indent = opts.indent ?? '    ';
  const url = canonicalFor(meta, site);
  const isArticle = meta.type === 'post';
  const image = meta.image ? absolute(site.siteUrl, meta.image) : undefined;
  const title = shareTitle(meta, site);
  const lines: string[] = [];
  const add = (s: string) => lines.push(s ? indent + s : '');

  if (meta.description) add(`<meta name="description" content="${esc(meta.description)}">`);
  if (meta.noindex) add('<meta name="robots" content="noindex">');
  add(`<link rel="canonical" href="${esc(url)}">`);
  add(`<meta name="referrer" content="no-referrer-when-downgrade">`);
  add('');
  add(`<meta property="og:site_name" content="${esc(site.siteName)}">`);
  add(`<meta property="og:type" content="${isArticle ? 'article' : 'website'}">`);
  add(`<meta property="og:title" content="${esc(title)}">`);
  if (meta.description) add(`<meta property="og:description" content="${esc(meta.description)}">`);
  add(`<meta property="og:url" content="${esc(url)}">`);
  if (image) add(`<meta property="og:image" content="${esc(image)}">`);
  if (isArticle && meta.publishedAt) add(`<meta property="article:published_time" content="${meta.publishedAt}">`);
  if (isArticle && (meta.modifiedAt || meta.publishedAt)) add(`<meta property="article:modified_time" content="${meta.modifiedAt ?? meta.publishedAt}">`);
  if (isArticle) for (const t of meta.tags) add(`<meta property="article:tag" content="${esc(t)}">`);
  add('');
  add(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  add(`<meta name="twitter:title" content="${esc(title)}">`);
  if (meta.description) add(`<meta name="twitter:description" content="${esc(meta.description)}">`);
  add(`<meta name="twitter:url" content="${esc(url)}">`);
  if (image) add(`<meta name="twitter:image" content="${esc(image)}">`);
  if (!meta.noindex) {
    add('');
    for (const block of buildJsonLd(meta, site)) {
      add(`<script type="application/ld+json">\n${jsonLd(block)}\n${indent}</script>`);
    }
  }
  if (site.rssPath && (opts.rssLink ?? true)) {
    add('');
    add(`<link rel="alternate" type="application/rss+xml" title="${esc(site.siteName)}" href="${esc(absolute(site.siteUrl, site.rssPath))}">`);
  }
  return lines.join('\n');
}

const REMOVE = [
  'link[rel="canonical"]',
  'meta[property^="og:"]',
  'meta[property^="article:"]',
  'meta[name^="twitter:"]',
  'meta[property^="twitter:"]',
  'meta[name="description" i]',
  'meta[name="generator" i]',
  'meta[charset]',
  'link[rel="shortlink"]',
  'link[rel="EditURI"]',
  'link[rel="wlwmanifest"]',
  'link[rel="pingback"]',
  'link[rel="https://api.w.org/"]',
  'link[type="application/json+oembed"]',
  'link[type="text/xml+oembed"]',
];

// The JSON-LD types the seo-head block writes, and the plain WebPage subtypes it stands in for; the
// page's own nodes of these types make way for it. FAQPage and QAPage are WebPages too, but they
// earn rich results of their own, so they stay.
const REGENERATED = new Set([
  'WebSite', 'WebPage', 'AboutPage', 'CheckoutPage', 'ContactPage', 'ItemPage', 'SearchResultsPage', 'CollectionPage', 'ProfilePage',
  'BreadcrumbList',
]);
// The block writes an Article only for a post. On any other page nothing takes the place of the
// page's own article (a WordPress static page, an undated news story), so it stays.
const ARTICLES = new Set(['Article', 'BlogPosting', 'NewsArticle']);
const regenerated = (t: string, type: PageType) => (ARTICLES.has(t) ? type === 'post' : REGENERATED.has(t));
// What a dropped page or article node holds that earns rich results of its own.
const HOISTED = ['mainEntity', 'video'];

type LdNode = Record<string, unknown>;
const isNode = (v: unknown): v is LdNode => !!v && typeof v === 'object' && !Array.isArray(v);
/** A bare {"@id": ...}: a reference to a node described elsewhere. */
const isRef = (v: unknown): v is { '@id': string } => isNode(v) && typeof v['@id'] === 'string' && Object.keys(v).length === 1;

/**
 * What stays of one node: all of it; only its own types when the seo-head writes some of them
 * (Yoast marks an FAQ page ["WebPage", "FAQPage"]); or, when it writes all of them, the Recipe,
 * FAQPage or VideoObject the node held. A top-level node passes its @context on to what it held.
 * The ids of dropped nodes go to `dropped`.
 */
function keepLd(node: unknown, top: boolean, dropped: Set<string>, type: PageType): unknown[] {
  if (!isNode(node)) return [node];
  const types = [node['@type']].flat().filter((t): t is string => typeof t === 'string');
  const own = types.filter((t) => !regenerated(t, type));
  if (own.length === types.length) return [node];
  if (own.length) return [{ ...node, '@type': own.length === 1 ? own[0] : own }];
  if (typeof node['@id'] === 'string') dropped.add(node['@id']);
  const context = top ? node['@context'] : undefined;
  return HOISTED.flatMap((k) => [node[k] ?? []].flat())
    .filter((n): n is LdNode => isNode(n) && !isRef(n))
    .flatMap((n) => keepLd(context && !('@context' in n) ? { '@context': context, ...n } : n, top, dropped, type));
}

/** The value without references to dropped nodes (isPartOf, breadcrumb, ...); the same object when it has none. */
function unlink(v: unknown, dropped: Set<string>): unknown {
  const gone = (x: unknown) => isRef(x) && dropped.has(x['@id']);
  if (Array.isArray(v)) {
    const out = v.filter((x) => !gone(x)).map((x) => unlink(x, dropped));
    return out.length === v.length && out.every((x, i) => x === v[i]) ? v : out;
  }
  if (!isNode(v)) return v;
  let out: LdNode | undefined;
  for (const [k, x] of Object.entries(v)) {
    const y = gone(x) ? undefined : unlink(x, dropped);
    if (y === x) continue;
    out ??= { ...v };
    if (y === undefined || (Array.isArray(y) && !y.length)) delete out[k];
    else out[k] = y;
  }
  return out ?? v;
}

/**
 * Removes the page's own JSON-LD that the seo-head block replaces and keeps the rest: the Recipe,
 * Product, FAQPage, Event or LocalBusiness markup that earned the page its rich results. Yoast and
 * plugins put those in one @graph, so this works node by node, and references to the dropped
 * nodes go with them.
 */
function pruneJsonLd($: Doc, type: PageType): void {
  const blocks: Array<{ el: AnyNode; data: unknown; graph: boolean; nodes: unknown[]; kept: unknown[] }> = [];
  const dropped = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data: unknown = JSON.parse($(el).html() ?? '');
      const graph = isNode(data) && Array.isArray(data['@graph']);
      const nodes = graph ? (data['@graph'] as unknown[]) : Array.isArray(data) ? data : [data];
      blocks.push({ el, data, graph, nodes, kept: nodes.flatMap((n) => keepLd(n, !graph, dropped, type)) });
    } catch {
      // Unreadable (or nested past what the parser can take): leave the site's markup as it was.
    }
  });
  // A node another block still describes is not gone.
  for (const b of blocks) for (const n of b.kept) if (isNode(n) && typeof n['@id'] === 'string') dropped.delete(n['@id']);
  for (const { el, data, graph, nodes, kept: pruned } of blocks) {
    let kept = pruned;
    try {
      if (dropped.size) kept = unlink(kept, dropped) as unknown[];
      if (kept.length === nodes.length && kept.every((n, i) => n === nodes[i])) continue;
      if (!kept.length) removeNode($, el);
      else $(el).text(`\n${jsonLd(graph ? { ...(data as LdNode), '@graph': kept } : Array.isArray(data) || kept.length > 1 ? kept : kept[0])}\n`);
    } catch {
      // As above: too deep to walk or to write back.
    }
  }
}

export function applySeo($: Doc, meta: PageMeta, site: SiteContext): void {
  for (const sel of REMOVE) $(sel).each((_, el) => removeNode($, el));
  pruneJsonLd($, meta.type);
  $('meta[http-equiv]').each((_, el) => {
    if (($(el).attr('http-equiv') ?? '').toLowerCase() === 'content-type') removeNode($, el);
  });
  // hreflang alternates must be absolute.
  $('link[rel="alternate"][hreflang][href^="/"]').each((_, el) => {
    $(el).attr('href', absolute(site.siteUrl, $(el).attr('href')!));
  });

  if (!$('head').length) $('html').prepend('<head></head>');
  $('head').prepend('<meta charset="utf-8">\n');

  // The page keeps its own robots meta, so the block does not add another one.
  const block = seoHead({ ...meta, noindex: false }, site, { rssLink: !$('link[rel="alternate"][type="application/rss+xml"]').length });
  $('head').append(`\n    <!-- seo-head -->\n${block}\n    <!-- /seo-head -->\n`);
}
