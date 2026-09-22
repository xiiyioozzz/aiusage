import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { contextWindowForModel, estimateTokens, normalizeKiroModel, scanKiroDates } from '../kiro.js';
import { dateKey, takeHourly } from '../utils.js';
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
    expect(rows[0]?.inputTokens).toBe(100_000);
    expect(rows[0]?.outputTokens).toBe(estimateTokens(8 + JSON.stringify({ cmd: 'ls' }).length));
    expect(rows[0]?.costUSD).toBeUndefined();
    expect(rows[0]?.projectDisplay).toBe('demo-app');
    expect(rows[0]?.tokenQuality).toBe('estimated');
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

  it('does not convert official credits into cost or token counts', async () => {
    const sessionDir = join(rootDir, 'workspace-c', 'sess_credits');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
      modelId: 'claude-opus-4.8',
      workspacePaths: ['/Users/test/Projects/demo-app'],
    }));
    await writeFile(join(sessionDir, 'messages.jsonl'), [
      JSON.stringify({ timestamp: '2026-08-15T12:00:00.000Z', payload: { type: 'user', content: 'abcd' } }),
      JSON.stringify({ timestamp: '2026-08-15T12:00:01.000Z', payload: { type: 'assistant', content: 'efgh' } }),
      JSON.stringify({
        timestamp: '2026-08-15T12:00:02.000Z',
        payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', usage: 10 }] },
      }),
      JSON.stringify({ timestamp: '2026-08-15T12:00:03.000Z', payload: { type: 'turn_end' } }),
    ].join('\n'));

    const usageDate = dateKey(new Date('2026-08-15T12:00:00.000Z'));
    const row = (await scanKiroDates([usageDate], rootDir, undefined, { home: rootDir, env: {} }))
      .get(usageDate)?.[0];
    expect(row?.costUSD).toBeUndefined();
    expect(row?.inputTokens).toBe(1);
    expect(row?.outputTokens).toBe(1);
    expect(row?.tokenQuality).toBe('estimated');
    expect(row?.channel).toBe('ide');
  });

  it('reads execution usageSummary credits when a day has no messages.jsonl turns', async () => {
    const storageDir = join(rootDir, 'agent-storage');
    const execDir = join(storageDir, 'profile', 'execs');
    await mkdir(execDir, { recursive: true });
    await writeFile(join(execDir, 'exec-1.json'), JSON.stringify({
      executionId: 'exec-1',
      chatSessionId: 'session-old',
      startTime: Date.parse('2026-06-18T12:00:00.000Z'),
      contextUsagePercentage: 10,
      usageSummary: [{ unit: 'credit', usage: 5 }],
      actions: [],
    }));
    await mkdir(join(storageDir, 'workspace-sessions', 'ws'), { recursive: true });
    await writeFile(join(storageDir, 'workspace-sessions', 'ws', 'session-old.json'), JSON.stringify({
      sessionId: 'session-old',
      selectedModel: 'claude-opus-4.8',
      workspaceDirectory: '/Users/test/Projects/demo-app',
    }));

    const usageDate = dateKey(new Date('2026-06-18T12:00:00.000Z'));
    const row = (await scanKiroDates([usageDate], join(rootDir, 'empty-sessions'), undefined, {
      home: rootDir,
      env: {},
      agentStorageDir: storageDir,
    })).get(usageDate)?.[0];
    expect(row?.channel).toBe('ide');
    expect(row?.model).toBe('claude-opus-4.8');
    expect(row?.projectDisplay).toBe('demo-app');
    expect(row?.eventCount).toBe(1);
    expect(row?.inputTokens).toBe(100_000);
    expect(row?.costUSD).toBeUndefined();
  });

  it('overlays execution credits onto the same day instead of double-counting events', async () => {
    const sessionDir = join(rootDir, 'workspace-d', 'sess_overlay');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'sess_overlay',
      modelId: 'claude-opus-4.8',
      workspacePaths: ['/Users/test/Projects/demo-app'],
    }));
    await writeFile(join(sessionDir, 'messages.jsonl'), [
      JSON.stringify({ timestamp: '2026-07-10T12:00:00.000Z', payload: { type: 'user', content: 'abcd' } }),
      JSON.stringify({
        timestamp: '2026-07-10T12:00:01.000Z',
        payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 10 } },
      }),
      JSON.stringify({ timestamp: '2026-07-10T12:00:02.000Z', payload: { type: 'assistant', content: 'efgh' } }),
      JSON.stringify({ timestamp: '2026-07-10T12:00:03.000Z', payload: { type: 'turn_end' } }),
    ].join('\n'));
    const storageDir = join(rootDir, 'agent-storage');
    const execDir = join(storageDir, 'profile', 'execs');
    await mkdir(execDir, { recursive: true });
    await writeFile(join(execDir, 'exec-2.json'), JSON.stringify({
      executionId: 'exec-2',
      chatSessionId: 'sess_overlay',
      startTime: Date.parse('2026-07-10T12:05:00.000Z'),
      contextUsagePercentage: 25,
      usageSummary: [{ unit: 'credit', usage: 8 }],
      actions: [],
    }));

    const usageDate = dateKey(new Date('2026-07-10T12:00:00.000Z'));
    const rows = (await scanKiroDates([usageDate], rootDir, undefined, {
      home: rootDir,
      env: {},
      agentStorageDir: storageDir,
    })).get(usageDate) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventCount).toBe(1);
    expect(rows[0]?.costUSD).toBeUndefined();
    expect(rows[0]?.inputTokens).toBe(100_000);
  });
});

