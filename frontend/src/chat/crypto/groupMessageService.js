import {
  E2EE_PROTOCOL_VERSION,
  buildAssociatedData,
  parseEnvelope,
  resolveDisplayState,
  serializeEnvelope,
} from './messageEnvelope.js';
import {
  ensureInboundPairwiseSession,
  ensureOutboundPairwiseSession,
  hydrateTargetsWithClaimedPrekeys,
} from './directMessageService.js';

const GROUP_KEY_PACKAGE_SESSION_TYPE = 'group_sender_key';

const normalizeEnvelope = (value, fallback = {}) => (
  parseEnvelope(value)
  || {
    ciphertext: fallback.ciphertext || '',
    nonce: fallback.nonce || '',
    aad: fallback.aad || '',
  }
);

const normalizeGroupKeyPayload = (value) => {
  if (!value || typeof value !== 'string') {
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

const latestEventForEpoch = (membershipEvents, conversationId, epoch) => (
  [...(membershipEvents || [])]
    .filter((event) => event.conversationId === conversationId && Number(event.newEpoch) === Number(epoch))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .pop()
);

const canLocalDevicePublishEpoch = ({
  conversation,
  currentUserId,
  currentDeviceId,
  membershipEvents,
}) => {
  const epochEvent = latestEventForEpoch(
    membershipEvents,
    conversation.conversationId,
    conversation.currentEpoch
  );

  if (epochEvent) {
    if (epochEvent.actorDeviceId) {
      return epochEvent.actorDeviceId === currentDeviceId;
    }
    return Number(epochEvent.actorUserId) === Number(currentUserId);
  }

  return Number(conversation.currentEpoch) === 1 && Number(conversation.createdByUserId) === Number(currentUserId);
};

const buildPackageMetadata = ({
  conversation,
  senderUserId,
  senderDeviceId,
  recipientUserId,
  recipientDeviceId,
}) => ({
  conversationId: conversation.conversationId,
  messageId: `group-key:${conversation.conversationId}:${conversation.currentEpoch}:${recipientDeviceId}`,
  senderUserId,
  senderDeviceId,
  recipientUserId,
  recipientDeviceId,
  conversationEpoch: conversation.currentEpoch,
  protocolVersion: E2EE_PROTOCOL_VERSION,
  sessionType: GROUP_KEY_PACKAGE_SESSION_TYPE,
});

const buildGroupTargetDevices = (bundleRoster) => (
  (bundleRoster?.members || []).flatMap((member) => (
    (member.devices || []).map((device) => ({
      ...device,
      userId: Number(member.userId),
    }))
  ))
);

export const createGroupMessageService = ({
  deviceManager,
  sessionManager,
  groupKeyManager,
  prekeyService,
  store,
}) => {
  const decryptPendingPackages = async ({
    currentDeviceId,
    conversationId,
    epoch,
  }) => {
    if (!currentDeviceId) {
      return [];
    }

    const localDevice = await deviceManager.getLocalDevice(currentDeviceId);
    if (!localDevice) {
      return [];
    }

    const packageRows = await store.listKeyPackages();
    const relevantPackages = packageRows
      .filter((row) => row.recipientDeviceId === currentDeviceId)
      .filter((row) => (conversationId ? row.conversationId === conversationId : true))
      .filter((row) => (epoch != null ? Number(row.epoch) === Number(epoch) : true))
      .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));

    const importedGroupKeys = [];
    for (const packageRow of relevantPackages) {
      const existingGroupKey = await groupKeyManager.getLocalGroupKey(packageRow.conversationId, packageRow.epoch);
      if (existingGroupKey?.keyMaterial) {
        continue;
      }

      const envelope = normalizeEnvelope(packageRow.sealedSenderKey, {
        ciphertext: packageRow.sealedSenderKey,
      });
      let session = await sessionManager.getSession(localDevice.deviceId, packageRow.senderDeviceId);
      if (!session?.keyMaterial && envelope.senderIdentityKey) {
        try {
          session = await ensureInboundPairwiseSession({
            sessionManager,
            prekeyService,
            localDevice,
            currentDeviceId,
            remoteUserId: packageRow.senderUserId,
            remoteDeviceId: packageRow.senderDeviceId,
            recipientUserId: packageRow.recipientUserId,
            recipientDeviceId: packageRow.recipientDeviceId,
            envelope,
            defaultSessionType: GROUP_KEY_PACKAGE_SESSION_TYPE,
          });
        } catch (_error) {
          session = null;
        }
      }

      if (!session?.keyMaterial || !envelope.ciphertext || !envelope.nonce) {
        continue;
      }

      try {
        const decryptedPayload = await prekeyService.decryptText({
          keyMaterial: session.keyMaterial,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
          aad: envelope.aad || '',
        });
        const parsedPayload = normalizeGroupKeyPayload(decryptedPayload);
        if (
          !parsedPayload
          || parsedPayload.conversationId !== packageRow.conversationId
          || Number(parsedPayload.epoch) !== Number(packageRow.epoch)
          || !parsedPayload.groupKeyMaterial
        ) {
          continue;
        }

        const groupKeyRecord = await groupKeyManager.putLocalGroupKey({
          conversationId: packageRow.conversationId,
          epoch: Number(packageRow.epoch),
          keyMaterial: parsedPayload.groupKeyMaterial,
          sourcePackageId: packageRow.packageId,
          senderUserId: packageRow.senderUserId,
          senderDeviceId: packageRow.senderDeviceId,
          createdAt: packageRow.createdAt,
        });
        importedGroupKeys.push(groupKeyRecord);
      } catch (_error) {
        // Leave undecryptable packages in place; later refreshes may succeed once local state catches up.
      }
    }

    return importedGroupKeys;
  };

  const publishEpochKey = async ({
    conn,
    conversation,
    currentUserId,
    currentDeviceId,
  }) => {
    const localDevice = await deviceManager.getLocalDevice(currentDeviceId);
    if (!localDevice) {
      throw new Error('Local chat device keys are unavailable for encrypted group delivery.');
    }

    const bundleRoster = await deviceManager.fetchConversationDeviceBundles(conversation.conversationId, {
      claimPrekeys: false,
    });
    let targetDevices = buildGroupTargetDevices(bundleRoster);
    const missingMembers = (bundleRoster.members || []).filter((member) => (member.devices || []).length === 0);
    if (missingMembers.length > 0) {
      throw new Error('All group members need an active encrypted chat device before encrypted group messages can be sent.');
    }

    targetDevices = await hydrateTargetsWithClaimedPrekeys({
      deviceManager,
      sessionManager,
      localDeviceId: localDevice.deviceId,
      senderUserId: currentUserId,
      targetDevices,
    });

    const keyMaterial = prekeyService.generateSymmetricKey();
    const packages = [];

    for (const targetDevice of targetDevices) {
      const session = await ensureOutboundPairwiseSession({
        sessionManager,
        prekeyService,
        localDevice,
        senderUserId: currentUserId,
        targetDevice,
      });
      const aad = buildAssociatedData(buildPackageMetadata({
        conversation,
        senderUserId: currentUserId,
        senderDeviceId: localDevice.deviceId,
        recipientUserId: targetDevice.userId,
        recipientDeviceId: targetDevice.deviceId,
      }));
      const encryptedPayload = await prekeyService.encryptText({
        keyMaterial: session.keyMaterial,
        plaintext: JSON.stringify({
          conversationId: conversation.conversationId,
          epoch: conversation.currentEpoch,
          groupKeyMaterial: keyMaterial,
        }),
        aad,
      });
      const sealedSenderKey = serializeEnvelope({
        nonce: encryptedPayload.nonce,
        aad,
        ciphertext: encryptedPayload.ciphertext,
        sessionType: GROUP_KEY_PACKAGE_SESSION_TYPE,
        senderIdentityKey: session.senderIdentityKey,
        senderAgreementSuite: session.senderAgreementSuite,
        recipientSignedPrekeyId: session.recipientSignedPrekeyId,
        recipientOneTimePrekeyId: session.recipientOneTimePrekeyId,
      });

      packages.push({
        recipientUserId: targetDevice.userId,
        recipientDeviceId: targetDevice.deviceId,
        sealedSenderKey: sealedSenderKey,
      });

    }

    await conn.reducers.publishConversationKeyPackages({
      conversationId: conversation.conversationId,
      epoch: conversation.currentEpoch,
      packages,
    });

    return groupKeyManager.putLocalGroupKey({
      conversationId: conversation.conversationId,
      epoch: conversation.currentEpoch,
      keyMaterial,
      senderUserId: currentUserId,
      senderDeviceId: currentDeviceId,
      createdAt: new Date().toISOString(),
    });
  };

  const ensureCurrentEpochKey = async ({
    conn,
    conversation,
    currentUserId,
    currentDeviceId,
    membershipEvents = [],
    allowFallbackPublisher = false,
  }) => {
    await decryptPendingPackages({
      currentDeviceId,
      conversationId: conversation.conversationId,
      epoch: conversation.currentEpoch,
    });

    const existingGroupKey = await groupKeyManager.getLocalGroupKey(
      conversation.conversationId,
      conversation.currentEpoch
    );
    if (existingGroupKey?.keyMaterial) {
      return existingGroupKey;
    }

    const shouldPublish = canLocalDevicePublishEpoch({
      conversation,
      currentUserId,
      currentDeviceId,
      membershipEvents,
    });

    if (!conn || (!shouldPublish && !allowFallbackPublisher)) {
      return null;
    }

    return publishEpochKey({
      conn,
      conversation,
      currentUserId,
      currentDeviceId,
    });
  };

  const encryptMessage = async ({
    conn,
    conversation,
    plaintext,
    currentUserId,
    currentDeviceId,
    membershipEvents = [],
  }) => {
    const localDevice = await deviceManager.getLocalDevice(currentDeviceId);
    if (!localDevice) {
      throw new Error('Local chat device keys are unavailable for encrypted group delivery.');
    }

    const groupKey = await ensureCurrentEpochKey({
      conn,
      conversation,
      currentUserId,
      currentDeviceId,
      membershipEvents,
      allowFallbackPublisher: true,
    });
    if (!groupKey?.keyMaterial) {
      throw new Error('No sender key is available for the current encrypted group epoch yet.');
    }

    const aad = buildAssociatedData({
      conversationId: conversation.conversationId,
      messageId: `group-message:${conversation.conversationId}:${conversation.currentEpoch}`,
      senderUserId: currentUserId,
      senderDeviceId: currentDeviceId,
      conversationEpoch: conversation.currentEpoch,
      protocolVersion: E2EE_PROTOCOL_VERSION,
    });
    const encryptedPayload = await prekeyService.encryptText({
      keyMaterial: groupKey.keyMaterial,
      plaintext,
      aad,
    });

    return {
      protocolVersion: E2EE_PROTOCOL_VERSION,
      messageType: 'chat',
      conversationEpoch: conversation.currentEpoch,
      payloads: [
        {
          deliveryScope: 'conversation',
          ciphertext: serializeEnvelope({
            nonce: encryptedPayload.nonce,
            aad,
            ciphertext: encryptedPayload.ciphertext,
            epoch: conversation.currentEpoch,
          }),
          nonce: encryptedPayload.nonce,
          aad,
        },
      ],
    };
  };

  const decryptMessage = async ({
    conversation,
    message,
    currentDeviceId,
  }) => {
    await decryptPendingPackages({
      currentDeviceId,
      conversationId: message.conversationId,
      epoch: message.conversationEpoch,
    });

    const groupKey = await groupKeyManager.getLocalGroupKey(
      message.conversationId,
      message.conversationEpoch
    );
    if (!groupKey?.keyMaterial) {
      const display = resolveDisplayState({
        conversation,
        message,
        failureReason: 'missing_group_key',
      });
      return {
        ...message,
        ciphertext: display.displayText,
        bodyText: display.displayText,
        messageState: display.messageState,
      };
    }

    const envelope = normalizeEnvelope(message.wireCiphertext ?? message.ciphertext, {
      ciphertext: message.wireCiphertext ?? message.ciphertext,
      nonce: message.nonce,
      aad: message.aad,
    });

    let decryptedText = null;
    try {
      decryptedText = await prekeyService.decryptText({
        keyMaterial: groupKey.keyMaterial,
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce || message.nonce,
        aad: envelope.aad || message.aad || '',
      });
    } catch (_error) {
      decryptedText = null;
    }

    const display = resolveDisplayState({
      conversation,
      message,
      decryptedText,
      failureReason: decryptedText ? undefined : 'failed_to_decrypt',
    });

    return {
      ...message,
      ciphertext: display.displayText,
      bodyText: display.displayText,
      messageState: display.messageState,
    };
  };

  return {
    decryptPendingPackages,
    ensureCurrentEpochKey,
    encryptMessage,
    decryptMessage,
  };
};
