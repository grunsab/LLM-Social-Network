import { SenderError, schema, table, t } from 'spacetimedb/server';

const adminIdentity = table(
  { name: 'admin_identity' },
  {
    identity: t.identity().primaryKey(),
    created_at: t.timestamp(),
  }
);

const appUserIdentity = table(
  { name: 'app_user_identity' },
  {
    user_id: t.u64().primaryKey(),
    identity: t.identity().unique(),
    created_at: t.timestamp(),
  }
);

const conversation = table(
  { name: 'conversation' },
  {
    conversation_id: t.string().primaryKey(),
    kind: t.string(),
    title: t.string(),
    created_by_user_id: t.u64(),
    created_at: t.timestamp(),
    last_message_at: t.timestamp(),
    last_message_id: t.option(t.string()),
  }
);

const dmPair = table(
  { name: 'dm_pair' },
  {
    pair_key: t.string().primaryKey(),
    conversation_id: t.string().unique(),
    created_at: t.timestamp(),
  }
);

const conversationMember = table(
  {
    name: 'conversation_member',
    indexes: [
      { accessor: 'byUserId', algorithm: 'hash', columns: ['user_id'] as const },
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
    ],
  },
  {
    member_id: t.string().primaryKey(),
    conversation_id: t.string(),
    user_id: t.u64(),
    identity: t.identity(),
    joined_at: t.timestamp(),
  }
);

const message = table(
  {
    name: 'message',
    indexes: [
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
      { accessor: 'bySenderUserId', algorithm: 'hash', columns: ['sender_user_id'] as const },
    ],
  },
  {
    message_id: t.string().primaryKey(),
    conversation_id: t.string(),
    sender_user_id: t.u64(),
    sender_identity: t.identity(),
    ciphertext: t.string(),
    created_at: t.timestamp(),
  }
);

const readCursor = table(
  {
    name: 'read_cursor',
    indexes: [
      { accessor: 'byUserId', algorithm: 'hash', columns: ['user_id'] as const },
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
    ],
  },
  {
    read_cursor_id: t.string().primaryKey(),
    conversation_id: t.string(),
    user_id: t.u64(),
    last_read_message_id: t.string(),
    last_read_at: t.timestamp(),
  }
);

const typingState = table(
  {
    name: 'typing_state',
    indexes: [
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
      { accessor: 'byUserId', algorithm: 'hash', columns: ['user_id'] as const },
    ],
  },
  {
    typing_state_id: t.string().primaryKey(),
    conversation_id: t.string(),
    user_id: t.u64(),
    is_typing: t.bool(),
    updated_at: t.timestamp(),
  }
);

const presence = table(
  { name: 'presence' },
  {
    user_id: t.u64().primaryKey(),
    identity: t.identity(),
    active_connections: t.u32(),
    is_online: t.bool(),
    last_seen_at: t.timestamp(),
  }
);

const conversationViewRow = t.row('ConversationViewRow', {
  conversation_id: t.string(),
  kind: t.string(),
  title: t.string(),
  created_by_user_id: t.u64(),
  created_at: t.timestamp(),
  last_message_at: t.timestamp(),
  last_message_id: t.option(t.string()),
  participant_user_ids: t.array(t.u64()),
});

const presenceViewRow = t.row('PresenceViewRow', {
  user_id: t.u64(),
  identity: t.identity(),
  active_connections: t.u32(),
  is_online: t.bool(),
  last_seen_at: t.timestamp(),
});

const spacetimedb = schema({
  adminIdentity,
  appUserIdentity,
  conversation,
  dmPair,
  conversationMember,
  message,
  readCursor,
  typingState,
  presence,
});

export default spacetimedb;

const DM_KIND = 'dm';
const GROUP_KIND = 'group';
const CONFIGURED_ADMIN_IDENTITY =
  'c2008ed00e0e4c7fe1d7053d2c776922132be48615756819f630907e9a5d12b7';

