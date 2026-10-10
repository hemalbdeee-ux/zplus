// Sitemaps, robots.txt and the RSS feed, laid out the way Ghost serves them:
// /sitemap.xml is an index pointing at sitemap-pages.xml, sitemap-posts.xml, sitemap-tags.xml and
// sitemap-authors.xml, styled by /sitemap.xsl.

import { absolute } from './seo.ts';

export interface SitemapEntry {
  path: string;
  lastmod?: string;
  image?: string;
}

export interface FeedItem {
  title: string;
  path: string;
  description: string;
  publishedAt: string;
  author?: string;
  tags: string[];
  image?: string;
}

const MAX_PER_FILE = 50_000;

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function urlset(siteUrl: string, entries: SitemapEntry[]): string {
  const rows = entries.map((e) => {
    const parts = [`<loc>${xmlEscape(absolute(siteUrl, e.path))}</loc>`];
    if (e.lastmod) parts.push(`<lastmod>${e.lastmod}</lastmod>`);
    if (e.image) parts.push(`<image:image><image:loc>${xmlEscape(absolute(siteUrl, e.image))}</image:loc></image:image>`);
    return `<url>${parts.join('')}</url>`;
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">` +
    rows.join('') +
    `</urlset>\n`
  );
}

function newest(entries: SitemapEntry[]): string | undefined {
  return entries.map((e) => e.lastmod).filter((v): v is string => !!v).sort().pop();
}

/** Returns file name -> XML for the index and every non-empty group. */
export function sitemaps(siteUrl: string, groups: Record<'pages' | 'posts' | 'tags' | 'authors', SitemapEntry[]>): Map<string, string> {
  const files = new Map<string, string>();
  const index: Array<{ name: string; lastmod?: string }> = [];
  for (const [group, entries] of Object.entries(groups)) {
    if (!entries.length) continue;
    const sorted = [...entries].sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? '') || a.path.localeCompare(b.path));
    for (let i = 0; i * MAX_PER_FILE < sorted.length; i++) {
      const chunk = sorted.slice(i * MAX_PER_FILE, (i + 1) * MAX_PER_FILE);
      const name = `sitemap-${group}${i ? `-${i + 1}` : ''}.xml`;
      files.set(name, urlset(siteUrl, chunk));
      index.push({ name, lastmod: newest(chunk) });
    }
  }
  files.set(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      index.map((s) => `<sitemap><loc>${xmlEscape(`${siteUrl}/${s.name}`)}</loc>${s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : ''}</sitemap>`).join('') +
      `</sitemapindex>\n`,
  );
  return files;
}

export function sitemapXsl(siteName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
<xsl:template match="/">
<html>
<head>
  <title>XML Sitemap · ${xmlEscape(siteName)}</title>
  <meta name="robots" content="noindex"/>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; color: #1c2321; margin: 0; padding: 32px 16px; background: #f6f7f6; }
    main { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p { color: #5a6460; margin: 0 0 20px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dde2df; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e8ecea; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5a6460; }
    a { color: #1d5ea8; word-break: break-all; }
  </style>
</head>
<body><main>
  <h1>XML Sitemap</h1>
  <xsl:choose>
    <xsl:when test="sitemap:sitemapindex">
      <p>This index lists <xsl:value-of select="count(sitemap:sitemapindex/sitemap:sitemap)"/> sitemaps.</p>
      <table><tr><th>Sitemap</th><th>Last modified</th></tr>
        <xsl:for-each select="sitemap:sitemapindex/sitemap:sitemap">
          <tr><td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td><td><xsl:value-of select="substring(sitemap:lastmod, 0, 11)"/></td></tr>
        </xsl:for-each>
      </table>
    </xsl:when>
    <xsl:otherwise>
      <p>This sitemap lists <xsl:value-of select="count(sitemap:urlset/sitemap:url)"/> URLs. <a href="/sitemap.xml">Back to the index</a></p>
      <table><tr><th>URL</th><th>Images</th><th>Last modified</th></tr>
        <xsl:for-each select="sitemap:urlset/sitemap:url">
          <tr><td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td><td><xsl:value-of select="count(image:image)"/></td><td><xsl:value-of select="substring(sitemap:lastmod, 0, 11)"/></td></tr>
        </xsl:for-each>
      </table>
    </xsl:otherwise>
  </xsl:choose>
</main></body>
</html>
</xsl:template>
</xsl:stylesheet>
`;
}

export function robotsTxt(siteUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /__wbd/\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}

function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function rssFeed(site: { siteUrl: string; siteName: string; description: string; rssPath: string }, items: FeedItem[]): string {
  const latest = [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 50);
  const body = latest
    .map((it) => {
      const link = absolute(site.siteUrl, it.path);
      const parts = [
        `<title>${cdata(it.title)}</title>`,
        `<description>${cdata(it.description)}</description>`,
        `<link>${xmlEscape(link)}</link>`,
        `<guid isPermaLink="true">${xmlEscape(link)}</guid>`,
        ...it.tags.map((t) => `<category>${cdata(t)}</category>`),
        it.author ? `<dc:creator>${cdata(it.author)}</dc:creator>` : '',
        `<pubDate>${rfc822(it.publishedAt)}</pubDate>`,
        it.image ? `<media:content url="${xmlEscape(absolute(site.siteUrl, it.image))}" medium="image"/>` : '',
      ];
      return `<item>${parts.join('')}</item>`;
    })
    .join('');
  const build = latest[0]?.publishedAt ? rfc822(latest[0].publishedAt) : new Date(0).toUTCString();
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">` +
    `<channel><title>${cdata(site.siteName)}</title><description>${cdata(site.description)}</description>` +
    `<link>${xmlEscape(site.siteUrl + '/')}</link><lastBuildDate>${build}</lastBuildDate>` +
    `<atom:link href="${xmlEscape(absolute(site.siteUrl, site.rssPath))}" rel="self" type="application/rss+xml"/><ttl>60</ttl>` +
    body +
    `</channel></rss>\n`
  );
}
