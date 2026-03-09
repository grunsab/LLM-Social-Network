import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeviceManager } from './deviceManager.js';
import { createIndexedDbStore } from './indexedDbStore.js';
import { createPrekeyService } from './prekeyService.js';

const makeJsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

test('first-device registration can recover after an interrupted response once the server-side device exists', async () => {
  const store = createIndexedDbStore();
  const prekeyService = createPrekeyService();

  let createdDeviceId = null;

  const fetchImpl = async (url, options = {}) => {
    const urlString = String(url);

    if (urlString === '/api/v1/chat/e2ee/bootstrap') {
      return makeJsonResponse({
        enabled: true,
        new_conversations_enabled: true,
        current_device_id: null,
        has_active_device: false,
        devices: [],
        remaining_one_time_prekeys: 0,
        min_one_time_prekeys: 8,
      });
    }

    if (urlString === '/api/v1/chat/e2ee/devices') {
      createdDeviceId = JSON.parse(String(options.body || '{}')).device_id || null;
      return {
        ok: true,
        status: 201,
        text: async () => {
          throw new Error('network interrupted');
        },
      };
    }

    if (urlString.startsWith('/api/v1/chat/e2ee/bootstrap?preferred_device_id=')) {
      const preferredDeviceId = new URL(urlString, 'https://example.test').searchParams.get('preferred_device_id');
      return makeJsonResponse({
        enabled: true,
        new_conversations_enabled: true,
        current_device_id: preferredDeviceId,
        has_active_device: true,
        devices: [
          {
            device_id: preferredDeviceId,
            label: 'This macOS',
            device_kind: 'primary',
            status: 'active',
          },
        ],
        remaining_one_time_prekeys: 8,
        min_one_time_prekeys: 8,
      });
    }

    throw new Error(`Unexpected fetch: ${urlString}`);
  };

  const deviceManager = createDeviceManager({
    fetchImpl,
    store,
    prekeyService,
  });

  await assert.rejects(
    () => deviceManager.ensureCurrentDevice(),
    /network interrupted/
  );

  const provisionalDevices = await store.listDevices();
  assert.equal(provisionalDevices.length, 1);
  assert.equal(provisionalDevices[0].deviceId, createdDeviceId);

  const recovered = await deviceManager.ensureCurrentDevice();
  assert.equal(recovered.localDeviceState, 'ready');
  assert.equal(recovered.localDevice?.deviceId, createdDeviceId);
  assert.equal(recovered.bootstrap.current_device_id, createdDeviceId);
});
