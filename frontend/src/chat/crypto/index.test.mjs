import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatCryptoClient } from './index.js';
import { createIndexedDbStore } from './indexedDbStore.js';
import { createPrekeyService } from './prekeyService.js';

const prekeyService = createPrekeyService();

const createDeviceRecord = async ({ label }) => {
  const bundle = await prekeyService.generateDeviceBundle({
    label,
    oneTimePrekeyCount: 3,
  });
  return bundle.privateRecord;
};

const createServerBundle = (deviceRecord, userId, includeOneTimePrekey = false) => ({
  device_id: deviceRecord.deviceId,
  label: deviceRecord.label,
  device_kind: deviceRecord.deviceKind || 'primary',
  status: deviceRecord.status || 'active',
  identity_key_public: deviceRecord.identityKey.publicKey,
  signing_key_public: deviceRecord.signingKey?.publicKey || '',
  signed_prekey_id: deviceRecord.signedPrekey.keyId,
  signed_prekey_public: deviceRecord.signedPrekey.publicKey,
  signed_prekey_signature: deviceRecord.signedPrekey.signature,
  one_time_prekey: includeOneTimePrekey && deviceRecord.oneTimePrekeys[0]
    ? {
      prekey_id: deviceRecord.oneTimePrekeys[0].prekeyId,
      public_key: deviceRecord.oneTimePrekeys[0].publicKey,
    }
    : null,
  user_id: userId,
});

const makeJsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

test('encrypted DM send coerces reducer recipient user ids to BigInt', async () => {
  const store = createIndexedDbStore();
  const localDevice = await createDeviceRecord({ label: 'Alice Device' });
  const remoteDevice = await createDeviceRecord({ label: 'Bob Device' });
  await store.putDevice(localDevice);

  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));

    if (String(url) === '/api/v1/chat/e2ee/conversations/dm:1:2/device-bundles?claim_prekeys=0') {
      return makeJsonResponse({
        conversation_id: 'dm:1:2',
        members: [
          {
            user_id: 1,
            devices: [createServerBundle(localDevice, 1, false)],
          },
          {
            user_id: 2,
            devices: [createServerBundle(remoteDevice, 2, false)],
          },
        ],
      });
    }

    if (String(url) === '/api/v1/chat/e2ee/users/2/device-bundles?claim_prekeys=1') {
      return makeJsonResponse({
        user_id: 2,
        devices: [createServerBundle(remoteDevice, 2, true)],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const client = createChatCryptoClient({
    fetchImpl,
    store,
  });

  const reducerCalls = [];
  const conn = {
    reducers: {
      sendMessage: async (payload) => {
        reducerCalls.push(payload);
      },
    },
  };

  await client.sendMessage({
    conn,
    conversation: {
      conversationId: 'dm:1:2',
      kind: 'dm',
      encryptionMode: 'e2ee_v1',
      currentEpoch: 1,
    },
    plaintext: 'hello world',
    currentUserId: 1,
    currentDeviceId: localDevice.deviceId,
  });

  assert.equal(reducerCalls.length, 1);
  assert.equal(fetchCalls.length, 2);
  assert.equal(reducerCalls[0].payloads.length, 2);
  reducerCalls[0].payloads.forEach((payload) => {
    assert.equal(typeof payload.recipientUserId, 'bigint');
  });
  assert.deepEqual(
    reducerCalls[0].payloads.map((payload) => payload.recipientUserId).sort(),
    [1n, 2n]
  );
});
