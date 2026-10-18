import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

await migrate();
const server = createApp().listen(config.port, () => console.log(`[server] listening on :${config.port}`));

const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
