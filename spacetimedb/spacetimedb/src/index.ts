import { SenderError, schema, table, t } from 'spacetimedb/server';

const adminIdentity = table(
  { name: 'admin_identity' },
  {
    identity: t.identity().primaryKey(),
    created_at: t.timestamp(),
  }
);

const appDeviceIdentity = table(
  {
    name: 'app_device_identity',
    indexes: [
      { accessor: 'byUserId', algorithm: 'hash', columns: ['user_id'] as const },
    ],
  },
  {
    device_id: t.string().primaryKey(),
    user_id: t.u64(),
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
    encryption_mode: t.string(),
    current_epoch: t.u32(),
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
    joined_at: t.timestamp(),
  }
);

const message = table(
  {
    name: 'message',
    indexes: [
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
      { accessor: 'bySenderUserId', algorithm: 'hash', columns: ['sender_user_id'] as const },
      { accessor: 'bySenderDeviceId', algorithm: 'hash', columns: ['sender_device_id'] as const },
    ],
  },
  {
    message_id: t.string().primaryKey(),
    conversation_id: t.string(),
    sender_user_id: t.u64(),
    sender_device_id: t.string(),
    protocol_version: t.string(),
    message_type: t.string(),
    conversation_epoch: t.u32(),
    created_at: t.timestamp(),
  }
);

const messagePayload = table(
  {
    name: 'message_payload',
    indexes: [
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
      { accessor: 'byMessageId', algorithm: 'hash', columns: ['message_id'] as const },
    ],
  },
  {
    payload_id: t.string().primaryKey(),
    message_id: t.string(),
    conversation_id: t.string(),
    delivery_scope: t.string(),
    recipient_user_id: t.option(t.u64()),
    recipient_device_id: t.option(t.string()),
    ciphertext: t.string(),
    nonce: t.string(),
    aad: t.string(),
    created_at: t.timestamp(),
  }
);

const conversationKeyPackage = table(
  {
    name: 'conversation_key_package',
    indexes: [
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
      { accessor: 'byRecipientDeviceId', algorithm: 'hash', columns: ['recipient_device_id'] as const },
      { accessor: 'byRecipientUserId', algorithm: 'hash', columns: ['recipient_user_id'] as const },
    ],
  },
  {
    package_id: t.string().primaryKey(),
    conversation_id: t.string(),
    epoch: t.u32(),
    recipient_user_id: t.u64(),
    recipient_device_id: t.string(),
    sender_user_id: t.u64(),
    sender_device_id: t.string(),
    sealed_sender_key: t.string(),
    created_at: t.timestamp(),
  }
);

const conversationMembershipEvent = table(
  {
    name: 'conversation_membership_event',
    indexes: [
      { accessor: 'byConversationId', algorithm: 'hash', columns: ['conversation_id'] as const },
      { accessor: 'byTargetUserId', algorithm: 'hash', columns: ['target_user_id'] as const },
    ],
  },
  {
    event_id: t.string().primaryKey(),
    conversation_id: t.string(),
    event_type: t.string(),
    target_user_id: t.u64(),
    target_device_id: t.option(t.string()),
    actor_user_id: t.u64(),
    actor_device_id: t.option(t.string()),
    new_epoch: t.u32(),
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
  encryption_mode: t.string(),
  current_epoch: t.u32(),
  created_at: t.timestamp(),
  last_message_at: t.timestamp(),
  last_message_id: t.option(t.string()),
  participant_user_ids: t.array(t.u64()),
});

const messageViewRow = t.row('MessageViewRow', {
  payload_id: t.string(),
  message_id: t.string(),
  conversation_id: t.string(),
  sender_user_id: t.u64(),
  sender_device_id: t.string(),
  protocol_version: t.string(),
  message_type: t.string(),
  conversation_epoch: t.u32(),
  delivery_scope: t.string(),
  recipient_user_id: t.option(t.u64()),
  recipient_device_id: t.option(t.string()),
  ciphertext: t.string(),
  nonce: t.string(),
  aad: t.string(),
  created_at: t.timestamp(),
});

