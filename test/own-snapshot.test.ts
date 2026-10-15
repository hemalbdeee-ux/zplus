// A snapshot the user names on the snapshots page (a Wayback Machine link or a date) instead of
// one from the list, the preview of the chosen capture, and a restore of a date outside the period
// the scan picked.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { HealthReport, MonthHealth } from '../src/engine/health.ts';
import { restore } from '../src/engine/restore.ts';
import { configFromEnv, createApp } from '../src/web/server.ts';
import { ownSnapshotProblem, parseOwnSnapshot, waybackLinks } from '../src/web/snapshot.ts';
import { startFakeArchive, type FakeArchive, type FakeCapture } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };
const NOW = new Date('2026-10-15T12:00:00Z');

describe('a snapshot the user names', () => {
  const parse = (s: string) => parseOwnSnapshot(s, 'oldbakery.example', NOW);

  it('reads the date and page of a Wayback Machine link', () => {
    assert.deepEqual(parse('https://web.archive.org/web/20190612083015/http://www.oldbakery.example/'), { timestamp: '20190612083015', url: 'http://www.oldbakery.example/' });
    assert.deepEqual(parse('  http://web.archive.org/web/20190612083015/https://oldbakery.example/about.php?x=1#top '), { timestamp: '20190612083015', url: 'https://oldbakery.example/about.php?x=1' });
    // Without the scheme, with a playback flag, with a short date, with one slash dropped.
    assert.deepEqual(parse('web.archive.org/web/20190612id_/oldbakery.example/blog/'), { timestamp: '20190612000000', url: 'http://oldbakery.example/blog/' });
    assert.deepEqual(parse('https://web.archive.org/web/2019if_/https:/www.oldbakery.example/'), { timestamp: '20190101000000', url: 'https://www.oldbakery.example/' });
    assert.deepEqual(parse('https://wayback.archive.org/web/20190612083015/http://WWW.OldBakery.example:80/'), { timestamp: '20190612083015', url: 'http://www.oldbakery.example/' });
  });

  it('reads a date', () => {
    assert.deepEqual(parse('2019-06-12'), { timestamp: '20190612000000' });
    assert.deepEqual(parse('2019-6'), { timestamp: '20190601000000' });
    assert.deepEqual(parse('2019-06-12 08:30:15'), { timestamp: '20190612083015' });
    assert.deepEqual(parse('20190612083015'), { timestamp: '20190612083015' });
  });

  it('says what is wrong with anything else', () => {
    const error = (s: string) => {
      const r = parse(s);
      assert.ok('error' in r, `${s} -> ${JSON.stringify(r)}`);
      return r.error;
    };
    assert.match(error('https://web.archive.org/web/2019*/oldbakery.example'), /calendar of all captures/);
    assert.match(error('https://web.archive.org/web/*/oldbakery.example/*'), /calendar of all captures/);
    assert.match(error('https://web.archive.org/web/20190612083015/http://www.otherbakery.example/'), /capture of otherbakery\.example, not of oldbakery\.example/);
    assert.match(error('https://web.archive.org/web/20190612083015/http://shop.oldbakery.example/'), /capture of shop\.oldbakery\.example/);
    assert.match(error('https://web.archive.org/web/20191340000000/http://oldbakery.example/'), /date in that Wayback Machine link is not valid/);
    assert.match(error('https://web.archive.org/web/20190612083015/javascript:alert(1)'), /no page address|not of oldbakery/);
    assert.match(error('https://archive.ph/abcd'), /Paste the link of one capture from web\.archive\.org/);
    assert.match(error('oldbakery.example'), /Paste the link of one capture/);
    assert.match(error('last summer'), /Type a date like 2015-06-12/);
    assert.match(error('2019-02-30'), /Type a date/);
    assert.match(error('1995-05-01'), /no captures before 1996/);
    assert.match(error('2027-01-01'), /2027-01-01 is in the future/);
    assert.match(error('x'.repeat(2001)), /too long/);
  });

  it('builds the preview and Wayback links', () => {
    assert.deepEqual(waybackLinks('https://web.archive.org/', '20190612083015', 'http://www.oldbakery.example/'), {
      frame: 'https://web.archive.org/web/20190612083015if_/http://www.oldbakery.example/',
      page: 'https://web.archive.org/web/20190612083015/http://www.oldbakery.example/',
    });
  });
});

