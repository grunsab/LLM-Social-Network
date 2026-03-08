import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    'my_messages',
    'my_typing',
    'my_read_state',
    'my_presence',
  ];

  const state = {
    currentUserId: 1,
    rows: Object.fromEntries(tableNames.map((name) => [name, []])),
    reducerCalls: {
      sendMessage: [],
      setTyping: [],
      markRead: [],
    },
    nextMessageCounter: 1,
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
    state.rows.my_messages = [...state.rows.my_messages, { ...message }];
    emitTable('my_messages');
    updateConversationMetadata(message.conversationId, {
      lastMessageId: message.messageId,
      lastMessageAt: message.createdAt,
    });
  };

  const upsertTyping = (typingRow) => {
    state.rows.my_typing = replaceMatchingRow(
      state.rows.my_typing,
      (row) => row.conversationId === typingRow.conversationId && row.userId === typingRow.userId,
      { ...typingRow }
    );
    emitTable('my_typing');
  };

  const upsertReadState = (readRow) => {
    state.rows.my_read_state = replaceMatchingRow(
      state.rows.my_read_state,
      (row) => row.conversationId === readRow.conversationId && row.userId === readRow.userId,
      { ...readRow }
    );
    emitTable('my_read_state');
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
      state.lastConfig = null;
      state.currentUserId = 1;
    },
    getReducerCalls() {
      return state.reducerCalls;
    },
    getLastConfig() {
      return state.lastConfig;
    },
    pushMessage,
    setTypingRow(typingRow) {
      upsertTyping(typingRow);
    },
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
              async sendMessage({ conversationId, ciphertext }) {
                state.reducerCalls.sendMessage.push({ conversationId, ciphertext });
                const nextMessageId = `local-message-${state.nextMessageCounter++}`;
                pushMessage({
                  messageId: nextMessageId,
                  conversationId,
                  senderUserId: state.currentUserId,
                  ciphertext,
                  createdAt: `2026-03-07T12:00:${String(state.nextMessageCounter).padStart(2, '0')}Z`,
                });
              },
              async setTyping({ conversationId, isTyping }) {
                state.reducerCalls.setTyping.push({ conversationId, isTyping });
                upsertTyping({
                  typingStateId: `typing:${conversationId}:${state.currentUserId}`,
                  conversationId,
                  userId: state.currentUserId,
                  isTyping,
                  updatedAt: '2026-03-07T12:00:59Z',
                });
              },
              async markRead({ conversationId, lastReadMessageId }) {
                state.reducerCalls.markRead.push({ conversationId, lastReadMessageId });
                upsertReadState({
                  readCursorId: `read:${conversationId}:${state.currentUserId}`,
                  conversationId,
                  userId: state.currentUserId,
                  lastReadMessageId,
                  lastReadAt: '2026-03-07T12:01:00Z',
                });
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

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('../spacetimedb/module_bindings', () => ({
  DbConnection: {
    builder: () => mockRealtime.makeBuilder(),
  },
  tables: mockRealtime.tables,
}));

describe('ChatPage integration', () => {
  beforeEach(() => {
    window.innerWidth = 1280;
    mockAuthState.currentUser = {
      id: 1,
      username: 'alice',
      profile_picture: null,
    };
    mockRealtime.reset();
    global.fetch = vi.fn(async (url) => {
      if (url === '/api/v1/chat/bootstrap') {
        return {
          ok: true,
          json: async () => ({
            ws_url: 'wss://maincloud.spacetimedb.com',
            db_name: 'socialnetworkdotsocial-48xhr',
            websocket_token: 'ws-token-123',
            user_id: 1,
          }),
        };
      }

      if (url === '/api/v1/chat/friends') {
        return {
          ok: true,
          json: async () => ([
            { id: 2, username: 'bob', profile_picture: null },
            { id: 3, username: 'carol', profile_picture: null },
          ]),
        };
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });
  });

  const renderChat = () => render(
    <ChatProvider>
      <ChatPage />
    </ChatProvider>
  );

  it('hydrates realtime state, marks messages read, and shows live typing/presence', async () => {
    const liveTimestamp = new Date().toISOString();

    mockRealtime.reset({
      my_conversations: [
        {
          conversationId: 'dm:1:2',
          kind: 'dm',
          title: 'DM: alice & bob',
          createdByUserId: 1,
          createdAt: '2026-03-07T11:59:00Z',
          lastMessageAt: '2026-03-07T12:00:00Z',
          lastMessageId: 'message-1',
          participantUserIds: [1, 2],
        },
        {
          conversationId: 'dm:1:3',
          kind: 'dm',
          title: 'DM: alice & carol',
          createdByUserId: 1,
          createdAt: '2026-03-07T11:58:00Z',
          lastMessageAt: '2026-03-07T11:59:00Z',
          lastMessageId: 'message-2',
          participantUserIds: [1, 3],
        },
      ],
      my_messages: [
        {
          messageId: 'message-1',
          conversationId: 'dm:1:2',
          senderUserId: 2,
          ciphertext: 'hello from bob',
          createdAt: '2026-03-07T12:00:00Z',
        },
        {
          messageId: 'message-2',
          conversationId: 'dm:1:3',
          senderUserId: 3,
          ciphertext: 'ping from carol',
          createdAt: '2026-03-07T11:59:00Z',
        },
      ],
      my_typing: [
        {
          typingStateId: 'typing:dm:1:2:2',
          conversationId: 'dm:1:2',
          userId: 2,
          isTyping: true,
          updatedAt: liveTimestamp,
        },
      ],
      my_presence: [
        {
          userId: 2,
          isOnline: true,
          activeConnections: 1,
          lastSeenAt: liveTimestamp,
        },
      ],
    });

    renderChat();

    expect(await screen.findByRole('heading', { name: 'DM: alice & bob' })).toBeInTheDocument();
    expect(await screen.findByText('hello from bob')).toBeInTheDocument();
    expect(screen.getByText('bob typing...')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(document.querySelector('.chat-unread-badge')).toHaveTextContent('1');

    await waitFor(() => {
      expect(mockRealtime.getReducerCalls().markRead).toEqual([
        {
          conversationId: 'dm:1:2',
          lastReadMessageId: 'message-1',
        },
      ]);
    });

    expect(await screen.findByText('Read by alice')).toBeInTheDocument();
    expect(mockRealtime.getLastConfig()).toEqual({
      uri: 'wss://maincloud.spacetimedb.com',
      dbName: 'socialnetworkdotsocial-48xhr',
      token: 'ws-token-123',
    });
  });

  it('uses a single-pane mobile flow with back navigation and a group sheet', async () => {
    window.innerWidth = 390;

    mockRealtime.reset({
      my_conversations: [
        {
          conversationId: 'dm:1:2',
          kind: 'dm',
          title: 'DM: alice & bob',
          createdByUserId: 1,
          createdAt: '2026-03-07T11:59:00Z',
          lastMessageAt: '2026-03-07T12:00:00Z',
          lastMessageId: 'message-1',
          participantUserIds: [1, 2],
        },
      ],
      my_messages: [
        {
          messageId: 'message-1',
          conversationId: 'dm:1:2',
          senderUserId: 2,
          ciphertext: 'hello from bob',
          createdAt: '2026-03-07T12:00:00Z',
        },
      ],
    });

    renderChat();
    expect(screen.getByText('Chats')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Group/i })).toBeEnabled();
    });
    await screen.findByRole('button', { name: /DM: alice & bob/i });
    expect(screen.queryByRole('heading', { name: 'DM: alice & bob' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New Group/i }));
    expect(screen.getByRole('dialog', { name: 'Create Group' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));

    fireEvent.click(screen.getByRole('button', { name: /DM: alice & bob/i }));

    expect(await screen.findByRole('heading', { name: 'DM: alice & bob' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to chats/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Chats' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Back to chats/i }));

    expect(await screen.findByRole('heading', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'DM: alice & bob' })).not.toBeInTheDocument();
  });
});