const conversationKeyPackageViewRow = t.row('ConversationKeyPackageViewRow', {
  package_id: t.string(),
  conversation_id: t.string(),
  epoch: t.u32(),
  recipient_user_id: t.u64(),
  recipient_device_id: t.string(),
  sender_user_id: t.u64(),
  sender_device_id: t.string(),
  sealed_sender_key: t.string(),
  created_at: t.timestamp(),
});

const conversationMembershipEventViewRow = t.row('ConversationMembershipEventViewRow', {
  event_id: t.string(),
  conversation_id: t.string(),
  event_type: t.string(),
  target_user_id: t.u64(),
  target_device_id: t.option(t.string()),
  actor_user_id: t.u64(),
  actor_device_id: t.option(t.string()),
  new_epoch: t.u32(),
  created_at: t.timestamp(),
});

const presenceViewRow = t.row('PresenceViewRow', {
  user_id: t.u64(),
  identity: t.identity(),
  active_connections: t.u32(),
  is_online: t.bool(),
  last_seen_at: t.timestamp(),
});

const messagePayloadInput = t.row('MessagePayloadInput', {
  delivery_scope: t.string(),
  recipient_user_id: t.option(t.u64()),
  recipient_device_id: t.option(t.string()),
  ciphertext: t.string(),
  nonce: t.string(),
  aad: t.string(),
});

const conversationKeyPackageInput = t.row('ConversationKeyPackageInput', {
  recipient_user_id: t.u64(),
  recipient_device_id: t.string(),
  sealed_sender_key: t.string(),
});

const spacetimedb = schema({
  adminIdentity,
  appDeviceIdentity,
  conversation,
  dmPair,
  conversationMember,
  message,
  messagePayload,
  conversationKeyPackage,
  conversationMembershipEvent,
  readCursor,
  typingState,
  presence,
});

export default spacetimedb;

const DM_KIND = 'dm';
const GROUP_KIND = 'group';
const LEGACY_ENCRYPTION_MODE = 'legacy';
const E2EE_ENCRYPTION_MODE = 'e2ee_v1';
const LEGACY_PROTOCOL_VERSION = 'legacy_v1';
const CHAT_MESSAGE_TYPE = 'chat';
const SYSTEM_MESSAGE_TYPE = 'system';
const DEVICE_SCOPE = 'device';
const CONVERSATION_SCOPE = 'conversation';
const MEMBER_ADDED_EVENT = 'member_added';
const DEVICE_ADDED_EVENT = 'device_added';
const DEVICE_REVOKED_EVENT = 'device_revoked';
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

const getMappedDeviceBySender = (ctx: any) => ctx.db.appDeviceIdentity.identity.find(ctx.sender);

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

const requireMappedDevice = (ctx: any) => {
  const mapping = getMappedDeviceBySender(ctx);
  if (!mapping) {
    throw new SenderError('Your device identity is not registered for chat.');
  }
  return mapping;
};

const assertConversationMember = (ctx: any, conversation_id: string, user_id: bigint) => {
  if (!getMember(ctx, conversation_id, user_id)) {
    throw new SenderError('You are not a member of this conversation.');
  }
};

const validateEncryptionMode = (value?: string | null) => {
  if (!value) {
    return LEGACY_ENCRYPTION_MODE;
  }
  if (value !== LEGACY_ENCRYPTION_MODE && value !== E2EE_ENCRYPTION_MODE) {
    throw new SenderError('Unsupported encryption mode.');
  }
  return value;
};

const validateMessageType = (value?: string | null) => {
  if (!value) {
    return CHAT_MESSAGE_TYPE;
  }
  if (value !== CHAT_MESSAGE_TYPE && value !== SYSTEM_MESSAGE_TYPE) {
    throw new SenderError('Unsupported message type.');
  }
  return value;
};

