import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ChatPage from './ChatPage';
import { ChatProvider } from '../context/ChatContext';

const mockAuthState = vi.hoisted(() => ({
  currentUser: {
    id: 1,
    username: 'alice',
    profile_picture: null,
  },
}));

const mockRealtime = vi.hoisted(() => {
  const tableNames = [
    'my_conversations',
    'my_conversation_key_packages',
    'my_conversation_membership_events',
    'my_messages',
    'my_typing',
    'my_read_state',
    'my_presence',
  ];

  const state = {
    currentUserId: 1,
    currentDeviceId: 'device-primary-001',
    rows: Object.fromEntries(tableNames.map((name) => [name, []])),
    reducerCalls: {
      sendMessage: [],
      setTyping: [],
      markRead: [],
    },
    nextMessageCounter: 1,
    nextPayloadCounter: 1,
    lastConfig: null,
  };

  const cloneRows = (rows = []) => rows.map((row) => ({ ...row }));

  const replaceMatchingRow = (rows, matcher, nextRow) => {
    let didReplace = false;
    const nextRows = rows.map((row) => {
      if (matcher(row)) {
        didReplace = true;
        return nextRow;
      }
      return row;
    });
    if (!didReplace) {
      nextRows.push(nextRow);
    }
    return nextRows;
  };

  const createTable = (name) => {
    const insertListeners = new Set();
    const deleteListeners = new Set();
    const updateListeners = new Set();

    const emit = () => {
      new Set([...insertListeners, ...deleteListeners, ...updateListeners]).forEach((listener) => {
        listener();
      });
    };

    return {
      iter() {
        return state.rows[name].values();
      },
      onInsert(listener) {
        insertListeners.add(listener);
      },
      removeOnInsert(listener) {
        insertListeners.delete(listener);
      },
      onDelete(listener) {
        deleteListeners.add(listener);
      },
      removeOnDelete(listener) {
        deleteListeners.delete(listener);
      },
      onUpdate(listener) {
        updateListeners.add(listener);
      },
      removeOnUpdate(listener) {
        updateListeners.delete(listener);
      },
      __emit: emit,
    };
  };

  const db = Object.fromEntries(tableNames.map((name) => [name, createTable(name)]));

  const emitTable = (name) => {
    db[name].__emit();
  };

  const upsertConversation = (conversation) => {
    state.rows.my_conversations = replaceMatchingRow(
      state.rows.my_conversations,
      (row) => row.conversationId === conversation.conversationId,
      {
        encryptionMode: 'legacy',
        currentEpoch: 1,
        participantUserIds: [state.currentUserId],
        ...conversation,
      }
    );
    emitTable('my_conversations');
  };

  const updateConversationMetadata = (conversationId, nextValues) => {
    state.rows.my_conversations = state.rows.my_conversations.map((conversation) => {
      if (conversation.conversationId !== conversationId) {
        return conversation;
      }
      return {
        ...conversation,
        ...nextValues,
      };
    });
    emitTable('my_conversations');
  };

  const pushMessage = (message) => {
    state.rows.my_messages = [...state.rows.my_messages, {
      protocolVersion: null,
      messageType: 'chat',
      conversationEpoch: 1,
      deliveryScope: 'conversation',
      recipientUserId: null,
      recipientDeviceId: null,
      senderDeviceId: null,
      nonce: '',
      aad: '',
      payloadId: message.payloadId || `payload-${state.nextPayloadCounter++}`,
      ...message,
    }];
    emitTable('my_messages');
    updateConversationMetadata(message.conversationId, {
      lastMessageId: message.messageId,
      lastMessageAt: message.createdAt,
    });
  };

  const pushMembershipEvent = (eventRow) => {
    state.rows.my_conversation_membership_events = [
      ...state.rows.my_conversation_membership_events,
      { ...eventRow },
    ];
    emitTable('my_conversation_membership_events');
  };

  const subscriptionHandle = () => {
    let ended = false;
    return {
      isEnded() {
        return ended;
      },
      unsubscribe() {
        ended = true;
      },
    };
  };

  return {
    tables: {
      my_conversations: 'my_conversations',
      my_conversation_key_packages: 'my_conversation_key_packages',
      my_conversation_membership_events: 'my_conversation_membership_events',
      my_messages: 'my_messages',
      my_typing: 'my_typing',
      my_read_state: 'my_read_state',
      my_presence: 'my_presence',
    },
    reset(initialRows = {}) {
      tableNames.forEach((name) => {
        state.rows[name] = cloneRows(initialRows[name]);
      });
      state.reducerCalls = {
        sendMessage: [],
        setTyping: [],
        markRead: [],
      };
      state.nextMessageCounter = 1;
      state.nextPayloadCounter = 1;
      state.lastConfig = null;
      state.currentUserId = 1;
      state.currentDeviceId = 'device-primary-001';
    },
    getReducerCalls() {
      return state.reducerCalls;
    },
    getLastConfig() {
      return state.lastConfig;
    },
    upsertConversation,
    pushMembershipEvent,
    makeBuilder() {
      const handlers = {
        onConnect: null,
        onDisconnect: null,
        onConnectError: null,
      };
      const config = {
        uri: null,
        dbName: null,
        token: null,
      };

      return {
        withUri(uri) {
          config.uri = uri;
          return this;
        },
        withDatabaseName(dbName) {
          config.dbName = dbName;
          return this;
        },
        withToken(token) {
          config.token = token;
          return this;
        },
        onConnect(handler) {
          handlers.onConnect = handler;
          return this;
        },
        onDisconnect(handler) {
          handlers.onDisconnect = handler;
          return this;
        },
        onConnectError(handler) {
          handlers.onConnectError = handler;
          return this;
        },
        build() {
          state.lastConfig = { ...config };

          const connection = {
            db,
            reducers: {
              async sendMessage(args) {
                const nextArgs = {
                  ...args,
                  payloads: Array.isArray(args.payloads)
                    ? args.payloads.map((payload) => ({ ...payload }))
                    : undefined,
                };
                state.reducerCalls.sendMessage.push(nextArgs);

                const createdAt = `2026-03-08T12:00:${String(state.nextMessageCounter).padStart(2, '0')}Z`;
                const nextMessageId = `local-message-${state.nextMessageCounter++}`;

                if (Array.isArray(args.payloads) && args.payloads.length > 0) {
                  const visiblePayload = args.payloads.find((payload) => (
                    payload.deliveryScope === 'conversation'
                    || payload.recipientDeviceId === state.currentDeviceId
                    || payload.recipientUserId === state.currentUserId
                  )) || args.payloads[0];

                  pushMessage({
                    messageId: nextMessageId,
                    conversationId: args.conversationId,
                    senderUserId: state.currentUserId,
                    senderDeviceId: state.currentDeviceId,
                    protocolVersion: args.protocolVersion || null,
                    messageType: args.messageType || 'chat',
                    conversationEpoch: Number(args.conversationEpoch ?? 1),
                    deliveryScope: visiblePayload.deliveryScope || 'conversation',
                    recipientUserId: visiblePayload.recipientUserId ?? null,
                    recipientDeviceId: visiblePayload.recipientDeviceId ?? null,
                    ciphertext: visiblePayload.ciphertext || '',
                    nonce: visiblePayload.nonce || '',
                    aad: visiblePayload.aad || '',
                    createdAt,
                  });
                  return;
                }

                pushMessage({
                  messageId: nextMessageId,
                  conversationId: args.conversationId,
                  senderUserId: state.currentUserId,
                  ciphertext: args.ciphertext,
                  createdAt,
                });
              },
              async setTyping({ conversationId, isTyping }) {
                state.reducerCalls.setTyping.push({ conversationId, isTyping });
              },
              async markRead({ conversationId, lastReadMessageId }) {
                state.reducerCalls.markRead.push({ conversationId, lastReadMessageId });
              },
            },
            subscriptionBuilder() {
              const subscriptionHandlers = {
                onApplied: null,
                onError: null,
              };
              return {
                onApplied(handler) {
                  subscriptionHandlers.onApplied = handler;
                  return this;
                },
                onError(handler) {
                  subscriptionHandlers.onError = handler;
                  return this;
                },
                subscribe() {
                  const handle = subscriptionHandle();
                  Promise.resolve().then(() => {
                    subscriptionHandlers.onApplied?.();
                  });
                  return handle;
                },
              };
            },
            disconnect() {
              handlers.onDisconnect?.(null, null);
            },
          };

          Promise.resolve().then(() => {
            handlers.onConnect?.(connection);
          });

          return connection;
        },
      };
    },
  };
});

