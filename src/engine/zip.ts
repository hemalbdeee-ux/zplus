import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';

async function* walk(dir: string, base = dir): AsyncGenerator<{ abs: string; rel: string }> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs, base);
    else if (entry.isFile()) yield { abs, rel: path.relative(base, abs).split(path.sep).join('/') };
  }
}

/** Zips folders (and single files) under the given names: { "site": "/out/x/site", "report.html": "/out/x/report.html" }. */
export async function zipPaths(entries: Record<string, string>, zipFile: string): Promise<number> {
  const zip = new yazl.ZipFile();
  let count = 0;
  for (const [name, source] of Object.entries(entries)) {
    if (!(await stat(source)).isDirectory()) {
      zip.addFile(source, name);
      count++;
      continue;
    }
    for await (const f of walk(source)) {
      zip.addFile(f.abs, `${name.replace(/\/$/, '')}/${f.rel}`);
      count++;
    }
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipFile);
    zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
  });
  return count;
}
