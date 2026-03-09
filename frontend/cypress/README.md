# Cypress E2E Tests

This directory contains end-to-end tests for the Social Network application using Cypress.

## Test Suites

### ✅ Active Tests

1. **auth.cy.js** - Authentication flow tests
   - User login
   - User registration
   - Error handling
   - Invite code validation

2. **category.cy.js** - Category view functionality
   - Display posts by category
   - Category privacy controls
   - Invalid category handling

3. **feed.cy.js** - Main feed functionality
   - Display public posts
   - Friend post visibility
   - Feed pagination with infinite scroll

4. **invites.cy.js** - Invite code management
   - Display invite state
   - Generate new codes
   - Handle invite limits

5. **posts.cy.js** - Post management
   - Create posts
   - Delete posts
   - Add/delete comments
   - Image uploads

6. **chat_e2ee.cy.js** and **chat_e2ee_delivery.cy.js** - Encrypted chat coverage
   - Create encrypted DMs and groups
   - Verify sender-side encrypted DM delivery, live payload fanout, and reload persistence
   - Optionally query live SpaceTime `message` and `message_payload` tables during the test run
   - Use the Playwright live diagnostic for true multi-browser recipient delivery checks

### ⏭️ Skipped Tests

Some tests are currently skipped due to:
- **Privacy settings test**: Backend issue with privacy field
- **Large file upload test**: Complex browser file API mocking
- **Profile tests**: Missing data-cy attributes in Profile component

## Running Tests

### Local Development

```bash
# Run all tests interactively
npm run cypress:open

# Run all tests headlessly
npm run cypress:run

# Run specific test file
npx cypress run --spec "cypress/e2e/auth.cy.js"

# Run the stronger encrypted DM delivery coverage
npm run cypress:chat-live
```

### Live Heroku + SpaceTime diagnostics

The encrypted DM delivery spec can run against a deployed frontend/backend and optionally assert on the raw SpaceTime tables. This is useful when the UI shows "Send" succeeding but no rows appear in SpaceTime.

Recommended environment:

```bash
export CYPRESS_BASE_URL="https://your-heroku-app.herokuapp.com"
export CYPRESS_TEST_SETUP_ENABLED=0
export CYPRESS_LIVE_SPACETIME_ASSERTIONS=1
export CYPRESS_SPACETIME_DB_NAME="your-chat-test-db"
export CYPRESS_SPACETIME_SERVICE_TOKEN="owner-or-admin-token-for-that-test-db"
export CYPRESS_SPACETIME_HTTP_URL="https://maincloud.spacetimedb.com"

npm run cypress:chat-live
```

Notes:

- Point Heroku at a dedicated SpaceTime database with a name like `*-test` before running this spec.
- If `CYPRESS_LIVE_SPACETIME_ASSERTIONS=1` and `CYPRESS_SPACETIME_DB_NAME` is omitted, the spec will require the bootstrapped DB name to include `test` so it does not silently hit production chat storage.
- `CYPRESS_TEST_SETUP_ENABLED=0` disables the local-only `/api/v1/test-setup/reset-user-state` bootstrap endpoint, which does not exist on production deploys.
- The Cypress spec no longer simulates two browser key stores in one browser context, because that produced false decrypt failures unrelated to the deployed app.
- The Cypress spec now proves the sender-side encrypted send path, device-scoped payload insertion, recipient device targeting, and sender reload persistence.
- The real multi-browser diagnostic is:

```bash
PLAYWRIGHT_BASE_URL="https://your-heroku-app.herokuapp.com" \
PLAYWRIGHT_CHAT_INVITE_CODE_ALICE="alice-invite-code" \
PLAYWRIGHT_CHAT_INVITE_CODE_BOB="bob-invite-code" \
npm run playwright:chat-live
```

### CI/CD

Tests run automatically on:
- Push to main branch
- Pull requests
- Daily schedule (2 AM UTC)
- Manual workflow dispatch

## Test Structure

### Setup

- Tests use custom commands defined in `cypress/support/commands.js`
- User data is created/cleaned up within test suites
- Backend and frontend servers must be running

### Custom Commands

- `cy.login(username, password)` - Login with session caching
- `cy.ensureUserExists(userData)` - Create user if doesn't exist
- `cy.createPost(postData)` - Create a post via API
- `cy.sendFriendRequestTo(username)` - Send friend request
- `cy.acceptFriendRequest(requestId)` - Accept friend request
- `cy.deleteAllMyPosts()` - Clean up user's posts

## Troubleshooting

### Common Issues

1. **Tests timing out**: Increase timeout in cypress.config.js
2. **Elements not found**: Check if selectors have changed
3. **API errors**: Ensure backend is running and healthy
4. **Session issues**: Clear Cypress cache

### Debug Mode

```bash
# Run with debug logs
DEBUG=cypress:* npm run cypress:run

# Increase timeout for slow CI
CYPRESS_defaultCommandTimeout=10000 npm run cypress:run
```

## Future Improvements

1. Add data-cy attributes to all components for reliable selection
2. Implement visual regression testing
3. Add performance benchmarks
4. Create more comprehensive cleanup strategies
5. Add accessibility tests
