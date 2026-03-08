import { E2EE_ENCRYPTION_MODE } from './messageEnvelope.js';

const parseResponsePayload = async (response) => {
  const rawText = typeof response.text === 'function'
    ? await response.text()
    : '';

  if (!rawText && typeof response.json === 'function') {
    try {
      return await response.json();
    } catch (_error) {
      return {};
    }
  }

  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch (_error) {
    return { message: rawText.trim() };
  }
};

const defaultFetchJson = async (fetchImpl, url, options = {}, defaultErrorMessage) => {
  const response = await fetchImpl(url, {
    credentials: 'include',
    ...options,
  });
  const payload = await parseResponsePayload(response);
  if (!response.ok) {
    throw new Error(payload.message || defaultErrorMessage);
  }
  return payload;
};

const mergeServerDeviceState = (localDeviceRecord, serverDevice) => ({
  ...localDeviceRecord,
  label: serverDevice?.label || localDeviceRecord.label,
  deviceKind: serverDevice?.device_kind || localDeviceRecord.deviceKind || 'primary',
  status: serverDevice?.status || localDeviceRecord.status || 'active',
  linkedAt: serverDevice?.linked_at || localDeviceRecord.linkedAt || localDeviceRecord.createdAt,
  lastSeenAt: serverDevice?.last_seen_at || localDeviceRecord.lastSeenAt || null,
  approvedByDeviceId: serverDevice?.approved_by_device_id || localDeviceRecord.approvedByDeviceId || null,
});

const normalizeOneTimePrekey = (prekey) => {
  if (!prekey || typeof prekey !== 'object') {
    return null;
  }

  return {
    prekeyId: Number(prekey.prekey_id ?? prekey.prekeyId ?? 0),
    publicKey: prekey.public_key || prekey.publicKey || '',
  };
};

const normalizeDeviceBundle = (device, userId) => ({
  userId: Number(userId),
  deviceId: device?.device_id || device?.deviceId || '',
  label: device?.label || '',
  deviceKind: device?.device_kind || device?.deviceKind || 'linked',
  status: device?.status || 'active',
  linkedAt: device?.linked_at || device?.linkedAt || null,
  lastSeenAt: device?.last_seen_at || device?.lastSeenAt || null,
  approvedByDeviceId: device?.approved_by_device_id || device?.approvedByDeviceId || null,
  identityKeyPublic: device?.identity_key_public || device?.identityKeyPublic || '',
  signingKeyPublic: device?.signing_key_public || device?.signingKeyPublic || '',
  signedPrekeyId: Number(device?.signed_prekey_id ?? device?.signedPrekeyId ?? 0),
  signedPrekeyPublic: device?.signed_prekey_public || device?.signedPrekeyPublic || '',
  signedPrekeySignature: device?.signed_prekey_signature || device?.signedPrekeySignature || '',
  oneTimePrekey: normalizeOneTimePrekey(device?.one_time_prekey || device?.oneTimePrekey),
});

const buildBundleUrl = (baseUrl, options = {}) => {
  const claimPrekeys = options.claimPrekeys;
  if (claimPrekeys == null) {
    return baseUrl;
  }

  const params = new URLSearchParams();
  params.set('claim_prekeys', claimPrekeys ? '1' : '0');
  return `${baseUrl}?${params.toString()}`;
};

