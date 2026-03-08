import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DbConnection, tables } from '../spacetimedb/module_bindings';
import { useAuth } from './AuthContext';

const ChatContext = createContext(null);

const toNumber = (value) => {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value;
};

const timestampToMillis = (value) => {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (typeof value.microsSinceUnixEpoch === 'bigint') {
    return Number(value.microsSinceUnixEpoch / 1000n);
  }
  return 0;
};

const toIsoString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toISOString === 'function') return value.toISOString();
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return null;
};

const normalizeConversation = (row) => ({
  conversationId: row.conversationId,
  kind: row.kind,
  title: row.title,
  createdByUserId: toNumber(row.createdByUserId),
  createdAtMs: timestampToMillis(row.createdAt),
  lastMessageAtMs: timestampToMillis(row.lastMessageAt),
  lastMessageId: row.lastMessageId || null,
  participantUserIds: Array.isArray(row.participantUserIds)
    ? row.participantUserIds.map(toNumber)
    : [],
});

const normalizeMessage = (row) => ({
  messageId: row.messageId,
  conversationId: row.conversationId,
  senderUserId: toNumber(row.senderUserId),
  ciphertext: row.ciphertext,
  createdAtMs: timestampToMillis(row.createdAt),
  createdAtIso: toIsoString(row.createdAt),
});

const normalizeTyping = (row) => ({
  typingStateId: row.typingStateId,
  conversationId: row.conversationId,
  userId: toNumber(row.userId),
  isTyping: Boolean(row.isTyping),
  updatedAtMs: timestampToMillis(row.updatedAt),
});

const normalizeReadState = (row) => ({
  readCursorId: row.readCursorId,
  conversationId: row.conversationId,
  userId: toNumber(row.userId),
  lastReadMessageId: row.lastReadMessageId,
  lastReadAtMs: timestampToMillis(row.lastReadAt),
});

const normalizePresence = (row) => ({
  userId: toNumber(row.userId),
  isOnline: Boolean(row.isOnline),
  activeConnections: Number(row.activeConnections ?? 0),
  lastSeenAtMs: timestampToMillis(row.lastSeenAt),
  lastSeenAtIso: toIsoString(row.lastSeenAt),
});

