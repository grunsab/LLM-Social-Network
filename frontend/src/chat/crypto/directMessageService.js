import {
  E2EE_PROTOCOL_VERSION,
  buildAssociatedData,
  parseEnvelope,
  resolveDisplayState,
  serializeEnvelope,
} from './messageEnvelope.js';

export const PAIRWISE_SESSION_SALT = 'llm-social-network:dm-session:v1';
export const PREKEY_BUNDLE_SESSION_TYPE = 'prekey_bundle';
export const ESTABLISHED_SESSION_TYPE = 'session';

const buildSessionInfo = ({
  senderUserId,
  senderDeviceId,
  recipientUserId,
  recipientDeviceId,
}) => ({
  protocol: PAIRWISE_SESSION_SALT,
  sender_user_id: senderUserId,
  sender_device_id: senderDeviceId,
  recipient_user_id: recipientUserId,
  recipient_device_id: recipientDeviceId,
});

const buildLocalDeviceDescriptor = (localDevice, userId) => ({
  userId: Number(userId),
  deviceId: localDevice.deviceId,
  identityKeyPublic: localDevice.identityKey.publicKey,
  signedPrekeyId: Number(localDevice.signedPrekey.keyId),
  signedPrekeyPublic: localDevice.signedPrekey.publicKey,
  oneTimePrekey: null,
});

const buildTargetDevices = ({ bundleRoster, localDevice, senderUserId }) => {
  const targetDevices = new Map();

  (bundleRoster?.members || []).forEach((member) => {
    (member.devices || []).forEach((device) => {
      if (!device?.deviceId) {
        return;
      }
      targetDevices.set(device.deviceId, {
        ...device,
        userId: Number(member.userId),
      });
    });
  });

  if (localDevice?.deviceId && !targetDevices.has(localDevice.deviceId)) {
    targetDevices.set(localDevice.deviceId, buildLocalDeviceDescriptor(localDevice, senderUserId));
  }

  return Array.from(targetDevices.values());
};

const mergeClaimedPrekeys = ({ targetDevices, claimedBundles }) => {
  const claimedDeviceMap = new Map();
  claimedBundles.forEach((bundle) => {
    (bundle?.devices || []).forEach((device) => {
      claimedDeviceMap.set(device.deviceId, device);
    });
  });

  return targetDevices.map((targetDevice) => {
    const claimedDevice = claimedDeviceMap.get(targetDevice.deviceId);
    if (!claimedDevice?.oneTimePrekey) {
      return targetDevice;
    }
    return {
      ...targetDevice,
      oneTimePrekey: claimedDevice.oneTimePrekey,
    };
  });
};

const buildSessionRecord = ({
  sessionManager,
  localDeviceId,
  remoteUserId,
  remoteDeviceId,
  remoteIdentityKey,
  keyMaterial,
  senderIdentityKey,
  senderAgreementSuite,
  recipientSignedPrekeyId,
  recipientOneTimePrekeyId,
  sessionType,
}) => sessionManager.upsertSession({
  sessionId: sessionManager.createSessionId(localDeviceId, remoteDeviceId),
  localDeviceId,
  remoteUserId,
  remoteDeviceId,
  remoteIdentityKey,
  keyMaterial,
  senderIdentityKey,
  senderAgreementSuite,
  recipientSignedPrekeyId,
  recipientOneTimePrekeyId,
  sessionType,
  status: 'established',
  establishedAt: new Date().toISOString(),
});

const normalizeEnvelope = (message) => (
  parseEnvelope(message.wireCiphertext ?? message.ciphertext)
  || {
    ciphertext: message.wireCiphertext ?? message.ciphertext ?? '',
    nonce: message.nonce || '',
    aad: message.aad || '',
  }
);

