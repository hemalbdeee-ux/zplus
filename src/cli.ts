#!/usr/bin/env node
// wbd: restore an expired website from the Wayback Machine.
//
//   wbd scan example.com                 how the homepage looked, month by month
//   wbd restore example.com [options]    download and build the site
//   wbd serve out/example.com/site       preview a restored site locally

import { parseArgs } from 'node:util';
import { ArchiveClient } from './engine/archive.ts';
import { scanHealth, type HealthReport } from './engine/health.ts';
import { restore } from './engine/restore.ts';
import { createPreviewServer } from './engine/serve.ts';
import { normalizeDomain } from './engine/url.ts';

const HELP = `wbd: restore an expired website from the Wayback Machine, every URL kept exactly.

Usage:
  wbd scan <domain>              Show the homepage health month by month and the last good snapshot
  wbd restore <domain>           Download the site and build a deploy-ready copy with an SEO layer
  wbd serve <site-folder>        Preview a restored site with the same URL rules as the real host

Restore options:
  --target <date>       Snapshot to restore (2019, 2019-06, 2019-06-12 or 20190612083015).
                        Default: the last snapshot in which the site looked healthy
  --from <date>         Ignore captures before this date
  --to <date>           Ignore captures after this date
  --site-url <url>      Address of the restored site (default: https:// + the host the site used)
  --out <dir>           Output folder (default: ./out)
  --max-urls <n>        Stop after this many URLs (default: 20000)
  --demo                Restore only the first 4 pages (and their images and styles)
  --no-orphans          Only URLs that pages link to, not every URL in the archive index
  --keep-tracking       Keep the old site's analytics and ad scripts
  --no-health           Skip the health scan (then --target is required)
  --no-zip              Do not create the ZIP file
  --concurrency <n>     Parallel requests to archive.org (default: 3)
  --delay <ms>          Minimum gap between requests (default: 350)
  --archive <url>       Wayback Machine base URL (default: https://web.archive.org)

Scan options: --archive, --probes <n> (homepage captures to inspect, default 14)
Serve options: --port <n> (default 8080)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'site-url': { type: 'string' },
    out: { type: 'string', default: 'out' },
    'max-urls': { type: 'string' },
    demo: { type: 'boolean' },
    'no-orphans': { type: 'boolean' },
    'keep-tracking': { type: 'boolean' },
    'no-health': { type: 'boolean' },
    'no-zip': { type: 'boolean' },
    concurrency: { type: 'string' },
    delay: { type: 'string' },
    archive: { type: 'string' },
    probes: { type: 'string' },
    port: { type: 'string', default: '8080' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, arg] = positionals;
const color = process.stdout.isTTY;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

function printTimeline(h: HealthReport): void {
  const years = [...new Set(h.months.map((m) => m.month.slice(0, 4)))];
  console.log('       J F M A M J J A S O N D');
  for (const y of years) {
    const cells = Array.from({ length: 12 }, (_, i) => {
      const m = h.months.find((x) => x.month === `${y}${String(i + 1).padStart(2, '0')}`);
      if (!m) return paint('2', '·');
      const ch = h.lastGood?.month === m.month ? '◆' : '■';
      return paint(m.verdict === 'good' ? '32' : m.verdict === 'weak' ? '33' : m.verdict === 'bad' ? '31' : '2', ch);
    });
    console.log(`  ${y} ${cells.join(' ')}`);
  }
  console.log(`  ${paint('32', '■')} good  ${paint('33', '■')} weak  ${paint('31', '■')} parked/dead/spam  ◆ chosen`);
}

async function main(): Promise<void> {
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  if (command === 'scan') {
    if (!arg) throw new Error('Give a domain: wbd scan example.com');
    const domain = normalizeDomain(arg);
    const client = new ArchiveClient({ base: values.archive, concurrency: num(values.concurrency), minIntervalMs: num(values.delay), log: (m) => console.error(paint('2', m)) });
    const h = await scanHealth(client, domain, { maxProbes: num(values.probes), log: (m) => console.error(paint('2', m)) });
    if (!h.months.length) {
      console.log(`The Wayback Machine has no captures of ${domain}.`);
      return;
    }
    printTimeline(h);
    if (h.lastGood) {
      console.log(`\nLast good snapshot: ${h.lastGood.timestamp} (score ${h.lastGood.score})`);
      console.log(`Healthy period:     ${h.window.from?.slice(0, 8) ?? 'start'} to ${h.window.to?.slice(0, 8) ?? 'last capture'}`);
      console.log(`Host:               ${h.host}`);
    } else {
      console.log('\nNo capture looks like a real website.');
    }
    for (const m of h.months.filter((x) => x.probed)) {
      console.log(paint('2', `  ${m.month.slice(0, 4)}-${m.month.slice(4)}  ${String(m.score).padStart(3)}  ${m.verdict.padEnd(4)}  ${m.reasons.join('; ')}`));
    }
    return;
  }
  if (command === 'restore') {
    if (!arg) throw new Error('Give a domain: wbd restore example.com');
    if (values['no-health'] && !values.target) throw new Error('--no-health needs --target');
    let last = 0;
    const result = await restore({
      domain: arg,
      outDir: values.out!,
      target: values.target,
      from: values.from,
      to: values.to,
      siteUrl: values['site-url'],
      maxUrls: num(values['max-urls']),
      maxPages: values.demo ? 4 : undefined,
      orphans: !values['no-orphans'],
      stripTracking: !values['keep-tracking'],
      skipHealth: values['no-health'],
      zip: !values['no-zip'],
      archive: { base: values.archive, concurrency: num(values.concurrency), minIntervalMs: num(values.delay) },
      onEvent: (e) => {
        if (e.phase === 'download' && e.done !== undefined) {
          if (Date.now() - last < 1000 && color) return;
          last = Date.now();
          console.error(paint('2', `  [${e.done} done, ${e.queued} queued] ${e.message}`));
        } else {
          console.error(`${paint('36', e.phase.padEnd(8))} ${e.message}`);
        }
      },
    });
    const c = result.report.counts;
    console.log(`\nRestored ${result.report.domain} from ${result.report.target}`);
    console.log(`  ${c.pages} pages (${c.posts} posts), ${c.files} files, ${c.redirects} original redirects, ${c.missing} not in the archive`);
    console.log(`  Site:   ${result.siteDir}`);
    if (result.zipFile) console.log(`  ZIP:    ${result.zipFile}`);
    console.log(`  Report: ${result.jobDir}/report.html`);
    for (const w of result.report.warnings) console.log(paint('33', `  note: ${w}`));
    return;
  }
  if (command === 'serve') {
    if (!arg) throw new Error('Give the site folder: wbd serve out/example.com/site');
    const server = await createPreviewServer(arg);
    const port = Number(values.port);
    server.listen(port, () => console.log(`Preview: http://localhost:${port}/`));
    return;
  }
  throw new Error(`Unknown command "${command}". Run wbd --help.`);
}

main().catch((err: Error) => {
  console.error(paint('31', `error: ${err.message}`));
  process.exitCode = 1;
});
