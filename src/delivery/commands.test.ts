import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeReadonlyCommand } from './commands.js';

test('readonly commands require the configured admin private chat', () => {
  const base = {
    chatId: '100',
    userId: '7',
    adminChatId: '100',
    allowedUserIds: ['7'],
    command: '/health' as const,
  };
  assert.deepEqual(authorizeReadonlyCommand({ ...base, chatKind: 'private' }), {
    allowed: true,
    command: '/health',
  });
  assert.equal(authorizeReadonlyCommand({ ...base, chatKind: 'group' }).allowed, false);
  assert.equal(
    authorizeReadonlyCommand({ ...base, chatKind: 'private', userId: '8' }).allowed,
    false,
  );
  assert.equal(
    authorizeReadonlyCommand({ ...base, chatKind: 'private', command: '/pause' }).allowed,
    false,
  );
});
