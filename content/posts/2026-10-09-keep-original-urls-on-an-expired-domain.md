---
title: Why the original URLs must not change when you rebuild an expired domain
slug: keep-original-urls-on-an-expired-domain
date: 2026-10-09
tags: Expired domains, SEO
author: team
excerpt: Backlinks point at exact addresses. Here is how to keep .php pages, query strings and missing trailing slashes working on modern hosting, without a single redirect.
---

When you rebuild a website on an expired domain, it is tempting to tidy the URLs: `/about.php` becomes `/about/`, `/index.php?page=contact` becomes `/contact/`, and redirects send the old addresses to the new ones. Don't.

## Links point at exact addresses

The value of an expired domain is in the links other websites made to it over the years. Each of those links points at one exact URL. Search engines follow that URL. If it answers with the page, the link counts. If it answers with a redirect, some of the value can be lost along the way and the old URL may drop out of the index. If it answers with a 404, the link counts for nothing.

So every URL that existed should answer with its page at the same address.

## The hard cases

A static host serves `/about/` and `/about.html` without any help. Old sites have other shapes too:

| Original URL | Problem on static hosting |
| --- | --- |
| `/about.php` | The file is HTML now, but it still needs the `.php` name |
| `/index.php?page=contact` | A static file cannot depend on the query string |
| `/blog/2019/05/rye-bread` | No extension and no slash, so the server does not know it is a page |
| `/thumb.php?id=3` | An image served by a script |

## How to keep them

- **`.php` pages** keep their file name and contain plain HTML. A PHP server prints such a file unchanged. Other servers are told to send it as `text/html`.
- **Query-string URLs** are stored as files under another name, and an internal rewrite rule serves them at the original address. In Apache that is a `RewriteRule` with a `RewriteCond` on the query string. In nginx it is a `map` on `$request_uri`. The browser and Google still see `/index.php?page=contact`.
- **Extensionless URLs** are stored as `rye-bread.html` and served at `/blog/2019/05/rye-bread` by a rule that tries `.html` before giving up. No slash is added.
- **Script-served images** are stored with a proper extension and served at the original URL by a rewrite.

## Redirects: only the original ones

Some URLs did redirect on the original site. For example, `/old-page.html` sent visitors to `/about.php` with a 301. The archive records those redirects, and they should come back exactly as they were. Every other URL answers with its page.

## Check before you go live

Take the URLs with the most backlinks from your SEO tool and open each one on the new site. Each should return 200 with the right page, unless the original site redirected it.
