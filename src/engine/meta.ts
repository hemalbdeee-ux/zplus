// Reads what a page is about from its own markup: title, description, image, dates, author,
// tags, and whether it is a blog post, a plain page or a tag/author/date archive. The SEO layer
// and the sitemaps are built from this.

import type { Doc } from './html.ts';
import { visibleText } from './html.ts';
import { isInternal, pathAndQuery, toUrl } from './url.ts';

export type PageType = 'home' | 'post' | 'page' | 'tag' | 'author' | 'archive';

export interface PageMeta {
  /** Original path plus query, unchanged. */
  path: string;
  type: PageType;
  title: string;
  headline: string;
  description: string;
  /** Root-relative or absolute URL. */
  image?: string;
  publishedAt?: string;
  modifiedAt?: string;
  author?: string;
  tags: string[];
  lang?: string;
  noindex: boolean;
  /** Original canonical path (same site only). */
  canonicalPath?: string;
  siteNameHint?: string;
}

const TAG_PATH = /\/(tag|tags|category|categories|topics?|labels?|search\/label)\/[^/]+\/?$/i;
const AUTHOR_PATH = /\/author\/[^/]+\/?$/i;
const ARCHIVE_PATH = /\/page\/\d+\/?$|^\/(19|20)\d{2}\/((0[1-9]|1[0-2])\/)?((0[1-9]|[12]\d|3[01])\/)?$/;
const DATE_IN_PATH = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])(?:\/(0[1-9]|[12]\d|3[01]))?\//;

function attr($: Doc, selector: string, name = 'content'): string | undefined {
  const v = $(selector).first().attr(name);
  return v && v.trim() ? v.trim() : undefined;
}

function toIsoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!/\d{4}/.test(s)) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  if (y < 1991 || y > 2100) return undefined;
  return d.toISOString().replace(/\.000Z$/, 'Z');
}

function jsonLdObjects($: Doc): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      out.push(v as Record<string, unknown>);
      const graph = (v as Record<string, unknown>)['@graph'];
      if (graph) walk(graph);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).html() ?? ''));
    } catch {
      // Broken JSON-LD on old sites is common; ignore it.
    }
  });
  return out;
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}

function contentRoot($: Doc) {
  for (const sel of ['article', 'main', '[role="main"]', '.entry-content', '.post-content', '.post', '#content', '.content', 'body']) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 80) return el;
  }
  return $('body');
}

export interface ExtractOptions {
  /** True when the restored site has a file for this original path (images that are not in the archive are skipped). */
  hasPath?: (pathAndQuery: string) => boolean;
}