const mockCrypto = vi.hoisted(() => {
  const state = {
    currentDeviceId: 'device-primary-001',
    currentUserId: 1,
    newConversationsEnabled: true,
    fetchUserDeviceBundlesCalls: [],
    sendMessageCalls: [],
    ensureGroupConversationStateCalls: [],
    ingestConversationKeyPackagesCalls: [],
    resolveMessagesCalls: [],
    startCandidateLinkCalls: [],
    approveCandidateLinkCalls: [],
    completeCandidateLinkCalls: [],
    pendingLinkSessions: [],
    userBundles: new Map(),
  };

  const cloneBundle = (bundle) => ({
    userId: Number(bundle.userId),
    devices: (bundle.devices || []).map((device) => ({ ...device })),
  });

  const decryptCiphertext = (ciphertext) => (
    typeof ciphertext === 'string' && ciphertext.startsWith('enc:')
      ? ciphertext.slice(4)
      : ciphertext
  );

  const bootstrapResult = () => ({
    bootstrap: {
      enabled: true,
      new_conversations_enabled: state.newConversationsEnabled,
      current_device_id: state.currentDeviceId,
      has_active_device: true,
      devices: [
        {
          device_id: state.currentDeviceId,
          label: 'Alice Laptop',
          device_kind: 'primary',
          status: 'active',
        },
      ],
      remaining_one_time_prekeys: 12,
      min_one_time_prekeys: 5,
    },
    localDevice: {
      deviceId: state.currentDeviceId,
      label: 'Alice Laptop',
      status: 'active',
    },
    localDeviceState: 'ready',
    storageKind: 'memory',
    autoRegistered: false,
    supported: true,
  });

  return {
    reset({ newConversationsEnabled = true, pendingLinkSessions = [], userBundles = {} } = {}) {
      state.newConversationsEnabled = newConversationsEnabled;
      state.fetchUserDeviceBundlesCalls = [];
      state.sendMessageCalls = [];
      state.ensureGroupConversationStateCalls = [];
      state.ingestConversationKeyPackagesCalls = [];
      state.resolveMessagesCalls = [];
      state.startCandidateLinkCalls = [];
      state.approveCandidateLinkCalls = [];
      state.completeCandidateLinkCalls = [];
      state.pendingLinkSessions = pendingLinkSessions.map((session) => ({ ...session }));
      state.userBundles = new Map(
        Object.entries(userBundles).map(([userId, bundle]) => [Number(userId), cloneBundle(bundle)])
      );
    },
    getCalls() {
      return {
        fetchUserDeviceBundles: state.fetchUserDeviceBundlesCalls.map((call) => ({
          userId: call.userId,
          options: { ...call.options },
        })),
        sendMessage: state.sendMessageCalls.map((call) => ({
          ...call,
          membershipEvents: call.membershipEvents.map((event) => ({ ...event })),
        })),
        ensureGroupConversationState: state.ensureGroupConversationStateCalls.map((call) => ({
          ...call,
          conversations: call.conversations.map((conversation) => ({ ...conversation })),
          membershipEventsByConversation: Object.fromEntries(
            Object.entries(call.membershipEventsByConversation).map(([conversationId, events]) => [
              conversationId,
              events.map((event) => ({ ...event })),
            ])
          ),
        })),
        ingestConversationKeyPackages: state.ingestConversationKeyPackagesCalls.map((call) => ({
          currentDeviceId: call.currentDeviceId,
          packageRows: call.packageRows.map((row) => ({ ...row })),
        })),
        resolveMessages: state.resolveMessagesCalls.map((call) => ({ ...call })),
        startCandidateLink: state.startCandidateLinkCalls.map((call) => ({ ...call })),
        approveCandidateLink: state.approveCandidateLinkCalls.map((call) => ({ ...call })),
        completeCandidateLink: state.completeCandidateLinkCalls.map((call) => ({ ...call })),
      };
    },
    createClient() {
      return {
        storeKind: 'memory',
        initialize: async () => bootstrapResult(),
        refreshBootstrap: async () => bootstrapResult(),
        ingestConversationKeyPackages: async ({ packageRows, currentDeviceId }) => {
          state.ingestConversationKeyPackagesCalls.push({
            currentDeviceId,
            packageRows: (packageRows || []).map((row) => ({ ...row })),
          });
          return {};
        },
        ensureGroupConversationState: async ({
          conn: _conn,
          conversations,
          currentUserId,
          currentDeviceId,
          membershipEventsByConversation = {},
        }) => {
          state.ensureGroupConversationStateCalls.push({
            currentUserId,
            currentDeviceId,
            conversations: conversations.map((conversation) => ({ ...conversation })),
            membershipEventsByConversation: Object.fromEntries(
              Object.entries(membershipEventsByConversation).map(([conversationId, events]) => [
                conversationId,
                events.map((event) => ({ ...event })),
              ])
            ),
          });
        },
        resolveMessages: async ({ conversations, messagesByConversation, currentDeviceId }) => {
          state.resolveMessagesCalls.push({
            currentDeviceId,
            conversationIds: conversations.map((conversation) => conversation.conversationId),
          });

          const conversationById = new Map(
            conversations.map((conversation) => [conversation.conversationId, conversation])
          );
          return Object.fromEntries(
            Object.entries(messagesByConversation).map(([conversationId, messages]) => {
              const conversation = conversationById.get(conversationId);
              const resolvedMessages = messages.map((message) => {
                if (conversation?.encryptionMode !== 'e2ee_v1') {
                  return {
                    ...message,
                    bodyText: message.ciphertext,
                    messageState: 'legacy',
                  };
                }

                const decryptedText = decryptCiphertext(message.ciphertext);
                return {
                  ...message,
                  ciphertext: decryptedText,
                  bodyText: decryptedText,
                  messageState: decryptedText === message.ciphertext ? 'pending_keys' : 'decrypted',
                };
              });
              return [conversationId, resolvedMessages];
            })
          );
        },
        sendMessage: async ({
          conn,
          conversation,
          plaintext,
          currentUserId,
          currentDeviceId,
          membershipEvents = [],
        }) => {
          state.sendMessageCalls.push({
            conversationId: conversation.conversationId,
            plaintext,
            currentUserId,
            currentDeviceId,
            membershipEvents: membershipEvents.map((event) => ({ ...event })),
          });

          if (conversation.encryptionMode === 'e2ee_v1') {
            const payload = conversation.kind === 'group'
              ? {
                deliveryScope: 'conversation',
                ciphertext: `enc:${plaintext}`,
                nonce: 'nonce-group',
                aad: 'aad-group',
              }
              : {
                deliveryScope: 'device',
                recipientUserId: currentUserId,
                recipientDeviceId: currentDeviceId,
                ciphertext: `enc:${plaintext}`,
                nonce: 'nonce-dm',
                aad: 'aad-dm',
              };

            await conn.reducers.sendMessage({
              conversationId: conversation.conversationId,
              protocolVersion: 'e2ee_v1',
              messageType: 'chat',
              conversationEpoch: conversation.currentEpoch || 1,
              payloads: [payload],
            });
            return;
          }

          await conn.reducers.sendMessage({
            conversationId: conversation.conversationId,
            ciphertext: plaintext,
          });
        },
        fetchUserDeviceBundles: async (userId, options = {}) => {
          state.fetchUserDeviceBundlesCalls.push({
            userId: Number(userId),
            options: { ...options },
          });
          return cloneBundle(
            state.userBundles.get(Number(userId))
            || { userId: Number(userId), devices: [] }
          );
        },
        rotateSignedPrekey: async () => ({}),
        replenishOneTimePrekeys: async () => ({}),
        revokeDevice: async () => ({}),
        startCandidateLink: async (options = {}) => {
          state.startCandidateLinkCalls.push({ ...options });
          return {};
        },
        approveCandidateLink: async (options = {}) => {
          state.approveCandidateLinkCalls.push({ ...options });
          return {};
        },
        completeCandidateLink: async (linkSessionId) => {
          state.completeCandidateLinkCalls.push({ linkSessionId });
          return { status: 'active', current_device_id: 'device-linked-001' };
        },
        listPendingLinkSessions: async () => state.pendingLinkSessions.map((session) => ({ ...session })),
      };
    },
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('../spacetimedb/module_bindings', () => ({
  DbConnection: {
    builder: () => mockRealtime.makeBuilder(),
  },
  tables: mockRealtime.tables,
}));

vi.mock('../chat/crypto', () => ({
  createChatCryptoClient: () => mockCrypto.createClient(),
}));

const makeJsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('Encrypted Chat Flows', () => {
  let extraFetchHandler;

  beforeEach(() => {
    window.innerWidth = 1280;
    mockAuthState.currentUser = {
      id: 1,
      username: 'alice',
      profile_picture: null,
    };
    mockRealtime.reset();
    mockCrypto.reset();
    extraFetchHandler = null;

    global.fetch = vi.fn(async (url, options = {}) => {
      if (extraFetchHandler) {
        const extraResponse = await extraFetchHandler(url, options);
        if (extraResponse) {
          return extraResponse;
        }
      }

      if (String(url).startsWith('/api/v1/chat/bootstrap')) {
        return makeJsonResponse({
          ws_url: 'wss://maincloud.spacetimedb.com',
          db_name: 'socialnetworkdotsocial-48xhr',
          websocket_token: 'ws-token-123',
          user_id: 1,
          device_id: 'device-primary-001',
        });
      }

      if (url === '/api/v1/chat/friends') {
        return makeJsonResponse([
          { id: 2, username: 'bob', profile_picture: null },
          { id: 3, username: 'carol', profile_picture: null },
        ]);
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });
  });

  const renderChat = () => render(
    <ChatProvider>
      <ChatPage />
    </ChatProvider>
  );

  it('creates an encrypted direct chat and sends an encrypted payload through the crypto client', async () => {
    let dmRequestBody = null;
    mockCrypto.reset({
      userBundles: {
        2: {
          userId: 2,
          devices: [
            {
              deviceId: 'device-bob-001',
            },
          ],
        },
      },
    });

    extraFetchHandler = async (url, options = {}) => {
      if (url === '/api/v1/chat/dm' && options.method === 'POST') {
        dmRequestBody = JSON.parse(options.body);
        mockRealtime.upsertConversation({
          conversationId: 'dm:1:2',
          kind: 'dm',
          title: 'DM: alice & bob',
          createdByUserId: 1,
          encryptionMode: dmRequestBody.encryption_mode,
          currentEpoch: 1,
          createdAt: '2026-03-08T11:59:00Z',
          lastMessageAt: '2026-03-08T11:59:00Z',
          lastMessageId: null,
          participantUserIds: [1, 2],
        });
        return makeJsonResponse({ conversation_id: 'dm:1:2' });
      }
      return null;
    };

    renderChat();

    await screen.findByRole('button', { name: /new group/i });

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Open$/i }));

    expect(await screen.findByRole('heading', { name: 'DM: alice & bob' })).toBeInTheDocument();

    expect(dmRequestBody).toEqual({
      user_id: 2,
      encryption_mode: 'e2ee_v1',
    });
    expect(mockCrypto.getCalls().fetchUserDeviceBundles).toEqual([
      {
        userId: 2,
        options: { claimPrekeys: false },
      },
    ]);

    fireEvent.change(screen.getByPlaceholderText('Type a message'), {
      target: { value: 'hello secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));

    await waitFor(() => {
      expect(mockCrypto.getCalls().sendMessage).toHaveLength(1);
    });

    expect(mockCrypto.getCalls().sendMessage[0]).toMatchObject({
      conversationId: 'dm:1:2',
      plaintext: 'hello secret',
      currentUserId: 1,
      currentDeviceId: 'device-primary-001',
    });

    await waitFor(() => {
      expect(mockRealtime.getReducerCalls().sendMessage).toHaveLength(1);
      expect(mockRealtime.getReducerCalls().sendMessage[0]).toMatchObject({
        conversationId: 'dm:1:2',
        protocolVersion: 'e2ee_v1',
        messageType: 'chat',
        conversationEpoch: 1,
      });
      expect(mockRealtime.getReducerCalls().sendMessage[0].payloads[0]).toMatchObject({
        deliveryScope: 'device',
        ciphertext: 'enc:hello secret',
      });
    });

    expect(await screen.findByText('hello secret')).toBeInTheDocument();
  });

  it('falls back to legacy DM creation when new encrypted conversations are rollout-gated', async () => {
    let dmRequestBody = null;
    mockCrypto.reset({
      newConversationsEnabled: false,
      userBundles: {
        2: {
          userId: 2,
          devices: [
            {
              deviceId: 'device-bob-001',
            },
          ],
        },
      },
    });

    extraFetchHandler = async (url, options = {}) => {
      if (url === '/api/v1/chat/dm' && options.method === 'POST') {
        dmRequestBody = JSON.parse(options.body);
        mockRealtime.upsertConversation({
          conversationId: 'dm:1:2',
          kind: 'dm',
          title: 'DM: alice & bob',
          createdByUserId: 1,
          encryptionMode: dmRequestBody.encryption_mode,
          currentEpoch: 0,
          createdAt: '2026-03-08T11:59:00Z',
          lastMessageAt: '2026-03-08T11:59:00Z',
          lastMessageId: null,
          participantUserIds: [1, 2],
        });
        return makeJsonResponse({ conversation_id: 'dm:1:2' });
      }
      return null;
    };

    renderChat();

    await screen.findByRole('button', { name: /new group/i });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Open$/i }));

    expect(dmRequestBody).toEqual({
      user_id: 2,
      encryption_mode: 'legacy',
    });
    expect(mockCrypto.getCalls().fetchUserDeviceBundles).toEqual([]);
    expect(await screen.findByText(/new encrypted conversations are currently paused for rollout/i)).toBeInTheDocument();
  });

  it('creates encrypted groups and rekeys after membership changes', async () => {
    let groupRequestBody = null;
    let addMemberRequestBody = null;
    mockCrypto.reset({
      userBundles: {
        2: {
          userId: 2,
          devices: [
            {
              deviceId: 'device-bob-001',
            },
          ],
        },
        3: {
          userId: 3,
          devices: [
            {
              deviceId: 'device-carol-001',
            },
          ],
        },
      },
    });

    extraFetchHandler = async (url, options = {}) => {
      if (url === '/api/v1/chat/groups' && options.method === 'POST') {
        groupRequestBody = JSON.parse(options.body);
        mockRealtime.upsertConversation({
          conversationId: 'grp:weekend-plans',
          kind: 'group',
          title: groupRequestBody.title,
          createdByUserId: 1,
          encryptionMode: groupRequestBody.encryption_mode,
          currentEpoch: 1,
          createdAt: '2026-03-08T12:10:00Z',
          lastMessageAt: '2026-03-08T12:10:00Z',
          lastMessageId: null,
          participantUserIds: [1, ...groupRequestBody.member_user_ids],
        });
        return makeJsonResponse({ conversation_id: 'grp:weekend-plans' });
      }

      if (url === '/api/v1/chat/groups/grp:weekend-plans/members' && options.method === 'POST') {
        addMemberRequestBody = JSON.parse(options.body);
        mockRealtime.upsertConversation({
          conversationId: 'grp:weekend-plans',
          kind: 'group',
          title: 'Weekend Plans',
          createdByUserId: 1,
          encryptionMode: 'e2ee_v1',
          currentEpoch: 2,
          createdAt: '2026-03-08T12:10:00Z',
          lastMessageAt: '2026-03-08T12:11:00Z',
          lastMessageId: null,
          participantUserIds: [1, 2, 3],
        });
        mockRealtime.pushMembershipEvent({
          eventId: 'membership-event-1',
          conversationId: 'grp:weekend-plans',
          eventType: 'member_added',
          targetUserId: 3,
          targetDeviceId: null,
          actorUserId: 1,
          actorDeviceId: 'device-primary-001',
          newEpoch: 2,
          createdAt: '2026-03-08T12:11:00Z',
        });
        return makeJsonResponse({ conversation_id: 'grp:weekend-plans', user_id: 3 });
      }

      return null;
    };

    renderChat();

    await screen.findByRole('button', { name: /new group/i });
    fireEvent.click(screen.getByRole('button', { name: /new group/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Create Group' });
    fireEvent.change(within(dialog).getByPlaceholderText('Weekend plans'), {
      target: { value: 'Weekend Plans' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /bob/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /create group/i }));

    expect(await screen.findByRole('heading', { name: 'Weekend Plans' })).toBeInTheDocument();

    expect(groupRequestBody).toEqual({
      title: 'Weekend Plans',
      member_user_ids: [2],
      encryption_mode: 'e2ee_v1',
    });
    expect(mockCrypto.getCalls().fetchUserDeviceBundles).toEqual([
      {
        userId: 2,
        options: { claimPrekeys: false },
      },
    ]);

    await waitFor(() => {
      expect(mockCrypto.getCalls().ensureGroupConversationState.length).toBeGreaterThanOrEqual(1);
    });

    const initialEnsureGroupCall = mockCrypto.getCalls().ensureGroupConversationState.at(-1);
    expect(initialEnsureGroupCall).toMatchObject({
      currentUserId: 1,
      currentDeviceId: 'device-primary-001',
      conversations: [
        {
          conversationId: 'grp:weekend-plans',
          encryptionMode: 'e2ee_v1',
          currentEpoch: 1,
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    const addMemberDialog = await screen.findByRole('dialog', { name: 'Add Member' });
    fireEvent.click(within(addMemberDialog).getByRole('button', { name: /carol/i }));

    expect(addMemberRequestBody).toEqual({ user_id: 3 });

    await waitFor(() => {
      expect(mockCrypto.getCalls().ensureGroupConversationState.length).toBeGreaterThan(1);
    });

    const lastEnsureGroupCall = mockCrypto.getCalls().ensureGroupConversationState.at(-1);
    expect(lastEnsureGroupCall.conversations[0]).toMatchObject({
      conversationId: 'grp:weekend-plans',
      currentEpoch: 2,
      encryptionMode: 'e2ee_v1',
    });
    expect(lastEnsureGroupCall.membershipEventsByConversation['grp:weekend-plans']).toEqual([
      expect.objectContaining({
        eventType: 'member_added',
        targetUserId: 3,
        actorDeviceId: 'device-primary-001',
        newEpoch: 2,
      }),
    ]);

    fireEvent.change(screen.getByPlaceholderText('Type a message'), {
      target: { value: 'group secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));

    await waitFor(() => {
      expect(mockCrypto.getCalls().sendMessage).toHaveLength(1);
    });

    expect(mockCrypto.getCalls().sendMessage[0]).toMatchObject({
      conversationId: 'grp:weekend-plans',
      plaintext: 'group secret',
      membershipEvents: [
        expect.objectContaining({
          eventType: 'member_added',
          newEpoch: 2,
        }),
      ],
    });

    await waitFor(() => {
      expect(mockRealtime.getReducerCalls().sendMessage).toHaveLength(1);
      expect(mockRealtime.getReducerCalls().sendMessage[0]).toMatchObject({
        conversationId: 'grp:weekend-plans',
        protocolVersion: 'e2ee_v1',
        conversationEpoch: 2,
      });
      expect(mockRealtime.getReducerCalls().sendMessage[0].payloads[0]).toMatchObject({
        deliveryScope: 'conversation',
        ciphertext: 'enc:group secret',
      });
    });

    expect(await screen.findByText('group secret')).toBeInTheDocument();
  });

  it('submits linked-device approval from the chat security panel', async () => {
    renderChat();

    await screen.findByRole('button', { name: /new group/i });

    const sessionInput = screen.getByPlaceholderText('Link session ID');
    const approvalInput = screen.getByPlaceholderText('Approval code');
    fireEvent.change(sessionInput, { target: { value: '17' } });
    fireEvent.change(approvalInput, { target: { value: 'abcd1234' } });
    fireEvent.click(screen.getByRole('button', { name: /approve device/i }));

    await waitFor(() => {
      expect(mockCrypto.getCalls().approveCandidateLink).toHaveLength(1);
    });

    expect(mockCrypto.getCalls().approveCandidateLink[0]).toMatchObject({
      linkSessionId: 17,
      approvalCode: 'ABCD1234',
      approverDeviceId: 'device-primary-001',
    });
  });
});
