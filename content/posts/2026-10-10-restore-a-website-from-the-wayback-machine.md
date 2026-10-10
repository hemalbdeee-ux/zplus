---
title: How to restore a website from the Wayback Machine
slug: restore-a-website-from-the-wayback-machine
date: 2026-10-10
tags: Guides, Expired domains
author: team
excerpt: A step-by-step guide: find the last healthy snapshot, download the right capture of every URL, and put the site back online without losing a single URL.
---

The Wayback Machine has billions of archived pages, and many of them belong to websites that no longer exist. If you own one of those domains again, you can bring the site back. This guide covers the whole process and the mistakes that cost the most.

## 1. Find out when the site was healthy

Open the domain in the Wayback Machine calendar and you will see a dot for every capture. The newest captures of an expired domain are almost never the site itself. They are usually one of these:

- a parking page ("this domain may be for sale"),
- an error from the hosting company ("account suspended"),
- a default server page ("it works!"),
- a redirect to some other website,
- spam put up by whoever owned the domain after the original owner.

Restore from one of those dates and you restore junk. Go back month by month until the homepage looks like the real site, and note the last month in which it did. Our snapshot check does this automatically and shows the result as a timeline.

## 2. Take each URL from the healthy period only

Each URL in the archive has its own captures. The about page may have been captured in March, the homepage in November, a blog post only once in 2017. For every URL, take the capture closest to your chosen date, but never one from after the site went bad. Otherwise a page in the middle of the site can turn out to be a parking page.

## 3. Download the raw files

The archive shows pages with its own toolbar and rewritten links. Add `id_` after the timestamp in the address to get the original file:

```
https://web.archive.org/web/20201114083015id_/http://example.com/
```

Go slowly. The archive blocks addresses that send too many requests, sometimes for an hour or more.

## 4. Keep every URL exactly as it was

This is the step most tools get wrong. An expired domain is valuable because other sites link to it, and those links point at exact addresses: `/about.php`, `/index.php?page=contact`, `/blog/2019/05/rye-bread` without a slash at the end. If any of these changes, the link lands on a 404 page and its value is lost. Read [why the URLs must not change](/keep-original-urls-on-an-expired-domain/) for the details.

## 5. Clean the pages

Remove what does not belong on your site:

- The archive's toolbar scripts and any links that still go through web.archive.org.
- The previous owner's Google Analytics, AdSense and tracking pixels. Leave them in and your visitors are reported to the old owner's accounts.
- Absolute links to the old domain, which should become root-relative so the site works on any hosting.

## 6. Add what search engines expect today

Many old sites have no canonical tags, no sitemap and no structured data. Adding them does not change any URL. Ghost, the publishing platform, prints all of this in one block in the head of every page, and it is a good model to follow:

- a canonical tag and a meta description,
- Open Graph and Twitter card tags,
- JSON-LD structured data,
- a sitemap index and an RSS feed.

## 7. Upload and check

Upload the files with server rules that serve the old URLs, then open a sample of old URLs, especially the ones with backlinks, and make sure each one returns the page and not a redirect or an error.
