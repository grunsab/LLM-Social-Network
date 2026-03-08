export const LEGACY_ENCRYPTION_MODE = 'legacy';
export const E2EE_ENCRYPTION_MODE = 'e2ee_v1';
export const LEGACY_PROTOCOL_VERSION = 'legacy_v1';
export const LEGACY_PLAINTEXT_PROTOCOL_VERSION = 'legacy_plaintext';
export const E2EE_PROTOCOL_VERSION = 'e2ee_v1';

export const MESSAGE_STATE_LEGACY = 'legacy';
export const MESSAGE_STATE_DECRYPTED = 'decrypted';
export const MESSAGE_STATE_PENDING_KEYS = 'pending_keys';
export const MESSAGE_STATE_FAILED_TO_DECRYPT = 'failed_to_decrypt';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBuffer = (value, encoding) => {
  if (typeof Buffer === 'function') {
    return Buffer.from(value, encoding);
  }
  return null;
};

export const utf8ToBytes = (value) => textEncoder.encode(String(value ?? ''));

export const bytesToUtf8 = (value) => textDecoder.decode(value);

export const bytesToBase64 = (value) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const buffer = toBuffer(bytes);
  if (buffer) {
    return buffer.toString('base64');
  }

  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

export const base64ToBytes = (value) => {
  if (!value) {
    return new Uint8Array();
  }

  const buffer = toBuffer(value, 'base64');
  if (buffer) {
    return new Uint8Array(buffer);
  }

  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
};

export const getConversationEncryptionMode = (conversation) => (
  conversation?.encryptionMode || LEGACY_ENCRYPTION_MODE
);

export const isLegacyProtocolVersion = (protocolVersion) => {
  if (!protocolVersion) return true;
  return protocolVersion === LEGACY_PROTOCOL_VERSION || protocolVersion === LEGACY_PLAINTEXT_PROTOCOL_VERSION;
};

export const isEncryptedProtocolVersion = (protocolVersion) => protocolVersion === E2EE_PROTOCOL_VERSION;

export const isEncryptedConversation = (conversation) => (
  getConversationEncryptionMode(conversation) === E2EE_ENCRYPTION_MODE
);

export const buildAssociatedData = (metadata) => bytesToBase64(utf8ToBytes(JSON.stringify({
  conversation_id: metadata.conversationId,
  message_id: metadata.messageId,
  sender_user_id: metadata.senderUserId,
  sender_device_id: metadata.senderDeviceId,
  recipient_user_id: metadata.recipientUserId,
  recipient_device_id: metadata.recipientDeviceId,
  conversation_epoch: metadata.conversationEpoch,
  protocol_version: metadata.protocolVersion,
  session_type: metadata.sessionType,
})));

export const serializeEnvelope = (payload) => {
  const {
    version,
    algorithm,
    nonce,
    aad,
    ciphertext,
    ...extraFields
  } = payload;

  return JSON.stringify({
    version: version || E2EE_PROTOCOL_VERSION,
    algorithm: algorithm || 'AES-GCM',
    nonce,
    aad,
    ciphertext,
    ...extraFields,
  });
};

export const parseEnvelope = (value) => {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
};

export const encryptedPlaceholderForState = (messageState) => {
  if (messageState === MESSAGE_STATE_FAILED_TO_DECRYPT) {
    return 'Encrypted message could not be decrypted';
  }
  return 'Encrypted message: keys unavailable';
};

export const resolveDisplayState = ({ conversation, message, decryptedText, failureReason }) => {
  if (!isEncryptedConversation(conversation) || isLegacyProtocolVersion(message.protocolVersion)) {
    return {
      messageState: MESSAGE_STATE_LEGACY,
      displayText: message.wireCiphertext ?? message.ciphertext ?? '',
    };
  }

  if (typeof decryptedText === 'string' && decryptedText.length > 0) {
    return {
      messageState: MESSAGE_STATE_DECRYPTED,
      displayText: decryptedText,
    };
  }

  const terminalFailure = failureReason === 'failed_to_decrypt';
  return {
    messageState: terminalFailure ? MESSAGE_STATE_FAILED_TO_DECRYPT : MESSAGE_STATE_PENDING_KEYS,
    displayText: encryptedPlaceholderForState(
      terminalFailure ? MESSAGE_STATE_FAILED_TO_DECRYPT : MESSAGE_STATE_PENDING_KEYS
    ),
  };
};
