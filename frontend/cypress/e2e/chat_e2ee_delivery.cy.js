const runSuffix = Date.now();
const aliceInviteCode = Cypress.env('chatInviteCodeAlice') || Cypress.env('chatInviteCode') || null;
const bobInviteCode = Cypress.env('chatInviteCodeBob') || Cypress.env('chatInviteCode') || null;

const alice = {
  username: `chat_delivery_alice_${runSuffix}`,
  email: `chat_delivery_alice_${runSuffix}@example.com`,
  password: 'password123',
  inviteCode: aliceInviteCode,
};

const bob = {
  username: `chat_delivery_bob_${runSuffix}`,
  email: `chat_delivery_bob_${runSuffix}@example.com`,
  password: 'password123',
  inviteCode: bobInviteCode,
};

const normalizeBoolean = (value) => {
  if (typeof value === 'string') {
    return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
};

const liveSpacetimeAssertionsEnabled = normalizeBoolean(Cypress.env('liveSpacetimeAssertions'));

const sqlEscape = (value) => String(value).replace(/'/g, "''");

const unwrapSpacetimeOption = (value) => {
  if (Array.isArray(value) && value.length === 2) {
    return value[0] === 0 ? value[1] : null;
  }
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'some')) {
      return value.some;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Some')) {
      return value.Some;
    }
  }
  return value ?? null;
};

const timestampToMicros = (value) => {
  if (Array.isArray(value) && value.length === 1) {
    return Number(value[0]);
  }
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, '__timestamp_micros_since_unix_epoch__')) {
      return Number(value.__timestamp_micros_since_unix_epoch__);
    }
    if (Array.isArray(value.elements) && value.elements.length === 1) {
      return Number(value.elements[0]);
    }
  }
  return Number(value || 0);
};

const normalizeSpacetimeRow = (row) => ({
  ...row,
  recipient_user_id: unwrapSpacetimeOption(row.recipient_user_id),
  recipient_device_id: unwrapSpacetimeOption(row.recipient_device_id),
  last_message_id: unwrapSpacetimeOption(row.last_message_id),
  created_at_micros: timestampToMicros(row.created_at),
});

const ensureFriendship = (sender, receiver) => {
  let requestId;

  return cy.login(sender.username, sender.password)
    .then(() => cy.sendFriendRequestTo(receiver.username))
    .then((nextRequestId) => {
      requestId = nextRequestId;
      return cy.login(receiver.username, receiver.password);
    })
    .then(() => cy.acceptFriendRequest(requestId))
    .then(() => cy.logout());
};

const resolveAuthenticatedUserId = (user) => {
  return cy.login(user.username, user.password)
    .then(() => cy.request('/api/v1/profiles/me').its('body.user.id'))
    .then((userId) => {
      user.id = Number(userId);
      return cy.logout();
    });
};

const waitFor = (producer, predicate, {
  timeout = 30000,
  interval = 1000,
  errorMessage = 'Timed out while waiting for the expected chat state.',
} = {}) => {
  const startedAt = Date.now();

  const poll = () => (
    producer().then((result) => {
      if (predicate(result)) {
        return result;
      }

      if (Date.now() - startedAt >= timeout) {
        throw new Error(errorMessage);
      }

      return cy.wait(interval, { log: false }).then(poll);
    })
  );

  return cy.wrap(null, { log: false }).then(poll);
};

const buildE2eeBootstrapUrl = (preferredDeviceId = null) => (
  preferredDeviceId
    ? `/api/v1/chat/e2ee/bootstrap?preferred_device_id=${encodeURIComponent(preferredDeviceId)}`
    : '/api/v1/chat/e2ee/bootstrap'
);

const latestIndexedDbDeviceId = (snapshot) => {
  const devices = Array.isArray(snapshot?.stores?.devices) ? snapshot.stores.devices : [];
  return devices
    .map((device) => device?.deviceId)
    .filter(Boolean)
    .at(-1) || null;
};

