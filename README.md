# Wayback Downloader

Restores an expired website from the Wayback Machine and delivers it as a deploy-ready static site
with a Ghost-style SEO layer. **Every original URL keeps working at exactly the same address**:
`.php` pages, query strings, missing trailing slashes, upper-case paths. Backlinks point at those
exact URLs, so nothing is renamed and the only redirects are the ones the original site itself made.

```
node src/cli.ts scan oldsite.com                 # homepage health month by month, last good snapshot
node src/cli.ts restore oldsite.com              # download + build out/oldsite.com/
node src/cli.ts restore oldsite.com --demo       # first 4 pages only
node src/cli.ts serve out/oldsite.com/site       # preview with the same URL rules as the real host
npm test                                         # unit + end-to-end tests against a local fake archive
```

Requires Node.js 22.18 or newer (TypeScript runs natively, there is no build step).

## Web app

```
npm start                 # http://localhost:8080 against the real web.archive.org
npm run demo              # same UI against the local fake archive (try oldbakery.example, access code "demo")
```

Served the way Ghost serves a site: server-rendered Handlebars templates (`src/web/theme/`, with
`default.hbs` as the layout and `{{seo_head}}` in place of `{{ghost_head}}`), posts and pages as
Markdown in `content/`, clean `/slug/` URLs with a trailing slash, `/tag/<slug>/`, `/author/<slug>/`,
`/blog/page/2/`, `/rss/`, a sitemap index and `robots.txt`.

The app flow: `/restore/` (domain) -> `/job/<id>/` health timeline and snapshot choice -> a restore
job with live progress -> ZIP download and report. App pages are `noindex`. Jobs are stored in SQLite
(`node:sqlite`, no native module) and run by an in-process worker; after a restart, interrupted jobs
are requeued and resume from their work folder. Finished jobs are deleted after
`WBD_RETENTION_DAYS`.

Demo restores (4 pages) are free. A full restore needs `WBD_ACCESS_CODE` until payments are added.
Each IP may start `WBD_SCAN_LIMIT` scans per hour and `WBD_RESTORE_LIMIT` restores per day; a domain
scanned in the last 12 hours reuses that scan.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | |
| `WBD_SITE_URL` | `http://localhost:8080` | used in canonicals, sitemaps, RSS |
| `WBD_DATA` | `./data` | SQLite file and job folders |
| `WBD_ACCESS_CODE` | empty | code for full restores; empty = demos only |
| `WBD_WORKERS` | `1` | jobs at the same time; keep it low for archive.org |
| `WBD_RETENTION_DAYS` | `7` | |
| `WBD_ARCHIVE` | `https://web.archive.org` | |

## Deploy

`docker-compose.yml` follows the RigConfigurator setup on the Hostinger VPS: one container behind
Traefik (`WBD_DOMAIN`), data in the `wbd-data` volume. Copy `.env.example` to `.env`, set the domain
and the access code, then `docker compose up -d --build` in this folder.

## How a restore works

1. **Health scan**: the homepage captures are grouped by month and scored 0 to 100. Parking pages
   ("this domain may be for sale"), suspended accounts, server default pages, redirects to other
   domains and spam that a later owner added all score as bad. The newest good month becomes the
   target, and the period around it in which the site was itself becomes the window. Captures from
   outside the window are never used.
2. **Index**: the CDX API lists every archived URL; for each URL the capture closest to the target
   inside the window is kept (earlier captures win ties).
3. **Download**: breadth-first from the homepage, then archived URLs nothing links to any more
   (often the ones with backlinks). Raw bytes come from `/web/<timestamp>id_/<url>`, so there is no
   Wayback toolbar. Requests are throttled (3 parallel, 350 ms apart, shared pause on HTTP 429), and
   a stopped job resumes from `.work/`.
4. **Build**: each URL gets a file that serves it at the same address. Wayback leftovers and the
   previous owner's analytics/ad code are removed, pages are converted to UTF-8, absolute links to
   the site become root-relative, and the SEO block is added.
5. **Package**: `site/`, `server/nginx.conf`, `report.html`, and a ZIP of all three.

## URL to file

| Original URL               | File                              | Served by                          |
| -------------------------- | --------------------------------- | ---------------------------------- |
| `/about/`                  | `about/index.html`                | any static host                    |
| `/about.html`              | `about.html`                      | any static host                    |
| `/about.php`               | `about.php` (HTML inside)         | PHP hosts print it as is; `.htaccess`/nginx set `text/html` |
| `/blog/post`               | `blog/post.html`                  | `.htaccess` / nginx `try_files`, Netlify, Cloudflare Pages |
| `/index.php?page=contact`  | `__wbd/q/<hash>.html`             | internal rewrite (`.htaccess`, nginx) |
| `/thumb.php?id=3` (image)  | `__wbd/q/<hash>.jpg`              | internal rewrite                   |
| `/style.css?ver=2`         | `style.css`                       | static host ignores the query      |
| `/old.html` (301 in 2018)  | none                              | the same 301, as the original site did |

`__wbd/routes.json` lists every rewrite and redirect; the preview server and the generated
`.htaccess`, `server/nginx.conf`, `_redirects` and `_headers` are all built from it. Netlify and
Cloudflare Pages cannot match exact query strings, so sites with query-string URLs need Apache,
LiteSpeed or nginx.

## SEO layer (modelled on Ghost)

Ghost's `{{ghost_head}}` prints one block before `</head>`; each restored page gets the same block:
canonical (the page's own original URL on the new host, or the original same-site canonical),
meta description (original, or the first real paragraph), Open Graph, Twitter card, JSON-LD
(`WebSite` on the homepage, `Article` for posts, `WebPage`/`CollectionPage`/`ProfilePage` otherwise,
plus `BreadcrumbList`) and the RSS link. Dead WordPress endpoints (`EditURI`, `wlwmanifest`,
`pingback`, oEmbed) are removed. The original doctype is kept so old layouts render in the same mode.

Next to the pages: `sitemap.xml` as an index of `sitemap-pages.xml`, `sitemap-posts.xml`,
`sitemap-tags.xml` and `sitemap-authors.xml` with `sitemap.xsl`, `/rss/`, `robots.txt` and `404.html`,
the same layout Ghost serves. Pages are classified as home, post, page, tag, author or date archive
from their own markup (dates, `<article>`, `og:type`, JSON-LD, URL shape).

## Layout

```
src/cli.ts                 wbd command line
src/engine/archive.ts      CDX + id_ playback client, throttling and retries
src/engine/health.ts       homepage health scan, last good snapshot, window
src/engine/crawl.ts        index, prioritized download, resume
src/engine/build.ts        URL -> file plan, page processing, generated files
src/engine/meta.ts         page metadata and type
src/engine/seo.ts          the seo-head block and JSON-LD
src/engine/sitemap.ts      sitemaps, RSS, robots.txt
src/engine/serverconfig.ts .htaccess, nginx.conf, _redirects, _headers
src/engine/serve.ts        preview server
src/web/server.ts          web app (Express): public site, app routes, sitemaps, RSS
src/web/views.ts           Handlebars theme engine and helpers
src/web/theme/             templates, partials, CSS, JS
src/web/content.ts         Markdown posts and pages with front matter
src/web/db.ts              SQLite job store (also the queue)
src/web/worker.ts          background job runner and cleanup
content/                   settings, authors, tags, posts, pages
test/fake-archive.ts       local stand-in for web.archive.org
test/fixtures/oldbakery.ts a site that was good 2015-2020 and parked from 2021
test/demo-server.ts        the web app against the fake archive
```
