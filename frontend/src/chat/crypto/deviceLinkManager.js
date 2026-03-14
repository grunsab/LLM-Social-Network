export const createDeviceLinkManager = ({
  fetchImpl = globalThis.fetch,
  store,
  prekeyService,
  resolvePreferredDeviceId,
  linkedDeviceHistoryService,
} = {}) => {
  const parseResponsePayload = async (response) => {
    const rawText = typeof response.text === 'function' ? await response.text() : '';
    if (!rawText) {
      return {};
    }

    try {
      return JSON.parse(rawText);
    } catch (_error) {
      return { message: rawText.trim() };
    }
  };

  const fetchJson = async (url, options = {}, defaultErrorMessage) => {
    const preferredDeviceId = resolvePreferredDeviceId ? await resolvePreferredDeviceId() : null;
    const headers = { ...options.headers };
    if (preferredDeviceId) {
      headers['X-Chat-Device-Id'] = preferredDeviceId;
    }
    const response = await fetchImpl(url, {
      credentials: 'include',
      ...options,
      headers,
    });
    const payload = await parseResponsePayload(response);
    if (!response.ok) {
      throw new Error(payload.message || defaultErrorMessage);
    }
    return payload;
  };
  const uploadOneTimePrekeys = async (deviceId, oneTimePrekeys = []) => {
    if (!deviceId || !Array.isArray(oneTimePrekeys) || oneTimePrekeys.length === 0) {
      return;
    }

    await fetchJson(
      `/api/v1/chat/e2ee/devices/${deviceId}/one-time-prekeys`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          one_time_prekeys: oneTimePrekeys.map((prekey) => ({
            prekey_id: prekey.prekeyId,
            public_key: prekey.publicKey,
          })),
        }),
      },
      'Failed to upload one-time prekeys for the linked device.'
    );
  };

  const startCandidateLink = async ({ label, minOneTimePrekeys = 10 } = {}) => {
    const bundle = await prekeyService.generateDeviceBundle({
      label,
      oneTimePrekeyCount: minOneTimePrekeys,
    });

    const response = await fetchJson(
      '/api/v1/chat/e2ee/device-links',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...bundle.publicBundle,
          one_time_prekeys: undefined,
        }),
      },
      'Failed to start linked-device approval.'
    );

    const linkSessionRecord = {
      linkSessionId: response.link_session_id,
      pendingDeviceId: bundle.deviceId,
      approvalCode: response.approval_code,
      expiresAt: response.expires_at,
      localBundle: bundle.privateRecord,
      createdAt: bundle.createdAt,
    };
    await store.putLinkSession(linkSessionRecord);
    return {
      ...response,
      localBundle: bundle.privateRecord,
    };
  };

  const completeCandidateLink = async (linkSessionId) => {
    const response = await fetchJson(
      `/api/v1/chat/e2ee/device-links/${linkSessionId}/complete`,
      {
        method: 'POST',
      },
      'Failed to complete linked-device activation.'
    );

    const storedLinkSession = await store.getLinkSession(linkSessionId);
    if (response.status === 'active' && storedLinkSession?.localBundle) {
      const nextDevice = {
        ...storedLinkSession.localBundle,
        status: 'active',
        deviceKind: 'linked',
        linkedAt: new Date().toISOString(),
      };
      await store.putDevice(nextDevice);

      let prekeyUploadError = null;
      let historyImportError = null;
      try {
        await uploadOneTimePrekeys(nextDevice.deviceId, nextDevice.oneTimePrekeys || []);
      } catch (error) {
        prekeyUploadError = error;
      }
      if (response.history_backfill_envelope && linkedDeviceHistoryService) {
        try {
          await linkedDeviceHistoryService.importEncryptedHistorySnapshot({
            currentDeviceId: nextDevice.deviceId,
            localDevice: nextDevice,
            encryptedEnvelope: response.history_backfill_envelope,
          });
        } catch (error) {
          historyImportError = error;
        }
      }
      await store.deleteLinkSession(linkSessionId);

      if (prekeyUploadError || historyImportError) {
        return {
          ...response,
          prekey_upload_error: prekeyUploadError?.message || undefined,
          history_import_error: historyImportError?.message || undefined,
        };
      }
    }

    return response;
  };

  const approveCandidateLink = async ({
    linkSessionId,
    approvalCode,
    approverDeviceId,
    conversations = [],
    messagesByConversation = {},
  }) => {
    if (!linkSessionId) {
      throw new Error('A link session ID is required before approving a linked device.');
    }
    if (!approvalCode) {
      throw new Error('An approval code is required before approving a linked device.');
    }

    const approvalResult = await fetchJson(
      `/api/v1/chat/e2ee/device-links/${linkSessionId}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_code: approvalCode,
          approver_device_id: approverDeviceId || undefined,
        }),
      },
      'Failed to approve the linked browser.'
    );

    if (
      linkedDeviceHistoryService
      && approverDeviceId
      && approvalResult?.pending_device_bundle?.device_id
    ) {
      const approverDevice = await store.getDevice(approverDeviceId);
      const encryptedHistorySnapshot = await linkedDeviceHistoryService.encryptHistorySnapshot({
        localDevice: approverDevice,
        targetDevice: {
          deviceId: approvalResult.pending_device_bundle.device_id,
          identityKeyPublic: approvalResult.pending_device_bundle.identity_key_public,
          signedPrekeyId: approvalResult.pending_device_bundle.signed_prekey_id,
          signedPrekeyPublic: approvalResult.pending_device_bundle.signed_prekey_public,
        },
        conversations,
        messagesByConversation,
      });

      if (encryptedHistorySnapshot) {
        try {
          await fetchJson(
            `/api/v1/chat/e2ee/device-links/${linkSessionId}/history-backfill`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                history_backfill_envelope: encryptedHistorySnapshot,
              }),
            },
            'Failed to upload linked-device history backfill.'
          );
        } catch (error) {
          return {
            ...approvalResult,
            history_backfill_error: error.message || 'Failed to upload linked-device history backfill.',
          };
        }
      }
    }

    return approvalResult;
  };

  const listPendingLinkSessions = async () => store.listLinkSessions();

  return {
    startCandidateLink,
    completeCandidateLink,
    approveCandidateLink,
    listPendingLinkSessions,
  };
};