describe('the period a named snapshot is restored from', () => {
  const month = (m: string, verdict: MonthHealth['verdict'], reasons: string[] = []): MonthHealth => ({ month: m, captures: 1, timestamp: `${m}10120000`, score: verdict === 'good' ? 90 : 5, verdict, reasons, probed: true });
  const health: HealthReport = {
    domain: 'riverside.example',
    host: 'www.riverside.example',
    probes: 8,
    months: [
      month('201005', 'good'),
      month('201205', 'good'),
      month('201305', 'bad', ['parked domain page ("this domain may be for sale")']),
      month('201405', 'bad', ['parked domain page ("this domain may be for sale")']),
      month('201505', 'good'),
      month('201705', 'good'),
    ],
    lastGood: { month: '201705', timestamp: '20170510120000', score: 90, original: 'http://www.riverside.example/' },
    window: { from: '20140601000000' },
  };

  it('allows a date in the healthy period and a date in an earlier healthy period', () => {
    assert.equal(ownSnapshotProblem(health, '20160101000000'), undefined);
    assert.equal(ownSnapshotProblem(health, '20110101000000'), undefined);
  });

  it('refuses a date when the site was parked or run by another owner', () => {
    assert.match(ownSnapshotProblem(health, '20131001000000') ?? '', /found riverside\.example parked or run by another owner around 2013-10-01/);
  });

  it('refuses a date after the healthy period, when the scan found the site gone or taken over', () => {
    const ended: HealthReport = { ...health, months: health.months.slice(0, 3), lastGood: { month: '201205', timestamp: '20120510120000', score: 90, original: '' }, window: { to: '20130430235959' } };
    assert.match(ownSnapshotProblem(ended, '20160510000000') ?? '', /After 2013-04-30 our check found riverside\.example down, parked or run by another owner/);
    assert.match(ownSnapshotProblem(ended, '20130510120000') ?? '', /After 2013-04-30/);
  });

  it('refuses a date whose last checked month before it was bad, even when it looks like an outage', () => {
    const down: HealthReport = { ...health, months: [month('201005', 'weak'), month('201205', 'weak'), month('201305', 'bad', ['homepage answered HTTP 404'])], lastGood: undefined, window: {} };
    assert.match(ownSnapshotProblem(down, '20160510000000') ?? '', /homepage of riverside\.example bad in May 2013 \(homepage answered HTTP 404\)/);
    assert.equal(ownSnapshotProblem(down, '20110101000000'), undefined);
  });

  it('refuses a date before a first capture that was already bad', () => {
    const late: HealthReport = { ...health, months: [month('200905', 'bad', ['parked domain page ("this domain may be for sale")']), ...health.months.slice(0, 2)], window: { from: '20090601000000', to: '20130430235959' } };
    assert.match(ownSnapshotProblem(late, '20080601000000') ?? '', /first homepage capture of riverside\.example is from May 2009 and our check found it bad/);
  });

  it('refuses a domain without captures', () => {
    assert.match(ownSnapshotProblem({ ...health, months: [], lastGood: undefined }, '20110101000000') ?? '', /no captures of riverside\.example/);
  });
});

