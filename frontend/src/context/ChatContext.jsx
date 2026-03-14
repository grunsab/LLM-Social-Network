import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { createChatCryptoClient } from '../chat/crypto';
import { DbConnection, tables } from '../spacetimedb/module_bindings';
import { useAuth } from './AuthContext';

const ChatContext = createContext(null);
const LEGACY_ENCRYPTION_MODE = 'legacy';
const E2EE_ENCRYPTION_MODE = 'e2ee_v1';

const createDefaultE2eeState = () => ({
  initialized: false,
  enabled: false,
  newConversationsEnabled: false,
  currentDeviceId: null,
  hasActiveDevice: false,
  devices: [],
  localDevice: null,
  localDeviceState: 'disabled',
  storageKind: null,
  supported: false,
  autoRegistered: false,
  remainingOneTimePrekeys: 0,
  minOneTimePrekeys: 0,
  pendingLinkSessions: [],
  error: '',
});

const parseResponsePayload = async (response) => {
  if (typeof response.text === 'function') {
    const rawText = await response.text();
    if (!rawText) {
      return {};
    }

    try {
      return JSON.parse(rawText);
    } catch (_err) {
      return { message: rawText.trim() };
    }
  }

  if (typeof response.json === 'function') {
    return response.json().catch(() => ({}));
  }

  return {};
};

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
  encryptionMode: row.encryptionMode || LEGACY_ENCRYPTION_MODE,
  currentEpoch: Number(row.currentEpoch ?? 0),
  createdAtMs: timestampToMillis(row.createdAt),
  lastMessageAtMs: timestampToMillis(row.lastMessageAt),
  lastMessageId: row.lastMessageId || null,
  participantUserIds: Array.isArray(row.participantUserIds)
    ? row.participantUserIds.map(toNumber)
    : [],
});

const normalizeMessage = (row) => ({
  payloadId: row.payloadId || row.messageId,
  messageId: row.messageId,
  conversationId: row.conversationId,
  senderUserId: toNumber(row.senderUserId),
  senderDeviceId: row.senderDeviceId || null,
  protocolVersion: row.protocolVersion || null,
  messageType: row.messageType || 'chat',
  conversationEpoch: Number(row.conversationEpoch ?? 0),
  deliveryScope: row.deliveryScope || 'conversation',
  recipientUserId: row.recipientUserId == null ? null : toNumber(row.recipientUserId),
  recipientDeviceId: row.recipientDeviceId || null,
  nonce: row.nonce || '',
  aad: row.aad || '',
  wireCiphertext: row.ciphertext || '',
  ciphertext: row.ciphertext || '',
  bodyText: row.ciphertext || '',
  messageState: 'legacy',
  createdAtMs: timestampToMillis(row.createdAt),
  createdAtIso: toIsoString(row.createdAt),
});

const normalizeConversationKeyPackage = (row) => ({
  packageId: row.packageId,
  conversationId: row.conversationId,
  epoch: Number(row.epoch ?? 0),
  recipientUserId: row.recipientUserId == null ? null : toNumber(row.recipientUserId),
  recipientDeviceId: row.recipientDeviceId,
  senderUserId: toNumber(row.senderUserId),
  senderDeviceId: row.senderDeviceId,
  sealedSenderKey: row.sealedSenderKey,
  createdAtMs: timestampToMillis(row.createdAt),
  createdAtIso: toIsoString(row.createdAt),
});

