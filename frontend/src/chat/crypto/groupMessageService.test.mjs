import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbStore } from './indexedDbStore.js';
import { createPrekeyService } from './prekeyService.js';
import { createSessionManager } from './sessionManager.js';
import { createGroupKeyManager } from './groupKeyManager.js';
import { createGroupMessageService } from './groupMessageService.js';

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

const createService = async ({ localDeviceRecord, getBundleRoster }) => {
  const store = createIndexedDbStore();
  await store.putDevice(localDeviceRecord);

  const sessionManager = createSessionManager({ store });
  const groupKeyManager = createGroupKeyManager({ store });
  const service = createGroupMessageService({
    deviceManager: {
      getLocalDevice: async (deviceId) => store.getDevice(deviceId),
      fetchConversationDeviceBundles: async (conversationId, options = {}) => {
        const bundleRoster = getBundleRoster(conversationId);
        return {
          conversationId: bundleRoster.conversationId,
          members: bundleRoster.members.map((member) => ({
            userId: member.userId,
            devices: (member.devices || []).map((device) => cloneBundleDescriptor(
              device,
              Boolean(options.claimPrekeys)
            )),
          })),
        };
      },
      fetchUserDeviceBundles: async (userId, options = {}) => {
        const bundleRoster = getBundleRoster();
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
    groupKeyManager,
    prekeyService,
    store,
  });

  return {
    store,
    service,
  };
};

const createGroupMessageRow = ({ conversationId, epoch, senderUserId, senderDeviceId, payload }) => ({
  payloadId: `group-payload:${conversationId}:${epoch}`,
  messageId: `group-message:${conversationId}:${epoch}`,
  conversationId,
  senderUserId,
  senderDeviceId,
  protocolVersion: 'e2ee_v1',
  messageType: 'chat',
  conversationEpoch: epoch,
  deliveryScope: 'conversation',
  recipientUserId: null,
  recipientDeviceId: null,
  ciphertext: payload.ciphertext,
  wireCiphertext: payload.ciphertext,
  nonce: payload.nonce,
  aad: payload.aad,
  createdAtMs: Date.now(),
  createdAtIso: new Date().toISOString(),
});

const createPackagePublisher = ({ recipientStores, senderUserId, senderDeviceId }) => {
  const publishedBatches = [];

  return {
    publishedBatches,
    reducers: {
      async publishConversationKeyPackages({ conversationId, epoch, packages }) {
        publishedBatches.push({
          conversationId,
          epoch,
          packages: packages.map((pkg) => ({ ...pkg })),
        });

        let counter = 0;
        for (const pkg of packages) {
          const recipientStore = recipientStores.get(pkg.recipientDeviceId);
          if (!recipientStore) {
            continue;
          }
          counter += 1;
          await recipientStore.putKeyPackage({
            packageId: `${conversationId}:${epoch}:${pkg.recipientDeviceId}:${counter}`,
            conversationId,
            epoch,
            recipientUserId: Number(pkg.recipientUserId),
            recipientDeviceId: pkg.recipientDeviceId,
            senderUserId,
            senderDeviceId,
            sealedSenderKey: pkg.sealedSenderKey,
            createdAt: new Date().toISOString(),
          });
        }
      },
    },
  };
};

test('encrypted groups publish sender-key packages and preserve old-epoch boundaries after member rekey', async () => {
  const aliceDevice = await createDeviceRecord({ label: 'Alice Group Device' });
  const bobDevice = await createDeviceRecord({ label: 'Bob Group Device' });
  const carolDevice = await createDeviceRecord({ label: 'Carol Group Device' });

  let bundleRoster = {
    conversationId: 'grp:test-room',
    members: [
      { userId: 1, devices: [createBundleDescriptor(aliceDevice, 1, false)] },
      { userId: 2, devices: [createBundleDescriptor(bobDevice, 2, true)] },
    ],
  };

  const alice = await createService({
    localDeviceRecord: aliceDevice,
    getBundleRoster: () => bundleRoster,
  });
  const bob = await createService({
    localDeviceRecord: bobDevice,
    getBundleRoster: () => bundleRoster,
  });
  const carol = await createService({
    localDeviceRecord: carolDevice,
    getBundleRoster: () => bundleRoster,
  });

  const publisherConn = createPackagePublisher({
    recipientStores: new Map([
      [aliceDevice.deviceId, alice.store],
      [bobDevice.deviceId, bob.store],
      [carolDevice.deviceId, carol.store],
    ]),
    senderUserId: 1,
    senderDeviceId: aliceDevice.deviceId,
  });

  const epochOneConversation = {
    conversationId: 'grp:test-room',
    kind: 'group',
    title: 'Test Room',
    createdByUserId: 1,
    encryptionMode: 'e2ee_v1',
    currentEpoch: 1,
  };

  const epochOneOutbound = await alice.service.encryptMessage({
    conn: publisherConn,
    conversation: epochOneConversation,
    plaintext: 'epoch one hello',
    currentUserId: 1,
    currentDeviceId: aliceDevice.deviceId,
    membershipEvents: [],
  });

  const epochOneMessage = createGroupMessageRow({
    conversationId: epochOneConversation.conversationId,
    epoch: 1,
    senderUserId: 1,
    senderDeviceId: aliceDevice.deviceId,
    payload: epochOneOutbound.payloads[0],
  });
  const bobEpochOne = await bob.service.decryptMessage({
    conversation: epochOneConversation,
    message: epochOneMessage,
    currentDeviceId: bobDevice.deviceId,
  });
  assert.equal(bobEpochOne.bodyText, 'epoch one hello');
  assert.equal(bobEpochOne.messageState, 'decrypted');

  bundleRoster = {
    conversationId: 'grp:test-room',
    members: [
      { userId: 1, devices: [createBundleDescriptor(aliceDevice, 1, false)] },
      { userId: 2, devices: [createBundleDescriptor(bobDevice, 2, true)] },
      { userId: 3, devices: [createBundleDescriptor(carolDevice, 3, true)] },
    ],
  };

  const epochTwoConversation = {
    ...epochOneConversation,
    currentEpoch: 2,
  };
  const membershipEvents = [
    {
      conversationId: epochTwoConversation.conversationId,
      eventType: 'member_added',
      actorUserId: 1,
      actorDeviceId: aliceDevice.deviceId,
      targetUserId: 3,
      targetDeviceId: null,
      newEpoch: 2,
      createdAtMs: Date.now(),
    },
  ];

  await alice.service.ensureCurrentEpochKey({
    conn: publisherConn,
    conversation: epochTwoConversation,
    currentUserId: 1,
    currentDeviceId: aliceDevice.deviceId,
    membershipEvents,
  });

  const epochTwoOutbound = await alice.service.encryptMessage({
    conn: publisherConn,
    conversation: epochTwoConversation,
    plaintext: 'epoch two hello',
    currentUserId: 1,
    currentDeviceId: aliceDevice.deviceId,
    membershipEvents,
  });

  const epochTwoMessage = createGroupMessageRow({
    conversationId: epochTwoConversation.conversationId,
    epoch: 2,
    senderUserId: 1,
    senderDeviceId: aliceDevice.deviceId,
    payload: epochTwoOutbound.payloads[0],
  });

  const carolEpochOne = await carol.service.decryptMessage({
    conversation: epochTwoConversation,
    message: epochOneMessage,
    currentDeviceId: carolDevice.deviceId,
  });
  assert.equal(carolEpochOne.messageState, 'pending_keys');

  const bobEpochTwo = await bob.service.decryptMessage({
    conversation: epochTwoConversation,
    message: epochTwoMessage,
    currentDeviceId: bobDevice.deviceId,
  });
  const carolEpochTwo = await carol.service.decryptMessage({
    conversation: epochTwoConversation,
    message: epochTwoMessage,
    currentDeviceId: carolDevice.deviceId,
  });

  assert.equal(bobEpochTwo.bodyText, 'epoch two hello');
  assert.equal(bobEpochTwo.messageState, 'decrypted');
  assert.equal(carolEpochTwo.bodyText, 'epoch two hello');
  assert.equal(carolEpochTwo.messageState, 'decrypted');
});

test('device roster rekey publishes packages for a newly linked device', async () => {
  const aliceDevice = await createDeviceRecord({ label: 'Alice Publisher' });
  const bobPrimary = await createDeviceRecord({ label: 'Bob Primary' });
  const bobLinked = await createDeviceRecord({ label: 'Bob Linked' });

  let bundleRoster = {
    conversationId: 'grp:device-room',
    members: [
      { userId: 1, devices: [createBundleDescriptor(aliceDevice, 1, false)] },
      { userId: 2, devices: [createBundleDescriptor(bobPrimary, 2, true)] },
    ],
  };

  const alice = await createService({
    localDeviceRecord: aliceDevice,
    getBundleRoster: () => bundleRoster,
  });
  const bobPrimaryService = await createService({
    localDeviceRecord: bobPrimary,
    getBundleRoster: () => bundleRoster,
  });
  const bobLinkedService = await createService({
    localDeviceRecord: bobLinked,
    getBundleRoster: () => bundleRoster,
  });

  const publisherConn = createPackagePublisher({
    recipientStores: new Map([
      [aliceDevice.deviceId, alice.store],
      [bobPrimary.deviceId, bobPrimaryService.store],
      [bobLinked.deviceId, bobLinkedService.store],
    ]),
    senderUserId: 1,
    senderDeviceId: aliceDevice.deviceId,
  });

  const epochOneConversation = {
    conversationId: 'grp:device-room',
    kind: 'group',
    title: 'Device Room',
    createdByUserId: 1,
    encryptionMode: 'e2ee_v1',
    currentEpoch: 1,
  };

  await alice.service.encryptMessage({
    conn: publisherConn,
    conversation: epochOneConversation,
    plaintext: 'before linked device',
    currentUserId: 1,
    currentDeviceId: aliceDevice.deviceId,
    membershipEvents: [],
  });

  bundleRoster = {
    conversationId: 'grp:device-room',
    members: [
      { userId: 1, devices: [createBundleDescriptor(aliceDevice, 1, false)] },
      {
        userId: 2,
        devices: [
          createBundleDescriptor(bobPrimary, 2, true),
          createBundleDescriptor(bobLinked, 2, true),
        ],
      },
    ],
  };

  const epochTwoConversation = {
    ...epochOneConversation,
    currentEpoch: 2,
  };
  const deviceEvent = [
    {
      conversationId: epochTwoConversation.conversationId,
      eventType: 'device_added',
      actorUserId: 1,
      actorDeviceId: aliceDevice.deviceId,
      targetUserId: 2,
      targetDeviceId: bobLinked.deviceId,
      newEpoch: 2,
      createdAtMs: Date.now(),
    },
  ];

  const epochTwoOutbound = await alice.service.encryptMessage({
    conn: publisherConn,
    conversation: epochTwoConversation,
    plaintext: 'after linked device',
    currentUserId: 1,
    currentDeviceId: aliceDevice.deviceId,
    membershipEvents: deviceEvent,
  });

  const epochTwoMessage = createGroupMessageRow({
    conversationId: epochTwoConversation.conversationId,
    epoch: 2,
    senderUserId: 1,
    senderDeviceId: aliceDevice.deviceId,
    payload: epochTwoOutbound.payloads[0],
  });

  const linkedResult = await bobLinkedService.service.decryptMessage({
    conversation: epochTwoConversation,
    message: epochTwoMessage,
    currentDeviceId: bobLinked.deviceId,
  });

  assert.equal(linkedResult.bodyText, 'after linked device');
  assert.equal(linkedResult.messageState, 'decrypted');
  assert.ok(publisherConn.publishedBatches.length >= 2);
  publisherConn.publishedBatches.flatMap((batch) => batch.packages).forEach((pkg) => {
    assert.equal(typeof pkg.recipientUserId, 'bigint');
  });
});
