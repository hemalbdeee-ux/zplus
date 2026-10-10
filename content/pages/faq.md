---
title: Frequently asked questions
slug: faq
meta_description: How Wayback Downloader picks a snapshot, why it never changes URLs, which hosting works, and what a demo restore includes.
---

## Which snapshot do you restore?

We check the homepage of the domain month by month and score every month from 0 to 100. A parking page ("this domain may be for sale"), a suspended hosting account, a default server page, a redirect to another domain, or spam added by a later owner all count as bad. The newest month that scores well is chosen. You can pick any other healthy month instead.

## Do you take every page from that one date?

No. The Wayback Machine captures each URL on its own schedule. For every URL we take the capture closest to the date you chose, but only from the period in which the site was healthy. A page captured after the domain was parked is never used, even if it is the newest one.

## Will my URLs change?

No. Every original URL works at exactly the same address, including `.php` pages, URLs with a query string such as `/index.php?page=contact`, and URLs without a trailing slash. Backlinks point at those exact addresses, so we do not rename anything. The only redirects in the restored site are the ones the original site made, as the archive recorded them.

## Which hosting can I use?

Any Apache or LiteSpeed hosting (most shared hosting, including cPanel and hPanel) works with the included `.htaccess`. For nginx we include a server configuration. Netlify and Cloudflare Pages work too, except for URLs with a query string, which they cannot match.

## What do you change in the pages?

- Code the Wayback Machine added, and links that went through web.archive.org.
- The previous owner's analytics, AdSense and tracking pixels.
- Absolute links to the old domain become root-relative, so the site works on the new hosting. The path stays the same.
- Pages are converted to UTF-8.
- An SEO block is added before `</head>`: canonical, description, Open Graph, Twitter card and structured data.

Text, images, layout and the original doctype are kept as they were.

## What is in the demo?

The homepage and the first pages it links to (4 pages in total), with their images, styles and scripts. It is enough to see how the restored site will look.

## How long does a full restore take?

The Wayback Machine limits how fast anyone can download from it, and blocks addresses that go faster. We wait between requests. A site with a few hundred pages takes minutes; a site with 20,000 URLs can take several hours.

## Some images are missing. Why?

The archive did not save every file. The report lists each URL that was not in the archive and the page that linked to it.

## Who owns the restored content?

Buying a domain does not give you the copyright to what was published on it. Restore content that is yours, or that you have permission to use.