const compareTimestampAsc = (a: { microsSinceUnixEpoch: bigint }, b: { microsSinceUnixEpoch: bigint }) => {
  if (a.microsSinceUnixEpoch === b.microsSinceUnixEpoch) return 0;
  return a.microsSinceUnixEpoch > b.microsSinceUnixEpoch ? 1 : -1;
};

const compareTimestampDesc = (a: { microsSinceUnixEpoch: bigint }, b: { microsSinceUnixEpoch: bigint }) => {
  if (a.microsSinceUnixEpoch === b.microsSinceUnixEpoch) return 0;
  return a.microsSinceUnixEpoch > b.microsSinceUnixEpoch ? -1 : 1;
};

const ensureAdmin = (ctx: any) => {
  const adminRow = ctx.db.adminIdentity.identity.find(ctx.sender);
  if (adminRow) {
    return;
  }

  if (
    typeof ctx.sender?.toHexString === 'function' &&
    ctx.sender.toHexString() === CONFIGURED_ADMIN_IDENTITY
  ) {
    ctx.db.adminIdentity.insert({
      identity: ctx.sender,
      created_at: ctx.timestamp,
    });
    return;
  }

  throw new SenderError('Reducer may only be invoked by module owner/admin.');
};

const getMappedUserBySender = (ctx: any) => ctx.db.appUserIdentity.identity.find(ctx.sender);

const getMember = (ctx: any, conversation_id: string, user_id: bigint) => {
  for (const member of ctx.db.conversationMember.byConversationId.filter(conversation_id)) {
    if (member.user_id === user_id) {
      return member;
    }
  }
  return null;
};

const requireConversation = (ctx: any, conversation_id: string) => {
  const row = ctx.db.conversation.conversation_id.find(conversation_id);
  if (!row) {
    throw new SenderError('Conversation was not found.');
  }
  return row;
};

const addConversationMember = (ctx: any, conversation_id: string, user_id: bigint) => {
  if (getMember(ctx, conversation_id, user_id)) {
    return;
  }
  const mapping = ctx.db.appUserIdentity.user_id.find(user_id);
  if (!mapping) {
    throw new SenderError(`No identity mapping exists for user_id=${user_id.toString()}.`);
  }
  ctx.db.conversationMember.insert({
    member_id: ctx.newUuidV7().toString(),
    conversation_id,
    user_id,
    identity: mapping.identity,
    joined_at: ctx.timestamp,
  });
};

const getTypingState = (ctx: any, conversation_id: string, user_id: bigint) => {
  for (const row of ctx.db.typingState.byConversationId.filter(conversation_id)) {
    if (row.user_id === user_id) {
      return row;
    }
  }
  return null;
};

const getReadCursor = (ctx: any, conversation_id: string, user_id: bigint) => {
  for (const row of ctx.db.readCursor.byConversationId.filter(conversation_id)) {
    if (row.user_id === user_id) {
      return row;
    }
  }
  return null;
};

export const init = spacetimedb.init(ctx => {
  if (!ctx.db.adminIdentity.identity.find(ctx.sender)) {
    ctx.db.adminIdentity.insert({
      identity: ctx.sender,
      created_at: ctx.timestamp,
    });
  }
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  const mapping = getMappedUserBySender(ctx);
  if (!mapping) {
    return;
  }

  const existing = ctx.db.presence.user_id.find(mapping.user_id);
  if (!existing) {
    ctx.db.presence.insert({
      user_id: mapping.user_id,
      identity: mapping.identity,
      active_connections: 1,
      is_online: true,
      last_seen_at: ctx.timestamp,
    });
    return;
  }

  ctx.db.presence.user_id.update({
    ...existing,
    active_connections: existing.active_connections + 1,
    is_online: true,
    last_seen_at: ctx.timestamp,
  });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const mapping = getMappedUserBySender(ctx);
  if (!mapping) {
    return;
  }

  const existing = ctx.db.presence.user_id.find(mapping.user_id);
  if (!existing) {
    return;
  }

  const decremented = existing.active_connections > 0 ? existing.active_connections - 1 : 0;
  ctx.db.presence.user_id.update({
    ...existing,
    active_connections: decremented,
    is_online: decremented > 0,
    last_seen_at: ctx.timestamp,
  });
});

