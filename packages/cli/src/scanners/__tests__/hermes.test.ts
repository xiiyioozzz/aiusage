import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dateKey } from '../utils.js';
import { scanHermesDates } from '../hermes.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = join(tmpdir(), `aiusage-hermes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('scanHermesDates', () => {
  it('counts standalone Hermes sessions and skips Kiro-Go billing', async () => {
    const when = new Date('2026-08-06T12:00:00.000Z');
    const usageDate = dateKey(when);
    const dbPath = join(rootDir, 'state.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at REAL,
        model TEXT,
        cwd TEXT,
        git_repo_root TEXT
      );
      CREATE TABLE session_model_usage (
        session_id TEXT,
        model TEXT,
        billing_provider TEXT,
        billing_base_url TEXT,
        api_call_count INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER
      );
    `);
    db.prepare('INSERT INTO sessions (id, started_at, model, cwd, git_repo_root) VALUES (?, ?, ?, ?, ?)')
      .run('sess-open', when.getTime() / 1000, 'claude-opus-5', '/Users/test/Documents/shop', '/Users/test/Documents/shop');
    db.prepare('INSERT INTO sessions (id, started_at, model, cwd, git_repo_root) VALUES (?, ?, ?, ?, ?)')
      .run('sess-kiro', when.getTime() / 1000, 'gpt-5.6-sol', '/tmp/kiro', '/tmp/kiro');
    db.prepare(`INSERT INTO session_model_usage
      (session_id, model, billing_provider, billing_base_url, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`).run('sess-open', 'claude-opus-5', 'custom', 'https://api.openmodel.ai/v1', 4, 1200, 80);
    db.prepare(`INSERT INTO session_model_usage
      (session_id, model, billing_provider, billing_base_url, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`).run('sess-kiro', 'gpt-5.6-sol', 'kiro-go-local', 'http://127.0.0.1:8080/v1', 3, 5000, 40);
    db.close();

    const rows = (await scanHermesDates([usageDate], { hermesDbPath: dbPath, home: rootDir, env: {} })).get(usageDate) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product).toBe('hermes');
    expect(rows[0]?.provider).toBe('hermes');
    expect(rows[0]?.model).toBe('claude-opus-5');
    expect(rows[0]?.projectDisplay).toBe('shop');
    expect(rows[0]?.eventCount).toBe(4);
    expect(rows[0]?.inputTokens).toBe(1200);
    expect(rows[0]?.outputTokens).toBe(80);
  });
});
