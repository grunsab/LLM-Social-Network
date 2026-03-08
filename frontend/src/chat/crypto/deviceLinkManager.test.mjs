import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeviceLinkManager } from './deviceLinkManager.js';
import { createIndexedDbStore } from './indexedDbStore.js';
import { createPrekeyService } from './prekeyService.js';

const createJsonResponse = (payload, { ok = true } = {}) => ({
  ok,
  text: async () => JSON.stringify(payload),
});

test('device link manager starts, approves, and completes linked-browser activation', async () => {
  const store = createIndexedDbStore();
  const prekeyService = createPrekeyService();
  const fetchCalls = [];
  let linkedDeviceId = null;

  const fetchImpl = async (url, options = {}) => {
    const requestBody = options.body ? JSON.parse(options.body) : null;
    if (url === '/api/v1/chat/e2ee/device-links' && options.method === 'POST') {
      linkedDeviceId = requestBody?.device_id || null;
    }

    fetchCalls.push({
      url,
      method: options.method || 'GET',
      body: requestBody,
    });

    if (url === '/api/v1/chat/e2ee/device-links' && options.method === 'POST') {
      return createJsonResponse({
        link_session_id: 17,
        approval_code: 'ABCD1234',
        expires_at: '2026-03-08T14:00:00Z',
      });
    }

    if (url === '/api/v1/chat/e2ee/device-links/17/approve' && options.method === 'POST') {
      return createJsonResponse({
        device: {
          device_id: linkedDeviceId,
          status: 'active',
        },
      });
    }

    if (url === '/api/v1/chat/e2ee/device-links/17/complete' && options.method === 'POST') {
      return createJsonResponse({
        status: 'active',
        current_device_id: linkedDeviceId,
      });
    }

    if (url === `/api/v1/chat/e2ee/devices/${linkedDeviceId}/one-time-prekeys` && options.method === 'POST') {
      return createJsonResponse({
        inserted_count: requestBody?.one_time_prekeys.length || 0,
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const manager = createDeviceLinkManager({
    fetchImpl,
    store,
    prekeyService,
  });

  const startedLink = await manager.startCandidateLink({
    label: 'Linked Tablet',
    minOneTimePrekeys: 4,
  });

  assert.equal(startedLink.link_session_id, 17);
  assert.equal(startedLink.approval_code, 'ABCD1234');
  assert.equal(startedLink.localBundle.label, 'Linked Tablet');
  assert.ok(startedLink.localBundle.oneTimePrekeys.length >= 4);

  const storedPendingLink = await store.getLinkSession(17);
  assert.equal(storedPendingLink.linkSessionId, 17);
  assert.equal(storedPendingLink.approvalCode, 'ABCD1234');

  const approvedLink = await manager.approveCandidateLink({
    linkSessionId: 17,
    approvalCode: 'ABCD1234',
    approverDeviceId: 'device-primary-001',
  });
  assert.equal(approvedLink.device.device_id, linkedDeviceId);

  const completedLink = await manager.completeCandidateLink(17);
  assert.equal(completedLink.status, 'active');
  assert.equal(completedLink.current_device_id, linkedDeviceId);
  assert.equal(completedLink.prekey_upload_error, undefined);

  const activatedDevice = await store.getDevice(linkedDeviceId);
  assert.equal(activatedDevice.status, 'active');
  assert.equal(activatedDevice.deviceKind, 'linked');

  const pendingLinkAfterComplete = await store.getLinkSession(17);
  assert.equal(pendingLinkAfterComplete, null);

  const approveCall = fetchCalls.find((call) => call.url.endsWith('/approve'));
  assert.deepEqual(approveCall.body, {
    approval_code: 'ABCD1234',
    approver_device_id: 'device-primary-001',
  });

  const prekeyUploadCall = fetchCalls.find((call) => call.url.endsWith('/one-time-prekeys'));
  assert.ok(prekeyUploadCall);
  assert.equal(prekeyUploadCall.body.one_time_prekeys.length, startedLink.localBundle.oneTimePrekeys.length);
});
