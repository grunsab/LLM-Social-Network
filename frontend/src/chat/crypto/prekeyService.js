import {
  bytesToBase64,
  base64ToBytes,
  bytesToUtf8,
  utf8ToBytes,
} from './messageEnvelope.js';

const DEFAULT_ONE_TIME_PREKEY_COUNT = 12;

const AGREEMENT_SUITES = [
  {
    id: 'x25519',
    generateKey: { name: 'X25519' },
    importKey: { name: 'X25519' },
    usages: ['deriveKey', 'deriveBits'],
  },
  {
    id: 'ecdh-p256',
    generateKey: { name: 'ECDH', namedCurve: 'P-256' },
    importKey: { name: 'ECDH', namedCurve: 'P-256' },
    usages: ['deriveKey', 'deriveBits'],
  },
];

const SIGNING_SUITES = [
  {
    id: 'ed25519',
    generateKey: { name: 'Ed25519' },
    importKey: { name: 'Ed25519' },
    sign: { name: 'Ed25519' },
    usages: ['sign', 'verify'],
  },
  {
    id: 'ecdsa-p256',
    generateKey: { name: 'ECDSA', namedCurve: 'P-256' },
    importKey: { name: 'ECDSA', namedCurve: 'P-256' },
    sign: { name: 'ECDSA', hash: 'SHA-256' },
    usages: ['sign', 'verify'],
  },
];

const ensureSubtleCrypto = (cryptoImpl) => {
  const subtle = cryptoImpl?.subtle;
  if (!subtle) {
    throw new Error('This browser does not expose Web Crypto SubtleCrypto APIs required for E2EE.');
  }
  return subtle;
};

const supportsSuite = async (subtle, suite) => {
  try {
    const keyPair = await subtle.generateKey(suite.generateKey, true, suite.usages);
    const publicKey = keyPair.publicKey || keyPair;
    await subtle.exportKey('raw', publicKey);
    return true;
  } catch (_error) {
    return false;
  }
};

let cachedAgreementSuite = null;
let cachedSigningSuite = null;

const selectAgreementSuite = async (subtle) => {
  if (cachedAgreementSuite) {
    return cachedAgreementSuite;
  }

  for (const suite of AGREEMENT_SUITES) {
    if (await supportsSuite(subtle, suite)) {
      cachedAgreementSuite = suite;
      return suite;
    }
  }

  throw new Error('This browser does not support a compatible agreement key algorithm for E2EE.');
};

const selectSigningSuite = async (subtle) => {
  if (cachedSigningSuite) {
    return cachedSigningSuite;
  }

  for (const suite of SIGNING_SUITES) {
    if (await supportsSuite(subtle, suite)) {
      cachedSigningSuite = suite;
      return suite;
    }
  }

  throw new Error('This browser does not support a compatible signing key algorithm for E2EE.');
};

const exportPublicKey = async (subtle, key) => bytesToBase64(await subtle.exportKey('raw', key));

const exportPrivateKey = async (subtle, key) => subtle.exportKey('jwk', key);

const concatBytes = (...parts) => {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
};

const importAgreementPrivateKey = async (subtle, suite, privateKeyJwk) => (
  subtle.importKey('jwk', privateKeyJwk, suite.importKey, true, ['deriveKey', 'deriveBits'])
);

const importAgreementPublicKey = async (subtle, suite, publicKeyBase64) => (
  subtle.importKey('raw', base64ToBytes(publicKeyBase64), suite.importKey, true, [])
);

const importSigningPrivateKey = async (subtle, suite, privateKeyJwk) => (
  subtle.importKey('jwk', privateKeyJwk, suite.importKey, true, ['sign'])
);

const generateKeyPair = async (subtle, suite) => subtle.generateKey(suite.generateKey, true, suite.usages);

const getAgreementSuiteById = (suiteId) => AGREEMENT_SUITES.find((suite) => suite.id === suiteId);

