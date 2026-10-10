// What happened during a restore, for the customer: which snapshot was used and why, what came
// back, what is missing, and which original redirects were put back.

import type { BuildResult } from './build.ts';
import type { Manifest } from './crawl.ts';
import type { HealthReport } from './health.ts';

export interface RestoreReport {
  domain: string;
  siteUrl: string;
  target: string;
  window: { from?: string; to?: string };
  generatedAt: string;
  durationSeconds: number;
  archiveRequests: number;
  health?: HealthReport;
  counts: {
    indexUrls: number;
    pages: number;
    posts: number;
    files: number;
    bytes: number;
    rewrites: number;
    redirects: number;
    missing: number;
    trackersRemoved: number;
  };
  truncated: boolean;
  missing: Array<{ url: string; reason: string; referrer?: string }>;
  redirects: Array<{ from: string; to: string; status: number }>;
  warnings: string[];
}

export function makeReport(input: {
  manifest: Manifest;
  build: BuildResult;
  health?: HealthReport;
  siteUrl: string;
  startedAt: number;
  archiveRequests: number;
  warnings: string[];
}): RestoreReport {
  const { manifest, build } = input;
  return {
    domain: manifest.domain,
    siteUrl: input.siteUrl,
    target: manifest.target,
    window: manifest.window,
    generatedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - input.startedAt) / 1000),
    archiveRequests: input.archiveRequests,
    health: input.health,
    counts: {
      indexUrls: manifest.indexSize,
      pages: build.pages.length,
      posts: build.pages.filter((p) => p.type === 'post').length,
      files: build.files,
      bytes: build.bytes,
      rewrites: build.routes.length,
      redirects: build.redirects.length,
      missing: manifest.missing.length,
      trackersRemoved: build.cleaned.trackers,
    },
    truncated: manifest.truncated,
    missing: manifest.missing.map((m) => ({ url: m.url, reason: m.reason, referrer: m.referrer })),
    redirects: build.redirects.map((r) => ({ from: r.rawPath + (r.query ? `?${r.query}` : ''), to: r.to, status: r.status })),
    warnings: [...input.warnings, ...build.warnings],
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtTs = (ts?: string) => (ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : '—');

