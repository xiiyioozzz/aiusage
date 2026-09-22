import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeBase32Key,
  grokBotDisplayName,
  parseGrokBotRosterBlob,
  readGrokBotRosterFromDisk,
  resolveGrokBotProject,
} from '../grok-bot-roster.js';

describe('grok bot roster', () => {
  it('decodes persistence blob keys', () => {
    const key = 'sand.client.slice.account.user.roster.last-roster';
    expect(decodeBase32Key(encodeBase32(key))).toBe(key);
  });

  it('parses roster rows into id → name', () => {
    const roster = parseGrokBotRosterBlob(JSON.stringify({
      schemaVersion: 4,
      value: {
        rows: [
          { id: 'bot-a', name: 'HeavenPrem 货单机器人', title: '' },
          { id: 'bot-b', name: '  ', title: 'Relay' },
          { id: '', name: 'ignored' },
        ],
      },
    }));
    expect(Object.fromEntries(roster)).toEqual({
      'bot-a': 'HeavenPrem 货单机器人',
      'bot-b': 'Relay',
    });
  });

  it('reads roster blobs from the Grok Bot persistence directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-bot-roster-'));
    const key = 'sand.client.slice.account.user.roster.last-roster';
    await writeFile(join(dir, `${encodeBase32(key)}.blob`), JSON.stringify({
      schemaVersion: 4,
      value: { rows: [{ id: '1c8a0f29-af41-404a-9e06-9fa8004b8c1b', name: 'HeavenPrem' }] },
    }));
    await writeFile(join(dir, `${encodeBase32('sand.client.slice.ui-layout')}.blob`), JSON.stringify({
      schemaVersion: 4,
      value: { ignored: true },
    }));
    expect(Object.fromEntries(readGrokBotRosterFromDisk(dir))).toEqual({
      '1c8a0f29-af41-404a-9e06-9fa8004b8c1b': 'HeavenPrem',
    });
  });

  it('uses the bot name, disambiguates duplicates, and buckets subagents', () => {
    const roster = new Map([
      ['bot-a', 'New Bot'],
      ['bot-b', 'New Bot'],
      ['bot-c', 'Cursor Sand Relay'],
    ]);
    expect(grokBotDisplayName('bot-a', 'New Bot', roster)).toBe('New Bot · bot-a');
    expect(resolveGrokBotProject('bot-c', roster)).toEqual({
      project: 'grok-bot/bot-c',
      projectDisplay: 'Cursor Sand Relay',
    });
    expect(resolveGrokBotProject('sand-subagent-aaaa', roster)).toEqual({
      project: 'grok-bot-subagent',
      projectDisplay: 'grok-bot-subagent',
    });
    expect(resolveGrokBotProject('missing-uuid', roster)).toEqual({
      project: 'grok-bot/missing-uuid',
      projectDisplay: 'Grok Bot · missing-',
    });
  });
});

function encodeBase32(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(value, 'utf8')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += alphabet[Number.parseInt(chunk, 2)];
  }
  return out;
}
