// Removes what does not belong on the restored site: anything the Wayback Machine injected, and
// the previous owner's analytics and ad code (it would report the new owner's traffic to them).

import { removeNode, type Doc } from './html.ts';

export function stripWaybackMarkup(html: string): string {
  return html
    .replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi, '')
    .replace(/<!--\s*FILE ARCHIVED ON[\s\S]*?-->/gi, '')
    .replace(/<!--\s*playback timings[\s\S]*?-->/gi, '');
}

const ARCHIVE_ASSET = /(web-static\.archive\.org|(?:web\.)?archive\.org\/(?:_static|static|includes)\/|^\/_static\/(?:js|css)\/)/i;
const ARCHIVE_INLINE = /(__wm\.(?:init|wombat|rw|bt)|wbhack|_wb_wombat|archive_analytics|WB_wombat_)/;

const TRACKER_SRC = new RegExp(
  [
    'google-analytics\\.com',
    'googletagmanager\\.com',
    'googlesyndication\\.com',
    'googleadservices\\.com',
    'doubleclick\\.net',
    'connect\\.facebook\\.net/[^"\']*/(?:fbevents|fbds)',
    'facebook\\.com/tr',
    'static\\.hotjar\\.com',
    'statcounter\\.com',
    'quantserve\\.com',
    'scorecardresearch\\.com',
    'histats\\.com',
    'mc\\.yandex\\.ru',
    'getclicky\\.com',
    'addthis\\.com',
    'stats\\.wp\\.com',
    'pixel\\.wp\\.com',
    'bat\\.bing\\.com',
    'snap\\.licdn\\.com',
    'analytics\\.twitter\\.com',
    'static\\.ads-twitter\\.com',
    'amazon-adsystem\\.com',
    'infolinks\\.com',
    'chitika\\.net',
    'contextual\\.media\\.net',
    'bidvertiser\\.com',
    'popads\\.net',
    'propellerads\\.com',
    'adsterra',
    'hm\\.baidu\\.com',
    'cnzz\\.com',
  ].join('|'),
  'i',
);

const TRACKER_INLINE =
  /(GoogleAnalyticsObject|_gaq\.push|\bgtag\(|\bga\(\s*['"](?:create|send)|googletagmanager\.com|\bfbq\(|_fbq|hotjar|_hmt\.push|\bym\(\d+|yaCounter|sc_project|_qevents|adsbygoogle|clicky_site_ids|addthis_config|__gaTracker|urchinTracker|pageTracker\._track|_paq\.push)/;

export interface CleanStats {
  waybackRemoved: number;
  trackersRemoved: number;
}

export function cleanDocument($: Doc, opts: { stripTracking: boolean }): CleanStats {
  const stats: CleanStats = { waybackRemoved: 0, trackersRemoved: 0 };

  $('script[src], link[href]').each((_, el) => {
    const v = $(el).attr('src') ?? $(el).attr('href') ?? '';
    if (ARCHIVE_ASSET.test(v)) {
      removeNode($, el);
      stats.waybackRemoved++;
    }
  });
  $('script:not([src])').each((_, el) => {
    if (ARCHIVE_INLINE.test($(el).html() ?? '')) {
      removeNode($, el);
      stats.waybackRemoved++;
    }
  });
  $('#wm-ipp-base, #wm-ipp, #donato, #wm-ipp-print').each((_, el) => {
    removeNode($, el);
    stats.waybackRemoved++;
  });

  if (!opts.stripTracking) return stats;

  $('script').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') ?? '';
    if ((src && TRACKER_SRC.test(src)) || (!src && TRACKER_INLINE.test($el.html() ?? ''))) {
      removeNode($, el);
      stats.trackersRemoved++;
    }
  });
  $('noscript').each((_, el) => {
    const inner = $(el).html() ?? '';
    if (TRACKER_SRC.test(inner)) {
      removeNode($, el);
      stats.trackersRemoved++;
    }
  });
  $('ins.adsbygoogle, iframe[src*="googlesyndication"], iframe[src*="doubleclick"]').each((_, el) => {
    removeNode($, el);
    stats.trackersRemoved++;
  });
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (TRACKER_SRC.test(src)) {
      removeNode($, el);
      stats.trackersRemoved++;
    }
  });
  return stats;
}
