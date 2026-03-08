describe('Chat Device Management', () => {
  const testUser = {
    username: `test_dev_mgr_${Date.now()}`,
    email: `test_dev_mgr_${Date.now()}@example.com`,
    password: 'Password123!',
  };

  before(() => {
    cy.ensureUserExists(testUser);
  });

  it('manually registers the first device and then enables encrypted chat', () => {
    cy.login(testUser.username, testUser.password);
    
    // 1. Visit chat and see setup required
    cy.visit('/chat');
    cy.contains('span', /Encryption/i).should('be.visible');
    
    // We might need to clear indexedDB to ensure we see the "Register" button if 
    // automatic registration was triggered but we want to test the manual one.
    // However, the button appears if e2ee.hasActiveDevice is false.
    
    cy.get('.chat-security-subpanel').within(() => {
      cy.contains('Register this browser').should('be.visible');
      cy.get('input[placeholder="Browser label"]').type('Primary Chrome');
      cy.contains('button', 'Register This Browser').click();
    });

    // 2. Verify status changes to READY
    cy.contains('.status-badge', 'READY', { timeout: 10000 }).should('be.visible');
    cy.contains('strong', 'Primary Chrome').should('be.visible');
    cy.contains('span', 'primary · current').should('be.visible');
  });

  it('handles the device linking flow (simulated)', () => {
    // This test assumes the user already has one device from the previous test
    cy.login(testUser.username, testUser.password);
    cy.visit('/chat');

    // Simulate a "New Browser" by clearing the local device store
    // Note: This relies on the implementation using IndexedDB named 'llm-social-network-chat-e2ee'
    cy.window().then(async (win) => {
      await win.indexedDB.deleteDatabase('llm-social-network-chat-e2ee');
    });
    
    cy.reload();
    
    // Now it should show "Link this browser" because hasActiveDevice is true but local keys are gone
    cy.get('.chat-security-subpanel').within(() => {
      cy.contains('Link this browser').should('be.visible');
      cy.get('input[placeholder="Browser label"]').type('Linked Browser');
      cy.contains('button', 'Link This Browser').click();
    });

    // Capture the Session ID and Code
    cy.get('.chat-link-metadata').then(($meta) => {
      const text = $meta.text();
      const sessionId = text.match(/Session (\d+)/)[1];
      const approvalCode = $meta.find('strong').text();

      cy.log(`Linking Session: ${sessionId}, Code: ${approvalCode}`);

      // Now we "Approve" it via API (simulating the other device)
      // In a real UI test we would open another window, but for CI we use the API
      cy.request({
        method: 'POST',
        url: '/api/v1/chat/e2ee/device-links/approve',
        body: {
          link_session_id: Number(sessionId),
          approval_code: approvalCode
        }
      });

      // Complete the link
      cy.contains('button', 'Complete Link').click();
      
      // Verify success
      cy.contains('.status-badge', 'READY', { timeout: 10000 }).should('be.visible');
      cy.contains('strong', 'Linked Browser').should('be.visible');
      cy.contains('span', 'linked · current').should('be.visible');
    });
  });
});
