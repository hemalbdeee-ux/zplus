// Posts and pages are Markdown files with front matter, organised the way Ghost organises them:
// posts (dated, tagged, with an author) and pages (static), tags and authors, settings.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';
import { truncate } from '../engine/meta.ts';

export interface Tag {
  slug: string;
  name: string;
  description?: string;
}

export interface Author {
  slug: string;
  name: string;
  bio?: string;
}

export interface Entry {
  type: 'post' | 'page';
  slug: string;
  title: string;
  html: string;
  excerpt: string;
  date?: string;
  updated?: string;
  tags: Tag[];
  author?: Author;
  image?: string;
  metaTitle?: string;
  metaDescription?: string;
  featured: boolean;
}

export interface Settings {
  title: string;
  description: string;
  lang: string;
  navigation: Array<{ label: string; url: string }>;
  secondaryNavigation: Array<{ label: string; url: string }>;
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (kv) data[kv[1].toLowerCase()] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(m[0].length) };
}

function toIso(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T09:00:00Z` : date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.000Z$/, 'Z');
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export class Content {
  settings: Settings;
  posts: Entry[];
  pages: Entry[];
  tags: Map<string, Tag>;
  authors: Map<string, Author>;

  constructor(settings: Settings, posts: Entry[], pages: Entry[], tags: Map<string, Tag>, authors: Map<string, Author>) {
    this.settings = settings;
    this.posts = posts;
    this.pages = pages;
    this.tags = tags;
    this.authors = authors;
  }

  static async load(dir: string): Promise<Content> {
    const settings = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Settings;
    const authorList = JSON.parse(await readFile(path.join(dir, 'authors.json'), 'utf8')) as Author[];
    const authors = new Map(authorList.map((a) => [a.slug, a]));
    const tagList = JSON.parse(await readFile(path.join(dir, 'tags.json'), 'utf8').catch(() => '[]')) as Tag[];
    const tags = new Map(tagList.map((t) => [t.slug, t]));

    const readEntries = async (type: 'post' | 'page'): Promise<Entry[]> => {
      const folder = path.join(dir, type === 'post' ? 'posts' : 'pages');
      const files = (await readdir(folder).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort();
      const out: Entry[] = [];
      for (const f of files) {
        const { data, body } = parseFrontMatter(await readFile(path.join(folder, f), 'utf8'));
        if (data.status === 'draft') continue;
        const html = await marked.parse(body);
        const entryTags = (data.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((name) => {
            const slug = slugify(name);
            if (!tags.has(slug)) tags.set(slug, { slug, name });
            return tags.get(slug)!;
          });
        out.push({
          type,
          slug: data.slug || slugify(f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')),
          title: data.title ?? f,
          html,
          excerpt: data.excerpt || truncate(textOf(html), 160),
          date: toIso(data.date),
          updated: toIso(data.updated),
          tags: entryTags,
          author: data.author ? authors.get(data.author) : authorList[0],
          image: data.feature_image || undefined,
          metaTitle: data.meta_title || undefined,
          metaDescription: data.meta_description || undefined,
          featured: data.featured === 'true',
        });
      }
      return out;
    };

    const posts = (await readEntries('post')).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const pages = await readEntries('page');
    return new Content(settings, posts, pages, tags, authors);
  }

  find(slug: string): Entry | undefined {
    return this.posts.find((p) => p.slug === slug) ?? this.pages.find((p) => p.slug === slug);
  }

  postsByTag(slug: string): Entry[] {
    return this.posts.filter((p) => p.tags.some((t) => t.slug === slug));
  }

  postsByAuthor(slug: string): Entry[] {
    return this.posts.filter((p) => p.author?.slug === slug);
  }
}

export function paginate<T>(items: T[], page: number, perPage: number): { items: T[]; page: number; pages: number; prev?: number; next?: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((p - 1) * perPage, p * perPage),
    page: p,
    pages,
    prev: p > 1 ? p - 1 : undefined,
    next: p < pages ? p + 1 : undefined,
  };
}