export const register_user_identity = spacetimedb.reducer(
  { name: 'register_user_identity' },
  {
    user_id: t.u64(),
    identity: t.identity(),
  },
  (ctx, { user_id, identity }) => {
    ensureAdmin(ctx);

    const existingByIdentity = ctx.db.appUserIdentity.identity.find(identity);
    if (existingByIdentity && existingByIdentity.user_id !== user_id) {
      throw new SenderError('Identity is already assigned to another user.');
    }

    const existingByUser = ctx.db.appUserIdentity.user_id.find(user_id);
    if (existingByUser) {
      if (!existingByUser.identity.isEqual(identity)) {
        ctx.db.appUserIdentity.user_id.update({
          ...existingByUser,
          identity,
        });
      }
    } else {
      ctx.db.appUserIdentity.insert({
        user_id,
        identity,
        created_at: ctx.timestamp,
      });
    }

    const existingPresence = ctx.db.presence.user_id.find(user_id);
    if (existingPresence) {
      ctx.db.presence.user_id.update({
        ...existingPresence,
        identity,
      });
    } else {
      ctx.db.presence.insert({
        user_id,
        identity,
        active_connections: 0,
        is_online: false,
        last_seen_at: ctx.timestamp,
      });
    }
  }
);

export const ensure_dm = spacetimedb.reducer(
  { name: 'ensure_dm' },
  {
    conversation_id: t.string(),
    user_a_id: t.u64(),
    user_b_id: t.u64(),
    title: t.string(),
  },
  (ctx, { conversation_id, user_a_id, user_b_id, title }) => {
    ensureAdmin(ctx);

    if (user_a_id === user_b_id) {
      throw new SenderError('Cannot create a DM with yourself.');
    }

    const low = user_a_id < user_b_id ? user_a_id : user_b_id;
    const high = user_a_id < user_b_id ? user_b_id : user_a_id;
    const pair_key = `${low.toString()}:${high.toString()}`;

    if (ctx.db.dmPair.pair_key.find(pair_key)) {
      return;
    }

    if (!ctx.db.appUserIdentity.user_id.find(low) || !ctx.db.appUserIdentity.user_id.find(high)) {
      throw new SenderError('Both users must be registered before creating a DM.');
    }

    if (!ctx.db.conversation.conversation_id.find(conversation_id)) {
      ctx.db.conversation.insert({
        conversation_id,
        kind: DM_KIND,
        title,
        created_by_user_id: low,
        created_at: ctx.timestamp,
        last_message_at: ctx.timestamp,
        last_message_id: undefined,
      });
    }

    addConversationMember(ctx, conversation_id, low);
    addConversationMember(ctx, conversation_id, high);

    ctx.db.dmPair.insert({
      pair_key,
      conversation_id,
      created_at: ctx.timestamp,
    });
  }
);

export const create_group = spacetimedb.reducer(
  { name: 'create_group' },
  {
    conversation_id: t.string(),
    title: t.string(),
    creator_user_id: t.u64(),
    member_user_ids: t.array(t.u64()),
  },
  (ctx, { conversation_id, title, creator_user_id, member_user_ids }) => {
    ensureAdmin(ctx);

    if (ctx.db.conversation.conversation_id.find(conversation_id)) {
      return;
    }

    const uniqueMembers = new Set<bigint>([creator_user_id, ...member_user_ids]);
    if (uniqueMembers.size < 2) {
      throw new SenderError('Group chats require at least two users.');
    }

    for (const user_id of uniqueMembers) {
      if (!ctx.db.appUserIdentity.user_id.find(user_id)) {
        throw new SenderError(`No identity mapping exists for user_id=${user_id.toString()}.`);
      }
    }

    ctx.db.conversation.insert({
      conversation_id,
      kind: GROUP_KIND,
      title,
      created_by_user_id: creator_user_id,
      created_at: ctx.timestamp,
      last_message_at: ctx.timestamp,
      last_message_id: undefined,
    });

    for (const user_id of uniqueMembers) {
      addConversationMember(ctx, conversation_id, user_id);
    }
  }
);