const nextPrekeyId = (deviceRecord) => {
  const highestCurrentId = Math.max(
    deviceRecord?.signedPrekey?.keyId || 0,
    ...(deviceRecord?.oneTimePrekeys || []).map((record) => Number(record.prekeyId || 0))
  );
  return highestCurrentId + 1;
};

const createDeviceId = (cryptoImpl) => {
  if (typeof cryptoImpl?.randomUUID === 'function') {
    return `device-${cryptoImpl.randomUUID()}`;
  }
  const randomSuffix = Math.random().toString(36).slice(2, 12);
  return `device-${Date.now().toString(36)}-${randomSuffix}`;
};

const defaultDeviceLabel = () => {
  if (typeof navigator === 'undefined') {
    return 'This browser';
  }

  const platform = navigator.userAgentData?.platform || navigator.platform || 'browser';
  return `This ${platform}`;
};

const createSignedPrekeySignaturePayload = ({ deviceId, prekeyId, publicKey, agreementSuiteId }) => utf8ToBytes(
  JSON.stringify({
    device_id: deviceId,
    prekey_id: prekeyId,
    public_key: publicKey,
    agreement_suite: agreementSuiteId,
  })
);

const serializePrivateRecord = async (subtle, agreementSuite, signingSuite, payload) => ({
  deviceId: payload.deviceId,
  label: payload.label,
  createdAt: payload.createdAt,
  cryptoProfile: {
    agreementSuite: agreementSuite.id,
    signingSuite: signingSuite.id,
  },
  identityKey: {
    publicKey: payload.identityKeyPublic,
    privateKeyJwk: await exportPrivateKey(subtle, payload.identityKeyPair.privateKey),
  },
  signingKey: {
    publicKey: payload.signingKeyPublic,
    privateKeyJwk: await exportPrivateKey(subtle, payload.signingKeyPair.privateKey),
  },
  signedPrekey: {
    keyId: payload.signedPrekeyId,
    publicKey: payload.signedPrekeyPublic,
    privateKeyJwk: await exportPrivateKey(subtle, payload.signedPrekeyPair.privateKey),
    signature: payload.signedPrekeySignature,
    createdAt: payload.createdAt,
  },
  oneTimePrekeys: await Promise.all(payload.oneTimePrekeyPairs.map(async (prekey) => ({
    prekeyId: prekey.prekeyId,
    publicKey: prekey.publicKey,
    privateKeyJwk: await exportPrivateKey(subtle, prekey.keyPair.privateKey),
    createdAt: payload.createdAt,
  }))),
});

