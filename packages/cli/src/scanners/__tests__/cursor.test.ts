import { describe, expect, it } from 'vitest';
import { dateKey } from '../utils.js';
import {
  encodeCursorWorkspacePath,
  groupCursorUsageEvents,
  isPlaceholderProjectName,
  nameFromEncodedCursorProject,
  parseDateStr,
  resolveCursorConversationProject,
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
    expect(rows).toHaveLength(3);
    const byProject = Object.fromEntries(rows.map(row => [row.projectDisplay ?? row.project, row]));
    expect(byProject.aiusage?.eventCount).toBe(1);
    expect(byProject.aiusage?.inputTokens).toBe(10);
    expect(byProject.aiusage?.cachedInputTokens).toBe(100);
    expect(byProject['cdk-express']?.eventCount).toBe(1);
    expect(byProject.unknown?.eventCount).toBe(1);
    expect(byProject.unknown?.inputTokens).toBe(8);
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
});