export const ChatProvider = ({ children }) => {
  const { currentUser } = useAuth();

  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  const [chatUserId, setChatUserId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [messagesByConversation, setMessagesByConversation] = useState({});
  const [typingByConversation, setTypingByConversation] = useState({});
  const [readStateByConversation, setReadStateByConversation] = useState({});
  const [presenceByUserId, setPresenceByUserId] = useState({});
  const [friends, setFriends] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [totalUnread, setTotalUnread] = useState(0);

  const connectionRef = useRef(null);
  const subscriptionRef = useRef(null);
  const listenerCleanupRef = useRef([]);
  const connectPromiseRef = useRef(null);
  const lastReadMessageRef = useRef({});
  const chatUserIdRef = useRef(null);

  const resetState = useCallback(() => {
    setLoading(false);
    setConnected(false);
    setError('');
    chatUserIdRef.current = null;
    setChatUserId(null);
    setConversations([]);
    setMessagesByConversation({});
    setTypingByConversation({});
    setReadStateByConversation({});
    setPresenceByUserId({});
    setFriends([]);
    setActiveConversationId(null);
    setUnreadCounts({});
    setTotalUnread(0);
    lastReadMessageRef.current = {};
  }, []);

  const cleanupConnection = useCallback(() => {
    if (subscriptionRef.current) {
      try {
        if (!subscriptionRef.current.isEnded()) {
          subscriptionRef.current.unsubscribe();
        }
      } catch (_err) {
        // Ignore cleanup errors
      }
      subscriptionRef.current = null;
    }

    listenerCleanupRef.current.forEach((cleanup) => {
      try {
        cleanup();
      } catch (_err) {
        // Ignore cleanup errors
      }
    });
    listenerCleanupRef.current = [];

    if (connectionRef.current) {
      try {
        connectionRef.current.disconnect();
      } catch (_err) {
        // Ignore cleanup errors
      }
      connectionRef.current = null;
    }

    connectPromiseRef.current = null;
  }, []);

  const computeUnread = useCallback((messageMap, readMap, currentChatUserId) => {
    const counts = {};
    let total = 0;

    Object.entries(messageMap).forEach(([conversationId, messages]) => {
      const readStateForConversation = readMap[conversationId] || {};
      const ownReadMessageId = readStateForConversation[currentChatUserId]?.lastReadMessageId || null;

      let unread = 0;
      if (!ownReadMessageId) {
        unread = messages.filter((msg) => msg.senderUserId !== currentChatUserId).length;
      } else {
        const lastReadIndex = messages.findIndex((msg) => msg.messageId === ownReadMessageId);
        unread = messages
          .slice(lastReadIndex >= 0 ? lastReadIndex + 1 : 0)
          .filter((msg) => msg.senderUserId !== currentChatUserId)
          .length;
      }

      counts[conversationId] = unread;
      total += unread;
    });

    return { counts, total };
  }, []);

  const refreshFromCache = useCallback((conn) => {
    if (!conn) return;

    const nextConversations = Array.from(conn.db.my_conversations.iter())
      .map(normalizeConversation)
      .sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);

    const nextMessagesByConversation = {};
    Array.from(conn.db.my_messages.iter())
      .map(normalizeMessage)
      .forEach((messageRow) => {
        if (!nextMessagesByConversation[messageRow.conversationId]) {
          nextMessagesByConversation[messageRow.conversationId] = [];
        }
        nextMessagesByConversation[messageRow.conversationId].push(messageRow);
      });

    Object.values(nextMessagesByConversation).forEach((rows) => {
      rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
    });

    const nextTypingByConversation = {};
    Array.from(conn.db.my_typing.iter())
      .map(normalizeTyping)
      .forEach((typingRow) => {
        if (!nextTypingByConversation[typingRow.conversationId]) {
          nextTypingByConversation[typingRow.conversationId] = [];
        }
        nextTypingByConversation[typingRow.conversationId].push(typingRow);
      });

    const nextReadByConversation = {};
    Array.from(conn.db.my_read_state.iter())
      .map(normalizeReadState)
      .forEach((readRow) => {
        if (!nextReadByConversation[readRow.conversationId]) {
          nextReadByConversation[readRow.conversationId] = {};
        }
        nextReadByConversation[readRow.conversationId][readRow.userId] = readRow;
      });

    const nextPresenceByUserId = {};
    Array.from(conn.db.my_presence.iter())
      .map(normalizePresence)
      .forEach((presenceRow) => {
        nextPresenceByUserId[presenceRow.userId] = presenceRow;
      });

    setConversations(nextConversations);
    setMessagesByConversation(nextMessagesByConversation);
    setTypingByConversation(nextTypingByConversation);
    setReadStateByConversation(nextReadByConversation);
    setPresenceByUserId(nextPresenceByUserId);

    const currentChatUserId = chatUserIdRef.current;
    if (currentChatUserId != null) {
      const { counts, total } = computeUnread(
        nextMessagesByConversation,
        nextReadByConversation,
        currentChatUserId
      );
      setUnreadCounts(counts);
      setTotalUnread(total);
    }

    setActiveConversationId((previousValue) => {
      if (previousValue && nextConversations.some((conv) => conv.conversationId === previousValue)) {
        return previousValue;
      }
      return nextConversations[0]?.conversationId || null;
    });
  }, [computeUnread]);

  const fetchFriends = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/chat/friends', { credentials: 'include' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Failed to load chat friends.');
      }
      const payload = await response.json();
      setFriends(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err.message || 'Failed to load chat friends.');
      setFriends([]);
    }
  }, []);

  const attachListeners = useCallback((conn) => {
    const cleanupFns = [];
    const tableNames = ['my_conversations', 'my_messages', 'my_typing', 'my_read_state', 'my_presence'];

    const callback = () => refreshFromCache(conn);

    tableNames.forEach((tableName) => {
      const table = conn.db[tableName];
      if (!table) return;

      if (typeof table.onInsert === 'function') {
        table.onInsert(callback);
        cleanupFns.push(() => table.removeOnInsert?.(callback));
      }
      if (typeof table.onDelete === 'function') {
        table.onDelete(callback);
        cleanupFns.push(() => table.removeOnDelete?.(callback));
      }
      if (typeof table.onUpdate === 'function') {
        table.onUpdate(callback);
        cleanupFns.push(() => table.removeOnUpdate?.(callback));
      }
    });

    listenerCleanupRef.current = cleanupFns;
  }, [refreshFromCache]);

  const ensureConnected = useCallback(async () => {
    if (!currentUser) return null;
    if (connectionRef.current) return connectionRef.current;
    if (connectPromiseRef.current) return connectPromiseRef.current;

    connectPromiseRef.current = (async () => {
      setLoading(true);
      setError('');

      const bootstrapResponse = await fetch('/api/v1/chat/bootstrap', {
        credentials: 'include',
      });
      if (!bootstrapResponse.ok) {
        const payload = await bootstrapResponse.json().catch(() => ({}));
        throw new Error(payload.message || 'Failed to bootstrap chat connection.');
      }

      const bootstrap = await bootstrapResponse.json();
      if (!bootstrap?.ws_url || !bootstrap?.db_name || !bootstrap?.websocket_token) {
        throw new Error('Chat bootstrap response is missing required fields.');
      }

      const nextChatUserId = Number(bootstrap.user_id);
      chatUserIdRef.current = nextChatUserId;
      setChatUserId(nextChatUserId);

      const conn = DbConnection.builder()
        .withUri(bootstrap.ws_url)
        .withDatabaseName(bootstrap.db_name)
        .withToken(bootstrap.websocket_token)
        .onConnect((connectedConn) => {
          setConnected(true);
          setError('');

          subscriptionRef.current = connectedConn
            .subscriptionBuilder()
            .onApplied(() => {
              refreshFromCache(connectedConn);
              setLoading(false);
            })
            .onError((_ctx, subscriptionError) => {
              setError(subscriptionError?.message || 'Chat subscription failed.');
            })
            .subscribe([
              tables.my_conversations,
              tables.my_messages,
              tables.my_typing,
              tables.my_read_state,
              tables.my_presence,
            ]);

          attachListeners(connectedConn);
        })
        .onDisconnect((_ctx, disconnectError) => {
          setConnected(false);
          if (disconnectError) {
            setError(disconnectError.message || 'Chat connection disconnected.');
          }
        })
        .onConnectError((_ctx, connectionError) => {
          setConnected(false);
          setLoading(false);
          setError(connectionError?.message || 'Could not connect to chat server.');
        })
        .build();

      connectionRef.current = conn;
      await fetchFriends();
      return conn;
    })();

    try {
      return await connectPromiseRef.current;
    } catch (err) {
      cleanupConnection();
      setLoading(false);
      setConnected(false);
      setError(err.message || 'Failed to initialize chat.');
      throw err;
    } finally {
      connectPromiseRef.current = null;
    }
  }, [attachListeners, cleanupConnection, currentUser, fetchFriends, refreshFromCache]);

  const disconnect = useCallback(() => {
    cleanupConnection();
    resetState();
  }, [cleanupConnection, resetState]);

  const createDm = useCallback(async (userId) => {
    const response = await fetch('/api/v1/chat/dm', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: Number(userId) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || 'Failed to create direct message conversation.');
    }
    if (payload.conversation_id) {
      setActiveConversationId(payload.conversation_id);
    }
    return payload;
  }, []);

  const createGroup = useCallback(async (title, memberUserIds) => {
    const response = await fetch('/api/v1/chat/groups', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        member_user_ids: memberUserIds.map((value) => Number(value)),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || 'Failed to create group conversation.');
    }
    if (payload.conversation_id) {
      setActiveConversationId(payload.conversation_id);
    }
    return payload;
  }, []);

  const addGroupMember = useCallback(async (conversationId, userId) => {
    const response = await fetch(`/api/v1/chat/groups/${conversationId}/members`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: Number(userId) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || 'Failed to add member to group conversation.');
    }
    return payload;
  }, []);

  const sendMessage = useCallback(async (conversationId, ciphertext) => {
    const conn = connectionRef.current;
    if (!conn) {
      throw new Error('Chat connection is not active.');
    }
    await conn.reducers.sendMessage({
      conversationId,
      ciphertext,
    });
  }, []);

  const setTyping = useCallback(async (conversationId, isTyping) => {
    const conn = connectionRef.current;
    if (!conn) return;
    await conn.reducers.setTyping({
      conversationId,
      isTyping,
    });
  }, []);

  const markRead = useCallback(async (conversationId, lastReadMessageId) => {
    const conn = connectionRef.current;
    if (!conn || !lastReadMessageId) return;

    const lastMarked = lastReadMessageRef.current[conversationId];
    if (lastMarked === lastReadMessageId) {
      return;
    }

    await conn.reducers.markRead({
      conversationId,
      lastReadMessageId,
    });
    lastReadMessageRef.current[conversationId] = lastReadMessageId;
  }, []);

  useEffect(() => {
    if (!currentUser) {
      disconnect();
    }
  }, [currentUser, disconnect]);

  useEffect(() => {
    if (!currentUser) return;
    ensureConnected().catch(() => {
      // Connection errors are surfaced through context state.
    });
  }, [currentUser, ensureConnected]);

  const value = useMemo(() => ({
    loading,
    connected,
    error,
    chatUserId,
    conversations,
    messagesByConversation,
    typingByConversation,
    readStateByConversation,
    presenceByUserId,
    friends,
    activeConversationId,
    setActiveConversationId,
    unreadCounts,
    totalUnread,
    ensureConnected,
    disconnect,
    refreshFromCache: () => refreshFromCache(connectionRef.current),
    createDm,
    createGroup,
    addGroupMember,
    sendMessage,
    setTyping,
    markRead,
    fetchFriends,
  }), [
    loading,
    connected,
    error,
    chatUserId,
    conversations,
    messagesByConversation,
    typingByConversation,
    readStateByConversation,
    presenceByUserId,
    friends,
    activeConversationId,
    unreadCounts,
    totalUnread,
    ensureConnected,
    disconnect,
    refreshFromCache,
    createDm,
    createGroup,
    addGroupMember,
    sendMessage,
    setTyping,
    markRead,
    fetchFriends,
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider.');
  }
  return context;
};