export const add_group_member = spacetimedb.reducer(
  { name: 'add_group_member' },
  {
    conversation_id: t.string(),
    user_id: t.u64(),
  },
  (ctx, { conversation_id, user_id }) => {
    ensureAdmin(ctx);

    const conv = requireConversation(ctx, conversation_id);
    if (conv.kind !== GROUP_KIND) {
      throw new SenderError('Cannot add members to a non-group conversation.');
    }

    addConversationMember(ctx, conversation_id, user_id);
  }
);

export const send_message = spacetimedb.reducer(
  { name: 'send_message' },
  {
    conversation_id: t.string(),
    ciphertext: t.string(),
  },
  (ctx, { conversation_id, ciphertext }) => {
    if (!ciphertext.trim()) {
      throw new SenderError('Message ciphertext cannot be empty.');
    }

    const mapping = getMappedUserBySender(ctx);
    if (!mapping) {
      throw new SenderError('Your identity is not registered for chat.');
    }

    const conv = requireConversation(ctx, conversation_id);
    if (!getMember(ctx, conversation_id, mapping.user_id)) {
      throw new SenderError('You are not a member of this conversation.');
    }

    const inserted = ctx.db.message.insert({
      message_id: ctx.newUuidV7().toString(),
      conversation_id,
      sender_user_id: mapping.user_id,
      sender_identity: mapping.identity,
      ciphertext,
      created_at: ctx.timestamp,
    });

    ctx.db.conversation.conversation_id.update({
      ...conv,
      last_message_at: ctx.timestamp,
      last_message_id: inserted.message_id,
    });

    const typing = getTypingState(ctx, conversation_id, mapping.user_id);
    if (typing && typing.is_typing) {
      ctx.db.typingState.typing_state_id.update({
        ...typing,
        is_typing: false,
        updated_at: ctx.timestamp,
      });
    }
  }
);

export const set_typing = spacetimedb.reducer(
  { name: 'set_typing' },
  {
    conversation_id: t.string(),
    is_typing: t.bool(),
  },
  (ctx, { conversation_id, is_typing }) => {
    const mapping = getMappedUserBySender(ctx);
    if (!mapping) {
      throw new SenderError('Your identity is not registered for chat.');
    }

    requireConversation(ctx, conversation_id);
    if (!getMember(ctx, conversation_id, mapping.user_id)) {
      throw new SenderError('You are not a member of this conversation.');
    }

    const existing = getTypingState(ctx, conversation_id, mapping.user_id);
    if (existing) {
      ctx.db.typingState.typing_state_id.update({
        ...existing,
        is_typing,
        updated_at: ctx.timestamp,
      });
      return;
    }

    ctx.db.typingState.insert({
      typing_state_id: ctx.newUuidV7().toString(),
      conversation_id,
      user_id: mapping.user_id,
      is_typing,
      updated_at: ctx.timestamp,
    });
  }
);

export const mark_read = spacetimedb.reducer(
  { name: 'mark_read' },
  {
    conversation_id: t.string(),
    last_read_message_id: t.string(),
  },
  (ctx, { conversation_id, last_read_message_id }) => {
    const mapping = getMappedUserBySender(ctx);
    if (!mapping) {
      throw new SenderError('Your identity is not registered for chat.');
    }

    requireConversation(ctx, conversation_id);
    if (!getMember(ctx, conversation_id, mapping.user_id)) {
      throw new SenderError('You are not a member of this conversation.');
    }

    const existing = getReadCursor(ctx, conversation_id, mapping.user_id);
    if (existing) {
      ctx.db.readCursor.read_cursor_id.update({
        ...existing,
        last_read_message_id,
        last_read_at: ctx.timestamp,
      });
      return;
    }

    ctx.db.readCursor.insert({
      read_cursor_id: ctx.newUuidV7().toString(),
      conversation_id,
      user_id: mapping.user_id,
      last_read_message_id,
      last_read_at: ctx.timestamp,
    });
  }
);

