---
title: Frequently asked questions
slug: faq
meta_description: How zplus.ai picks a snapshot, why it never changes URLs, which hosting works, and what a demo restore includes.
---

## Which snapshot do you restore?

We check the homepage of the domain month by month and score every month from 0 to 100. A parking page ("this domain may be for sale"), a suspended hosting account, a default server page, a redirect to another domain, or spam added by a later owner all count as bad. The newest month that scores well is chosen. You can pick any other healthy month instead.

## Do you take every page from that one date?

No. The Wayback Machine captures each URL on its own schedule. For every URL we take the capture closest to the date you chose, but only from the period in which the site was healthy. A page captured after the domain was parked is never used, even if it is the newest one.

## Will my URLs change?

No. On Apache, LiteSpeed and nginx hosting every original URL works at exactly the same address, including `.php` pages, URLs with a query string such as `/index.php?page=contact`, and URLs without a trailing slash. Backlinks point at those exact addresses, so we do not rename anything. The only redirects in the restored site are the ones the original site made, as the archive recorded them. Netlify and Cloudflare Pages cannot keep every URL; see the next question.

## Which hosting can I use?

Any Apache or LiteSpeed hosting (most shared hosting, including cPanel and hPanel) works with the included `.htaccess`. For nginx we include a server configuration. Both keep every original URL, including URLs with a query string.

Netlify and Cloudflare Pages read the included `_redirects` and `_headers` files, with limits:

- URLs with a query string, such as `/index.php?page=contact`, do not work there: the included `_redirects` has no rules for them.
- A URL with a doubled slash, such as `//menu.html` or `//about.php`, can show another page on both hosts.
- Netlify serves an existing file before it reads a rule. Where the original site had different pages at `/about` and `/about.html`, or at `/blog/` and `/blog/index.html`, both addresses show the same page there, and a redirect from such an address (for example `/index.html` to `/`) is not made.
- Cloudflare Pages on its own redirects `/about.html` to `/about` and `/blog/index.html` to `/blog/`. Rules in `_redirects` keep those URLs at their own address, but Pages reads at most 2,000 plain and 100 pattern rules from `_redirects` and 100 rules from `_headers`, and ignores the rest. A large site with many rewritten URLs or `.php` pages needs Apache, LiteSpeed or nginx.
- Cloudflare Pages reads a path with `:` followed by a letter, or with `*`, as a pattern. The rule for an original URL such as `/wiki/Talk:Main.html` then also catches neighbouring URLs such as `/wiki/Talkative.html`, which show the wrong page. Sites with such URLs need Apache, LiteSpeed, nginx or Netlify.

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