const toTimestamp = (value) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export const createDeviceManager = ({
  fetchImpl = globalThis.fetch,
  store,
  prekeyService,
} = {}) => {
  const fetchJson = (url, options, defaultErrorMessage) => defaultFetchJson(
    fetchImpl,
    url,
    options,
    defaultErrorMessage
  );

  const resolvePreferredDeviceId = async () => {
    const localDevices = await store.listDevices();
    return [...localDevices]
      .filter((device) => device?.deviceId && device.status !== 'revoked')
      .sort((left, right) => {
        const leftScore = Math.max(
          toTimestamp(left.updatedAt),
          toTimestamp(left.linkedAt),
          toTimestamp(left.createdAt)
        );
        const rightScore = Math.max(
          toTimestamp(right.updatedAt),
          toTimestamp(right.linkedAt),
          toTimestamp(right.createdAt)
        );
        return rightScore - leftScore;
      })[0]?.deviceId || null;
  };

  const loadBootstrap = async (options = {}) => {
    const preferredDeviceId = options.preferredDeviceId ?? await resolvePreferredDeviceId();
    const bootstrapUrl = preferredDeviceId
      ? `/api/v1/chat/e2ee/bootstrap?preferred_device_id=${encodeURIComponent(preferredDeviceId)}`
      : '/api/v1/chat/e2ee/bootstrap';

    return fetchJson(
      bootstrapUrl,
      {},
      'Failed to load end-to-end encryption bootstrap state.'
    );
  };

  const fetchUserDeviceBundles = async (userId, options = {}) => {
    const payload = await fetchJson(
      buildBundleUrl(`/api/v1/chat/e2ee/users/${Number(userId)}/device-bundles`, {
        claimPrekeys: options.claimPrekeys ?? false,
      }),
      {},
      'Failed to load device bundles for the selected user.'
    );

    return {
      userId: Number(payload.user_id ?? userId),
      devices: Array.isArray(payload.devices)
        ? payload.devices.map((device) => normalizeDeviceBundle(device, payload.user_id ?? userId))
        : [],
    };
  };

  const fetchConversationDeviceBundles = async (conversationId, options = {}) => {
    const payload = await fetchJson(
      buildBundleUrl(`/api/v1/chat/e2ee/conversations/${conversationId}/device-bundles`, {
        claimPrekeys: options.claimPrekeys ?? false,
      }),
      {},
      'Failed to load device bundles for the selected conversation.'
    );

    return {
      conversationId: payload.conversation_id || conversationId,
      members: Array.isArray(payload.members)
        ? payload.members.map((member) => ({
          userId: Number(member.user_id),
          devices: Array.isArray(member.devices)
            ? member.devices.map((device) => normalizeDeviceBundle(device, member.user_id))
            : [],
        }))
        : [],
    };
  };

  const registerFirstDevice = async (bootstrap, options = {}) => {
    const oneTimePrekeyCount = Math.max(
      options.oneTimePrekeyCount || 0,
      bootstrap?.min_one_time_prekeys || 0,
      prekeyService.DEFAULT_ONE_TIME_PREKEY_COUNT || 0
    );
    const bundle = await prekeyService.generateDeviceBundle({
      label: options.label,
      oneTimePrekeyCount,
    });

    const response = await fetchJson(
      '/api/v1/chat/e2ee/devices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle.publicBundle),
      },
      'Failed to register this browser as a chat device.'
    );

    const localRecord = mergeServerDeviceState({
      ...bundle.privateRecord,
      encryptionMode: E2EE_ENCRYPTION_MODE,
    }, response.device);
    await store.putDevice(localRecord);

    return {
      response,
      localRecord,
    };
  };

  const replenishOneTimePrekeys = async (deviceRecord, targetCount) => {
    if (!deviceRecord?.deviceId || !targetCount || targetCount <= 0) {
      return deviceRecord;
    }

    const nextPrekeys = await prekeyService.createOneTimePrekeys({
      deviceRecord,
      count: targetCount,
    });
    if (nextPrekeys.length === 0) {
      return deviceRecord;
    }

    await fetchJson(
      `/api/v1/chat/e2ee/devices/${deviceRecord.deviceId}/one-time-prekeys`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          one_time_prekeys: nextPrekeys.map((prekey) => ({
            prekey_id: prekey.prekeyId,
            public_key: prekey.publicKey,
          })),
        }),
      },
      'Failed to replenish one-time prekeys for this browser.'
    );

    const nextRecord = {
      ...deviceRecord,
      oneTimePrekeys: [
        ...(deviceRecord.oneTimePrekeys || []),
        ...nextPrekeys,
      ],
      updatedAt: new Date().toISOString(),
    };
    await store.putDevice(nextRecord);
    return nextRecord;
  };

  const rotateSignedPrekey = async (deviceRecord) => {
    if (!deviceRecord?.deviceId) {
      throw new Error('A local device record is required before rotating signed prekeys.');
    }

    const rotation = await prekeyService.createSignedPrekeyRotation(deviceRecord);
    await fetchJson(
      `/api/v1/chat/e2ee/devices/${deviceRecord.deviceId}/signed-prekey`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signed_prekey_id: rotation.signedPrekeyId,
          signed_prekey_public: rotation.signedPrekeyPublic,
          signed_prekey_signature: rotation.signedPrekeySignature,
        }),
      },
      'Failed to rotate the signed prekey for this browser.'
    );

    const nextRecord = {
      ...deviceRecord,
      signedPrekey: {
        ...deviceRecord.signedPrekey,
        keyId: rotation.signedPrekeyId,
        publicKey: rotation.signedPrekeyPublic,
        privateKeyJwk: rotation.privateKeyJwk,
        signature: rotation.signedPrekeySignature,
        createdAt: rotation.createdAt,
      },
      updatedAt: rotation.createdAt,
    };
    await store.putDevice(nextRecord);
    return nextRecord;
  };

  const revokeDevice = async (deviceId) => {
    if (!deviceId) {
      return;
    }

    await fetchJson(
      `/api/v1/chat/e2ee/devices/${deviceId}/revoke`,
      {
        method: 'POST',
      },
      'Failed to revoke the selected chat device.'
    );

    const localRecord = await store.getDevice(deviceId);
    if (!localRecord) {
      return null;
    }

    const nextRecord = {
      ...localRecord,
      status: 'revoked',
      revokedAt: new Date().toISOString(),
    };
    await store.putDevice(nextRecord);
    return nextRecord;
  };

  const getLocalDevice = async (deviceId) => {
    if (!deviceId) {
      return null;
    }
    return store.getDevice(deviceId);
  };

  const ensureCurrentDevice = async (options = {}) => {
    let bootstrap = await loadBootstrap();
    const out = {
      bootstrap,
      localDevice: null,
      localDeviceState: 'disabled',
      storageKind: store.kind,
      autoRegistered: false,
      error: '',
    };

    if (!bootstrap.enabled) {
      return out;
    }

    out.localDeviceState = 'server_only';

    if (!bootstrap.has_active_device) {
      await prekeyService.assertSupported();
      const { localRecord } = await registerFirstDevice(bootstrap, options);
      bootstrap = await loadBootstrap();
      return {
        ...out,
        bootstrap,
        localDevice: localRecord,
        localDeviceState: 'registered',
        autoRegistered: true,
      };
    }

    const currentDeviceId = bootstrap.current_device_id || null;
    const localDevice = currentDeviceId ? await getLocalDevice(currentDeviceId) : null;
    if (localDevice) {
      let nextLocalDevice = mergeServerDeviceState(
        localDevice,
        bootstrap.devices.find((device) => device.device_id === currentDeviceId)
      );
      await store.putDevice(nextLocalDevice);

      const targetPrekeys = Math.max(
        0,
        (bootstrap.min_one_time_prekeys || 0) - (bootstrap.remaining_one_time_prekeys || 0)
      );
      if (targetPrekeys > 0) {
        nextLocalDevice = await replenishOneTimePrekeys(nextLocalDevice, Math.max(targetPrekeys, 4));
        bootstrap = await loadBootstrap();
      }

      return {
        ...out,
        bootstrap,
        localDevice: nextLocalDevice,
        localDeviceState: 'ready',
      };
    }

    if (currentDeviceId) {
      return {
        ...out,
        bootstrap,
        localDeviceState: 'missing_local_keys',
      };
    }

    return {
      ...out,
      bootstrap,
      localDeviceState: bootstrap.devices.length > 1 ? 'selection_required' : 'server_only',
    };
  };

  return {
    loadBootstrap,
    fetchUserDeviceBundles,
    fetchConversationDeviceBundles,
    ensureCurrentDevice,
    getLocalDevice,
    registerFirstDevice,
    replenishOneTimePrekeys,
    rotateSignedPrekey,
    revokeDevice,
  };
};
