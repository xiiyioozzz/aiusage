import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Env } from '../types.js';

/** Execute the production SQL against the real migration schema. */
export function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }

  const DB = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...params: SQLInputValue[]) {
          values = params;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          sqlite.prepare(sql).run(...values);
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;

  const env = {
    DB,
    DEVICE_TOKEN_SECRET: 'synthetic-device-secret',
    SITE_ID: 'test-site',
    PROJECT_NAME_SALT: 'synthetic-project-salt',
    PUBLIC_PROJECT_VISIBILITY: 'masked',
    DEFAULT_TIMEZONE: 'UTC',
  } as unknown as Env;

  return { sqlite, env };
}