const normalizeOptionalString = (value?: string | null) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const addConversationMember = (ctx: any, conversation_id: string, user_id: bigint) => {
  if (getMember(ctx, conversation_id, user_id)) {
    return;
  }
  ctx.db.conversationMember.insert({
    member_id: ctx.newUuidV7().toString(),
    conversation_id,
    user_id,
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

const emitConversationMembershipEvent = (
  ctx: any,
  conversation_id: string,
  event_type: string,
  target_user_id: bigint,
  target_device_id: string | undefined,
  actor_user_id: bigint,
  actor_device_id: string | undefined,
  new_epoch: number
) => {
  ctx.db.conversationMembershipEvent.insert({
    event_id: ctx.newUuidV7().toString(),
    conversation_id,
    event_type,
    target_user_id,
    target_device_id,
    actor_user_id,
    actor_device_id,
    new_epoch,
    created_at: ctx.timestamp,
  });
};

const advanceConversationEpoch = (ctx: any, conv: any) => {
  const nextEpoch = Number(conv.current_epoch) + 1;
  const updated = {
    ...conv,
    current_epoch: nextEpoch,
  };
  ctx.db.conversation.conversation_id.update(updated);
  return updated;
};

const upsertPresence = (ctx: any, user_id: bigint, identity: any) => {
  const existingPresence = ctx.db.presence.user_id.find(user_id);
  if (existingPresence) {
    ctx.db.presence.user_id.update({
      ...existingPresence,
      identity,
    });
    return;
  }

  ctx.db.presence.insert({
    user_id,
    identity,
    active_connections: 0,
    is_online: false,
    last_seen_at: ctx.timestamp,
  });
};

const buildPayloadRows = (
  ctx: any,
  conv: any,
  rawCiphertext: string | undefined,
  rawPayloads: Array<any> | undefined
) => {
  const suppliedPayloads = Array.isArray(rawPayloads) ? rawPayloads : [];
  const payloads = suppliedPayloads.length
    ? suppliedPayloads.map(payload => ({
        delivery_scope: normalizeOptionalString(payload.delivery_scope),
        recipient_user_id: payload.recipient_user_id,
        recipient_device_id: normalizeOptionalString(payload.recipient_device_id),
        ciphertext: typeof payload.ciphertext === 'string' ? payload.ciphertext : '',
        nonce: typeof payload.nonce === 'string' ? payload.nonce : '',
        aad: typeof payload.aad === 'string' ? payload.aad : '',
      }))
    : [];

  if (!payloads.length) {
    const ciphertext = typeof rawCiphertext === 'string' ? rawCiphertext.trim() : '';
    if (!ciphertext) {
      throw new SenderError('Message ciphertext cannot be empty.');
    }
    payloads.push({
      delivery_scope: CONVERSATION_SCOPE,
      recipient_user_id: undefined,
      recipient_device_id: undefined,
      ciphertext,
      nonce: '',
      aad: '',
    });
  }

  for (const payload of payloads) {
    if (!payload.delivery_scope) {
      throw new SenderError('Message payloads must declare a delivery scope.');
    }
    if (!payload.ciphertext.trim()) {
      throw new SenderError('Message payload ciphertext cannot be empty.');
    }
    if (payload.delivery_scope !== DEVICE_SCOPE && payload.delivery_scope !== CONVERSATION_SCOPE) {
      throw new SenderError('Message payload delivery scope is invalid.');
    }
    if (payload.delivery_scope === DEVICE_SCOPE && !payload.recipient_device_id) {
      throw new SenderError('Device-scoped payloads require a recipient device ID.');
    }
    if (payload.delivery_scope === CONVERSATION_SCOPE && (payload.recipient_device_id || payload.recipient_user_id !== undefined)) {
      throw new SenderError('Conversation-scoped payloads cannot target a specific user or device.');
    }
    if (
      payload.recipient_user_id !== undefined &&
      !getMember(ctx, conv.conversation_id, payload.recipient_user_id)
    ) {
      throw new SenderError('Message payload recipient is not a conversation member.');
    }
  }

  if (conv.encryption_mode === LEGACY_ENCRYPTION_MODE) {
    if (payloads.length !== 1 || payloads[0].delivery_scope !== CONVERSATION_SCOPE) {
      throw new SenderError('Legacy conversations require one conversation-scoped payload.');
    }
    return payloads;
  }

  if (conv.kind === DM_KIND) {
    if (payloads.some(payload => payload.delivery_scope !== DEVICE_SCOPE)) {
      throw new SenderError('Encrypted DMs require device-scoped payloads.');
    }
    return payloads;
  }

  if (payloads.length !== 1 || payloads[0].delivery_scope !== CONVERSATION_SCOPE) {
    throw new SenderError('Encrypted groups require one conversation-scoped payload.');
  }
  return payloads;
};

const findConversationKeyPackage = (ctx: any, conversation_id: string, epoch: number, recipient_device_id: string) => {
  for (const row of ctx.db.conversationKeyPackage.byConversationId.filter(conversation_id)) {
    if (Number(row.epoch) === Number(epoch) && row.recipient_device_id === recipient_device_id) {
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
  const mapping = getMappedDeviceBySender(ctx);
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
    identity: mapping.identity,
    active_connections: existing.active_connections + 1,
    is_online: true,
    last_seen_at: ctx.timestamp,
  });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const mapping = getMappedDeviceBySender(ctx);
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
    identity: mapping.identity,
    active_connections: decremented,
    is_online: decremented > 0,
    last_seen_at: ctx.timestamp,
  });
});