export const ensureOutboundPairwiseSession = async ({
  sessionManager,
  prekeyService,
  localDevice,
  senderUserId,
  targetDevice,
  sessionSalt = PAIRWISE_SESSION_SALT,
  prekeySessionType = PREKEY_BUNDLE_SESSION_TYPE,
  establishedSessionType = ESTABLISHED_SESSION_TYPE,
}) => {
  const existingSession = await sessionManager.getSession(localDevice.deviceId, targetDevice.deviceId);
  if (existingSession?.keyMaterial && existingSession.status === 'established') {
    return existingSession;
  }

  const sharedSecrets = [
    await prekeyService.deriveAgreementBytes({
      localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
      suiteId: localDevice.cryptoProfile.agreementSuite,
      remotePublicKey: targetDevice.identityKeyPublic,
    }),
    await prekeyService.deriveAgreementBytes({
      localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
      suiteId: localDevice.cryptoProfile.agreementSuite,
      remotePublicKey: targetDevice.signedPrekeyPublic,
    }),
  ];

  if (targetDevice.oneTimePrekey?.publicKey) {
    sharedSecrets.push(await prekeyService.deriveAgreementBytes({
      localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
      suiteId: localDevice.cryptoProfile.agreementSuite,
      remotePublicKey: targetDevice.oneTimePrekey.publicKey,
    }));
  }

  const keyMaterial = await prekeyService.deriveSessionKey({
    sharedSecrets,
    salt: sessionSalt,
    info: buildSessionInfo({
      senderUserId,
      senderDeviceId: localDevice.deviceId,
      recipientUserId: targetDevice.userId,
      recipientDeviceId: targetDevice.deviceId,
    }),
  });

  return buildSessionRecord({
    sessionManager,
    localDeviceId: localDevice.deviceId,
    remoteUserId: targetDevice.userId,
    remoteDeviceId: targetDevice.deviceId,
    remoteIdentityKey: targetDevice.identityKeyPublic,
    keyMaterial,
    senderIdentityKey: localDevice.identityKey.publicKey,
    senderAgreementSuite: localDevice.cryptoProfile.agreementSuite,
    recipientSignedPrekeyId: targetDevice.signedPrekeyId,
    recipientOneTimePrekeyId: targetDevice.oneTimePrekey?.prekeyId || null,
    sessionType: targetDevice.oneTimePrekey ? prekeySessionType : establishedSessionType,
  });
};