const waitForChatDeviceReady = (preferredDeviceId = null) => waitFor(
  () => {
    const preferredDeviceIdChain = preferredDeviceId
      ? cy.wrap(preferredDeviceId, { log: false })
      : cy.captureChatE2eeState().then((snapshot) => latestIndexedDbDeviceId(snapshot));

    return preferredDeviceIdChain.then((resolvedDeviceId) => (
      cy.request(buildE2eeBootstrapUrl(resolvedDeviceId))
        .its('body')
        .then((body) => ({
          body,
          resolvedDeviceId,
        }))
    ));
  },
  ({ body }) => Boolean(body?.enabled && body?.has_active_device && body?.current_device_id),
  {
    timeout: 45000,
    interval: 1200,
    errorMessage: 'Timed out while waiting for the encrypted chat device bootstrap to become ready.',
  }
).then(({ body, resolvedDeviceId }) => ({
  ...body,
  current_device_id: body?.current_device_id || resolvedDeviceId || null,
}));

const assertChatMessageVisible = (text, options = {}) => (
  cy.contains('.chat-message p', text, options)
    .scrollIntoView()
    .should('be.visible')
);

const assertChatThreadContains = (text, options = {}) => (
  cy.get('.chat-messages', options).should('contain.text', text)
);

const queryLiveDbMessageState = ({ dbName, conversationId }) => {
  const escapedConversationId = sqlEscape(conversationId);

  return cy.task('spacetimeSql', {
    dbName,
    sql: `
      SELECT conversation_id, encryption_mode, current_epoch
      FROM conversation
      WHERE conversation_id = '${escapedConversationId}';

      SELECT *
      FROM message
      WHERE conversation_id = '${escapedConversationId}';

      SELECT *
      FROM message_payload
      WHERE conversation_id = '${escapedConversationId}';
    `,
  }).then((rows) => {
    const normalizedRows = rows.map(normalizeSpacetimeRow);
    const conversationRows = normalizedRows.filter((row) => row.conversation_id === conversationId && row.encryption_mode != null);
    const messageRows = normalizedRows
      .filter((row) => row.message_id && row.sender_user_id != null)
      .sort((left, right) => left.created_at_micros - right.created_at_micros);
    const payloadRows = normalizedRows
      .filter((row) => row.payload_id && row.delivery_scope)
      .sort((left, right) => left.created_at_micros - right.created_at_micros);

    return {
      conversationRows,
      messageRows,
      payloadRows,
    };
  });
};

const captureLiveDbBaseline = ({ dbName, conversationId }) => (
  queryLiveDbMessageState({ dbName, conversationId }).then(({ messageRows, payloadRows }) => ({
    messageCount: messageRows.length,
    payloadCount: payloadRows.length,
    latestMessageMicros: messageRows.at(-1)?.created_at_micros || 0,
    latestPayloadMicros: payloadRows.at(-1)?.created_at_micros || 0,
  }))
);

const waitForLiveDbMessageState = ({ dbName, conversationId, expectedMessageCount, expectedPayloadCount }) => {
  return waitFor(
    () => queryLiveDbMessageState({ dbName, conversationId }),
    (state) => (
      state.conversationRows.length === 1
      && state.messageRows.length >= expectedMessageCount
      && state.payloadRows.length >= expectedPayloadCount
    ),
    {
      timeout: 45000,
      interval: 1500,
      errorMessage: `Timed out while waiting for live SpaceTime rows for ${conversationId}.`,
    }
  );
};

const filterRowsAfterMicros = (rows, baselineMicros) => (
  rows.filter((row) => Number(row.created_at_micros || 0) > Number(baselineMicros || 0))
);

const findLatestMessageBySender = ({ messageRows, senderUserId, senderDeviceId, baselineMicros = 0 }) => (
  filterRowsAfterMicros(messageRows, baselineMicros)
    .filter((row) => Number(row.sender_user_id) === Number(senderUserId) && row.sender_device_id === senderDeviceId)
    .at(-1) || null
);

const bootstrapBrowserDevice = (user) => {
  return cy.visit('/login')
    .then(() => cy.clearChatE2eeState())
    .then(() => cy.login(user.username, user.password))
    .then(() => cy.visit('/chat'))
    .then(() => {
      cy.contains('.chat-pill', /^Live$/, { timeout: 30000 }).should('be.visible');
      cy.get('.chat-action-error').should('not.exist');
      return waitForChatDeviceReady();
    })
    .then((bootstrap) => (
      cy.captureChatE2eeState().then((snapshot) => ({
        snapshot,
        deviceId: bootstrap.current_device_id,
      }))
    ))
    .then((result) => cy.logout().then(() => result));
};

