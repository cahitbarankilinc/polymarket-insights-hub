import path from 'path';
import { fileURLToPath } from 'url';
import { startTrackerServer } from './trackerServer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

startTrackerServer({
  port: Number(process.env.SERVER_PORT ?? 8787),
  dataDir: process.env.POLYMARKET_DATA_DIR ?? path.join(projectRoot, 'app_data'),
});
