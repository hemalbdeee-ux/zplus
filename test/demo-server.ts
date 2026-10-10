// Runs the web app against the local fake archive, for trying the UI without archive.org:
//   node test/demo-server.ts   then open http://localhost:8080/ and check oldbakery.example
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { configFromEnv, createApp } from '../src/web/server.ts';
import { startFakeArchive } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const archive = await startFakeArchive(OLD_BAKERY);
const config = {
  ...configFromEnv(),
  dataDir: process.env.WBD_DATA ?? (await mkdtemp(path.join(os.tmpdir(), 'wbd-demo-'))),
  archiveBase: archive.base,
  archiveDelayMs: 150,
  archiveBackoffMs: 50,
  accessCode: process.env.WBD_ACCESS_CODE ?? 'demo',
};
const { app, runner } = await createApp(config);
runner.start();
app.listen(config.port, () => console.log(`Demo on http://localhost:${config.port}/ (fake archive ${archive.base}, access code "${config.accessCode}")`));
