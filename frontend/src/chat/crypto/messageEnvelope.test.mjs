import test from 'node:test';
import assert from 'node:assert/strict';

import {
  E2EE_ENCRYPTION_MODE,
  E2EE_PROTOCOL_VERSION,
  MESSAGE_STATE_DECRYPTED,
  MESSAGE_STATE_PENDING_KEYS,
  bytesToBase64,
  base64ToBytes,
  resolveDisplayState,
  utf8ToBytes,
} from './messageEnvelope.js';

test('base64 helpers round-trip UTF-8 payloads', () => {
  const encoded = bytesToBase64(utf8ToBytes('hello encrypted world'));
  const decoded = new TextDecoder().decode(base64ToBytes(encoded));
  assert.equal(decoded, 'hello encrypted world');
});

test('resolveDisplayState returns placeholders for encrypted payloads without keys', () => {
  const display = resolveDisplayState({
    conversation: {
      encryptionMode: E2EE_ENCRYPTION_MODE,
    },
    message: {
      protocolVersion: E2EE_PROTOCOL_VERSION,
      ciphertext: 'opaque',
    },
  });

  assert.equal(display.messageState, MESSAGE_STATE_PENDING_KEYS);
  assert.match(display.displayText, /Encrypted message/);
});

test('resolveDisplayState prefers decrypted plaintext when available', () => {
  const display = resolveDisplayState({
    conversation: {
      encryptionMode: E2EE_ENCRYPTION_MODE,
    },
    message: {
      protocolVersion: E2EE_PROTOCOL_VERSION,
      ciphertext: 'opaque',
    },
    decryptedText: 'hello from bob',
  });

  assert.equal(display.messageState, MESSAGE_STATE_DECRYPTED);
  assert.equal(display.displayText, 'hello from bob');
});
