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

const waitForChatDeviceReady = (preferredDeviceId = null) => waitFor(
  () => cy.request(buildE2eeBootstrapUrl(preferredDeviceId)).its('body'),
  (body) => Boolean(body?.enabled && body?.has_active_device && body?.current_device_id),
  {
    timeout: 45000,
    interval: 1200,
    errorMessage: 'Timed out while waiting for the encrypted chat device bootstrap to become ready.',
  }
);

const assertChatMessageVisible = (text, options = {}) => (
  cy.contains('.chat-message p', text, options)
    .scrollIntoView()
    .should('be.visible')
);

const assertChatThreadContains = (text, options = {}) => (
  cy.get('.chat-messages', options).should('contain.text', text)
);

const waitForLiveDbMessageState = ({ dbName, conversationId, expectedMessageCount, expectedPayloadCount }) => {
  const escapedConversationId = sqlEscape(conversationId);

  return waitFor(
    () => cy.task('spacetimeSql', {
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
    }),
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

  it('delivers encrypted DMs across separate browser key stores and can prove the raw payloads landed in SpaceTime', () => {
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
    cy.get('textarea[placeholder="Type a message"]').type(firstMessage);
    cy.contains('button', /^Send$/).click();
    cy.get('.chat-action-error').should('not.exist');
    assertChatMessageVisible(firstMessage, { timeout: 30000 });

    if (liveSpacetimeAssertionsEnabled) {
      cy.then(() => {
        expect(liveDbName).to.be.a('string').and.not.be.empty;
        expect(aliceDeviceId).to.be.a('string').and.not.be.empty;
        expect(bobDeviceId).to.be.a('string').and.not.be.empty;
      });

      waitForLiveDbMessageState({
        dbName: liveDbName,
        conversationId,
        expectedMessageCount: 1,
        expectedPayloadCount: 2,
      }).then(({ conversationRows, messageRows, payloadRows }) => {
        expect(conversationRows[0].encryption_mode).to.eq('e2ee_v1');
        expect(Number(messageRows[0].sender_user_id)).to.eq(alice.id);
        expect(messageRows[0].sender_device_id).to.eq(aliceDeviceId);
        expect(messageRows[0].protocol_version).to.eq('e2ee_v1');

        const recipientDeviceIds = payloadRows.map((row) => row.recipient_device_id).sort();
        expect(recipientDeviceIds).to.deep.eq([aliceDeviceId, bobDeviceId].sort());
        payloadRows.forEach((row) => {
          expect(row.delivery_scope).to.eq('device');
          expect(String(row.ciphertext || '')).to.not.equal(firstMessage);
          expect(String(row.ciphertext || '')).to.not.include(firstMessage);
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

    cy.get('textarea[placeholder="Type a message"]').type(replyMessage);
    cy.contains('button', /^Send$/).click();
    assertChatMessageVisible(replyMessage, { timeout: 30000 });

    if (liveSpacetimeAssertionsEnabled) {
      waitForLiveDbMessageState({
        dbName: liveDbName,
        conversationId,
        expectedMessageCount: 2,
        expectedPayloadCount: 4,
      }).then(({ messageRows, payloadRows }) => {
        expect(messageRows).to.have.length(2);
        expect(Number(messageRows[1].sender_user_id)).to.eq(bob.id);
        expect(messageRows[1].sender_device_id).to.eq(bobDeviceId);

        const replyPayloads = payloadRows.slice(-2);
        const recipientDeviceIds = replyPayloads.map((row) => row.recipient_device_id).sort();
        expect(recipientDeviceIds).to.deep.eq([aliceDeviceId, bobDeviceId].sort());
        replyPayloads.forEach((row) => {
          expect(String(row.ciphertext || '')).to.not.equal(replyMessage);
          expect(String(row.ciphertext || '')).to.not.include(replyMessage);
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