const switchToBrowser = (user, snapshot, deviceId) => {
  return cy.visit('/login')
    .then(() => cy.restoreChatE2eeState(snapshot))
    .then(() => cy.login(user.username, user.password))
    .then(() => cy.visit('/chat'))
    .then(() => {
      cy.contains('.chat-pill', /^Live$/, { timeout: 30000 }).should('be.visible');
      cy.get('.chat-action-error').should('not.exist');
      return waitForChatDeviceReady(deviceId);
    });
};

describe('Encrypted Chat Delivery', () => {
  const firstMessage = `hello from alice ${runSuffix}`;
  const replyMessage = `hello back from bob ${runSuffix}`;

  let liveDbName = null;
  let conversationId = null;
  let aliceSnapshot = null;
  let bobSnapshot = null;
  let aliceDeviceId = null;
  let bobDeviceId = null;

  before(() => {
    cy.ensureUserExists(alice);
    cy.ensureUserExists(bob);
    ensureFriendship(alice, bob);
    resolveAuthenticatedUserId(alice);
    resolveAuthenticatedUserId(bob);

    bootstrapBrowserDevice(alice).then(({ snapshot, deviceId }) => {
      aliceSnapshot = snapshot;
      aliceDeviceId = deviceId;
    });

    bootstrapBrowserDevice(bob).then(({ snapshot, deviceId }) => {
      bobSnapshot = snapshot;
      bobDeviceId = deviceId;
    });
  });

  it('delivers encrypted DMs across separate browser key stores and can prove the raw payloads landed in SpaceTime', { retries: 0 }, () => {
    let aliceSendBaseline = null;
    let bobReplyBaseline = null;

    switchToBrowser(alice, aliceSnapshot, aliceDeviceId);

    cy.request('/api/v1/chat/bootstrap').its('body').then((bootstrap) => {
      liveDbName = bootstrap.db_name;

      if (!liveSpacetimeAssertionsEnabled) {
        return;
      }

      const expectedDbName = Cypress.env('spacetimeDbName');
      if (expectedDbName) {
        expect(bootstrap.db_name).to.eq(expectedDbName);
      } else if (normalizeBoolean(Cypress.env('requireTestDbName'))) {
        expect(String(bootstrap.db_name).toLowerCase()).to.include('test');
      }
    });

    cy.intercept('POST', '/api/v1/chat/dm').as('createDm');
    cy.get('select').select(bob.username);
    cy.contains('button', /^Open$/).click();

    cy.wait('@createDm').then((interception) => {
      expect(interception.request.body.encryption_mode).to.eq('e2ee_v1');
      expect(interception.response?.statusCode).to.eq(200);
      conversationId = interception.response?.body?.conversation_id;
      expect(conversationId).to.match(/^dm:/);
    });

    cy.contains('.chat-list-item', bob.username, { timeout: 20000 })
      .scrollIntoView()
      .should('contain.text', bob.username);

    if (liveSpacetimeAssertionsEnabled) {
      cy.then(() => {
        expect(liveDbName).to.be.a('string').and.not.be.empty;
        return captureLiveDbBaseline({
          dbName: liveDbName,
          conversationId,
        }).then((baseline) => {
          aliceSendBaseline = baseline;
        });
      });
    }

    cy.get('textarea[placeholder="Type a message"]').type(firstMessage);
    cy.contains('button', /^Send$/).click();
    cy.get('.chat-action-error').should('not.exist');
    assertChatMessageVisible(firstMessage, { timeout: 30000 });

    if (liveSpacetimeAssertionsEnabled) {
      cy.then(() => {
        expect(liveDbName).to.be.a('string').and.not.be.empty;
        expect(aliceSendBaseline).to.not.equal(null);
        expect(aliceDeviceId).to.be.a('string').and.not.be.empty;
        expect(bobDeviceId).to.be.a('string').and.not.be.empty;
        return waitForLiveDbMessageState({
          dbName: liveDbName,
          conversationId,
          expectedMessageCount: aliceSendBaseline.messageCount + 1,
          expectedPayloadCount: aliceSendBaseline.payloadCount + 2,
        }).then(({ conversationRows, messageRows, payloadRows }) => {
          const latestAliceMessage = findLatestMessageBySender({
            messageRows,
            senderUserId: alice.id,
            senderDeviceId: aliceDeviceId,
            baselineMicros: aliceSendBaseline.latestMessageMicros,
          });

          expect(conversationRows[0].encryption_mode).to.eq('e2ee_v1');
          expect(latestAliceMessage, 'latest Alice message after live DB baseline').to.exist;
          expect(Number(latestAliceMessage.sender_user_id)).to.eq(alice.id);
          expect(latestAliceMessage.sender_device_id).to.eq(aliceDeviceId);
          expect(latestAliceMessage.protocol_version).to.eq('e2ee_v1');

          const latestAlicePayloads = filterRowsAfterMicros(payloadRows, aliceSendBaseline.latestPayloadMicros)
            .filter((row) => row.message_id === latestAliceMessage.message_id);

          expect(latestAlicePayloads).to.have.length(2);

          const recipientDeviceIds = latestAlicePayloads.map((row) => row.recipient_device_id).sort();
          expect(recipientDeviceIds).to.deep.eq([aliceDeviceId, bobDeviceId].sort());
          latestAlicePayloads.forEach((row) => {
            expect(row.delivery_scope).to.eq('device');
            expect(String(row.ciphertext || '')).to.not.equal(firstMessage);
            expect(String(row.ciphertext || '')).to.not.include(firstMessage);
          });
        });
      });
    }

    cy.reload();
    assertChatThreadContains(firstMessage, { timeout: 30000 });
    cy.captureChatE2eeState().then((snapshot) => {
      aliceSnapshot = snapshot;
    });

    switchToBrowser(bob, bobSnapshot, bobDeviceId);

    cy.contains('.chat-list-item', alice.username, { timeout: 30000 })
      .scrollIntoView()
      .click({ force: true });
    assertChatMessageVisible(firstMessage, { timeout: 30000 });
    cy.get('.chat-action-error').should('not.exist');

    if (liveSpacetimeAssertionsEnabled) {
      cy.then(() => (
        captureLiveDbBaseline({
          dbName: liveDbName,
          conversationId,
        }).then((baseline) => {
          bobReplyBaseline = baseline;
        })
      ));
    }

    cy.get('textarea[placeholder="Type a message"]').type(replyMessage);
    cy.contains('button', /^Send$/).click();
    assertChatMessageVisible(replyMessage, { timeout: 30000 });

    if (liveSpacetimeAssertionsEnabled) {
      cy.then(() => {
        expect(bobReplyBaseline).to.not.equal(null);
        return waitForLiveDbMessageState({
          dbName: liveDbName,
          conversationId,
          expectedMessageCount: bobReplyBaseline.messageCount + 1,
          expectedPayloadCount: bobReplyBaseline.payloadCount + 2,
        }).then(({ messageRows, payloadRows }) => {
          const latestBobMessage = findLatestMessageBySender({
            messageRows,
            senderUserId: bob.id,
            senderDeviceId: bobDeviceId,
            baselineMicros: bobReplyBaseline.latestMessageMicros,
          });

          expect(latestBobMessage, 'latest Bob reply after live DB baseline').to.exist;
          expect(Number(latestBobMessage.sender_user_id)).to.eq(bob.id);
          expect(latestBobMessage.sender_device_id).to.eq(bobDeviceId);

          const replyPayloads = filterRowsAfterMicros(payloadRows, bobReplyBaseline.latestPayloadMicros)
            .filter((row) => row.message_id === latestBobMessage.message_id);

          expect(replyPayloads).to.have.length(2);

          const recipientDeviceIds = replyPayloads.map((row) => row.recipient_device_id).sort();
          expect(recipientDeviceIds).to.deep.eq([aliceDeviceId, bobDeviceId].sort());
          replyPayloads.forEach((row) => {
            expect(String(row.ciphertext || '')).to.not.equal(replyMessage);
            expect(String(row.ciphertext || '')).to.not.include(replyMessage);
          });
        });
      });
    }

    cy.reload();
    assertChatThreadContains(replyMessage, { timeout: 30000 });
    cy.captureChatE2eeState().then((snapshot) => {
      bobSnapshot = snapshot;
    });

    switchToBrowser(alice, aliceSnapshot, aliceDeviceId);

    cy.contains('.chat-list-item', bob.username, { timeout: 30000 })
      .scrollIntoView()
      .click({ force: true });
    assertChatThreadContains(firstMessage, { timeout: 30000 });
    assertChatThreadContains(replyMessage, { timeout: 30000 });
    cy.get('.chat-action-error').should('not.exist');
  });
});
