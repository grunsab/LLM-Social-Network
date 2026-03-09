import { defineConfig } from "cypress";
import { registerSpacetimeTasks } from "./cypress/spacetimeNode.js";

export default defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost:5173',
    setupNodeEvents(on, config) {
      registerSpacetimeTasks(on);
      return config;
    },
    // Viewport settings
    viewportWidth: 1280,
    viewportHeight: 720,
    // Recording settings
    video: true,
    screenshotOnRunFailure: true,
    // Timeouts
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 10000,
    // Retry configuration for CI
    retries: {
      runMode: 2, // Retry failed tests twice in CI
      openMode: 0, // No retries in interactive mode
    },
    // Test isolation
    testIsolation: true,
    // Environment variables
    env: {
      apiUrl: process.env.CYPRESS_API_URL || 'http://localhost:5001',
      liveSpacetimeAssertions: process.env.CYPRESS_LIVE_SPACETIME_ASSERTIONS || '0',
      spacetimeHttpUrl: process.env.CYPRESS_SPACETIME_HTTP_URL || process.env.SPACETIMEDB_HTTP_URL || 'https://maincloud.spacetimedb.com',
      spacetimeDbName: process.env.CYPRESS_SPACETIME_DB_NAME || process.env.SPACETIMEDB_DB_NAME || '',
      spacetimeDbId: process.env.CYPRESS_SPACETIME_DB_ID || process.env.SPACETIMEDB_DB_ID || '',
      requireTestDbName: process.env.CYPRESS_REQUIRE_TEST_DB_NAME || '1',
      testSetupEnabled: process.env.CYPRESS_TEST_SETUP_ENABLED,
      chatInviteCode: process.env.CYPRESS_CHAT_INVITE_CODE || '',
    },
  },
});