export const ensureInboundPairwiseSession = async ({
  sessionManager,
  prekeyService,
  localDevice,
  currentDeviceId,
  remoteUserId,
  remoteDeviceId,
  recipientUserId,
  recipientDeviceId,
  envelope,
  sessionSalt = PAIRWISE_SESSION_SALT,
  defaultSessionType = ESTABLISHED_SESSION_TYPE,
}) => {
  if (!envelope.senderIdentityKey) {
    throw new Error('Encrypted envelope is missing the sender identity key.');
  }
  if (!remoteDeviceId) {
    throw new Error('Encrypted envelope is missing the sender device ID.');
  }

  if (
    envelope.recipientSignedPrekeyId != null
    && Number(envelope.recipientSignedPrekeyId) !== Number(localDevice.signedPrekey.keyId)
  ) {
    throw new Error('Encrypted envelope targets an unknown signed prekey.');
  }

  const sharedSecrets = [
    await prekeyService.deriveAgreementBytes({
      localPrivateKeyJwk: localDevice.identityKey.privateKeyJwk,
      suiteId: localDevice.cryptoProfile.agreementSuite,
      remotePublicKey: envelope.senderIdentityKey,
    }),
    await prekeyService.deriveAgreementBytes({
      localPrivateKeyJwk: localDevice.signedPrekey.privateKeyJwk,
      suiteId: localDevice.cryptoProfile.agreementSuite,
      remotePublicKey: envelope.senderIdentityKey,
    }),
  ];

  if (envelope.recipientOneTimePrekeyId != null) {
    const oneTimePrekey = (localDevice.oneTimePrekeys || []).find(
      (prekey) => Number(prekey.prekeyId) === Number(envelope.recipientOneTimePrekeyId)
    );
    if (!oneTimePrekey?.privateKeyJwk) {
      throw new Error('Encrypted envelope targets an unknown one-time prekey.');
    }
    sharedSecrets.push(await prekeyService.deriveAgreementBytes({
      localPrivateKeyJwk: oneTimePrekey.privateKeyJwk,
      suiteId: localDevice.cryptoProfile.agreementSuite,
      remotePublicKey: envelope.senderIdentityKey,
    }));
  }

  const keyMaterial = await prekeyService.deriveSessionKey({
    sharedSecrets,
    salt: sessionSalt,
    info: buildSessionInfo({
      senderUserId: remoteUserId,
      senderDeviceId: remoteDeviceId,
      recipientUserId,
      recipientDeviceId: recipientDeviceId || currentDeviceId,
    }),
  });

  return buildSessionRecord({
    sessionManager,
    localDeviceId: currentDeviceId,
    remoteUserId,
    remoteDeviceId,
    remoteIdentityKey: envelope.senderIdentityKey,
    keyMaterial,
    senderIdentityKey: envelope.senderIdentityKey,
    senderAgreementSuite: envelope.senderAgreementSuite
      || prekeyService.inferAgreementSuiteId(envelope.senderIdentityKey),
    recipientSignedPrekeyId: Number(envelope.recipientSignedPrekeyId ?? localDevice.signedPrekey.keyId),
    recipientOneTimePrekeyId: envelope.recipientOneTimePrekeyId != null
      ? Number(envelope.recipientOneTimePrekeyId)
      : null,
    sessionType: envelope.sessionType || defaultSessionType,
  });
};

export const hydrateTargetsWithClaimedPrekeys = async ({
  deviceManager,
  sessionManager,
  localDeviceId,
  senderUserId,
  targetDevices,
}) => {
  if (typeof deviceManager.fetchUserDeviceBundles !== 'function') {
    return targetDevices;
  }

  const userIdsNeedingClaims = new Set();
  for (const targetDevice of targetDevices) {
    if (Number(targetDevice.userId) === Number(senderUserId) || targetDevice.oneTimePrekey?.publicKey) {
      continue;
    }

    const existingSession = await sessionManager.getSession(localDeviceId, targetDevice.deviceId);
    if (existingSession?.keyMaterial) {
      continue;
    }

    userIdsNeedingClaims.add(Number(targetDevice.userId));
  }

  if (userIdsNeedingClaims.size === 0) {
    return targetDevices;
  }

  const claimResults = await Promise.allSettled(
    Array.from(userIdsNeedingClaims).map((userId) => deviceManager.fetchUserDeviceBundles(userId, {
      claimPrekeys: true,
    }))
  );

  const claimedBundles = claimResults
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  return mergeClaimedPrekeys({ targetDevices, claimedBundles });
};

