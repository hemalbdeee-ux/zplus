// A Ghost-like theme engine: Handlebars templates in theme/, partials in theme/partials/, and
// every template rendered inside default.hbs. {{seo_head}} plays the role of Ghost's {{ghost_head}}.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { PageMeta } from '../engine/meta.ts';
import { seoHead, type SiteContext } from '../engine/seo.ts';

export interface ViewContext {
  site: SiteContext & { description: string; lang: string; navigation: unknown; secondaryNavigation: unknown; year: number };
  seo: PageMeta;
  /** Shown in <title>. */
  title: string;
  bodyClass?: string;
  [key: string]: unknown;
}

export class Theme {
  readonly hb: typeof Handlebars;
  readonly dir: string;
  #templates = new Map<string, Handlebars.TemplateDelegate>();
  #assetVersion = '';

  constructor(dir: string) {
    this.dir = dir;
    this.hb = Handlebars.create();
  }

  async load(): Promise<void> {
    const files = await readdir(this.dir);
    for (const f of files.filter((x) => x.endsWith('.hbs'))) {
      this.#templates.set(f.replace(/\.hbs$/, ''), this.hb.compile(await readFile(path.join(this.dir, f), 'utf8'), { strict: false }));
    }
    for (const f of (await readdir(path.join(this.dir, 'partials'))).filter((x) => x.endsWith('.hbs'))) {
      this.hb.registerPartial(f.replace(/\.hbs$/, ''), await readFile(path.join(this.dir, 'partials', f), 'utf8'));
    }
    const hash = createHash('sha1');
    for (const f of (await readdir(path.join(this.dir, 'assets'))).sort()) hash.update(await readFile(path.join(this.dir, 'assets', f)));
    this.#assetVersion = hash.digest('hex').slice(0, 10);
    this.#helpers();
  }

  #helpers(): void {
    const hb = this.hb;
    hb.registerHelper('seo_head', function (this: ViewContext, options: Handlebars.HelperOptions) {
      const root = options.data.root as ViewContext;
      return new hb.SafeString(seoHead(root.seo, root.site, { indent: '    ' }));
    });
    hb.registerHelper('asset', (file: string) => `/assets/${file}?v=${this.#assetVersion}`);
    hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    hb.registerHelper('or', (...args: unknown[]) => args.slice(0, -1).some(Boolean));
    hb.registerHelper('json', (v: unknown) => new hb.SafeString(JSON.stringify(v).replace(/</g, '\\u003c')));
    hb.registerHelper('plural', (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`);
    hb.registerHelper('number', (n: number) => (typeof n === 'number' ? n.toLocaleString('en-US') : n));
    hb.registerHelper('date', (iso: string | undefined) => {
      if (!iso) return '';
      return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
    });
    hb.registerHelper('ts', (ts: string | undefined) => (ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : ''));
    hb.registerHelper('mb', (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`);
  }

  render(template: string, ctx: ViewContext): string {
    const tpl = this.#templates.get(template);
    if (!tpl) throw new Error(`Theme has no template "${template}"`);
    const body = tpl(ctx, { allowProtoPropertiesByDefault: false });
    return this.#templates.get('default')!({ ...ctx, body: new this.hb.SafeString(body) });
  }
}