const normalizeConversationMembershipEvent = (row) => ({
  eventId: row.eventId,
  conversationId: row.conversationId,
  eventType: row.eventType,
  targetUserId: toNumber(row.targetUserId),
  targetDeviceId: row.targetDeviceId || null,
  actorUserId: toNumber(row.actorUserId),
  actorDeviceId: row.actorDeviceId || null,
  newEpoch: Number(row.newEpoch ?? 0),
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
  const [e2eeState, setE2eeState] = useState(createDefaultE2eeState);
  const [conversationKeyPackagesByConversation, setConversationKeyPackagesByConversation] = useState({});
  const [conversationMembershipEventsByConversation, setConversationMembershipEventsByConversation] = useState({});

  const connectionRef = useRef(null);
  const subscriptionRef = useRef(null);
  const listenerCleanupRef = useRef([]);
  const connectPromiseRef = useRef(null);
  const lastReadMessageRef = useRef({});
  const chatUserIdRef = useRef(null);
  const refreshSequenceRef = useRef(0);
  const e2eeStateRef = useRef(createDefaultE2eeState());
  const conversationMembershipEventsRef = useRef({});
  const cryptoClientRef = useRef(null);

  if (!cryptoClientRef.current) {
    cryptoClientRef.current = createChatCryptoClient();
  }

  useEffect(() => {
    e2eeStateRef.current = e2eeState;
  }, [e2eeState]);

  useEffect(() => {
    conversationMembershipEventsRef.current = conversationMembershipEventsByConversation;
  }, [conversationMembershipEventsByConversation]);

  const applyE2eeResult = useCallback((result, overrides = {}) => {
    setE2eeState((previousValue) => ({
      initialized: true,
      enabled: Boolean(result?.bootstrap?.enabled),
      newConversationsEnabled: Boolean(result?.bootstrap?.new_conversations_enabled),
      currentDeviceId: overrides.currentDeviceId
        ?? result?.bootstrap?.current_device_id
        ?? previousValue.currentDeviceId
        ?? null,
      hasActiveDevice: Boolean(result?.bootstrap?.has_active_device),
      devices: Array.isArray(result?.bootstrap?.devices) ? result.bootstrap.devices : [],
      localDevice: overrides.localDevice
        ?? result?.localDevice
        ?? previousValue.localDevice
        ?? null,
      localDeviceState: result?.localDeviceState
        || (
          overrides.localDevice || result?.localDevice
            ? 'registered'
            : (result?.supported === false ? 'unsupported_browser' : previousValue.localDeviceState)
        ),
      storageKind: result?.storageKind || previousValue.storageKind || cryptoClientRef.current?.storeKind || null,
      supported: result?.supported !== false,
      autoRegistered: Boolean(result?.autoRegistered),
      remainingOneTimePrekeys: Number(result?.bootstrap?.remaining_one_time_prekeys ?? 0),
      minOneTimePrekeys: Number(result?.bootstrap?.min_one_time_prekeys ?? 0),
      pendingLinkSessions: previousValue.pendingLinkSessions || [],
      error: result?.error || '',
    }));
  }, []);

  const syncPendingLinkSessions = useCallback(async () => {
    const pendingSessions = await cryptoClientRef.current.listPendingLinkSessions();
    const normalizedSessions = Array.isArray(pendingSessions)
      ? [...pendingSessions]
        .map((sessionRow) => ({
          ...sessionRow,
          expiresAtMs: timestampToMillis(sessionRow.expiresAt || sessionRow.expires_at || null),
        }))
        .sort((a, b) => (a.expiresAtMs || 0) - (b.expiresAtMs || 0))
      : [];

    setE2eeState((previousValue) => ({
      ...previousValue,
      pendingLinkSessions: normalizedSessions,
    }));
    return normalizedSessions;
  }, []);

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
    setE2eeState(createDefaultE2eeState());
    setConversationKeyPackagesByConversation({});
    setConversationMembershipEventsByConversation({});
    lastReadMessageRef.current = {};
    refreshSequenceRef.current = 0;
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
        unread = messages.filter((msg) => !msg.isHistoricalSync && msg.senderUserId !== currentChatUserId).length;
      } else {
        const lastReadIndex = messages.findIndex((msg) => msg.messageId === ownReadMessageId);
        unread = messages
          .slice(lastReadIndex >= 0 ? lastReadIndex + 1 : 0)
          .filter((msg) => !msg.isHistoricalSync && msg.senderUserId !== currentChatUserId)
          .length;
      }

      counts[conversationId] = unread;
      total += unread;
    });

    return { counts, total };
  }, []);

  const refreshFromCache = useCallback(async (conn) => {
    if (!conn) return;
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;

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

    const nextConversationKeyPackages = conn.db.my_conversation_key_packages
      ? Array.from(conn.db.my_conversation_key_packages.iter()).map(normalizeConversationKeyPackage)
      : [];
    const nextConversationMembershipEventsByConversation = {};
    if (conn.db.my_conversation_membership_events) {
      Array.from(conn.db.my_conversation_membership_events.iter())
        .map(normalizeConversationMembershipEvent)
        .forEach((eventRow) => {
          if (!nextConversationMembershipEventsByConversation[eventRow.conversationId]) {
            nextConversationMembershipEventsByConversation[eventRow.conversationId] = [];
          }
          nextConversationMembershipEventsByConversation[eventRow.conversationId].push(eventRow);
        });
      Object.values(nextConversationMembershipEventsByConversation).forEach((rows) => {
        rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
      });
    }

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

    let nextResolvedMessagesByConversation = nextMessagesByConversation;
    let nextConversationKeyPackagesByConversation = {};

    try {
      if (nextConversationKeyPackages.length > 0) {
        nextConversationKeyPackagesByConversation = await cryptoClientRef.current.ingestConversationKeyPackages({
          packageRows: nextConversationKeyPackages,
          currentDeviceId: e2eeStateRef.current.currentDeviceId,
        });
      }
      await cryptoClientRef.current.ensureGroupConversationState({
        conn,
        conversations: nextConversations,
        currentUserId: chatUserIdRef.current,
        currentDeviceId: e2eeStateRef.current.currentDeviceId,
        membershipEventsByConversation: nextConversationMembershipEventsByConversation,
      });
      nextResolvedMessagesByConversation = await cryptoClientRef.current.resolveMessages({
        conversations: nextConversations,
        messagesByConversation: nextMessagesByConversation,
        currentDeviceId: e2eeStateRef.current.currentDeviceId,
      });
    } catch (cryptoError) {
      setE2eeState((previousValue) => ({
        ...previousValue,
        error: cryptoError.message || 'Failed to resolve encrypted chat state.',
      }));
    }

    if (refreshSequence !== refreshSequenceRef.current) {
      return;
    }

    setConversations(nextConversations);
    setMessagesByConversation(nextResolvedMessagesByConversation);
    setTypingByConversation(nextTypingByConversation);
    setReadStateByConversation(nextReadByConversation);
    setPresenceByUserId(nextPresenceByUserId);
    setConversationKeyPackagesByConversation(nextConversationKeyPackagesByConversation);
    setConversationMembershipEventsByConversation(nextConversationMembershipEventsByConversation);

    const currentChatUserId = chatUserIdRef.current;
    if (currentChatUserId != null) {
      const { counts, total } = computeUnread(
        nextResolvedMessagesByConversation,
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
        const payload = await parseResponsePayload(response);
        throw new Error(payload.message || 'Failed to load chat friends.');
      }
      const payload = await parseResponsePayload(response);
      setFriends(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err.message || 'Failed to load chat friends.');
      setFriends([]);
    }
  }, []);

  const attachListeners = useCallback((conn) => {
    const cleanupFns = [];
    const tableNames = [
      'my_conversations',
      'my_conversation_key_packages',
      'my_conversation_membership_events',
      'my_messages',
      'my_typing',
      'my_read_state',
      'my_presence',
    ];

    const callback = () => {
      refreshFromCache(conn).catch(() => {
        // E2EE resolution errors are surfaced through context state.
      });
    };

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

      const cryptoBootstrapResult = await cryptoClientRef.current.initialize();
      applyE2eeResult(cryptoBootstrapResult);
      await syncPendingLinkSessions();

      const preferredDeviceId = cryptoBootstrapResult?.localDevice?.deviceId
        || cryptoBootstrapResult?.bootstrap?.current_device_id
        || null;
      const bootstrapUrl = preferredDeviceId
        ? `/api/v1/chat/bootstrap?preferred_device_id=${encodeURIComponent(preferredDeviceId)}`
        : '/api/v1/chat/bootstrap';

      const bootstrapResponse = await fetch(bootstrapUrl, {
        credentials: 'include',
      });
      if (!bootstrapResponse.ok) {
        const payload = await parseResponsePayload(bootstrapResponse);
        throw new Error(payload.message || 'Failed to bootstrap chat connection.');
      }

      const bootstrap = await parseResponsePayload(bootstrapResponse);
      if (!bootstrap?.ws_url || !bootstrap?.db_name || !bootstrap?.websocket_token) {
        throw new Error('Chat bootstrap response is missing required fields.');
      }

      const nextChatUserId = Number(bootstrap.user_id);
      chatUserIdRef.current = nextChatUserId;
      setChatUserId(nextChatUserId);
      applyE2eeResult(cryptoBootstrapResult, {
        currentDeviceId: bootstrap.device_id || cryptoBootstrapResult?.bootstrap?.current_device_id || null,
      });

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
              refreshFromCache(connectedConn)
                .catch(() => {
                  // E2EE resolution errors are surfaced through context state.
                })
                .finally(() => {
                  setLoading(false);
                });
            })
            .onError((_ctx, subscriptionError) => {
              setError(subscriptionError?.message || 'Chat subscription failed.');
            })
            .subscribe([
              tables.my_conversations,
              tables.my_conversation_key_packages,
              tables.my_conversation_membership_events,
              tables.my_messages,
              tables.my_typing,
              tables.my_read_state,
              tables.my_presence,
            ].filter(Boolean));

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
  }, [applyE2eeResult, attachListeners, cleanupConnection, currentUser, fetchFriends, refreshFromCache, syncPendingLinkSessions]);

  const disconnect = useCallback(() => {
    cleanupConnection();
    resetState();
  }, [cleanupConnection, resetState]);

  const createDm = useCallback(async (userId) => {
    const shouldAttemptEncryptedDm = Boolean(
      e2eeState.enabled
      && e2eeState.newConversationsEnabled
      && e2eeState.currentDeviceId
      && e2eeState.localDevice
      && e2eeState.supported
    );
    let encryptionMode = LEGACY_ENCRYPTION_MODE;
    if (shouldAttemptEncryptedDm) {
      try {
        const remoteBundles = await cryptoClientRef.current.fetchUserDeviceBundles(Number(userId), {
          claimPrekeys: false,
        });
        if (Array.isArray(remoteBundles.devices) && remoteBundles.devices.length > 0) {
          encryptionMode = E2EE_ENCRYPTION_MODE;
        }
      } catch (_error) {
        encryptionMode = LEGACY_ENCRYPTION_MODE;
      }
    }

    const response = await fetch('/api/v1/chat/dm', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: Number(userId),
        encryption_mode: encryptionMode,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || 'Failed to create direct message conversation.');
    }
    if (payload.conversation_id) {
      setActiveConversationId(payload.conversation_id);
    }
    return payload;
  }, [e2eeState.currentDeviceId, e2eeState.enabled, e2eeState.localDevice, e2eeState.newConversationsEnabled, e2eeState.supported]);

  const createGroup = useCallback(async (title, memberUserIds) => {
    const shouldAttemptEncryptedGroup = Boolean(
      e2eeState.enabled
      && e2eeState.newConversationsEnabled
      && e2eeState.currentDeviceId
      && e2eeState.localDevice
      && e2eeState.supported
    );
    let encryptionMode = LEGACY_ENCRYPTION_MODE;

    if (shouldAttemptEncryptedGroup) {
      try {
        const bundleResults = await Promise.all(
          memberUserIds.map((userId) => cryptoClientRef.current.fetchUserDeviceBundles(Number(userId), {
            claimPrekeys: false,
          }))
        );
        if (bundleResults.every((result) => Array.isArray(result.devices) && result.devices.length > 0)) {
          encryptionMode = E2EE_ENCRYPTION_MODE;
        }
      } catch (_error) {
        encryptionMode = LEGACY_ENCRYPTION_MODE;
      }
    }

    const response = await fetch('/api/v1/chat/groups', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        member_user_ids: memberUserIds.map((value) => Number(value)),
        encryption_mode: encryptionMode,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || 'Failed to create group conversation.');
    }
    if (payload.conversation_id) {
      setActiveConversationId(payload.conversation_id);
    }
    if (
      encryptionMode === E2EE_ENCRYPTION_MODE
      && connectionRef.current
      && e2eeStateRef.current.currentDeviceId
      && chatUserIdRef.current != null
      && payload.conversation_id
    ) {
      await cryptoClientRef.current.ensureGroupConversationState({
        conn: connectionRef.current,
        conversations: [
          {
            conversationId: payload.conversation_id,
            kind: 'group',
            title,
            createdByUserId: chatUserIdRef.current,
            encryptionMode,
            currentEpoch: 1,
          },
        ],
        currentUserId: chatUserIdRef.current,
        currentDeviceId: e2eeStateRef.current.currentDeviceId,
        membershipEventsByConversation: {},
      });
    }
    return payload;
  }, [e2eeState.currentDeviceId, e2eeState.enabled, e2eeState.localDevice, e2eeState.newConversationsEnabled, e2eeState.supported]);

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

  const refreshE2eeState = useCallback(async (overrides = {}) => {
    const result = await cryptoClientRef.current.refreshBootstrap();
    applyE2eeResult(result, overrides);
    await syncPendingLinkSessions();
    if (connectionRef.current) {
      refreshFromCache(connectionRef.current).catch(() => {
        // E2EE resolution errors are surfaced through context state.
      });
    }
    return result;
  }, [applyE2eeResult, refreshFromCache, syncPendingLinkSessions]);

  const registerDevice = useCallback(async (options = {}) => {
    const result = await cryptoClientRef.current.registerFirstDevice(e2eeStateRef.current.bootstrap, options);
    await refreshE2eeState({
      currentDeviceId: result.localRecord.deviceId,
      localDevice: result.localRecord,
    });
    return result;
  }, [refreshE2eeState]);

  const rotateSignedPrekey = useCallback(async () => {

    const localDevice = e2eeStateRef.current.localDevice;
    if (!localDevice) {
      throw new Error('No local chat device is available for signed-prekey rotation.');
    }
    const nextLocalDevice = await cryptoClientRef.current.rotateSignedPrekey(localDevice);
    await refreshE2eeState({
      currentDeviceId: nextLocalDevice.deviceId,
      localDevice: nextLocalDevice,
    });
    return nextLocalDevice;
  }, [refreshE2eeState]);

  const replenishOneTimePrekeys = useCallback(async (targetCount) => {
    const localDevice = e2eeStateRef.current.localDevice;
    if (!localDevice) {
      throw new Error('No local chat device is available for one-time prekey replenishment.');
    }
    const nextLocalDevice = await cryptoClientRef.current.replenishOneTimePrekeys(localDevice, targetCount);
    await refreshE2eeState({
      currentDeviceId: nextLocalDevice.deviceId,
      localDevice: nextLocalDevice,
    });
    return nextLocalDevice;
  }, [refreshE2eeState]);

  const revokeDevice = useCallback(async (deviceId) => {
    const revokedDevice = await cryptoClientRef.current.revokeDevice(deviceId);
    await refreshE2eeState({
      currentDeviceId: deviceId === e2eeStateRef.current.currentDeviceId ? null : e2eeStateRef.current.currentDeviceId,
      localDevice: deviceId === e2eeStateRef.current.currentDeviceId ? null : e2eeStateRef.current.localDevice,
    });
    return revokedDevice;
  }, [refreshE2eeState]);

  const startDeviceLink = useCallback(async (options) => {
    const result = await cryptoClientRef.current.startCandidateLink(options);
    await syncPendingLinkSessions();
    return result;
  }, [syncPendingLinkSessions]);

  const approveDeviceLink = useCallback(async ({ linkSessionId, approvalCode, approverDeviceId } = {}) => {
    const result = await cryptoClientRef.current.approveCandidateLink({
      linkSessionId,
      approvalCode,
      approverDeviceId: approverDeviceId || e2eeStateRef.current.currentDeviceId,
      conversations,
      messagesByConversation,
    });
    await refreshE2eeState();
    return result;
  }, [conversations, messagesByConversation, refreshE2eeState]);

  const completeDeviceLink = useCallback(async (linkSessionId) => {
    const result = await cryptoClientRef.current.completeCandidateLink(linkSessionId);
    if (result?.status === 'active') {
      await refreshE2eeState({
        currentDeviceId: result.current_device_id || null,
      });
    } else {
      await syncPendingLinkSessions();
    }
    return result;
  }, [refreshE2eeState, syncPendingLinkSessions]);

  const sendMessage = useCallback(async (conversationId, plaintext) => {
    const conn = connectionRef.current;
    if (!conn) {
      throw new Error('Chat connection is not active.');
    }
    const conversation = conversations.find((row) => row.conversationId === conversationId) || null;
    await cryptoClientRef.current.sendMessage({
      conn,
      conversation,
      plaintext,
      currentUserId: chatUserIdRef.current,
      currentDeviceId: e2eeStateRef.current.currentDeviceId,
      membershipEvents: conversationMembershipEventsRef.current[conversationId] || [],
    });
  }, [conversations]);

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
    fetchFriends().catch(() => {
      // Friend list errors are already surfaced through context state.
    });
  }, [currentUser, fetchFriends]);

  useEffect(() => {
    if (!currentUser) return;
    ensureConnected().catch(() => {
      // Connection errors are surfaced through context state.
    });
  }, [currentUser, ensureConnected]);

  useEffect(() => {
    if (!connectionRef.current) return;
    refreshFromCache(connectionRef.current).catch(() => {
      // E2EE resolution errors are surfaced through context state.
    });
  }, [e2eeState.currentDeviceId, refreshFromCache]);

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
    e2ee: {
      ...e2eeState,
      conversationKeyPackagesByConversation,
      conversationMembershipEventsByConversation,
    },
    ensureConnected,
    disconnect,
    refreshFromCache: () => refreshFromCache(connectionRef.current),
    refreshE2eeState,
    registerDevice,
    createDm,
    createGroup,
    addGroupMember,
    sendMessage,
    setTyping,
    markRead,
    rotateSignedPrekey,
    replenishOneTimePrekeys,
    revokeDevice,
    startDeviceLink,
    approveDeviceLink,
    completeDeviceLink,
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
    e2eeState,
    conversationKeyPackagesByConversation,
    conversationMembershipEventsByConversation,
    ensureConnected,
    disconnect,
    refreshFromCache,
    refreshE2eeState,
    registerDevice,
    createDm,
    createGroup,
    addGroupMember,
    sendMessage,
    setTyping,
    markRead,
    rotateSignedPrekey,
    replenishOneTimePrekeys,
    revokeDevice,
    startDeviceLink,
    approveDeviceLink,
    completeDeviceLink,
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
