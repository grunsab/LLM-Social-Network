import {
  E2EE_ENCRYPTION_MODE,
  MESSAGE_STATE_DECRYPTED,
} from './messageEnvelope.js';

const LINKED_DEVICE_HISTORY_VERSION = 'linked_device_history_v1';
const LINKED_DEVICE_HISTORY_SALT = 'llm-social-network:linked-device-history:v1';

const buildHistoryInfo = ({ senderDeviceId, recipientDeviceId }) => ({
  protocol: LINKED_DEVICE_HISTORY_SALT,
  sender_device_id: senderDeviceId,
  recipient_device_id: recipientDeviceId,
});

const buildHistoryAdditionalData = ({ prekeyService, senderDeviceId, recipientDeviceId }) => (
  prekeyService.encodeText(JSON.stringify({
    version: LINKED_DEVICE_HISTORY_VERSION,
    sender_device_id: senderDeviceId,
    recipient_device_id: recipientDeviceId,
  }))
);

const parseEnvelope = (value) => {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const toHistoryRecord = ({ currentDeviceId, message }) => ({
  historyEntryId: `${currentDeviceId}:${message.conversationId}:${message.messageId}`,
  deviceId: currentDeviceId,
  conversationId: message.conversationId,
  messageId: message.messageId,
  senderUserId: Number(message.senderUserId),
  senderDeviceId: message.senderDeviceId || null,
  conversationEpoch: Number(message.conversationEpoch ?? 0),
  bodyText: message.bodyText,
  createdAtMs: Number(message.createdAtMs ?? 0),
  createdAtIso: message.createdAtIso || null,
  importedAt: new Date().toISOString(),
});

const toTimelineMessage = (record) => ({
  payloadId: record.historyEntryId,
  messageId: record.messageId,
  conversationId: record.conversationId,
  senderUserId: Number(record.senderUserId),
  senderDeviceId: record.senderDeviceId || null,
  protocolVersion: LINKED_DEVICE_HISTORY_VERSION,
  messageType: 'chat',
  conversationEpoch: Number(record.conversationEpoch ?? 0),
  deliveryScope: 'history_backfill',
  recipientUserId: null,
  recipientDeviceId: record.deviceId,
  nonce: '',
  aad: '',
  wireCiphertext: record.bodyText,
  ciphertext: record.bodyText,
  bodyText: record.bodyText,
  messageState: MESSAGE_STATE_DECRYPTED,
  createdAtMs: Number(record.createdAtMs ?? 0),
  createdAtIso: record.createdAtIso || null,
  isHistoricalSync: true,
});

const buildSnapshotMessages = ({ conversations, messagesByConversation }) => {
  const encryptedConversationIds = new Set(
    (Array.isArray(conversations) ? conversations : [])
      .filter((conversation) => conversation?.encryptionMode === E2EE_ENCRYPTION_MODE)
      .map((conversation) => conversation.conversationId)
  );

  const snapshotMessages = [];
  encryptedConversationIds.forEach((conversationId) => {
    const messages = Array.isArray(messagesByConversation?.[conversationId])
      ? messagesByConversation[conversationId]
      : [];

    messages.forEach((message) => {
      if (
        message?.isHistoricalSync
        || message?.messageState !== MESSAGE_STATE_DECRYPTED
        || typeof message?.bodyText !== 'string'
        || message.bodyText.length === 0
      ) {
        return;
      }

      snapshotMessages.push({
        conversationId,
        messageId: message.messageId,
        senderUserId: Number(message.senderUserId),
        senderDeviceId: message.senderDeviceId || null,
        conversationEpoch: Number(message.conversationEpoch ?? 0),
        bodyText: message.bodyText,
        createdAtMs: Number(message.createdAtMs ?? 0),
        createdAtIso: message.createdAtIso || null,
      });
    });
  });

  snapshotMessages.sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) {
      return left.createdAtMs - right.createdAtMs;
    }
    return String(left.messageId).localeCompare(String(right.messageId));
  });

  return snapshotMessages;
};

