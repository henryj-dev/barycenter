import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono().basePath('/api');

app.get('/healthz', (c) => c.json({ ok: true }));

// 3000 은 다른 로컬 도구가 쓴다.
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api: http://localhost:${info.port}/api`);
});

export type App = typeof app;
