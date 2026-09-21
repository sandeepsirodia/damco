import 'dotenv/config';
import './tracing.js'; // registers Langfuse's OTel span processor, if configured -- must run before any LLM call
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db/migrate.js';
import { router as sessionsRouter } from './routes/sessions.js';
import { router as fsRouter } from './routes/fs.js';
import { mountCopilotKit } from './copilotkit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'web', 'dist')));

app.use('/api/sessions', sessionsRouter);
app.use('/api/fs', fsRouter);
mountCopilotKit(app);

app.get('/api/health', (req, res) => res.json({ ok: true, llmProvider: process.env.LLM_PROVIDER || 'gemini' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

async function start() {
  await migrate();
  app.listen(PORT, () => console.log(`Spec Clarity listening on :${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