export const createLinkedDeviceHistoryService = ({
  prekeyService,
  store,
} = {}) => {
  const encryptHistorySnapshot = async ({
    localDevice,
    targetDevice,
    conversations,
    messagesByConversation,
  }) => {
    const snapshotMessages = buildSnapshotMessages({
      conversations,
      messagesByConversation,
    });
    if (!localDevice?.deviceId || !targetDevice?.deviceId || snapshotMessages.length === 0) {
      return null;
    }

    const sharedSecrets = [
      await prekeyService.deriveAgreementBytes({
        localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
        suiteId: localDevice.cryptoProfile.agreementSuite,
        remotePublicKey: targetDevice.identityKeyPublic,
      }),
      await prekeyService.deriveAgreementBytes({
        localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
        suiteId: localDevice.cryptoProfile.agreementSuite,
        remotePublicKey: targetDevice.signedPrekeyPublic,
      }),
    ];

    const keyMaterial = await prekeyService.deriveSessionKey({
      sharedSecrets,
      salt: LINKED_DEVICE_HISTORY_SALT,
      info: buildHistoryInfo({
        senderDeviceId: localDevice.deviceId,
        recipientDeviceId: targetDevice.deviceId,
      }),
    });

    const aad = buildHistoryAdditionalData({
      prekeyService,
      senderDeviceId: localDevice.deviceId,
      recipientDeviceId: targetDevice.deviceId,
    });
    const encryptedPayload = await prekeyService.encryptText({
      keyMaterial,
      plaintext: JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        messages: snapshotMessages,
      }),
      aad,
    });

    return JSON.stringify({
      version: LINKED_DEVICE_HISTORY_VERSION,
      nonce: encryptedPayload.nonce,
      aad,
      ciphertext: encryptedPayload.ciphertext,
      senderDeviceId: localDevice.deviceId,
      senderIdentityKey: localDevice.identityKey.publicKey,
      senderAgreementSuite: localDevice.cryptoProfile.agreementSuite,
      recipientSignedPrekeyId: Number(targetDevice.signedPrekeyId ?? 0),
    });
  };

  const importEncryptedHistorySnapshot = async ({
    currentDeviceId,
    localDevice,
    encryptedEnvelope,
  }) => {
    if (!currentDeviceId || !localDevice || !encryptedEnvelope) {
      return [];
    }

    const envelope = parseEnvelope(encryptedEnvelope);
    if (!envelope?.ciphertext || !envelope?.senderIdentityKey) {
      throw new Error('Linked-device history snapshot is malformed.');
    }
    if (
      envelope.recipientSignedPrekeyId != null
      && Number(envelope.recipientSignedPrekeyId) !== Number(localDevice.signedPrekey.keyId)
    ) {
      throw new Error('Linked-device history snapshot targets an unknown signed prekey.');
    }

    const sharedSecrets = [
      await prekeyService.deriveAgreementBytes({
        localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
        suiteId: localDevice.cryptoProfile.agreementSuite,
        remotePublicKey: envelope.senderIdentityKey,
      }),
      await prekeyService.deriveAgreementBytes({
        localPrivateKeyJwk: localDevice.signedPrekey.privateKeyJwk,
        suiteId: localDevice.cryptoProfile.agreementSuite,
        remotePublicKey: envelope.senderIdentityKey,
      }),
    ];

    const keyMaterial = await prekeyService.deriveSessionKey({
      sharedSecrets,
      salt: LINKED_DEVICE_HISTORY_SALT,
      info: buildHistoryInfo({
        senderDeviceId: envelope.senderDeviceId,
        recipientDeviceId: currentDeviceId,
      }),
    });

    const decryptedPayload = await prekeyService.decryptText({
      keyMaterial,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      aad: envelope.aad || '',
    });

    const snapshot = JSON.parse(decryptedPayload);
    const importedMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];

    await store.clearImportedHistory(currentDeviceId);
    await Promise.all(
      importedMessages.map((message) => store.putImportedHistory(toHistoryRecord({
        currentDeviceId,
        message,
      })))
    );

    return importedMessages;
  };

  const listImportedHistory = async (currentDeviceId) => {
    if (!currentDeviceId) {
      return [];
    }

    const rows = await store.listImportedHistory(currentDeviceId);
    return rows
      .map(toTimelineMessage)
      .sort((left, right) => {
        if (left.createdAtMs !== right.createdAtMs) {
          return left.createdAtMs - right.createdAtMs;
        }
        return String(left.messageId).localeCompare(String(right.messageId));
      });
  };

  return {
    encryptHistorySnapshot,
    importEncryptedHistorySnapshot,
    listImportedHistory,
  };
};
