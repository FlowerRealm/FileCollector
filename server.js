import path from 'node:path';
import { createApp } from './app.js';

const app = createApp({
  dataDir: process.env.DATA_DIR ?? path.join(import.meta.dirname, 'data'),
  maxFileMB: Number(process.env.MAX_FILE_MB ?? 500),
  ttlMs: Number(process.env.TTL_HOURS ?? 72) * 3600 * 1000,
});
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

setInterval(app.sweep, 10 * 60 * 1000).unref();

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`http://localhost:${port}`));