// A bookshop until 2012, parked in 2013 and 2014, then a gym under a new owner from 2015. Both shops
// have an /about.html page, each its own.
const R = 'http://www.riverside.example';
const page = (title: string, text: string, links: string[] = []) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${text.repeat(12)}</p>${links.map((l) => `<a href="/${l}">${l}</a>`).join(' ')}</body></html>`;
const BOOKS = 'Second hand books, maps and prints, bought and sold on the river front since 1987. ';
const GYM = 'Strength classes, spinning and yoga for every level, with trainers who know your name. ';
const RIVERSIDE: FakeCapture[] = [
  ...[2010, 2011, 2012].map((y) => ({ url: `${R}/`, ts: `${y}0510120000`, body: page('Riverside Books', BOOKS, ['about.html', 'catalogue.html']) })),
  { url: `${R}/about.html`, ts: '20110510120000', body: page('About Riverside Books', BOOKS) },
  { url: `${R}/catalogue.html`, ts: '20110510120000', body: page('Catalogue', BOOKS) },
  ...[2013, 2014].map((y) => ({ url: `${R}/`, ts: `${y}0510120000`, body: page('riverside.example', 'This domain may be for sale. Buy this domain today! ') })),
  ...[2015, 2016, 2017].map((y) => ({ url: `${R}/`, ts: `${y}0510120000`, body: page('Riverside Fitness', GYM, ['about.html', 'classes.html']) })),
  { url: `${R}/about.html`, ts: '20160510120000', body: page('About Riverside Fitness', GYM) },
  { url: `${R}/classes.html`, ts: '20160510120000', body: page('Classes', GYM) },
];

// A bookshop until 2012 whose homepage answered 404 from 2013, while a later owner put spam on its
// old inner URLs in 2014 and 2016: nothing on the homepage says "parked".
const E = 'http://www.elmbooks.example';
const ELM: FakeCapture[] = [
  ...[2010, 2011, 2012].map((y) => ({ url: `${E}/`, ts: `${y}0510120000`, body: page('Elm Books', BOOKS, ['about.html', 'catalogue.html']) })),
  { url: `${E}/about.html`, ts: '20110510120000', body: page('About Elm Books', BOOKS) },
  { url: `${E}/catalogue.html`, ts: '20110510120000', body: page('Catalogue', BOOKS) },
  { url: `${E}/`, ts: '20130510120000', status: 404, body: 'Not Found' },
  { url: `${E}/about.html`, ts: '20140110120000', body: page('Casino Gacor', 'Slot online gacor hari ini, bonus new member. ') },
  { url: `${E}/catalogue.html`, ts: '20160510120000', body: page('Slot Online', 'Slot online gacor hari ini, bonus new member. ') },
];

describe('restoring a date outside the period the scan picked', () => {
  let work: string;
  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'zp-own-'));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('takes the pages of that date period, never of the other one', async () => {
    const archive = await startFakeArchive(RIVERSIDE);
    try {
      const opts = { domain: 'riverside.example', zip: false, archive: { base: archive.base, ...FAST } };
      const books = await restore({ ...opts, outDir: await mkdtemp(path.join(work, 'r-')), target: '2011-05' });
      assert.match(await readFile(path.join(books.siteDir, 'about.html'), 'utf8'), /About Riverside Books/);
      assert.match(await readFile(path.join(books.siteDir, 'catalogue.html'), 'utf8'), /Catalogue/);
      await assert.rejects(readFile(path.join(books.siteDir, 'classes.html')), { code: 'ENOENT' });
      assert.ok(books.report.window.to && books.report.window.to < '20130501000000', JSON.stringify(books.report.window));
      assert.ok(!books.report.warnings.some((w) => /outside the period/.test(w)), books.report.warnings.join(' | '));

      const gym = await restore({ ...opts, outDir: await mkdtemp(path.join(work, 'r-')), target: '2016-05' });
      assert.match(await readFile(path.join(gym.siteDir, 'about.html'), 'utf8'), /About Riverside Fitness/);
      await assert.rejects(readFile(path.join(gym.siteDir, 'catalogue.html')), { code: 'ENOENT' });

      await assert.rejects(restore({ ...opts, outDir: await mkdtemp(path.join(work, 'r-')), target: '2013-09' }), /parked or run by another owner around 2013-09-01/);
    } finally {
      await archive.close();
    }
  });

  it('never opens the period after a homepage that went down', async () => {
    const archive = await startFakeArchive(ELM);
    try {
      const opts = { domain: 'elmbooks.example', zip: false, archive: { base: archive.base, ...FAST } };
      for (const target of ['2016-05-10', '2013-05-10']) {
        const r = await restore({ ...opts, outDir: await mkdtemp(path.join(work, 'r-')), target });
        assert.ok(r.report.window.to && r.report.window.to < '20130501000000', `${target}: ${JSON.stringify(r.report.window)}`);
        assert.match(await readFile(path.join(r.siteDir, 'about.html'), 'utf8'), /About Elm Books/, target);
        assert.doesNotMatch(await readFile(path.join(r.siteDir, 'catalogue.html'), 'utf8'), /Slot Online/, target);
        assert.ok(r.report.warnings.some((w) => /outside the period the site looked healthy/.test(w)), target);
      }
    } finally {
      await archive.close();
    }
  });
});

describe('web app: a snapshot the user names', () => {
  let archive: FakeArchive;
  let dataDir: string;
  let server: Server;
  let base: string;
  let stop: () => void;

  before(async () => {
    archive = await startFakeArchive(OLD_BAKERY);
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'zp-own-web-'));
    const { app, runner, store } = await createApp({
      ...configFromEnv({}),
      siteUrl: 'https://wayback.example',
      dataDir,
      archiveBase: archive.base,
      archiveDelayMs: 0,
      archiveBackoffMs: 5,
      accessCode: 'letmein',
    });
    runner.start();
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => {
      runner.stop();
      store.close();
    };
  });

  after(async () => {
    server?.close();
    stop?.();
    await archive?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(base + p, { redirect: 'manual' });
  const post = (p: string, form: Record<string, string>) =>
    fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { origin: base } });

  async function waitFor(id: string): Promise<{ status: string; error?: string }> {
    for (let i = 0; i < 200; i++) {
      const job = (await (await get(`/api/jobs/${id}`)).json()) as { status: string; error?: string };
      if (job.status === 'done' || job.status === 'failed') return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not finish');
  }

  let scanId = '';
  it('shows a preview of the last good snapshot next to the form, and months that pick a capture', async () => {
    const scan = await post('/restore/', { domain: 'oldbakery.example' });
    scanId = scan.headers.get('location')!.split('/')[2];
    assert.equal((await waitFor(scanId)).status, 'done');
    const html = await (await get(`/job/${scanId}/`)).text();
    const frame = /<iframe src="([^"]+)"[^>]*sandbox="allow-scripts allow-same-origin"[^>]*referrerpolicy="no-referrer"[^>]*tabindex="-1"/.exec(html);
    assert.ok(frame, 'preview frame');
    assert.equal(frame[1], `${archive.base}/web/20201114083015if_/http://www.oldbakery.example/`);
    assert.match(html, new RegExp(`href="${archive.base}/web/20201114083015/http://www.oldbakery.example/" data-open`));
    assert.match(html, /data-label>2020-11-14<\/b> <span class="pill good"/);
    assert.match(html, /<td class="good pick" data-month="202011" data-ts="20201114083015"/);
    assert.match(html, /<td class="bad" data-month="202103" data-ts="\d{14}"/);
    assert.match(html, /<td class="none" data-month="201501" title=/);
    assert.match(html, /<input id="custom" name="custom" type="text"/);
    // The page the preview frames plays back.
    const played = await fetch(frame[1]);
    assert.equal(played.status, 200);
    assert.match(await played.text(), /The Old Bakery/);
  });

  it('restores a date the user typed that is not in the list', async () => {
    const res = await post(`/job/${scanId}/restore`, { target: '20201114083015', custom: '2017-01-01', mode: 'demo' });
    assert.equal(res.status, 303);
    const id = res.headers.get('location')!.split('/')[2];
    assert.equal((await waitFor(id)).status, 'done');
    assert.match(await (await get(`/job/${id}/`)).text(), /Restored from the snapshot of <b>2017-01-01<\/b>/);
  });

  it('restores the date of a pasted Wayback Machine link', async () => {
    const res = await post(`/job/${scanId}/restore`, { custom: 'https://web.archive.org/web/20190915000000/http://www.oldbakery.example/blog/', mode: 'demo' });
    assert.equal(res.status, 303);
    const id = res.headers.get('location')!.split('/')[2];
    assert.equal((await waitFor(id)).status, 'done');
    assert.match(await (await get(`/job/${id}/`)).text(), /Restored from the snapshot of <b>2019-09-15<\/b>/);
  });

  it('refuses a link to another site or a parked date, and keeps what was typed', async () => {
    const other = await post(`/job/${scanId}/restore`, { custom: 'https://web.archive.org/web/20190915000000/http://www.example.com/', mode: 'full', code: 'letmein' });
    assert.equal(other.status, 422);
    const page = await other.text();
    assert.match(page, /That link is a capture of example\.com, not of oldbakery\.example\./);
    assert.match(page, /value="https:\/\/web\.archive\.org\/web\/20190915000000\/http:\/\/www\.example\.com\/"/);
    assert.match(page, /name="mode" value="full" checked/);

    const parked = await post(`/job/${scanId}/restore`, { custom: '2022-06', mode: 'demo' });
    assert.equal(parked.status, 422);
    const parkedPage = await parked.text();
    assert.match(parkedPage, /After 2021-02-28 our check found oldbakery\.example down, parked or run by another owner\. Choose an earlier date\./);
    // The message sits with the field, which is marked invalid, and the preview stays on the list's choice.
    assert.match(parkedPage, /aria-invalid="true">\s*<p class="form-hint bad" id="custom-hint" data-hint data-refused role="alert">After 2021-02-28/);
    assert.match(parkedPage, /web\/20201114083015if_\//);

    const calendar = await post(`/job/${scanId}/restore`, { custom: 'https://web.archive.org/web/2019*/oldbakery.example', mode: 'demo' });
    assert.equal(calendar.status, 422);
    assert.match(await calendar.text(), /calendar of all captures/);
  });

  it('checks the code for a named snapshot like for one from the list', async () => {
    const res = await post(`/job/${scanId}/restore`, { custom: '2019-09-15', mode: 'full', code: 'wrong' });
    assert.equal(res.status, 403);
  });

  it('links a demo of a named snapshot to a full restore of the same snapshot', async () => {
    const res = await post(`/job/${scanId}/restore`, { custom: '2016-06-12', mode: 'demo' });
    const id = res.headers.get('location')!.split('/')[2];
    assert.equal((await waitFor(id)).status, 'done');
    const result = await (await get(`/job/${id}/`)).text();
    const link = new RegExp(`href="/job/${scanId}/\\?snapshot=20160612000000&amp;mode=full">full restore</a>`);
    assert.match(result, link);
    assert.match(result, /The snapshot it was restored from/);
    const form = await (await get(`/job/${scanId}/?snapshot=20160612000000&mode=full`)).text();
    assert.match(form, /id="custom" name="custom"[^>]*value="2016-06-12 00:00:00"/);
    assert.match(form, /name="mode" value="full" checked/);
    assert.match(form, /web\/20160612000000if_\//);
    assert.match(form, /<td class="(good|weak|none) pick" data-month="201606"/);
    // A listed snapshot comes back selected in the list; anything else is ignored.
    assert.match(await (await get(`/job/${scanId}/?snapshot=20190920120000`)).text(), /<option value="20190920120000" selected>/);
    assert.match(await (await get(`/job/${scanId}/?snapshot=x"><script>`)).text(), /<option value="20201114083015" selected>/);
  });

  it('keeps the snapshot chosen in the list when the form comes back', async () => {
    const res = await post(`/job/${scanId}/restore`, { target: '20190920120000', custom: '', mode: 'full', code: 'wrong' });
    assert.equal(res.status, 403);
    const page = await res.text();
    assert.match(page, /<option value="20190920120000" selected>2019-09-20 · score \d+<\/option>/);
    assert.match(page, /<option value="20201114083015">2020-11-14 · score \d+ · last good<\/option>/);
    assert.match(page, /web\/20190920120000if_\/http:\/\/www\.oldbakery\.example\//);
  });
});
