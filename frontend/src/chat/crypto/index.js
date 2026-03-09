import { createDecryptionQueue } from './decryptionQueue.js';
import { createDirectMessageService } from './directMessageService.js';
import { createDeviceLinkManager } from './deviceLinkManager.js';
import { createDeviceManager } from './deviceManager.js';
import { createGroupKeyManager } from './groupKeyManager.js';
import { createGroupMessageService } from './groupMessageService.js';
import { createIndexedDbStore } from './indexedDbStore.js';
import {
  E2EE_ENCRYPTION_MODE,
  MESSAGE_STATE_PENDING_KEYS,
  resolveDisplayState,
} from './messageEnvelope.js';
import { createPrekeyService } from './prekeyService.js';
import { createSessionManager } from './sessionManager.js';

const groupMessagesByConversation = (messageRows) => {
  const out = {};
  messageRows.forEach((message) => {
    if (!out[message.conversationId]) {
      out[message.conversationId] = [];
    }
    out[message.conversationId].push(message);
  });
  return out;
};

export const createChatCryptoClient = ({
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  store: providedStore,
} = {}) => {
  const store = providedStore || createIndexedDbStore();
  const sessionManager = createSessionManager({ store });
  const groupKeyManager = createGroupKeyManager({ store });
  const decryptionQueue = createDecryptionQueue();
  let prekeyService = null;
  let deviceManager = null;
  let deviceLinkManager = null;
  let directMessageService = null;
  let groupMessageService = null;

  const getPrekeyService = () => {
    if (!prekeyService) {
      prekeyService = createPrekeyService({ cryptoImpl });
    }
    return prekeyService;
  };

  const getDeviceManager = () => {
    if (!deviceManager) {
      deviceManager = createDeviceManager({
        fetchImpl,
        store,
        prekeyService: getPrekeyService(),
      });
    }
    return deviceManager;
  };

  const getDeviceLinkManager = () => {
    if (!deviceLinkManager) {
      deviceLinkManager = createDeviceLinkManager({
        fetchImpl,
        store,
        prekeyService: getPrekeyService(),
        resolvePreferredDeviceId: () => getDeviceManager().resolvePreferredDeviceId(),
      });
    }
    return deviceLinkManager;
  };
  const getDirectMessageService = () => {
    if (!directMessageService) {
      directMessageService = createDirectMessageService({
        deviceManager: {
          getLocalDevice: (...args) => getDeviceManager().getLocalDevice(...args),
          fetchUserDeviceBundles: (...args) => getDeviceManager().fetchUserDeviceBundles(...args),
          fetchConversationDeviceBundles: (...args) => getDeviceManager().fetchConversationDeviceBundles(...args),
        },
        sessionManager,
        prekeyService: getPrekeyService(),
      });
    }
    return directMessageService;
  };

  const getGroupMessageService = () => {
    if (!groupMessageService) {
      groupMessageService = createGroupMessageService({
        deviceManager: {
          getLocalDevice: (...args) => getDeviceManager().getLocalDevice(...args),
          fetchUserDeviceBundles: (...args) => getDeviceManager().fetchUserDeviceBundles(...args),
          fetchConversationDeviceBundles: (...args) => getDeviceManager().fetchConversationDeviceBundles(...args),
        },
        sessionManager,
        groupKeyManager,
        prekeyService: getPrekeyService(),
        store,
      });
    }
    return groupMessageService;
  };

  const initialize = async () => {
    try {
      const result = await getDeviceManager().ensureCurrentDevice();
      return {
        ...result,
        supported: true,
      };
    } catch (error) {
      return {
        bootstrap: {
          enabled: true,
          new_conversations_enabled: false,
          current_device_id: null,
          has_active_device: false,
          devices: [],
          remaining_one_time_prekeys: 0,
          min_one_time_prekeys: 0,
        },
        localDevice: null,
        localDeviceState: 'unsupported_browser',
        storageKind: store.kind,
        autoRegistered: false,
        supported: false,
        error: error.message || 'E2EE bootstrap is unavailable in this browser.',
      };
    }
  };

  const refreshBootstrap = async () => {
    try {
      const bootstrap = await getDeviceManager().loadBootstrap();
      const localDevice = bootstrap.current_device_id
        ? await getDeviceManager().getLocalDevice(bootstrap.current_device_id)
        : null;
      return {
        bootstrap,
        localDevice,
        supported: true,
      };
    } catch (error) {
      return {
        bootstrap: {
          enabled: false,
          new_conversations_enabled: false,
          current_device_id: null,
          has_active_device: false,
          devices: [],
          remaining_one_time_prekeys: 0,
          min_one_time_prekeys: 0,
        },
        localDevice: null,
        supported: false,
        error: error.message || 'Failed to refresh end-to-end encryption state.',
      };
    }
  };

  const ingestConversationKeyPackages = async ({ packageRows, currentDeviceId }) => {
    await groupKeyManager.ingestServerPackages(packageRows);
    await getGroupMessageService().decryptPendingPackages({ currentDeviceId });
    return groupMessagesByConversation(packageRows);
  };

  const ensureGroupConversationState = async ({
    conn,
    conversations,
    currentUserId,
    currentDeviceId,
    membershipEventsByConversation = {},
  }) => {
    for (const conversation of conversations) {
      if (conversation.encryptionMode !== E2EE_ENCRYPTION_MODE || conversation.kind !== 'group') {
        continue;
      }

      await getGroupMessageService().ensureCurrentEpochKey({
        conn,
        conversation,
        currentUserId,
        currentDeviceId,
        membershipEvents: membershipEventsByConversation[conversation.conversationId] || [],
      });
    }
  };

  const resolveMessage = async ({ conversation, message, currentDeviceId }) => {
    if (conversation?.encryptionMode !== E2EE_ENCRYPTION_MODE) {
      const display = resolveDisplayState({ conversation, message });
      return {
        ...message,
        ciphertext: display.displayText,
        bodyText: display.displayText,
        messageState: display.messageState,
      };
    }

    if (!currentDeviceId) {
      const display = resolveDisplayState({
        conversation,
        message,
        failureReason: MESSAGE_STATE_PENDING_KEYS,
      });
      return {
        ...message,
        ciphertext: display.displayText,
        bodyText: display.displayText,
        messageState: display.messageState,
      };
    }

    const localDevice = await getDeviceManager().getLocalDevice(currentDeviceId);
    if (!localDevice) {
      const display = resolveDisplayState({
        conversation,
        message,
        failureReason: 'missing_local_keys',
      });
      return {
        ...message,
        ciphertext: display.displayText,
        bodyText: display.displayText,
        messageState: display.messageState,
      };
    }

    if (conversation.kind === 'group') {
      return getGroupMessageService().decryptMessage({
        conversation,
        message,
        currentDeviceId,
      });
    }

    return getDirectMessageService().decryptMessage({
      conversation,
      message,
      currentDeviceId,
    });
  };

  const resolveMessages = async ({ conversations, messagesByConversation, currentDeviceId }) => {
    const conversationById = new Map(conversations.map((conversation) => [conversation.conversationId, conversation]));
    const flattenedMessages = Object.values(messagesByConversation).flat();
    const resolvedRows = await decryptionQueue.map(flattenedMessages, async (message) => resolveMessage({
      conversation: conversationById.get(message.conversationId),
      message,
      currentDeviceId,
    }));
    return groupMessagesByConversation(resolvedRows);
  };

  const toReducerU64 = (value) => {
    if (value == null) {
      return undefined;
    }
    return BigInt(value);
  };

  const sendMessage = async ({
    conn,
    conversation,
    plaintext,
    currentUserId,
    currentDeviceId,
    membershipEvents = [],
  }) => {
    if (!conn) {
      throw new Error('Chat connection is not active.');
    }
    if (!conversation) {
      throw new Error('Conversation metadata is unavailable.');
    }

    if (conversation.encryptionMode === E2EE_ENCRYPTION_MODE) {
      if (!currentUserId || !currentDeviceId) {
        throw new Error('An active local chat device is required before sending encrypted messages.');
      }

      const encryptedMessage = conversation.kind === 'group'
        ? await getGroupMessageService().encryptMessage({
          conn,
          conversation,
          plaintext,
          currentUserId,
          currentDeviceId,
          membershipEvents,
        })
        : await getDirectMessageService().encryptMessage({
          conversation,
          plaintext,
          senderUserId: currentUserId,
          currentDeviceId,
        });
      const reducerPayloads = Array.isArray(encryptedMessage.payloads)
        ? encryptedMessage.payloads.map((payload) => ({
          ...payload,
          recipientUserId: toReducerU64(payload.recipientUserId),
        }))
        : encryptedMessage.payloads;
      await conn.reducers.sendMessage({
        conversationId: conversation.conversationId,
        protocolVersion: encryptedMessage.protocolVersion,
        messageType: encryptedMessage.messageType,
        conversationEpoch: encryptedMessage.conversationEpoch,
        payloads: reducerPayloads,
      });
      return;
    }

    await conn.reducers.sendMessage({
      conversationId: conversation.conversationId,
      ciphertext: plaintext,
    });
  };

  return {
    storeKind: store.kind,
    initialize,
    refreshBootstrap,
    ingestConversationKeyPackages,
    ensureGroupConversationState,
    resolveMessages,
    sendMessage,
    fetchUserDeviceBundles: (...args) => getDeviceManager().fetchUserDeviceBundles(...args),
    rotateSignedPrekey: (...args) => getDeviceManager().rotateSignedPrekey(...args),
    replenishOneTimePrekeys: (...args) => getDeviceManager().replenishOneTimePrekeys(...args),
    revokeDevice: (...args) => getDeviceManager().revokeDevice(...args),
    startCandidateLink: (...args) => getDeviceLinkManager().startCandidateLink(...args),
    approveCandidateLink: (...args) => getDeviceLinkManager().approveCandidateLink(...args),
    completeCandidateLink: (...args) => getDeviceLinkManager().completeCandidateLink(...args),
    listPendingLinkSessions: (...args) => getDeviceLinkManager().listPendingLinkSessions(...args),
  };
};