export const register_device_identity = spacetimedb.reducer(
  { name: 'register_device_identity' },
  {
    user_id: t.u64(),
    device_id: t.string(),
    identity: t.identity(),
  },
  (ctx, { user_id, device_id, identity }) => {
    ensureAdmin(ctx);

    const normalizedDeviceId = device_id.trim();
    if (!normalizedDeviceId) {
      throw new SenderError('Device ID cannot be empty.');
    }

    const existingByIdentity = ctx.db.appDeviceIdentity.identity.find(identity);
    if (existingByIdentity && existingByIdentity.device_id !== normalizedDeviceId) {
      throw new SenderError('Identity is already assigned to another device.');
    }

    const existingByDevice = ctx.db.appDeviceIdentity.device_id.find(normalizedDeviceId);
    if (existingByDevice) {
      if (existingByDevice.user_id !== user_id) {
        throw new SenderError('Device is already assigned to another user.');
      }
      if (!existingByDevice.identity.isEqual(identity)) {
        ctx.db.appDeviceIdentity.device_id.update({
          ...existingByDevice,
          identity,
        });
      }
    } else {
      ctx.db.appDeviceIdentity.insert({
        device_id: normalizedDeviceId,
        user_id,
        identity,
        created_at: ctx.timestamp,
      });
    }

    upsertPresence(ctx, user_id, identity);
  }
);

