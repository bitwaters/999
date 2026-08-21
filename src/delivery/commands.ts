export type ChatKind = 'private' | 'group' | 'channel';
export type ReadonlyCommand = '/status' | '/health' | '/credits' | '/report';

export function authorizeReadonlyCommand(input: {
  chatKind: ChatKind;
  chatId: string;
  userId: string;
  adminChatId: string;
  allowedUserIds: readonly string[];
  command: string;
}): { allowed: true; command: ReadonlyCommand } | { allowed: false; reason: string } {
  if (input.chatKind !== 'private') return { allowed: false, reason: 'command:private_only' };
  if (input.chatId !== input.adminChatId) return { allowed: false, reason: 'command:wrong_chat' };
  if (!input.allowedUserIds.includes(input.userId))
    return { allowed: false, reason: 'command:user_not_allowlisted' };
  if (!isReadonlyCommand(input.command))
    return { allowed: false, reason: 'command:not_allowlisted' };
  return { allowed: true, command: input.command };
}

function isReadonlyCommand(value: string): value is ReadonlyCommand {
  return value === '/status' || value === '/health' || value === '/credits' || value === '/report';
}