export const createDirectMessageService = ({
  deviceManager,
  sessionManager,
  prekeyService,
}) => {
  const deriveOutboundSession = async ({
    localDevice,
    senderUserId,
    targetDevice,
  }) => {
    return ensureOutboundPairwiseSession({
      sessionManager,
      prekeyService,
      localDevice,
      senderUserId,
      targetDevice,
    });
  };

  const deriveInboundSession = async ({
    localDevice,
    currentDeviceId,
    message,
    envelope,
  }) => {
    return ensureInboundPairwiseSession({
      sessionManager,
      prekeyService,
      localDevice,
      currentDeviceId,
      remoteUserId: message.senderUserId,
      remoteDeviceId: message.senderDeviceId,
      recipientUserId: message.recipientUserId,
      recipientDeviceId: message.recipientDeviceId || currentDeviceId,
      envelope,
    });
  };

  const encryptMessage = async ({
    conversation,
    plaintext,
    senderUserId,
    currentDeviceId,
  }) => {
    const localDevice = await deviceManager.getLocalDevice(currentDeviceId);
    if (!localDevice) {
      throw new Error('Local chat device keys are unavailable for encrypted DM delivery.');
    }

    const bundleRoster = await deviceManager.fetchConversationDeviceBundles(conversation.conversationId, {
      claimPrekeys: false,
    });
    const remoteMembers = (bundleRoster.members || []).filter((member) => Number(member.userId) !== Number(senderUserId));
    if (remoteMembers.length === 0 || remoteMembers.every((member) => (member.devices || []).length === 0)) {
      throw new Error('The recipient does not have an active encrypted chat device yet.');
    }

    let targetDevices = buildTargetDevices({
      bundleRoster,
      localDevice,
      senderUserId,
    });
    targetDevices = await hydrateTargetsWithClaimedPrekeys({
      deviceManager,
      sessionManager,
      localDeviceId: localDevice.deviceId,
      senderUserId,
      targetDevices,
    });

    const payloads = [];
    for (const targetDevice of targetDevices) {
      const session = await deriveOutboundSession({
        localDevice,
        senderUserId,
        targetDevice,
      });
      const aad = buildAssociatedData({
        conversationId: conversation.conversationId,
        senderUserId,
        senderDeviceId: localDevice.deviceId,
        recipientUserId: targetDevice.userId,
        recipientDeviceId: targetDevice.deviceId,
        conversationEpoch: conversation.currentEpoch,
        protocolVersion: E2EE_PROTOCOL_VERSION,
        sessionType: session.sessionType,
      });
      const encryptedPayload = await prekeyService.encryptText({
        keyMaterial: session.keyMaterial,
        plaintext,
        aad,
      });
      const envelope = serializeEnvelope({
        nonce: encryptedPayload.nonce,
        aad,
        ciphertext: encryptedPayload.ciphertext,
        sessionType: session.sessionType,
        senderIdentityKey: session.senderIdentityKey,
        senderAgreementSuite: session.senderAgreementSuite,
        recipientSignedPrekeyId: session.recipientSignedPrekeyId,
        recipientOneTimePrekeyId: session.recipientOneTimePrekeyId,
      });

      payloads.push({
        deliveryScope: 'device',
        recipientUserId: targetDevice.userId,
        recipientDeviceId: targetDevice.deviceId,
        ciphertext: envelope,
        nonce: encryptedPayload.nonce,
        aad,
      });

    }

    return {
      protocolVersion: E2EE_PROTOCOL_VERSION,
      messageType: 'chat',
      conversationEpoch: conversation.currentEpoch,
      payloads,
    };
  };

  const decryptMessage = async ({
    conversation,
    message,
    currentDeviceId,
  }) => {
    const localDevice = await deviceManager.getLocalDevice(currentDeviceId);
    if (!localDevice) {
      const display = resolveDisplayState({
        conversation,
        message,
        failureReason: 'missing_local_keys',
      });
      return {
        ...message,
        ciphertext: display.displayText,
        bodyText: display.displayText,
        messageState: display.messageState,
      };
    }

    const envelope = normalizeEnvelope(message);
    let session = await sessionManager.getSession(localDevice.deviceId, message.senderDeviceId);
    let decryptedText = null;

    if (!session?.keyMaterial && envelope.senderIdentityKey) {
      try {
        session = await deriveInboundSession({
          localDevice,
          currentDeviceId,
          message,
          envelope,
        });
      } catch (_error) {
        session = null;
      }
    }

    if (session?.keyMaterial && envelope.ciphertext && (envelope.nonce || message.nonce)) {
      try {
        decryptedText = await prekeyService.decryptText({
          keyMaterial: session.keyMaterial,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce || message.nonce,
          aad: envelope.aad || message.aad || '',
        });
      } catch (_error) {
        decryptedText = null;
      }
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
    encryptMessage,
    decryptMessage,
  };
};