export const createPrekeyService = ({ cryptoImpl = globalThis.crypto } = {}) => {
  const subtle = ensureSubtleCrypto(cryptoImpl);

  const assertSupported = async () => {
    await selectAgreementSuite(subtle);
    await selectSigningSuite(subtle);
    return true;
  };

  const createOneTimePrekeys = async ({ deviceRecord, count }) => {
    const agreementSuite = await selectAgreementSuite(subtle);
    const startId = nextPrekeyId(deviceRecord);
    const prekeys = [];

    for (let index = 0; index < count; index += 1) {
      const keyPair = await generateKeyPair(subtle, agreementSuite);
      const publicKey = await exportPublicKey(subtle, keyPair.publicKey);
      prekeys.push({
        prekeyId: startId + index,
        publicKey,
        privateKeyJwk: await exportPrivateKey(subtle, keyPair.privateKey),
      });
    }

    return prekeys;
  };

  const createSignedPrekeyRotation = async (deviceRecord) => {
    const agreementSuite = await selectAgreementSuite(subtle);
    const signingSuite = await selectSigningSuite(subtle);
    const signingPrivateKey = await importSigningPrivateKey(
      subtle,
      signingSuite,
      deviceRecord.signingKey.privateKeyJwk
    );
    const nextKeyId = nextPrekeyId(deviceRecord);
    const keyPair = await generateKeyPair(subtle, agreementSuite);
    const publicKey = await exportPublicKey(subtle, keyPair.publicKey);
    const signaturePayload = createSignedPrekeySignaturePayload({
      deviceId: deviceRecord.deviceId,
      prekeyId: nextKeyId,
      publicKey,
      agreementSuiteId: agreementSuite.id,
    });
    const signature = await subtle.sign(signingSuite.sign, signingPrivateKey, signaturePayload);

    return {
      signedPrekeyId: nextKeyId,
      signedPrekeyPublic: publicKey,
      signedPrekeySignature: bytesToBase64(signature),
      privateKeyJwk: await exportPrivateKey(subtle, keyPair.privateKey),
      createdAt: new Date().toISOString(),
    };
  };

  const generateDeviceBundle = async ({
    deviceId = createDeviceId(cryptoImpl),
    label = defaultDeviceLabel(),
    oneTimePrekeyCount = DEFAULT_ONE_TIME_PREKEY_COUNT,
  } = {}) => {
    const agreementSuite = await selectAgreementSuite(subtle);
    const signingSuite = await selectSigningSuite(subtle);
    const createdAt = new Date().toISOString();

    const identityKeyPair = await generateKeyPair(subtle, agreementSuite);
    const signingKeyPair = await generateKeyPair(subtle, signingSuite);
    const signedPrekeyPair = await generateKeyPair(subtle, agreementSuite);
    const signedPrekeyId = 1;

    const identityKeyPublic = await exportPublicKey(subtle, identityKeyPair.publicKey);
    const signingKeyPublic = await exportPublicKey(subtle, signingKeyPair.publicKey);
    const signedPrekeyPublic = await exportPublicKey(subtle, signedPrekeyPair.publicKey);

    const signaturePayload = createSignedPrekeySignaturePayload({
      deviceId,
      prekeyId: signedPrekeyId,
      publicKey: signedPrekeyPublic,
      agreementSuiteId: agreementSuite.id,
    });
    const signedPrekeySignature = bytesToBase64(
      await subtle.sign(signingSuite.sign, signingKeyPair.privateKey, signaturePayload)
    );

    const oneTimePrekeyPairs = [];
    for (let index = 0; index < oneTimePrekeyCount; index += 1) {
      const prekeyId = signedPrekeyId + index + 1;
      const keyPair = await generateKeyPair(subtle, agreementSuite);
      const publicKey = await exportPublicKey(subtle, keyPair.publicKey);
      oneTimePrekeyPairs.push({
        prekeyId,
        publicKey,
        keyPair,
      });
    }

    const privateRecord = await serializePrivateRecord(subtle, agreementSuite, signingSuite, {
      deviceId,
      label,
      createdAt,
      identityKeyPublic,
      signingKeyPublic,
      signedPrekeyId,
      signedPrekeyPublic,
      signedPrekeySignature,
      identityKeyPair,
      signingKeyPair,
      signedPrekeyPair,
      oneTimePrekeyPairs,
    });

    return {
      deviceId,
      label,
      createdAt,
      cryptoProfile: privateRecord.cryptoProfile,
      publicBundle: {
        device_id: deviceId,
        label,
        identity_key_public: identityKeyPublic,
        signing_key_public: signingKeyPublic,
        signed_prekey_id: signedPrekeyId,
        signed_prekey_public: signedPrekeyPublic,
        signed_prekey_signature: signedPrekeySignature,
        one_time_prekeys: oneTimePrekeyPairs.map((prekey) => ({
          prekey_id: prekey.prekeyId,
          public_key: prekey.publicKey,
        })),
      },
      privateRecord,
    };
  };

  const importAgreementKeyPair = async (deviceRecord) => {
    const agreementSuite = getAgreementSuiteById(deviceRecord.cryptoProfile.agreementSuite);
    if (!agreementSuite) {
      throw new Error(`Unsupported local agreement suite: ${deviceRecord.cryptoProfile.agreementSuite}`);
    }
    return {
      agreementSuite,
      privateKey: await importAgreementPrivateKey(
        subtle,
        agreementSuite,
        deviceRecord.identityKey.privateKeyJwk
      ),
      publicKey: base64ToBytes(deviceRecord.identityKey.publicKey),
    };
  };

  const inferAgreementSuiteId = (publicKeyBase64) => {
    const keyLength = base64ToBytes(publicKeyBase64).byteLength;
    if (keyLength === 32) {
      return 'x25519';
    }
    if (keyLength === 65) {
      return 'ecdh-p256';
    }
    if (cachedAgreementSuite) {
      return cachedAgreementSuite.id;
    }
    throw new Error('Unable to infer the agreement suite for the provided public key.');
  };

  const deriveAgreementBytes = async ({
    localPrivateKeyJwk,
    suiteId,
    remotePublicKey,
  }) => {
    const agreementSuite = getAgreementSuiteById(suiteId || inferAgreementSuiteId(remotePublicKey));
    if (!agreementSuite) {
      throw new Error(`Unsupported agreement suite: ${suiteId}`);
    }

    const privateKey = await importAgreementPrivateKey(subtle, agreementSuite, localPrivateKeyJwk);
    const publicKey = await importAgreementPublicKey(subtle, agreementSuite, remotePublicKey);
    const sharedSecret = await subtle.deriveBits(
      {
        name: agreementSuite.importKey.name,
        public: publicKey,
      },
      privateKey,
      256
    );
    return new Uint8Array(sharedSecret);
  };

  const deriveSessionKey = async ({
    sharedSecrets,
    salt,
    info,
  }) => {
    if (!Array.isArray(sharedSecrets) || sharedSecrets.length === 0) {
      throw new Error('At least one shared secret is required to derive a session key.');
    }

    const hkdfKey = await subtle.importKey(
      'raw',
      concatBytes(...sharedSecrets),
      'HKDF',
      false,
      ['deriveKey']
    );
    const aesKey = await subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8ToBytes(typeof salt === 'string' ? salt : JSON.stringify(salt ?? {})),
        info: utf8ToBytes(typeof info === 'string' ? info : JSON.stringify(info ?? {})),
      },
      hkdfKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );

    return bytesToBase64(await subtle.exportKey('raw', aesKey));
  };

  const randomBytes = (length) => {
    const out = new Uint8Array(length);
    cryptoImpl.getRandomValues(out);
    return out;
  };

  const generateSymmetricKey = (length = 32) => bytesToBase64(randomBytes(length));

  const importAesKey = async (keyMaterial) => subtle.importKey(
    'raw',
    base64ToBytes(keyMaterial),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );

  const encryptText = async ({
    keyMaterial,
    plaintext,
    aad = '',
  }) => {
    const key = await importAesKey(keyMaterial);
    const nonce = randomBytes(12);
    const ciphertext = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: base64ToBytes(aad),
        tagLength: 128,
      },
      key,
      utf8ToBytes(plaintext)
    );

    return {
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
  };

  const decryptText = async ({
    keyMaterial,
    ciphertext,
    nonce,
    aad = '',
  }) => {
    const key = await importAesKey(keyMaterial);
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(nonce),
        additionalData: base64ToBytes(aad),
        tagLength: 128,
      },
      key,
      base64ToBytes(ciphertext)
    );

    return bytesToUtf8(new Uint8Array(plaintext));
  };

  return {
    DEFAULT_ONE_TIME_PREKEY_COUNT,
    assertSupported,
    generateDeviceBundle,
    createSignedPrekeyRotation,
    createOneTimePrekeys,
    importAgreementKeyPair,
    inferAgreementSuiteId,
    deriveAgreementBytes,
    deriveSessionKey,
    generateSymmetricKey,
    encryptText,
    decryptText,
    decodePublicKey: base64ToBytes,
    encodeBytes: bytesToBase64,
    decodeBytes: base64ToBytes,
    encodeText: (value) => bytesToBase64(utf8ToBytes(value)),
    decodeText: (value) => bytesToUtf8(base64ToBytes(value)),
  };
};
