import { getDb } from '../../db.js';

const TABLES = [
  'messages',
  'token_usage',
  'admin_sessions',
  'stories',
  'conversations',
];

export function resetDb() {
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  for (const t of TABLES) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.pragma('foreign_keys = ON');
}
