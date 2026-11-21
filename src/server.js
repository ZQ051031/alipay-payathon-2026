import 'dotenv/config';
import { configFromEnv } from './core.js';
import { createApp } from './app.js';
const config = configFromEnv();
const port = Number(process.env.PORT || 3000);
const { app } = createApp(config);
const server = app.listen(port, '0.0.0.0', () => console.log(`VibeCopy running on port ${server.address().port} (${config.mode})`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
