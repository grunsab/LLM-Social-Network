import test from 'node:test';
import assert from 'node:assert/strict';

import { createDirectMessageService } from './directMessageService.js';
import { createIndexedDbStore } from './indexedDbStore.js';
import { E2EE_PROTOCOL_VERSION } from './messageEnvelope.js';
import { createPrekeyService } from './prekeyService.js';
import { createSessionManager } from './sessionManager.js';

const prekeyService = createPrekeyService();

const createDeviceRecord = async ({ label }) => {
  const bundle = await prekeyService.generateDeviceBundle({
    label,
    oneTimePrekeyCount: 3,
  });
  return bundle.privateRecord;
};

const createBundleDescriptor = (deviceRecord, userId, includeOneTimePrekey = false) => ({
  userId,
  deviceId: deviceRecord.deviceId,
  identityKeyPublic: deviceRecord.identityKey.publicKey,
  signedPrekeyId: deviceRecord.signedPrekey.keyId,
  signedPrekeyPublic: deviceRecord.signedPrekey.publicKey,
  oneTimePrekey: includeOneTimePrekey && deviceRecord.oneTimePrekeys[0]
    ? {
      prekeyId: deviceRecord.oneTimePrekeys[0].prekeyId,
      publicKey: deviceRecord.oneTimePrekeys[0].publicKey,
    }
    : null,
});

const cloneBundleDescriptor = (device, includeOneTimePrekey) => ({
  ...device,
  oneTimePrekey: includeOneTimePrekey ? device.oneTimePrekey : null,
});

const createService = async ({ localDeviceRecord, bundleRoster }) => {
  const store = createIndexedDbStore();
  await store.putDevice(localDeviceRecord);

  const sessionManager = createSessionManager({ store });
  const service = createDirectMessageService({
    deviceManager: {
      getLocalDevice: async (deviceId) => store.getDevice(deviceId),
      fetchConversationDeviceBundles: async (_conversationId, options = {}) => ({
        conversationId: bundleRoster.conversationId,
        members: bundleRoster.members.map((member) => ({
          userId: member.userId,
          devices: (member.devices || []).map((device) => cloneBundleDescriptor(
            device,
            Boolean(options.claimPrekeys)
          )),
        })),
      }),
      fetchUserDeviceBundles: async (userId, options = {}) => {
        const member = bundleRoster.members.find((entry) => Number(entry.userId) === Number(userId));
        return {
          userId: Number(userId),
          devices: (member?.devices || []).map((device) => cloneBundleDescriptor(
            device,
            Boolean(options.claimPrekeys)
          )),
        };
      },
    },
    sessionManager,
    prekeyService,
  });

  return {
    store,
    sessionManager,
    service,
  };
};

const createMessageRow = ({ payload, senderUserId, senderDeviceId }) => ({
  payloadId: `payload:${payload.recipientDeviceId}`,
  messageId: `message:${payload.recipientDeviceId}`,
  conversationId: 'dm:1:2',
  senderUserId,
  senderDeviceId,
  protocolVersion: E2EE_PROTOCOL_VERSION,
  messageType: 'chat',
  conversationEpoch: 1,
  deliveryScope: 'device',
  recipientUserId: payload.recipientUserId,
  recipientDeviceId: payload.recipientDeviceId,
  ciphertext: payload.ciphertext,
  wireCiphertext: payload.ciphertext,
  nonce: payload.nonce,
  aad: payload.aad,
  createdAtMs: Date.now(),
  createdAtIso: new Date().toISOString(),
});

test('encrypted DM fanout decrypts on recipient and sibling devices and survives empty session cache recovery', async () => {
  const conversation = {
    conversationId: 'dm:1:2',
    kind: 'dm',
    encryptionMode: 'e2ee_v1',
    currentEpoch: 1,
  };

  const aliceCurrent = await createDeviceRecord({ label: 'Alice Current' });
  const aliceSibling = await createDeviceRecord({ label: 'Alice Sibling' });
  const bobDevice = await createDeviceRecord({ label: 'Bob Primary' });

  const bundleRoster = {
    conversationId: conversation.conversationId,
    members: [
      {
        userId: 1,
        devices: [
          createBundleDescriptor(aliceCurrent, 1, false),
          createBundleDescriptor(aliceSibling, 1, false),
        ],
      },
      {
        userId: 2,
        devices: [
          createBundleDescriptor(bobDevice, 2, true),
        ],
      },
    ],
  };

  const aliceSender = await createService({
    localDeviceRecord: aliceCurrent,
    bundleRoster,
  });
  const aliceSiblingReceiver = await createService({
    localDeviceRecord: aliceSibling,
    bundleRoster,
  });
  const bobReceiver = await createService({
    localDeviceRecord: bobDevice,
    bundleRoster,
  });

  const firstOutbound = await aliceSender.service.encryptMessage({
    conversation,
    plaintext: 'first secret',
    senderUserId: 1,
    currentDeviceId: aliceCurrent.deviceId,
  });

  assert.equal(firstOutbound.protocolVersion, E2EE_PROTOCOL_VERSION);
  assert.equal(firstOutbound.payloads.length, 3);

  const payloadByDeviceId = new Map(firstOutbound.payloads.map((payload) => [payload.recipientDeviceId, payload]));
  assert.ok(payloadByDeviceId.has(aliceCurrent.deviceId));
  assert.ok(payloadByDeviceId.has(aliceSibling.deviceId));
  assert.ok(payloadByDeviceId.has(bobDevice.deviceId));

  const bobFirstMessage = createMessageRow({
    payload: payloadByDeviceId.get(bobDevice.deviceId),
    senderUserId: 1,
    senderDeviceId: aliceCurrent.deviceId,
  });
  const bobFirstDecrypted = await bobReceiver.service.decryptMessage({
    conversation,
    message: bobFirstMessage,
    currentDeviceId: bobDevice.deviceId,
  });
  assert.equal(bobFirstDecrypted.bodyText, 'first secret');
  assert.equal(bobFirstDecrypted.messageState, 'decrypted');

  const aliceSiblingFirstMessage = createMessageRow({
    payload: payloadByDeviceId.get(aliceSibling.deviceId),
    senderUserId: 1,
    senderDeviceId: aliceCurrent.deviceId,
  });
  const aliceSiblingDecrypted = await aliceSiblingReceiver.service.decryptMessage({
    conversation,
    message: aliceSiblingFirstMessage,
    currentDeviceId: aliceSibling.deviceId,
  });
  assert.equal(aliceSiblingDecrypted.bodyText, 'first secret');
  assert.equal(aliceSiblingDecrypted.messageState, 'decrypted');

  const secondOutbound = await aliceSender.service.encryptMessage({
    conversation,
    plaintext: 'second secret',
    senderUserId: 1,
    currentDeviceId: aliceCurrent.deviceId,
  });
  const secondPayloadByDeviceId = new Map(secondOutbound.payloads.map((payload) => [payload.recipientDeviceId, payload]));

  const bobRecoveredReceiver = await createService({
    localDeviceRecord: bobDevice,
    bundleRoster,
  });
  const bobSecondMessage = createMessageRow({
    payload: secondPayloadByDeviceId.get(bobDevice.deviceId),
    senderUserId: 1,
    senderDeviceId: aliceCurrent.deviceId,
  });
  const bobRecoveredDecrypted = await bobRecoveredReceiver.service.decryptMessage({
    conversation,
    message: bobSecondMessage,
    currentDeviceId: bobDevice.deviceId,
  });
  assert.equal(bobRecoveredDecrypted.bodyText, 'second secret');
  assert.equal(bobRecoveredDecrypted.messageState, 'decrypted');
});
