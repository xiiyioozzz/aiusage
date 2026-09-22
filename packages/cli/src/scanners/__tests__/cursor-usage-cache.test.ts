import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveCursorUsage,
  cursorAccountKey,
  readCursorProjectPaths,
  readCursorUsageArchive,
  writeCursorProjectPaths,
} from '../cursor-usage-cache.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function archivePath() {
  const dir = await mkdtemp(join(tmpdir(), 'aiusage-cursor-cache-test-'));
  dirs.push(dir);
  return join(dir, 'usage.json');
}
const a = cursorAccountKey('account-a', 'https://cursor.com');
const b = cursorAccountKey('account-b', 'https://cursor.com');
const event = { timestamp: Date.parse('2026-09-01T12:00:00Z'), model: 'gpt-5.5', conversationId: 'chat', tokenUsage: { inputTokens: 100, outputTokens: 50 } };

describe('Cursor billing history archive', () => {
  it('retains both accounts through switch, refresh and missing auth', async () => {
    const path = await archivePath();
    await archiveCursorUsage(path, a, 'json', [event]);
    const fromB = { ...event, timestamp: Number(event.timestamp) + 1000, model: 'claude-opus-4-8' };
    await archiveCursorUsage(path, b, 'json', [fromB]);
    await archiveCursorUsage(path, a, 'json', [event]);
    expect(await readCursorUsageArchive(path)).toHaveLength(2);
    // A later server window doesn't delete earlier archived days.
    await archiveCursorUsage(path, a, 'json', [{ ...event, timestamp: Number(event.timestamp) + 86400000 }]);
    expect(await readCursorUsageArchive(path)).toHaveLength(3);
  });

  it('preserves distinct identical events without repeating them on refresh', async () => {
    const path = await archivePath();
    await archiveCursorUsage(path, a, 'json', [event, event]);
    await archiveCursorUsage(path, a, 'json', [event, event]);
    expect(await readCursorUsageArchive(path)).toHaveLength(2);
  });

  it('does not double count JSON and CSV fallback for the same day', async () => {
    const path = await archivePath();
    await archiveCursorUsage(path, a, 'csv', [{ ...event, conversationId: undefined }]);
    await archiveCursorUsage(path, a, 'json', [event]);
    expect(await readCursorUsageArchive(path)).toEqual([{
      ...event, tokenUsage: { inputTokens: 100, outputTokens: 50 },
    }]);
  });

  it('persists only allowlisted metadata with owner-only access', async () => {
    const path = await archivePath();
    await archiveCursorUsage(path, a, 'json', [{ ...event, accessToken: 'do-not-store', prompt: 'private content' } as typeof event]);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('account-a');
    expect(raw).not.toContain('do-not-store');
    expect(raw).not.toContain('private content');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent account updates', async () => {
    const path = await archivePath();
    await Promise.all([archiveCursorUsage(path, a, 'json', [event]), archiveCursorUsage(path, b, 'json', [event])]);
    expect(await readCursorUsageArchive(path)).toHaveLength(2);
  });
});

describe('Cursor conversation project cache', () => {
  it('persists attributed paths and drops unknown placeholders', async () => {
    const path = join((await archivePath()).replace(/usage\.json$/, ''), 'projects.json');
    await writeCursorProjectPaths(path, {
      'chat-a': '/Users/test/Documents/aiusage',
      'chat-b': 'unknown',
      '': 'skip',
    });
    expect(await readCursorProjectPaths(path)).toEqual({
      'chat-a': '/Users/test/Documents/aiusage',
    });
  });
});
