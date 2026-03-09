// ***********************************************************
// This example support/e2e.js is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Import commands.js using ES2015 syntax:
import './commands'

// Global before hook to reset test user state
before(() => {
  const baseUrl = String(Cypress.config('baseUrl') || '');
  const explicitToggle = Cypress.env('testSetupEnabled');
  const normalizedExplicitToggle = typeof explicitToggle === 'string'
    ? !['0', 'false', 'no', 'off'].includes(explicitToggle.trim().toLowerCase())
    : explicitToggle;
  const shouldRunTestSetup = explicitToggle == null
    ? /localhost|127\.0\.0\.1/.test(baseUrl)
    : Boolean(normalizedExplicitToggle);

  if (!shouldRunTestSetup) {
    cy.log('Skipping local test-setup bootstrap for this Cypress target.');
    return;
  }

  cy.log('Attempting to reset testuser state before all tests...');
  let resetSuccessful = false;

  // IMPORTANT: Replace '/api/v1/test-setup/reset-user-state' 
  // with your actual backend endpoint for resetting the user.
  // The body should match what your backend endpoint expects.
  cy.request({
    method: 'POST',
    url: '/api/v1/test-setup/reset-user-state',
    body: {
      username: 'testuser', // Standardize the username
      // Ensure these details match the expected baseline state for 'testuser'
      // For example, set a default number of invites.
      // This body structure depends on your backend API.
      desired_state: { 
        password: 'password', // Ensure password is reset to known value
        invites_left: 10,     // Reset invites_left to a healthy number
        is_active: true
      }
    },
    failOnStatusCode: false // Set to true if test suite should halt on reset failure
  }).then((response) => {
    if (response.status === 200 || response.status === 204) {
      cy.log('STATE RESET SUCCEEDED: testuser state reset successfully via API.');
      resetSuccessful = true;
    } else {
      const errorMessage = `STATE RESET FAILED: Failed to reset testuser state. Backend responded with Status: ${response.status}. Body: ${JSON.stringify(response.body)}`;
      cy.log(errorMessage);
      // Depending on your needs, you might want to throw an error to stop the tests:
      // throw new Error('Critical testuser state reset failed. Halting tests.');
      // Or, allow tests to continue but with a clear warning.
    }
  }).then(() => {
    // This .then() ensures the cy.request has completed before the next steps.
    if (resetSuccessful) {
      cy.log('Proceeding to login testuser after successful state reset.');
      cy.login('testuser', 'password').then(() => {
        cy.log('LOGIN SUCCEEDED: Confirmed testuser can log in after state reset attempt.');
      });
    } else {
      cy.log('Skipping testuser login attempt because state reset failed.');
      // Optionally, throw an error here to halt all tests if reset is critical
      throw new Error('Halting tests: testuser state reset failed, cannot proceed with login check.');
    }
  });
  // Clear any cookies that might have been set by the login above,
  // so each spec file starts truly fresh if that's the desired behavior.
  // However, cy.session in cy.login is designed to cache across specs,
  // so clearing cookies here might negate some of its benefits unless done carefully.
  // Consider if this is needed based on your cy.session strategy.
  // cy.clearCookies(); 
});

// You can also clear session storage or local storage if your app uses them for auth/state
// beforeEach(() => {
//   cy.clearLocalStorage();
// });
