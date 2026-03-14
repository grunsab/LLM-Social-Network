import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbStore } from './indexedDbStore.js';
import { createLinkedDeviceHistoryService } from './linkedDeviceHistoryService.js';
import { createPrekeyService } from './prekeyService.js';

test('linked-device history snapshots are encrypted for the new device and import only decrypted encrypted-chat messages', async () => {
  const store = createIndexedDbStore();
  const prekeyService = createPrekeyService();
  const historyService = createLinkedDeviceHistoryService({
    prekeyService,
    store,
  });

  const approverBundle = await prekeyService.generateDeviceBundle({
    label: 'Primary Browser',
    oneTimePrekeyCount: 2,
  });
  const linkedBundle = await prekeyService.generateDeviceBundle({
    label: 'Linked Browser',
    oneTimePrekeyCount: 2,
  });

  const encryptedSnapshot = await historyService.encryptHistorySnapshot({
    localDevice: approverBundle.privateRecord,
    targetDevice: {
      deviceId: linkedBundle.privateRecord.deviceId,
      identityKeyPublic: linkedBundle.publicBundle.identity_key_public,
      signedPrekeyId: linkedBundle.publicBundle.signed_prekey_id,
      signedPrekeyPublic: linkedBundle.publicBundle.signed_prekey_public,
    },
    conversations: [
      {
        conversationId: 'dm:1:2',
        encryptionMode: 'e2ee_v1',
      },
      {
        conversationId: 'dm:1:3',
        encryptionMode: 'legacy',
      },
    ],
    messagesByConversation: {
      'dm:1:2': [
        {
          messageId: 'message-1',
          senderUserId: 2,
          senderDeviceId: 'device-bob-001',
          bodyText: 'hello from before linking',
          messageState: 'decrypted',
          conversationEpoch: 1,
          createdAtMs: 1700000000000,
          createdAtIso: '2023-11-14T22:13:20.000Z',
        },
        {
          messageId: 'message-2',
          senderUserId: 2,
          senderDeviceId: 'device-bob-001',
          bodyText: 'Encrypted message: keys unavailable',
          messageState: 'pending_keys',
          conversationEpoch: 1,
          createdAtMs: 1700000001000,
          createdAtIso: '2023-11-14T22:13:21.000Z',
        },
      ],
      'dm:1:3': [
        {
          messageId: 'legacy-1',
          senderUserId: 3,
          senderDeviceId: null,
          bodyText: 'legacy messages should not be copied',
          messageState: 'legacy',
          conversationEpoch: 1,
          createdAtMs: 1700000002000,
          createdAtIso: '2023-11-14T22:13:22.000Z',
        },
      ],
    },
  });

  assert.ok(encryptedSnapshot);

  const importedMessages = await historyService.importEncryptedHistorySnapshot({
    currentDeviceId: linkedBundle.privateRecord.deviceId,
    localDevice: linkedBundle.privateRecord,
    encryptedEnvelope: encryptedSnapshot,
  });

  assert.equal(importedMessages.length, 1);
  assert.equal(importedMessages[0].messageId, 'message-1');
  assert.equal(importedMessages[0].bodyText, 'hello from before linking');

  const timelineMessages = await historyService.listImportedHistory(linkedBundle.privateRecord.deviceId);
  assert.equal(timelineMessages.length, 1);
  assert.equal(timelineMessages[0].messageId, 'message-1');
  assert.equal(timelineMessages[0].bodyText, 'hello from before linking');
  assert.equal(timelineMessages[0].isHistoricalSync, true);
});
