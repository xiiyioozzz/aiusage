import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { estimateTokens, normalizeKiroModel, scanKiroDates } from '../kiro.js';
import { dateKey } from '../utils.js';
import { scanKiroProxyDates } from '../kiro-proxy.js';
import { scanKiroRecoveredDates } from '../kiro-recovered.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = join(tmpdir(), `aiusage-kiro-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('scanKiroDates', () => {
  it('estimates IDE turns from context usage and character counts', async () => {
    const sessionDir = join(rootDir, 'workspace-a', 'sess_test');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'sess_test',
      modelId: 'claude-opus-4.8',
      workspacePaths: ['/Users/test/Projects/demo-app'],
      createdAt: '2026-07-14T06:48:46.637Z',
    }));
    await writeFile(join(sessionDir, 'messages.jsonl'), [
      JSON.stringify({
        timestamp: '2026-07-14T06:50:00.000Z',
        payload: { type: 'user', content: 'abcd' },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T06:50:01.000Z',
        payload: { type: 'assistant', content: 'abcdefgh' },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T06:50:02.000Z',
        payload: { type: 'tool_call', args: { cmd: 'ls' } },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T06:50:03.000Z',
        payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 10 } },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T06:51:00.000Z',
        payload: { type: 'turn_end' },
      }),
    ].join('\n'));

    const usageDate = dateKey(new Date('2026-07-14T06:50:00.000Z'));
    const result = await scanKiroDates([usageDate], rootDir, undefined, { home: rootDir, env: {} });
    const rows = result.get(usageDate) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product).toBe('kiro');
    expect(rows[0]?.provider).toBe('anthropic');
    expect(rows[0]?.model).toBe('claude-opus-4.8');
    expect(rows[0]?.eventCount).toBe(1);
    expect(rows[0]?.inputTokens).toBe(20_000);
    expect(rows[0]?.outputTokens).toBe(estimateTokens(8 + JSON.stringify({ cmd: 'ls' }).length));
    expect(rows[0]?.projectDisplay).toBe('demo-app');
  });

  it('falls back to char estimates when context usage is missing', async () => {
    const sessionDir = join(rootDir, 'workspace-b', 'sess_flat');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
      modelId: 'auto',
      workspacePaths: ['/tmp/other'],
    }));
    await writeFile(join(sessionDir, 'messages.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-01T12:00:00.000Z',
        payload: { type: 'user', content: '12345678' },
      }),
      JSON.stringify({
        timestamp: '2026-08-01T12:00:01.000Z',
        payload: { type: 'assistant', content: 'abcd' },
      }),
      JSON.stringify({
        timestamp: '2026-08-01T12:00:02.000Z',
        payload: { type: 'turn_end' },
      }),
    ].join('\n'));

    const usageDate = dateKey(new Date('2026-08-01T12:00:00.000Z'));
    const result = await scanKiroDates([usageDate], rootDir, undefined, { home: rootDir, env: {} });
    const row = result.get(usageDate)?.[0];
    expect(row?.inputTokens).toBe(2);
    expect(row?.outputTokens).toBe(1);
    expect(row?.model).toBe('auto');
  });
});

describe('normalizeKiroModel', () => {
  it('strips vendor prefixes and thinking suffixes', () => {
    expect(normalizeKiroModel('nghi/claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeKiroModel('claude-opus-4.8-thinking')).toBe('claude-opus-4.8');
    expect(normalizeKiroModel('auto')).toBe('auto');
  });
});

describe('scanKiroProxyDates', () => {
  it('reads split tokens from kiro.rs usage logs', async () => {
    const usageDate = dateKey(new Date('2026-07-14T12:00:00.000Z'));
    await writeFile(join(rootDir, `usage_log.${usageDate}.jsonl`), [
      JSON.stringify({
        ts: '2026-07-14T12:00:00.000Z',
        model: 'claude-opus-4.8',
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 80,
        cacheCreationTokens: 40,
        credits: 2.5,
        status: 'success',
      }),
      JSON.stringify({
        ts: '2026-07-14T12:05:00.000Z',
        model: 'claude-opus-4.8',
        inputTokens: 100,
        outputTokens: 20,
        status: 'error',
      }),
    ].join('\n'));

    const result = await scanKiroProxyDates([usageDate], { extraDirs: [rootDir], home: rootDir, env: {} });
    const row = result.get(usageDate)?.[0];
    expect(row?.product).toBe('kiro');
    expect(row?.channel).toBe('api');
    expect(row?.provider).toBe('anthropic');
    expect(row?.model).toBe('claude-opus-4.8');
    expect(row?.projectDisplay).toBe('kiro-rs');
    expect(row?.eventCount).toBe(2);
    expect(row?.inputTokens).toBe(1300);
    expect(row?.outputTokens).toBe(320);
    expect(row?.cachedInputTokens).toBe(80);
    expect(row?.cacheWriteTokens).toBe(40);
  });

  it('reads Kiro-Go request logs and prices later from official list rates', async () => {
    const usageDate = dateKey(new Date('2026-07-14T12:00:00.000Z'));
    await mkdir(join(rootDir, 'data'), { recursive: true });
    await writeFile(join(rootDir, 'data', 'request_logs.json'), JSON.stringify([
      {
        time: Date.parse('2026-07-14T12:00:00.000Z') / 1000,
        model: 'gpt-5.6-sol',
        status: 'success',
        tokens: 4500,
        credits: 1.25,
      },
      {
        time: Date.parse('2026-07-14T12:01:00.000Z') / 1000,
        model: 'gpt-5.6-sol',
        status: 'error',
        tokens: 10,
      },
    ]));

    const result = await scanKiroProxyDates([usageDate], { extraDirs: [rootDir], home: rootDir, env: {} });
    const row = result.get(usageDate)?.[0];
    expect(row?.provider).toBe('openai');
    expect(row?.model).toBe('gpt-5.6-sol');
    expect(row?.projectDisplay).toBe('kiro-go');
    expect(row?.eventCount).toBe(2);
    expect(row?.inputTokens).toBe(4510);
    expect(row?.outputTokens).toBe(0);
  });
});

describe('scanKiroDates proxy merge', () => {
  it('keeps IDE estimates and proxy counters as separate channel rows', async () => {
    const usageDate = dateKey(new Date('2026-07-14T12:00:00.000Z'));
    const sessionDir = join(rootDir, 'workspace-a', 'sess_test');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
      modelId: 'claude-opus-4.8',
      workspacePaths: ['/Users/test/Projects/demo-app'],
    }));
    await writeFile(join(sessionDir, 'messages.jsonl'), [
      JSON.stringify({ timestamp: '2026-07-14T12:00:00.000Z', payload: { type: 'user', content: 'abcd' } }),
      JSON.stringify({ timestamp: '2026-07-14T12:00:01.000Z', payload: { type: 'assistant', content: 'abcd' } }),
      JSON.stringify({ timestamp: '2026-07-14T12:00:02.000Z', payload: { type: 'turn_end' } }),
    ].join('\n'));
    await writeFile(join(rootDir, `usage_log.${usageDate}.jsonl`), JSON.stringify({
      ts: '2026-07-14T12:00:00.000Z',
      model: 'claude-opus-4.8',
      inputTokens: 900,
      outputTokens: 100,
      status: 'success',
    }));

    const rows = (await scanKiroDates([usageDate], rootDir, undefined, {
      proxyDataDirs: [rootDir],
      home: rootDir,
      env: {},
    })).get(usageDate) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.channel).sort()).toEqual(['api', 'ide']);
    expect(rows.find(row => row.channel === 'api')?.inputTokens).toBe(900);
  });
});