export const my_conversations = spacetimedb.view(
  { name: 'my_conversations', public: true },
  t.array(conversationViewRow),
  ctx => {
    const mapping = ctx.db.appUserIdentity.identity.find(ctx.sender);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      const conv = ctx.db.conversation.conversation_id.find(membership.conversation_id);
      if (!conv) continue;

      const participant_user_ids = [];
      for (const member of ctx.db.conversationMember.byConversationId.filter(membership.conversation_id)) {
        participant_user_ids.push(member.user_id);
      }

      rows.push({
        conversation_id: conv.conversation_id,
        kind: conv.kind,
        title: conv.title,
        created_by_user_id: conv.created_by_user_id,
        created_at: conv.created_at,
        last_message_at: conv.last_message_at,
        last_message_id: conv.last_message_id,
        participant_user_ids,
      });
    }

    rows.sort((a, b) => compareTimestampDesc(a.last_message_at, b.last_message_at));
    return rows;
  }
);

export const my_messages = spacetimedb.view(
  { name: 'my_messages', public: true },
  t.array(message.rowType),
  ctx => {
    const mapping = ctx.db.appUserIdentity.identity.find(ctx.sender);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      for (const msg of ctx.db.message.byConversationId.filter(membership.conversation_id)) {
        rows.push(msg);
      }
    }

    rows.sort((a, b) => compareTimestampAsc(a.created_at, b.created_at));
    return rows;
  }
);

export const my_typing = spacetimedb.view(
  { name: 'my_typing', public: true },
  t.array(typingState.rowType),
  ctx => {
    const mapping = ctx.db.appUserIdentity.identity.find(ctx.sender);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      for (const state of ctx.db.typingState.byConversationId.filter(membership.conversation_id)) {
        rows.push(state);
      }
    }

    rows.sort((a, b) => compareTimestampDesc(a.updated_at, b.updated_at));
    return rows;
  }
);

export const my_read_state = spacetimedb.view(
  { name: 'my_read_state', public: true },
  t.array(readCursor.rowType),
  ctx => {
    const mapping = ctx.db.appUserIdentity.identity.find(ctx.sender);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      for (const cursor of ctx.db.readCursor.byConversationId.filter(membership.conversation_id)) {
        rows.push(cursor);
      }
    }

    rows.sort((a, b) => compareTimestampDesc(a.last_read_at, b.last_read_at));
    return rows;
  }
);

export const my_presence = spacetimedb.view(
  { name: 'my_presence', public: true },
  t.array(presenceViewRow),
  ctx => {
    const mapping = ctx.db.appUserIdentity.identity.find(ctx.sender);
    if (!mapping) {
      return [];
    }

    const participantUserIds = new Set<bigint>();
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      for (const member of ctx.db.conversationMember.byConversationId.filter(membership.conversation_id)) {
        participantUserIds.add(member.user_id);
      }
    }

    const rows = [];
    for (const user_id of participantUserIds) {
      const presenceRow = ctx.db.presence.user_id.find(user_id);
      if (presenceRow) {
        rows.push({
          user_id: presenceRow.user_id,
          identity: presenceRow.identity,
          active_connections: presenceRow.active_connections,
          is_online: presenceRow.is_online,
          last_seen_at: presenceRow.last_seen_at,
        });
      }
    }

    rows.sort((a, b) => compareTimestampDesc(a.last_seen_at, b.last_seen_at));
    return rows;
  }
);
