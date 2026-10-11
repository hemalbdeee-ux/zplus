// Round-2 health cases for a parking or "coming soon" phrase that the site itself showed from the
// start: it costs the site nothing, but a later owner's page that repeats it is not let off.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { scanHealth, type HealthReport } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

async function scan(captures: FakeCapture[]): Promise<HealthReport> {
  const archive = await startFakeArchive(captures);
  try {
    return await scanHealth(new ArchiveClient({ base: archive.base, ...FAST }), 'example.com');
  } finally {
    await archive.close();
  }
}

function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(4)); `${y}${String(m).padStart(2, '0')}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
  }
  return out;
}

const filler = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i % 40}`).join(' ');
const nav = (items: string[]) => `<ul>${items.map((i) => `<li><a href="/${i.toLowerCase().replace(/\W+/g, '-')}.html">${i}</a></li>`).join('')}</ul>`;
const later = (h: HealthReport, from: string) => h.months.filter((m) => m.month >= from);

describe('health2: a later page that repeats the site\'s own phrase', () => {
  const hobby = (m: string) =>
    `<html lang="en"><head><title>Dave's Model Railroad Page</title></head><body><h1>Dave's HO Scale Layout</h1>${nav(['Layout Photos', 'Track Plan', 'Rolling Stock', 'Scenery Tips', 'DCC Wiring', 'Guestbook'])}` +
    `<p>${filler(180, 'train')}</p><h2>Related Links</h2><ul><li><a href="http://www.nmra.org/">NMRA</a></li></ul><p>Updated ${m}</p></body></html>`;
  const kw = ['Model Trains', 'HO Scale Track', 'Train Sets', 'Hobby Shop', 'Lionel Trains', 'Railroad Models', 'Toy Trains', 'Model Railroad Scenery', 'DCC Decoders', 'Train Layouts'];
  const ppc = (title: string, m: string) =>
    `<html lang="en"><head><title>${title}</title></head><body><div class="hd">example.com</div><p>Welcome to example.com. Find the best information about model trains, toy trains and hobby shops. Browse our sponsored listings below.</p>` +
    `<h3>Related Links</h3><ul>${kw.map((k) => `<li><a href="/search?q=${encodeURIComponent(k)}">${k}</a></li>`).join('')}</ul>` +
    `<p>Top searches: ${kw.slice(0, 6).join(', ')}.</p><a href="/privacy.html">Privacy Policy</a> <a href="/terms.html">Terms</a> <a href="/contact.html">Contact</a> <span>${m}</span></body></html>`;

  it("does not let a later owner's ad page off for the site's \"related links\" box", async () => {
    const h = await scan([
      ...monthRange('201501', '201712').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: hobby(m) })),
      ...monthRange('201801', '201912').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: ppc('example.com', m) })),
    ]);
    assert.ok(h.lastGood && h.lastGood.month < '201801', h.lastGood?.month);
    assert.ok(later(h, '201801').every((m) => m.verdict !== 'good'));
    const probed = later(h, '201801').find((m) => m.probed)!;
    assert.ok(probed.reasons.includes('mentions "related links"'), probed.reasons.join('; '));
  });

  it('does not let it off for a site that went by its domain name either: the menu differs', async () => {
    const own = (m: string) => hobby(m).replace("Dave's Model Railroad Page", 'example.com');
    const h = await scan([
      ...monthRange('201501', '201712').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: own(m) })),
      ...monthRange('201801', '201912').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: ppc('example.com', m) })),
    ]);
    assert.ok(h.lastGood && h.lastGood.month < '201801', h.lastGood?.month);
    assert.ok(later(h, '201801').every((m) => m.verdict !== 'good'));
  });

  it("scores a new owner's \"coming soon\" page bad after a restaurant that always said it", async () => {
    const restaurant = (m: string) =>
      `<html lang="en"><head><title>Luigi's Trattoria</title></head><body><h1>Luigi's Trattoria</h1>${nav(['Menu', 'Wine List', 'Catering', 'Gallery', 'Reservations', 'Contact'])}` +
      `<p>${filler(180, 'pasta')}</p><p>Online ordering coming soon! Call us. ${m}</p></body></html>`;
    // Its theme makes it as heavy as the restaurant's page, so its size gives nothing away.
    const holding = (m: string) =>
      `<html lang="en"><head><title>Northwind Studio</title><style>${'.nw{margin:0}'.repeat(150)}</style></head><body><div class="logo">Northwind</div><p>Our new website is coming soon. In the meantime, read our blog or get in touch.</p>` +
      `<a href="/about">About</a> <a href="/contact">Contact</a> <a href="/privacy">Privacy</a> <a href="/blog">Blog</a><span>${m}</span></body></html>`;
    const h = await scan([
      ...monthRange('201501', '201712').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: restaurant(m) })),
      ...monthRange('201801', '201912').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: holding(m) })),
    ]);
    assert.equal(h.lastGood?.month, '201712');
    assert.equal(h.window.to, '20171231235959');
  });

  it("still lets the site's own pages off when it says the phrase on every capture", async () => {
    // A short page without a title: without its own phrase let off, every month would be weak.
    const dentist = (m: string) =>
      `<html lang="en"><head></head><body><h1>Maple Street Dental</h1>${nav(['Home', 'Services', 'Our Team', 'New Patients', 'Insurance', 'Contact'])}` +
      `<p>Dr. Anne Keller and her team have cared for families in Dayton since 1998. We offer cleanings, fillings, crowns, whitening and gentle care for nervous patients and children.</p>` +
      `<p>Open Monday to Friday 8am to 5pm and Saturday mornings. Most insurance plans accepted. Online booking coming soon!</p><p>412 Maple Street, Dayton. Call 555-0177 for an appointment. Updated ${m}.</p></body></html>`;
    const h = await scan([
      ...monthRange('201501', '201712').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: dentist(m) })),
      { url: 'http://example.com/', ts: '20180115120000', body: '<html><body><h1>example.com</h1><p>This domain may be for sale!</p></body></html>' },
    ]);
    assert.equal(h.lastGood?.month, '201712');
    assert.equal(h.window.to, '20171231235959');
  });
});
