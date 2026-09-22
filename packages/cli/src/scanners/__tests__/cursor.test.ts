import { describe, expect, it } from 'vitest';
import { dateKey } from '../utils.js';
import {
  applyCachedCursorProjects,
  encodeCursorWorkspacePath,
  groupCursorUsageEvents,
  isGrokBotUsage,
  isPlaceholderProjectName,
  nameFromEncodedCursorProject,
  parseDateStr,
  resolveCursorConversationProject,
  resolveCursorUsageProject,
  resolveEmptyWindowChatName,
  usableProjectPath,
} from '../cursor.js';

describe('parseDateStr', () => {
  it('keeps calendar dates as-is', () => {
    expect(parseDateStr('2026-09-14')).toBe('2026-09-14');
  });

  it('maps ISO timestamps onto the local calendar day', () => {
    const iso = '2026-09-14T21:38:40.936Z';
    expect(parseDateStr(iso)).toBe(dateKey(new Date(iso)));
  });
});

describe('cursor project helpers', () => {
  it('rejects Cursor placeholder workspace names', () => {
    expect(isPlaceholderProjectName('unknown')).toBe(true);
    expect(isPlaceholderProjectName('empty-window')).toBe(true);
    expect(isPlaceholderProjectName('New Project')).toBe(true);
    expect(isPlaceholderProjectName('workspace')).toBe(true);
    expect(usableProjectPath('/Users/test/empty-window')).toBeUndefined();
    expect(usableProjectPath('/home/ubuntu/workspace')).toBeUndefined();
    expect(usableProjectPath('/Users/test/aiusage')).toBe('/Users/test/aiusage');
  });

  it('maps encoded ~/.cursor/projects dirs onto known workspace paths', () => {
    const known = new Map([
      [encodeCursorWorkspacePath('/Users/test/Documents'), '/Users/test/Documents'],
      [encodeCursorWorkspacePath('/Users/test/Documents/cdk-express'), '/Users/test/Documents/cdk-express'],
    ]);
    expect(nameFromEncodedCursorProject('Users-test-Documents-cdk-express', known)).toBe('/Users/test/Documents/cdk-express');
    expect(nameFromEncodedCursorProject('Users-test-Documents-redeem-cdk', known)).toBe('redeem-cdk');
    expect(nameFromEncodedCursorProject('empty-window', known)).toBeUndefined();
  });

  it('resolves conversation IDs to workspace display names', () => {
    const fields = resolveCursorConversationProject('conv-1', {
      conversationToPath: new Map([['conv-1', '/Users/test/Documents/aiusage']]),
    });
    expect(fields.project).toBe('/Users/test/Documents/aiusage');
    expect(fields.projectDisplay).toBe('aiusage');
    expect(resolveCursorConversationProject('missing', {
      conversationToPath: new Map(),
    }).project).toBe('unknown');
    expect(resolveCursorConversationProject('chat-empty', {
      conversationToPath: new Map([['chat-empty', 'empty-window']]),
    })).toEqual({ project: 'empty-window', projectDisplay: 'empty-window' });
    expect(resolveEmptyWindowChatName('翻译助手')).toBe('translation-assistant');
    expect(resolveEmptyWindowChatName('TON/POL free nodes')).toBe('TON-POL free nodes');
    expect(resolveCursorConversationProject('chat-named', {
      conversationToPath: new Map([['chat-named', 'empty-window']]),
      conversationNames: new Map([['chat-named', '翻译助手']]),
      namedFolders: new Map([['translation-assistant', '/Users/test/Documents/translation-assistant']]),
    })).toEqual({
      project: '/Users/test/Documents/translation-assistant',
      projectDisplay: 'translation-assistant',
    });
    expect(resolveCursorConversationProject('chat-legacy-path', {
      conversationToPath: new Map([['chat-legacy-path', '/Users/test/Documents/翻译助手']]),
    })).toEqual({
      project: '/Users/test/Documents/translation-assistant',
      projectDisplay: 'translation-assistant',
    });
  });
});

