// The SEO layer, modelled on what Ghost's {{ghost_head}} helper prints: one block just before
// </head> with canonical, description, Open Graph, Twitter card, JSON-LD and the RSS link.
// URLs are never changed here; the canonical of a page is its own original URL on the new host.

import { removeNode, type Doc } from './html.ts';
import type { PageMeta } from './meta.ts';

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
  if (meta.type === 'post') {
    out.push({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: meta.headline,
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
      name: meta.headline,
      url,
      description: meta.description,
      ...(image ? { primaryImageOfPage: { '@type': 'ImageObject', url: image } } : {}),
      isPartOf: { '@type': 'WebSite', url: home, name: site.siteName },
      ...(meta.lang ? { inLanguage: meta.lang } : {}),
    });
  }
  out.push({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: site.siteName, item: home },
      { '@type': 'ListItem', position: 2, name: meta.headline, item: url },
    ],
  });
  return out;
}

/** The seo-head block (what Ghost's {{ghost_head}} prints), as HTML lines. */
export function seoHead(meta: PageMeta, site: SiteContext, opts: { rssLink?: boolean; indent?: string } = {}): string {
  const indent = opts.indent ?? '    ';
  const url = canonicalFor(meta, site);
  const isArticle = meta.type === 'post';
  const image = meta.image ? absolute(site.siteUrl, meta.image) : undefined;
  // Like Ghost: the homepage is shared under the site title, everything else under its own headline.
  const title = (meta.type === 'home' ? meta.title : meta.headline) || meta.title || site.siteName;
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

// The JSON-LD types the seo-head block writes; the page's own nodes of these types make way for it.
const REGENERATED = new Set(['WebSite', 'WebPage', 'CollectionPage', 'ProfilePage', 'Article', 'BlogPosting', 'NewsArticle', 'BreadcrumbList']);

type LdNode = Record<string, unknown>;
const isNode = (v: unknown): v is LdNode => !!v && typeof v === 'object' && !Array.isArray(v);

/** What stays of one node: all of it, or only its mainEntity (a Recipe, FAQPage, ...) when the seo-head writes its type. */
function keepLd(node: unknown): unknown[] {
  if (!isNode(node) || ![node['@type']].flat().some((t) => typeof t === 'string' && REGENERATED.has(t))) return [node];
  const context = node['@context'];
  return [node.mainEntity ?? []]
    .flat()
    .filter(isNode)
    .flatMap((n) => keepLd(context && !('@context' in n) ? { '@context': context, ...n } : n));
}

/**
 * Removes the page's own JSON-LD that the seo-head block replaces and keeps the rest: the Recipe,
 * Product, FAQPage, Event or LocalBusiness markup that earned the page its rich results. Yoast and
 * plugins put those in one @graph, so this works node by node.
 */
function pruneJsonLd($: Doc): void {
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).html() ?? '');
    } catch {
      return; // Unreadable: leave the site's markup as it was.
    }
    const graph = isNode(data) && Array.isArray(data['@graph']) ? (data['@graph'] as unknown[]) : undefined;
    const nodes = graph ?? (Array.isArray(data) ? data : [data]);
    const kept = nodes.flatMap(keepLd);
    if (kept.length === nodes.length && kept.every((n, i) => n === nodes[i])) return;
    if (!kept.length) removeNode($, el);
    else $(el).text(`\n${jsonLd(graph ? { ...(data as LdNode), '@graph': kept } : Array.isArray(data) || kept.length > 1 ? kept : kept[0])}\n`);
  });
}

export function applySeo($: Doc, meta: PageMeta, site: SiteContext): void {
  for (const sel of REMOVE) $(sel).each((_, el) => removeNode($, el));
  pruneJsonLd($);
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