describe('scanKiroRecoveredDates', () => {
  it('folds leftover lifetime tokens into the kiro-go Hermes day instead of a config-mtime spike', async () => {
    const when = new Date('2026-07-17T12:00:00.000Z');
    const usageDate = dateKey(when);
    const hermesDb = await writeHermesDb([[
      'sess-1', when, 'gpt-5.6-sol', 3, 1000, 40,
    ]]);
    await writeFile(join(rootDir, 'config.json'), JSON.stringify({
      totalTokens: 5000,
      totalRequests: 10,
    }));
    const remainderDate = dateKey(new Date('2026-08-01T12:00:00.000Z'));

    const result = await scanKiroRecoveredDates([usageDate, remainderDate], {
      extraDirs: [rootDir],
      hermesDbPath: hermesDb,
      home: rootDir,
      env: {},
    });

    const hermes = result.get(usageDate)?.[0];
    expect(hermes?.channel).toBe('api');
    expect(hermes?.projectDisplay).toBe('kiro-go');
    expect(hermes?.model).toBe('gpt-5.6-sol');
    expect(hermes?.eventCount).toBe(10);
    expect(hermes?.inputTokens).toBe(4960);
    expect(hermes?.outputTokens).toBe(40);
    expect(result.get(remainderDate) ?? []).toEqual([]);
  });

  it('spreads leftover lifetime totals evenly across every kiro-go day', async () => {
    const dayA = new Date('2026-07-17T12:00:00.000Z');
    const dayB = new Date('2026-07-20T12:00:00.000Z');
    const hermesDb = await writeHermesDb([
      ['sess-a', dayA, 'gpt-5.6-sol', 3, 1000, 40],
      ['sess-b', dayB, 'claude-opus-4.8', 4, 2000, 80],
    ]);
    await writeFile(join(rootDir, 'config.json'), JSON.stringify({
      totalTokens: 10000,
      totalRequests: 20,
    }));

    const result = await scanKiroRecoveredDates([dateKey(dayA), dateKey(dayB)], {
      extraDirs: [rootDir],
      hermesDbPath: hermesDb,
      home: rootDir,
      env: {},
    });

    const first = result.get(dateKey(dayA))?.[0];
    const second = result.get(dateKey(dayB))?.[0];
    expect(first?.projectDisplay).toBe('kiro-go');
    expect(second?.projectDisplay).toBe('kiro-go');
    expect(first?.inputTokens).toBe(4440);
    expect(second?.inputTokens).toBe(5440);
    expect(first?.eventCount).toBe(10);
    expect(second?.eventCount).toBe(10);
    expect((first?.inputTokens ?? 0) + (second?.inputTokens ?? 0)).toBe(9880);
  });
});

async function writeHermesDb(
  rows: Array<[string, Date, string, number, number, number]>,
): Promise<string> {
  const hermesDb = join(rootDir, 'state.db');
  const db = new DatabaseSync(hermesDb);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      started_at REAL,
      model TEXT,
      api_call_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      billing_provider TEXT,
      billing_base_url TEXT
    );
    CREATE TABLE session_model_usage (
      session_id TEXT,
      model TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT DEFAULT '',
      task TEXT DEFAULT '',
      api_call_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER
    );
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, started_at, model, api_call_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, billing_base_url)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
  `);
  const insertUsage = db.prepare(`
    INSERT INTO session_model_usage (session_id, model, billing_provider, billing_base_url,
      api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `);
  for (const [id, when, model, events, input, output] of rows) {
    insertSession.run(id, when.getTime() / 1000, model, events, input, output, 'kiro-go-local', 'http://127.0.0.1:8080/v1');
    insertUsage.run(id, model, 'kiro-go-local', 'http://127.0.0.1:8080/v1', events, input, output);
  }
  db.close();
  return hermesDb;
}
