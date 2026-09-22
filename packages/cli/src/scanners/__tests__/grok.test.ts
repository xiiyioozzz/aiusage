import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeGrokCwd, discoverGrokDates, scanGrokDates } from '../grok.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = join(tmpdir(), `aiusage-grok-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('decodeGrokCwd', () => {
  it('decodes URL-encoded working directories', () => {
    expect(decodeGrokCwd('%2Fprivate%2Ftmp%2Fgrok-test')).toBe('/private/tmp/grok-test');
  });
});

describe('scanGrokDates', () => {
  it('reads per-turn usage from updates.jsonl and keeps model splits', async () => {
    const sessionDir = join(rootDir, encodeURIComponent('/Users/test/demo-app'), 'sess-1');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'summary.json'), JSON.stringify({
      current_model_id: 'grok-4.6',
      created_at: '2026-08-13T12:00:00.000Z',
      updated_at: '2026-08-13T12:00:00.000Z',
      info: { id: 'sess-1', cwd: '/Users/test/demo-app' },
    }));
    await writeFile(join(sessionDir, 'updates.jsonl'), [
      {
        timestamp: '2026-08-13T12:00:00.000Z',
        params: {
          update: {
            prompt_id: 'turn-a',
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cachedReadTokens: 30,
              cacheCreationTokens: 4,
              reasoningTokens: 5,
              modelCalls: 1,
              modelUsage: {
                'grok-4.6-build': {
                  inputTokens: 100,
                  outputTokens: 20,
                  cachedReadTokens: 30,
                  cacheCreationTokens: 4,
                  reasoningTokens: 5,
                  modelCalls: 1,
                },
              },
            },
          },
        },
      },
      {
        timestamp: '2026-08-14T12:00:00.000Z',
        params: {
          update: {
            prompt_id: 'turn-b',
            usage: {
              inputTokens: 50,
              outputTokens: 8,
              cachedReadTokens: 0,
              cacheCreationTokens: 0,
              reasoningTokens: 0,
              modelCalls: 2,
              modelUsage: {
                'grok-4.6': {
                  inputTokens: 50,
                  outputTokens: 8,
                  modelCalls: 2,
                },
              },
            },
          },
        },
      },
    ].map(row => JSON.stringify(row)).join('\n'));

    const result = await scanGrokDates(['2026-08-13', '2026-08-14'], rootDir);
    const first = result.get('2026-08-13')?.[0];
    const second = result.get('2026-08-14')?.[0];

    expect(first).toEqual(expect.objectContaining({
      provider: 'xai',
      product: 'grok',
      channel: 'cli',
      model: 'grok-4.6-build',
      projectDisplay: 'demo-app',
      eventCount: 1,
      inputTokens: 100,
      cachedInputTokens: 30,
      cacheWriteTokens: 4,
      outputTokens: 20,
      reasoningOutputTokens: 5,
    }));
    expect(second).toEqual(expect.objectContaining({
      model: 'grok-4.6',
      eventCount: 2,
      inputTokens: 50,
      outputTokens: 8,
    }));
  });

  it('falls back to signals.json when updates.jsonl has no usage', async () => {
    const sessionDir = join(rootDir, encodeURIComponent('/tmp/grok-test'), 'sess-2');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'summary.json'), JSON.stringify({
      current_model_id: 'grok-4.6',
      last_active_at: '2026-08-22T12:00:00.000Z',
      info: { id: 'sess-2', cwd: '/tmp/grok-test' },
    }));
    await writeFile(join(sessionDir, 'updates.jsonl'), '{}\n');
    await writeFile(join(sessionDir, 'signals.json'), JSON.stringify({
      contextTokensUsed: 41839,
      turnCount: 70,
      primaryModelId: 'grok-4.6',
    }));

    const rows = (await scanGrokDates(['2026-08-22'], rootDir)).get('2026-08-22') ?? [];
    expect(rows).toEqual([
      expect.objectContaining({
        product: 'grok',
        model: 'grok-4.6',
        projectDisplay: 'grok-test',
        eventCount: 70,
        inputTokens: 41839,
        outputTokens: 0,
      }),
    ]);
  });

  it('discovers usage dates from completed turns', async () => {
    const sessionDir = join(rootDir, encodeURIComponent('/tmp/x'), 'sess-3');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'summary.json'), JSON.stringify({
      info: { id: 'sess-3', cwd: '/tmp/x' },
    }));
    await writeFile(join(sessionDir, 'updates.jsonl'), JSON.stringify({
      timestamp: '2026-08-15T12:00:00.000Z',
      params: { update: { prompt_id: 't1', usage: { inputTokens: 9, outputTokens: 1 } } },
    }));

    const dates = await discoverGrokDates(rootDir);
    expect([...dates]).toEqual(['2026-08-15']);
  });
});