export function reportHtml(r: RestoreReport): string {
  const months = r.health?.months ?? [];
  const years = [...new Set(months.map((m) => m.month.slice(0, 4)))];
  const cell = (y: string, mo: number) => {
    const m = months.find((x) => x.month === `${y}${String(mo).padStart(2, '0')}`);
    const cls = m ? m.verdict : 'none';
    const pick = r.health?.lastGood?.month === m?.month ? ' pick' : '';
    const title = m ? `${y}-${String(mo).padStart(2, '0')}: ${m.verdict}${m.score !== null ? ` (${m.score})` : ''}${m.reasons.length ? ' · ' + m.reasons.join('; ') : ''}` : `${y}-${mo}: no capture`;
    return `<td class="${cls}${pick}" title="${esc(title)}"></td>`;
  };
  const timeline = years.length
    ? `<table class="tl"><tr><th></th>${'JFMAMJJASOND'.split('').map((c) => `<th>${c}</th>`).join('')}</tr>${years
        .map((y) => `<tr><th>${y}</th>${Array.from({ length: 12 }, (_, i) => cell(y, i + 1)).join('')}</tr>`)
        .join('')}</table>`
    : '<p>Health scan was skipped.</p>';

  const mb = (r.counts.bytes / 1024 / 1024).toFixed(1);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Restore report · ${esc(r.domain)}</title>
<style>
  :root { --bg:#f5f7f6; --fg:#18211e; --muted:#5a6661; --line:#d6ddd9; --good:#2c8a57; --weak:#c58516; --bad:#c03d36; --none:#e3e8e5; --acc:#1d5ea8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121816; --fg:#e3eae6; --muted:#9aa8a2; --line:#2b3632; --none:#24302c; --acc:#79aef0; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 system-ui, sans-serif; }
  main { max-width:60rem; margin:0 auto; padding:32px 16px 64px; display:grid; gap:28px; }
  h1 { margin:0; font-size:1.8rem; } h2 { margin:0 0 8px; font-size:1.15rem; }
  .muted { color:var(--muted); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:12px; }
  .stat { border:1px solid var(--line); border-radius:8px; padding:12px; }
  .stat b { display:block; font-size:1.4rem; font-variant-numeric:tabular-nums; }
  table.tl { border-collapse:separate; border-spacing:3px; font:12px ui-monospace, monospace; color:var(--muted); }
  table.tl td { width:18px; height:18px; border-radius:3px; background:var(--none); }
  table.tl td.good { background:var(--good); } table.tl td.weak { background:var(--weak); } table.tl td.bad { background:var(--bad); }
  table.tl td.pick { outline:2px solid var(--fg); outline-offset:1px; }
  .list { overflow-x:auto; border:1px solid var(--line); border-radius:8px; }
  .list table { border-collapse:collapse; width:100%; font-size:13px; }
  .list td, .list th { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  code { font:12.5px ui-monospace, monospace; word-break:break-all; }
  a { color:var(--acc); }
</style>
</head>
<body>
<main>
  <header>
    <h1>${esc(r.domain)}</h1>
    <p class="muted">Restored from the Wayback Machine snapshot of <b>${fmtTs(r.target)}</b> (<code>${esc(r.target)}</code>) for ${esc(r.siteUrl)}. Every original URL is kept exactly as it was.</p>
  </header>
  <section class="stats">
    <div class="stat"><b>${r.counts.pages}</b>pages</div>
    <div class="stat"><b>${r.counts.posts}</b>blog posts</div>
    <div class="stat"><b>${r.counts.files}</b>files · ${mb} MB</div>
    <div class="stat"><b>${r.counts.redirects}</b>original redirects</div>
    <div class="stat"><b>${r.counts.rewrites}</b>query/odd URLs kept</div>
    <div class="stat"><b>${r.counts.missing}</b>not in the archive</div>
  </section>
  <section>
    <h2>Homepage health by month</h2>
    <p class="muted">Green: the real site. Amber: thin or broken. Red: parked, suspended or taken over. The outlined month is the snapshot that was used. Pages were taken only from ${fmtTs(r.window.from)} to ${fmtTs(r.window.to)}.</p>
    ${timeline}
  </section>
  ${r.warnings.length ? `<section><h2>Notes</h2><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>` : ''}
  ${
    r.redirects.length
      ? `<section><h2>Original redirects put back</h2><div class="list"><table><tr><th>From</th><th>To</th><th>Status</th></tr>${r.redirects
          .slice(0, 500)
          .map((d) => `<tr><td><code>${esc(d.from)}</code></td><td><code>${esc(d.to)}</code></td><td>${d.status}</td></tr>`)
          .join('')}</table></div></section>`
      : ''
  }
  ${
    r.missing.length
      ? `<section><h2>Not found in the archive</h2><div class="list"><table><tr><th>URL</th><th>Why</th><th>Linked from</th></tr>${r.missing
          .slice(0, 1000)
          .map((m) => `<tr><td><code>${esc(m.url)}</code></td><td>${esc(m.reason)}</td><td><code>${esc(m.referrer ?? '')}</code></td></tr>`)
          .join('')}</table></div></section>`
      : ''
  }
  <section class="muted">
    <h2>How to put it online</h2>
    <p>Upload the contents of the <code>site</code> folder to the web root (for example <code>public_html</code>). On Apache or LiteSpeed hosting the included <code>.htaccess</code> does the rest. On nginx use <code>server/nginx.conf</code>. Netlify and Cloudflare Pages read <code>_redirects</code> and <code>_headers</code>, but cannot serve URLs with a query string.</p>
  </section>
</main>
</body>
</html>
`;
}
