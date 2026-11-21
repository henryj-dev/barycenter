import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

// DB 는 처음 부를 때 붙는다 — DATABASE_URL 없이도 서버는 뜬다.
let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function db() {
  if (instance) return instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  instance = drizzle(postgres(url), { schema });
  return instance;
}