describe('groupCursorUsageEvents', () => {
  it('splits the same model across local workspaces', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'grok-4.6',
        conversationId: 'chat-a',
        tokenUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 4 },
      },
      {
        timestamp: ts,
        model: 'grok-4.6',
        conversationId: 'chat-b',
        tokenUsage: { inputTokens: 3, outputTokens: 1 },
      },
      {
        timestamp: ts,
        model: 'grok-4.6',
        conversationId: 'chat-c',
        tokenUsage: { inputTokens: 8, outputTokens: 1 },
      },
    ], [date], {
      conversationToPath: new Map([
        ['chat-a', '/Users/test/Documents/aiusage'],
        ['chat-b', '/Users/test/Documents/cdk-express'],
      ]),
    });

    const rows = result.get(date) ?? [];
    expect(rows).toHaveLength(2);
    const byProject = Object.fromEntries(rows.map(row => [row.projectDisplay ?? row.project, row]));
    expect(byProject.aiusage?.eventCount).toBe(1);
    expect(byProject.aiusage?.inputTokens).toBe(10);
    expect(byProject.aiusage?.cachedInputTokens).toBe(100);
    expect(byProject['cdk-express']?.eventCount).toBe(1);
    expect(byProject.unknown).toBeUndefined();
  });

  it('drops unmapped conversations instead of emitting unknown', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'cursor-grok-4.6',
        conversationId: 'ghost-chat',
        tokenUsage: { inputTokens: 8, outputTokens: 1 },
      },
    ], [date], { conversationToPath: new Map() });
    expect(result.get(date)).toEqual([]);
  });

  it('attributes Grok Bot billing IDs to the bot roster instead of empty-window', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const grokBots = new Map([
      ['ghost-bot', 'HeavenPrem'],
      ['other-bot', 'HeavenPrem'],
    ]);
    expect(isGrokBotUsage({ model: 'grok-bot-default', conversationId: 'ghost-bot' })).toBe(true);
    expect(isGrokBotUsage({ model: 'grok-bot-cua', conversationId: 'sand-subagent-aaaa' })).toBe(true);
    expect(resolveCursorUsageProject(
      { model: 'grok-bot-default', conversationId: 'ghost-bot' },
      { conversationToPath: new Map(), grokBots },
    )).toEqual({ project: 'grok-bot/ghost-bot', projectDisplay: 'HeavenPrem · ghost-bo' });
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'grok-bot-default',
        conversationId: 'ghost-bot',
        tokenUsage: { inputTokens: 8, outputTokens: 1, cacheReadTokens: 20 },
      },
      {
        timestamp: ts,
        model: 'grok-bot-cua',
        conversationId: 'sand-subagent-aaaa',
        tokenUsage: { inputTokens: 2, outputTokens: 1 },
      },
    ], [date], { conversationToPath: new Map(), grokBots });
    const rows = result.get(date) ?? [];
    expect(rows).toHaveLength(2);
    const byModel = Object.fromEntries(rows.map(row => [row.model, row]));
    expect(byModel['grok-bot-default']).toMatchObject({
      project: 'grok-bot/ghost-bot',
      projectDisplay: 'HeavenPrem · ghost-bo',
      eventCount: 1,
      inputTokens: 8,
      cachedInputTokens: 20,
    });
    expect(byModel['grok-bot-cua']).toMatchObject({
      project: 'grok-bot-subagent',
      projectDisplay: 'grok-bot-subagent',
      eventCount: 1,
      inputTokens: 2,
    });
  });

  it('still attributes a Grok Bot chat when a workspace mapping exists', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'grok-bot-default',
        conversationId: 'bot-in-repo',
        tokenUsage: { inputTokens: 4, outputTokens: 1 },
      },
    ], [date], {
      conversationToPath: new Map([['bot-in-repo', '/Users/test/Documents/aiusage']]),
    });
    expect(result.get(date)?.[0]).toMatchObject({
      projectDisplay: 'aiusage',
      model: 'grok-bot-default',
    });
  });

  it('reuses a cached conversation-to-project mapping after local metadata disappears', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const index = { conversationToPath: new Map<string, string>() };
    applyCachedCursorProjects(index, { 'old-cloud': '/Users/test/Documents/cdk-express' });
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'grok-4.6',
        conversationId: 'old-cloud',
        tokenUsage: { inputTokens: 4, outputTokens: 1 },
      },
    ], [date], index);
    expect(result.get(date)?.[0]?.projectDisplay).toBe('cdk-express');
  });

  it('keeps empty-window chats as their own project instead of unknown', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'grok-4.6',
        conversationId: 'sidebar-chat',
        tokenUsage: { inputTokens: 5, outputTokens: 1 },
      },
    ], [date], {
      conversationToPath: new Map([['sidebar-chat', 'empty-window']]),
    });
    const [row] = result.get(date) ?? [];
    expect(row?.project).toBe('empty-window');
    expect(row?.projectDisplay).toBe('empty-window');
  });

  it('maps a named empty-window chat onto its English workspace folder', () => {
    const date = dateKey(new Date('2026-09-12T12:00:00Z'));
    const ts = Date.parse('2026-09-12T12:00:00Z');
    const result = groupCursorUsageEvents([
      {
        timestamp: ts,
        model: 'grok-4.6',
        conversationId: 'translator-chat',
        tokenUsage: { inputTokens: 5, outputTokens: 1 },
      },
    ], [date], {
      conversationToPath: new Map([['translator-chat', 'empty-window']]),
      conversationNames: new Map([['translator-chat', '翻译助手']]),
      namedFolders: new Map([['translation-assistant', '/Users/test/Documents/translation-assistant']]),
    });
    const [row] = result.get(date) ?? [];
    expect(row?.project).toBe('/Users/test/Documents/translation-assistant');
    expect(row?.projectDisplay).toBe('translation-assistant');
  });
});