export function extractMeta($: Doc, pageUrl: URL, domain: string, opts: ExtractOptions = {}): PageMeta {
  const path = pathAndQuery(pageUrl);
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  const ld = jsonLdObjects($);
  const ldType = ld.map((o) => String(o['@type'] ?? '')).join(' ');
  const ldPublished = ld.map((o) => o.datePublished).find((v): v is string => typeof v === 'string');
  const ldModified = ld.map((o) => o.dateModified).find((v): v is string => typeof v === 'string');

  const ogTitle = attr($, 'meta[property="og:title"]') ?? attr($, 'meta[name="twitter:title"]');
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const headline = ogTitle ?? (h1 && h1.length <= 140 ? h1 : '') ?? '';

  const root = contentRoot($);
  let description =
    attr($, 'meta[name="description" i]') ??
    attr($, 'meta[property="og:description"]') ??
    attr($, 'meta[name="twitter:description"]') ??
    '';
  if (!description) {
    const p = root
      .find('p')
      .toArray()
      .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      .find((t) => t.length >= 60);
    description = p ?? visibleText($).slice(0, 400);
  }
  description = truncate(description, 160);

  const candidates = [
    attr($, 'meta[property="og:image"]'),
    attr($, 'meta[name="twitter:image"]'),
    attr($, 'link[rel="image_src"]', 'href'),
    ...root
      .find('img[src]')
      .toArray()
      .map((el) => $(el).attr('src') ?? '')
      .filter((src) => src && !/(logo|icon|avatar|spacer|pixel|blank|1x1|badge|button|banner-ad|captcha)/i.test(src) && !/\.gif(\?|$)/i.test(src)),
  ];
  let image: string | undefined;
  for (const c of candidates) {
    const u = c ? toUrl(c, pageUrl) : null;
    if (!u || !/^https?:$/.test(u.protocol)) continue;
    if (!isInternal(u, domain)) {
      image = u.toString();
      break;
    }
    if (opts.hasPath && !opts.hasPath(pathAndQuery(u)) && !opts.hasPath(u.pathname)) continue;
    image = pathAndQuery(u);
    break;
  }

  const timeEl = root.find('time[datetime]').first().attr('datetime') ?? $('time[datetime]').first().attr('datetime');
  const pathDate = DATE_IN_PATH.exec(pageUrl.pathname);
  const publishedAt =
    toIsoDate(attr($, 'meta[property="article:published_time"]')) ??
    toIsoDate(attr($, 'meta[itemprop="datePublished"]')) ??
    toIsoDate($('[itemprop="datePublished"]').first().attr('datetime')) ??
    toIsoDate(ldPublished) ??
    toIsoDate(attr($, 'meta[name="date" i]') ?? attr($, 'meta[name="pubdate" i]') ?? attr($, 'meta[name="DC.date.issued" i]')) ??
    toIsoDate(timeEl) ??
    (pathDate ? toIsoDate(`${pathDate[1]}-${pathDate[2]}-${pathDate[3] ?? '01'}`) : undefined);
  const modifiedAt = toIsoDate(attr($, 'meta[property="article:modified_time"]')) ?? toIsoDate(ldModified);

  const authorRaw =
    attr($, 'meta[name="author" i]') ??
    (() => {
      const a = attr($, 'meta[property="article:author"]');
      return a && !/^https?:/i.test(a) ? a : undefined;
    })() ??
    $('a[rel~="author"]').first().text().trim() ??
    '';
  const author =
    (authorRaw || $('[itemprop="author"] [itemprop="name"], [itemprop="author"], .author .fn, .byline .author, .entry-author').first().text())
      .replace(/\s+/g, ' ')
      .replace(/^by\s+/i, '')
      .trim()
      .slice(0, 80) || undefined;

  const tags = new Set<string>();
  $('meta[property="article:tag"]').each((_, el) => {
    const v = $(el).attr('content')?.trim();
    if (v) tags.add(v);
  });
  $('a[rel~="tag"]').each((_, el) => {
    const v = $(el).text().replace(/\s+/g, ' ').trim();
    if (v && v.length <= 50) tags.add(v);
  });

  const robots = (attr($, 'meta[name="robots" i]') ?? '').toLowerCase();
  const canonicalHref = attr($, 'link[rel="canonical"]', 'href');
  const canonicalUrl = canonicalHref ? toUrl(canonicalHref, pageUrl) : null;
  const canonicalPath = canonicalUrl && isInternal(canonicalUrl, domain) ? pathAndQuery(canonicalUrl) : undefined;

  const pathOnly = pageUrl.pathname;
  const query = pageUrl.search;
  const ogType = (attr($, 'meta[property="og:type"]') ?? '').toLowerCase();
  const bodyClass = $('body').attr('class') ?? '';
  const looksLikePost =
    !!pathDate ||
    ogType === 'article' ||
    /\b(BlogPosting|NewsArticle|Article)\b/.test(ldType) ||
    /\b(single-post|single|post-template)\b/.test(bodyClass) ||
    $('article').length === 1;

  let type: PageType;
  if (path === '/') type = 'home';
  else if (TAG_PATH.test(pathOnly) || /[?&](cat|tag)=/.test(query)) type = 'tag';
  else if (AUTHOR_PATH.test(pathOnly) || /[?&]author=/.test(query)) type = 'author';
  else if (ARCHIVE_PATH.test(pathOnly) || /[?&](paged|m)=\d/.test(query)) type = 'archive';
  else if (publishedAt && looksLikePost) type = 'post';
  else type = 'page';

  return {
    path,
    type,
    title,
    headline: headline || title,
    description,
    image,
    publishedAt,
    modifiedAt,
    author,
    tags: [...tags].slice(0, 20),
    lang: $('html').attr('lang')?.trim() || undefined,
    noindex: /\bnoindex\b/.test(robots),
    canonicalPath,
    siteNameHint: attr($, 'meta[property="og:site_name"]') ?? attr($, 'meta[name="application-name" i]'),
  };
}

/** Site name: og:site_name, else the title part most pages share ("Post title | Site name"). */
export function guessSiteName(titles: string[], homeTitle: string, hint: string | undefined, domain: string): string {
  if (hint) return hint;
  const counts = new Map<string, number>();
  for (const t of titles) {
    const parts = t.split(/\s+[|–—\-:·»]\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    for (const p of new Set([parts[0], parts[parts.length - 1]])) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best && titles.length >= 3 && best[1] >= Math.max(2, titles.length * 0.3)) return best[0];
  const home = homeTitle.split(/\s+[|–—\-:·»]\s+/)[0]?.trim();
  return home || domain;
}