export const ensure_dm = spacetimedb.reducer(
  { name: 'ensure_dm' },
  {
    conversation_id: t.string(),
    user_a_id: t.u64(),
    user_b_id: t.u64(),
    title: t.string(),
    encryption_mode: t.option(t.string()),
  },
  (ctx, { conversation_id, user_a_id, user_b_id, title, encryption_mode }) => {
    ensureAdmin(ctx);

    if (user_a_id === user_b_id) {
      throw new SenderError('Cannot create a DM with yourself.');
    }

    const low = user_a_id < user_b_id ? user_a_id : user_b_id;
    const high = user_a_id < user_b_id ? user_b_id : user_a_id;
    const pair_key = `${low.toString()}:${high.toString()}`;
    const normalizedEncryptionMode = validateEncryptionMode(encryption_mode);

    if (ctx.db.dmPair.pair_key.find(pair_key)) {
      return;
    }

    if (!ctx.db.conversation.conversation_id.find(conversation_id)) {
      ctx.db.conversation.insert({
        conversation_id,
        kind: DM_KIND,
        title,
        created_by_user_id: low,
        encryption_mode: normalizedEncryptionMode,
        current_epoch: normalizedEncryptionMode === E2EE_ENCRYPTION_MODE ? 1 : 0,
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
    encryption_mode: t.option(t.string()),
  },
  (ctx, { conversation_id, title, creator_user_id, member_user_ids, encryption_mode }) => {
    ensureAdmin(ctx);

    if (ctx.db.conversation.conversation_id.find(conversation_id)) {
      return;
    }

    const uniqueMembers = new Set<bigint>([creator_user_id, ...member_user_ids]);
    if (uniqueMembers.size < 2) {
      throw new SenderError('Group chats require at least two users.');
    }

    const normalizedEncryptionMode = validateEncryptionMode(encryption_mode);
    ctx.db.conversation.insert({
      conversation_id,
      kind: GROUP_KIND,
      title,
      created_by_user_id: creator_user_id,
      encryption_mode: normalizedEncryptionMode,
      current_epoch: normalizedEncryptionMode === E2EE_ENCRYPTION_MODE ? 1 : 0,
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
    actor_user_id: t.u64(),
    actor_device_id: t.option(t.string()),
  },
  (ctx, { conversation_id, user_id, actor_user_id, actor_device_id }) => {
    ensureAdmin(ctx);

    const conv = requireConversation(ctx, conversation_id);
    if (conv.kind !== GROUP_KIND) {
      throw new SenderError('Cannot add members to a non-group conversation.');
    }
    if (getMember(ctx, conversation_id, user_id)) {
      return;
    }

    addConversationMember(ctx, conversation_id, user_id);

    if (conv.encryption_mode !== E2EE_ENCRYPTION_MODE) {
      return;
    }

    const updatedConversation = advanceConversationEpoch(ctx, conv);
    emitConversationMembershipEvent(
      ctx,
      conversation_id,
      MEMBER_ADDED_EVENT,
      user_id,
      undefined,
      actor_user_id,
      normalizeOptionalString(actor_device_id),
      Number(updatedConversation.current_epoch)
    );
  }
);

export const emit_device_roster_change = spacetimedb.reducer(
  { name: 'emit_device_roster_change' },
  {
    user_id: t.u64(),
    device_id: t.string(),
    change_type: t.string(),
    actor_user_id: t.u64(),
    actor_device_id: t.option(t.string()),
  },
  (ctx, { user_id, device_id, change_type, actor_user_id, actor_device_id }) => {
    ensureAdmin(ctx);

    if (change_type !== DEVICE_ADDED_EVENT && change_type !== DEVICE_REVOKED_EVENT) {
      throw new SenderError('Unsupported device roster change type.');
    }

    for (const membership of ctx.db.conversationMember.byUserId.filter(user_id)) {
      const conv = ctx.db.conversation.conversation_id.find(membership.conversation_id);
      if (!conv || conv.kind !== GROUP_KIND || conv.encryption_mode !== E2EE_ENCRYPTION_MODE) {
        continue;
      }

      const updatedConversation = advanceConversationEpoch(ctx, conv);
      emitConversationMembershipEvent(
        ctx,
        membership.conversation_id,
        change_type,
        user_id,
        normalizeOptionalString(device_id),
        actor_user_id,
        normalizeOptionalString(actor_device_id),
        Number(updatedConversation.current_epoch)
      );
    }
  }
);

export const publish_conversation_key_packages = spacetimedb.reducer(
  { name: 'publish_conversation_key_packages' },
  {
    conversation_id: t.string(),
    epoch: t.u32(),
    packages: t.array(conversationKeyPackageInput),
  },
  (ctx, { conversation_id, epoch, packages }) => {
    const mapping = requireMappedDevice(ctx);
    const conv = requireConversation(ctx, conversation_id);
    assertConversationMember(ctx, conversation_id, mapping.user_id);

    if (conv.kind !== GROUP_KIND) {
      throw new SenderError('Conversation key packages are only valid for group conversations.');
    }
    if (conv.encryption_mode !== E2EE_ENCRYPTION_MODE) {
      throw new SenderError('Conversation key packages require encrypted group conversations.');
    }
    if (Number(epoch) !== Number(conv.current_epoch)) {
      throw new SenderError('Conversation key packages must target the current conversation epoch.');
    }
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new SenderError('At least one conversation key package is required.');
    }

    for (const entry of packages) {
      const recipientDeviceId = normalizeOptionalString(entry.recipient_device_id);
      const sealedSenderKey = typeof entry.sealed_sender_key === 'string' ? entry.sealed_sender_key.trim() : '';
      if (!recipientDeviceId) {
        throw new SenderError('Conversation key package recipient device ID cannot be empty.');
      }
      if (!sealedSenderKey) {
        throw new SenderError('Conversation key package payload cannot be empty.');
      }
      assertConversationMember(ctx, conversation_id, entry.recipient_user_id);

      const existing = findConversationKeyPackage(ctx, conversation_id, Number(epoch), recipientDeviceId);
      if (existing) {
        ctx.db.conversationKeyPackage.package_id.update({
          ...existing,
          recipient_user_id: entry.recipient_user_id,
          sender_user_id: mapping.user_id,
          sender_device_id: mapping.device_id,
          sealed_sender_key: sealedSenderKey,
          created_at: ctx.timestamp,
        });
        continue;
      }

      ctx.db.conversationKeyPackage.insert({
        package_id: ctx.newUuidV7().toString(),
        conversation_id,
        epoch,
        recipient_user_id: entry.recipient_user_id,
        recipient_device_id: recipientDeviceId,
        sender_user_id: mapping.user_id,
        sender_device_id: mapping.device_id,
        sealed_sender_key: sealedSenderKey,
        created_at: ctx.timestamp,
      });
    }
  }
);

export const send_message = spacetimedb.reducer(
  { name: 'send_message' },
  {
    conversation_id: t.string(),
    protocol_version: t.option(t.string()),
    message_type: t.option(t.string()),
    conversation_epoch: t.option(t.u32()),
    ciphertext: t.option(t.string()),
    payloads: t.option(t.array(messagePayloadInput)),
  },
  (ctx, { conversation_id, protocol_version, message_type, conversation_epoch, ciphertext, payloads }) => {
    const mapping = requireMappedDevice(ctx);
    const conv = requireConversation(ctx, conversation_id);
    assertConversationMember(ctx, conversation_id, mapping.user_id);

    const resolvedMessageType = validateMessageType(message_type);
    const resolvedProtocolVersion = normalizeOptionalString(protocol_version)
      || (conv.encryption_mode === E2EE_ENCRYPTION_MODE ? E2EE_ENCRYPTION_MODE : LEGACY_PROTOCOL_VERSION);
    const resolvedConversationEpoch = conversation_epoch === undefined ? Number(conv.current_epoch) : Number(conversation_epoch);

    if (conv.encryption_mode === E2EE_ENCRYPTION_MODE && resolvedConversationEpoch !== Number(conv.current_epoch)) {
      throw new SenderError('Encrypted messages must target the current conversation epoch.');
    }
    if (conv.encryption_mode === LEGACY_ENCRYPTION_MODE && resolvedConversationEpoch !== Number(conv.current_epoch)) {
      throw new SenderError('Legacy messages must target the legacy conversation epoch.');
    }

    const normalizedPayloads = buildPayloadRows(
      ctx,
      conv,
      typeof ciphertext === 'string' ? ciphertext : undefined,
      Array.isArray(payloads) ? payloads : undefined
    );

    const inserted = ctx.db.message.insert({
      message_id: ctx.newUuidV7().toString(),
      conversation_id,
      sender_user_id: mapping.user_id,
      sender_device_id: mapping.device_id,
      protocol_version: resolvedProtocolVersion,
      message_type: resolvedMessageType,
      conversation_epoch: resolvedConversationEpoch,
      created_at: ctx.timestamp,
    });

    for (const payload of normalizedPayloads) {
      ctx.db.messagePayload.insert({
        payload_id: ctx.newUuidV7().toString(),
        message_id: inserted.message_id,
        conversation_id,
        delivery_scope: payload.delivery_scope,
        recipient_user_id: payload.recipient_user_id,
        recipient_device_id: payload.recipient_device_id,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        aad: payload.aad,
        created_at: ctx.timestamp,
      });
    }

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
    const mapping = requireMappedDevice(ctx);

    requireConversation(ctx, conversation_id);
    assertConversationMember(ctx, conversation_id, mapping.user_id);

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
    const mapping = requireMappedDevice(ctx);

    requireConversation(ctx, conversation_id);
    assertConversationMember(ctx, conversation_id, mapping.user_id);

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
    const mapping = getMappedDeviceBySender(ctx);
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
        encryption_mode: conv.encryption_mode,
        current_epoch: conv.current_epoch,
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
  t.array(messageViewRow),
  ctx => {
    const mapping = getMappedDeviceBySender(ctx);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      for (const payload of ctx.db.messagePayload.byConversationId.filter(membership.conversation_id)) {
        const msg = ctx.db.message.message_id.find(payload.message_id);
        if (!msg) continue;

        if (payload.delivery_scope === DEVICE_SCOPE) {
          const isTargetDevice = payload.recipient_device_id === mapping.device_id;
          const isUserFallback = payload.recipient_device_id === undefined && payload.recipient_user_id === mapping.user_id;
          if (!isTargetDevice && !isUserFallback) {
            continue;
          }
        }

        rows.push({
          payload_id: payload.payload_id,
          message_id: msg.message_id,
          conversation_id: msg.conversation_id,
          sender_user_id: msg.sender_user_id,
          sender_device_id: msg.sender_device_id,
          protocol_version: msg.protocol_version,
          message_type: msg.message_type,
          conversation_epoch: msg.conversation_epoch,
          delivery_scope: payload.delivery_scope,
          recipient_user_id: payload.recipient_user_id,
          recipient_device_id: payload.recipient_device_id,
          ciphertext: payload.ciphertext,
          nonce: payload.nonce,
          aad: payload.aad,
          created_at: msg.created_at,
        });
      }
    }

    rows.sort((a, b) => compareTimestampAsc(a.created_at, b.created_at));
    return rows;
  }
);

export const my_conversation_key_packages = spacetimedb.view(
  { name: 'my_conversation_key_packages', public: true },
  t.array(conversationKeyPackageViewRow),
  ctx => {
    const mapping = getMappedDeviceBySender(ctx);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const row of ctx.db.conversationKeyPackage.byRecipientDeviceId.filter(mapping.device_id)) {
      if (!getMember(ctx, row.conversation_id, mapping.user_id)) {
        continue;
      }
      rows.push({
        package_id: row.package_id,
        conversation_id: row.conversation_id,
        epoch: row.epoch,
        recipient_user_id: row.recipient_user_id,
        recipient_device_id: row.recipient_device_id,
        sender_user_id: row.sender_user_id,
        sender_device_id: row.sender_device_id,
        sealed_sender_key: row.sealed_sender_key,
        created_at: row.created_at,
      });
    }

    rows.sort((a, b) => compareTimestampAsc(a.created_at, b.created_at));
    return rows;
  }
);

export const my_conversation_membership_events = spacetimedb.view(
  { name: 'my_conversation_membership_events', public: true },
  t.array(conversationMembershipEventViewRow),
  ctx => {
    const mapping = getMappedDeviceBySender(ctx);
    if (!mapping) {
      return [];
    }

    const rows = [];
    for (const membership of ctx.db.conversationMember.byUserId.filter(mapping.user_id)) {
      for (const row of ctx.db.conversationMembershipEvent.byConversationId.filter(membership.conversation_id)) {
        rows.push({
          event_id: row.event_id,
          conversation_id: row.conversation_id,
          event_type: row.event_type,
          target_user_id: row.target_user_id,
          target_device_id: row.target_device_id,
          actor_user_id: row.actor_user_id,
          actor_device_id: row.actor_device_id,
          new_epoch: row.new_epoch,
          created_at: row.created_at,
        });
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
    const mapping = getMappedDeviceBySender(ctx);
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
    const mapping = getMappedDeviceBySender(ctx);
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
    const mapping = getMappedDeviceBySender(ctx);
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
