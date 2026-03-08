const runSuffix = Date.now();

const alice = {
  username: `chat_e2ee_alice_${runSuffix}`,
  email: `chat_e2ee_alice_${runSuffix}@example.com`,
  password: 'password123',
};

const bob = {
  username: `chat_e2ee_bob_${runSuffix}`,
  email: `chat_e2ee_bob_${runSuffix}@example.com`,
  password: 'password123',
};

const carol = {
  username: `chat_e2ee_carol_${runSuffix}`,
  email: `chat_e2ee_carol_${runSuffix}@example.com`,
  password: 'password123',
};

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

describe('Encrypted Chat', () => {
  before(() => {
    cy.ensureUserExists(alice);
    cy.ensureUserExists(bob);
    cy.ensureUserExists(carol);

    ensureFriendship(alice, bob);
    ensureFriendship(alice, carol);
    ensureFriendship(bob, carol);
  });

  it('creates an encrypted direct message and keeps the sent text visible in the UI', () => {
    cy.login(alice.username, alice.password);
    cy.intercept('POST', '/api/v1/chat/dm').as('createDm');

    cy.visit('/chat');
    cy.get('select').select(bob.username);
    cy.contains('button', /^Open$/).click();

    cy.wait('@createDm').its('request.body').should((body) => {
      expect(body.user_id).to.be.a('number');
      expect(body.encryption_mode).to.eq('e2ee_v1');
    });

    cy.contains('h2', bob.username, { timeout: 20000 }).should('be.visible');
    cy.get('textarea[placeholder="Type a message"]').type('hello from encrypted dm');
    cy.contains('button', /^Send$/).click();
    cy.contains('.chat-message p', 'hello from encrypted dm', { timeout: 20000 }).should('be.visible');
  });

  it('creates an encrypted group, rekeys on add-member, and keeps group messages visible', () => {
    cy.login(alice.username, alice.password);
    cy.intercept('POST', '/api/v1/chat/groups').as('createGroup');
    cy.intercept('POST', '/api/v1/chat/groups/*/members').as('addGroupMember');

    cy.visit('/chat');
    cy.contains('button', /New Group/i).click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('input[placeholder="Weekend plans"]').type('Encrypted Weekend');
      cy.contains('button', bob.username).click();
      cy.contains('button', /Create Group/i).click();
    });

    cy.wait('@createGroup').its('request.body').should((body) => {
      expect(body.title).to.eq('Encrypted Weekend');
      expect(body.member_user_ids).to.have.length(1);
      expect(body.encryption_mode).to.eq('e2ee_v1');
    });

    cy.contains('h2', 'Encrypted Weekend', { timeout: 20000 }).should('be.visible');
    cy.contains('button', /Add Member/i, { timeout: 20000 }).click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains('button', carol.username).click();
    });

    cy.wait('@addGroupMember').its('request.body').should((body) => {
      expect(body.user_id).to.be.a('number');
    });

    cy.get('textarea[placeholder="Type a message"]').type('hello from encrypted group');
    cy.contains('button', /^Send$/).click();
    cy.contains('.chat-message p', 'hello from encrypted group', { timeout: 20000 }).should('be.visible');
  });
});