describe('normalizeKiroModel', () => {
  it('strips vendor prefixes and thinking suffixes', () => {
    expect(normalizeKiroModel('nghi/claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeKiroModel('claude-opus-4.8-thinking')).toBe('claude-opus-4.8');
    expect(normalizeKiroModel('auto')).toBe('auto');
  });
});

describe('contextWindowForModel', () => {
  it('uses official Kiro windows instead of a fixed 200k', () => {
    expect(contextWindowForModel('claude-opus-4.8')).toBe(1_000_000);
    expect(contextWindowForModel('claude-opus-5')).toBe(1_000_000);
    expect(contextWindowForModel('gpt-5.6-sol')).toBe(1_000_000);
    expect(contextWindowForModel('claude-sonnet-4-6')).toBe(1_000_000);
    expect(contextWindowForModel('claude-opus-4-5-20251101')).toBe(200_000);
    expect(contextWindowForModel('glm-5')).toBe(200_000);
    expect(contextWindowForModel('qwen3-coder-next')).toBe(256_000);
    expect(contextWindowForModel('deepseek-3.2')).toBe(128_000);
    expect(contextWindowForModel('auto')).toBe(200_000);
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
    expect(row?.tokenQuality).toBe('reported');
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
    expect(row?.tokenQuality).toBe('estimated');
  });

  it('skips invalid timestamps and keeps mixed split/combined aggregates estimated', async () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    const usageDate = dateKey(new Date(timestamp));
    await writeFile(join(rootDir, 'request_logs.json'), JSON.stringify([
      { time: { invalid: true }, model: 'gpt-5.6-sol', tokens: 9000 },
      { time: timestamp, model: 'gpt-5.6-sol', inputTokens: 100, outputTokens: 10 },
      { time: timestamp, model: 'gpt-5.6-sol', tokens: 50 },
    ]));
    const result = await scanKiroProxyDates([usageDate], { extraDirs: [rootDir], home: rootDir, env: {} });
    expect(result.get(usageDate)).toEqual([
      expect.objectContaining({ eventCount: 2, inputTokens: 150, outputTokens: 10, tokenQuality: 'estimated' }),
    ]);
    const hourly = [...takeHourly(result)!.get(usageDate)!.values()].flatMap(rows => [...rows.values()]);
    expect(hourly).toEqual([expect.objectContaining({ tokenQuality: 'estimated' })]);
  });
});

describe('scanKiroDates proxy merge', () => {
  it.each([1100, 1500, 400])('prefers %i request-log tokens over overlapping Hermes totals, with unique daily/hourly keys', async proxyTokens => {
    const when = new Date('2026-07-17T04:00:00.000Z');
    const proxyWhen = new Date('2026-07-17T06:00:00.000Z');
    const usageDate = dateKey(when);
    const hermesDb = await writeHermesDb([
      ['same-model', when, 'gpt-5.6-sol', 1, 1000, 100],
      ['fallback-model', when, 'claude-opus-4.8', 1, 200, 20],
    ]);
    await writeFile(join(rootDir, 'request_logs.json'), JSON.stringify([
      { time: proxyWhen.toISOString(), model: 'gpt-5.6-sol', status: 'success', tokens: proxyTokens },
    ]));
    // A lifetime balance must not reintroduce synthetic usage after reconciliation.
    await writeFile(join(rootDir, 'config.json'), JSON.stringify({ totalTokens: 99999, totalRequests: 100 }));
    const result = await scanKiroDates([usageDate], rootDir, undefined, {
      proxyDataDirs: [rootDir], hermesDbPath: hermesDb, home: rootDir, env: {},
    });
    expect(result.get(usageDate)).toHaveLength(2);
    expect(result.get(usageDate)?.find(row => row.model === 'gpt-5.6-sol')).toEqual(expect.objectContaining({
      eventCount: 1, inputTokens: proxyTokens, outputTokens: 0, tokenQuality: 'estimated',
    }));
    expect(result.get(usageDate)?.find(row => row.model === 'claude-opus-4.8')).toEqual(expect.objectContaining({
      eventCount: 1, inputTokens: 200, outputTokens: 20, tokenQuality: 'estimated',
    }));
    const hours = takeHourly(result)!.get(usageDate)!;
    expect([...hours.get(proxyWhen.getHours())!.values()]).toEqual([
      expect.objectContaining({ model: 'gpt-5.6-sol', inputTokens: proxyTokens, eventCount: 1 }),
    ]);
    expect([...hours.get(when.getHours())!.values()]).toEqual([
      expect.objectContaining({ model: 'claude-opus-4.8', inputTokens: 200 }),
    ]);
  });

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
  it('does not fabricate dated usage from lifetime counters', async () => {
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
    expect(hermes?.eventCount).toBe(3);
    expect(hermes?.inputTokens).toBe(1000);
    expect(hermes?.outputTokens).toBe(40);
    expect(hermes?.tokenQuality).toBe('estimated');
    expect(result.get(remainderDate) ?? []).toEqual([]);
  });

  it('keeps observed session totals unchanged when lifetime counters grow', async () => {
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
    expect(first?.inputTokens).toBe(1000);
    expect(second?.inputTokens).toBe(2000);
    expect(first?.eventCount).toBe(3);
    expect(second?.eventCount).toBe(4);
    await writeFile(join(rootDir, 'config.json'), JSON.stringify({ totalTokens: 20000, totalRequests: 40 }));
    const rescanned = await scanKiroRecoveredDates([dateKey(dayA), dateKey(dayB)], {
      extraDirs: [rootDir], hermesDbPath: hermesDb, home: rootDir, env: {},
    });
    expect([...rescanned]).toEqual([...result]);
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
