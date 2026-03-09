import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium, request } from 'playwright';

const normalizeBoolean = (value) => {
  if (typeof value === 'string') {
    return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
};

const asAbsoluteUrl = (baseUrl, pathname) => new URL(pathname, baseUrl).toString();

const extractErrorMessage = (payload, fallback) => {
  if (payload == null) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload?.message === 'string' && payload.message) return payload.message;
  if (typeof payload?.error === 'string' && payload.error) return payload.error;
  return fallback;
};

const parseResponsePayload = async (response) => {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
};

const readJsonEnv = (name) => {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Environment variable ${name} must be valid JSON: ${error.message}`);
  }
};

const runSuffix = Date.now();
const baseUrl = process.env.PLAYWRIGHT_BASE_URL
  || process.env.CYPRESS_BASE_URL
  || 'https://social-network-gemma-053a8f6650ab.herokuapp.com';
const outputDir = path.resolve(
  process.cwd(),
  process.env.PLAYWRIGHT_OUTPUT_DIR || `playwright-results/chat-e2ee-diagnostic-${runSuffix}`
);
const timeoutMs = Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 45000);
const headless = normalizeBoolean(process.env.PLAYWRIGHT_HEADLESS ?? '1');

const aliceInviteCode = process.env.PLAYWRIGHT_CHAT_INVITE_CODE_ALICE
  || process.env.CYPRESS_chatInviteCodeAlice
  || '';
const bobInviteCode = process.env.PLAYWRIGHT_CHAT_INVITE_CODE_BOB
  || process.env.CYPRESS_chatInviteCodeBob
  || '';

if (!aliceInviteCode || !bobInviteCode) {
  throw new Error(
    'Both PLAYWRIGHT_CHAT_INVITE_CODE_ALICE and PLAYWRIGHT_CHAT_INVITE_CODE_BOB are required.'
  );
}

const users = {
  alice: {
    username: `pw_chat_alice_${runSuffix}`,
    email: `pw_chat_alice_${runSuffix}@example.com`,
    password: process.env.PLAYWRIGHT_CHAT_PASSWORD || 'password123',
    inviteCode: aliceInviteCode,
    id: null,
  },
  bob: {
    username: `pw_chat_bob_${runSuffix}`,
    email: `pw_chat_bob_${runSuffix}@example.com`,
    password: process.env.PLAYWRIGHT_CHAT_PASSWORD || 'password123',
    inviteCode: bobInviteCode,
    id: null,
  },
};

const firstMessage = `playwright hello from alice ${runSuffix}`;
const replyMessage = `playwright hello back from bob ${runSuffix}`;

const report = {
  startedAt: new Date().toISOString(),
  baseUrl,
  runSuffix,
  outputDir,
  users: {
    alice: {
      username: users.alice.username,
      email: users.alice.email,
      inviteCode: users.alice.inviteCode,
    },
    bob: {
      username: users.bob.username,
      email: users.bob.email,
      inviteCode: users.bob.inviteCode,
    },
  },
  conversationId: null,
  messages: {
    firstMessage,
    replyMessage,
  },
  browser: {
    headless,
  },
  steps: [],
  pageDiagnostics: {
    alice: {
      console: [],
      pageErrors: [],
      requestFailures: [],
      snapshots: [],
    },
    bob: {
      console: [],
      pageErrors: [],
      requestFailures: [],
      snapshots: [],
    },
  },
};

const logStep = (message, extra = {}) => {
  const entry = {
    at: new Date().toISOString(),
    message,
    ...extra,
  };
  report.steps.push(entry);
  console.log(`[playwright-chat] ${message}`);
};

const ensureOutputDir = async () => {
  await fs.mkdir(outputDir, { recursive: true });
};

const writeReport = async () => {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(outputDir, 'report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );
};

const apiFetchJson = async (api, method, url, data, label) => {
  const response = await api.fetch(url, {
    method,
    data,
    failOnStatusCode: false,
  });
  const payload = await parseResponsePayload(response);
  if (!response.ok()) {
    throw new Error(`${label} (${response.status()}): ${extractErrorMessage(payload, response.statusText())}`);
  }
  return payload;
};

const registerUser = async (api, user, label) => {
  logStep(`Registering ${label}`);
  await apiFetchJson(api, 'POST', '/api/v1/register', {
    username: user.username,
    email: user.email,
    password: user.password,
    invite_code: user.inviteCode,
  }, `Failed to register ${label}`);
};

const loginApi = async (api, user, label) => {
  await apiFetchJson(api, 'POST', '/api/v1/login', {
    identifier: user.username,
    password: user.password,
  }, `Failed to log in ${label} through the API`);
};

const setupFriendship = async () => {
  const aliceApi = await request.newContext({ baseURL: baseUrl });
  const bobApi = await request.newContext({ baseURL: baseUrl });

  try {
    await registerUser(aliceApi, users.alice, 'Alice');
    await registerUser(bobApi, users.bob, 'Bob');

    await loginApi(aliceApi, users.alice, 'Alice');
    const bobProfile = await apiFetchJson(
      aliceApi,
      'GET',
      `/api/v1/profiles/${users.bob.username}`,
      undefined,
      'Failed to fetch Bob profile'
    );
    users.bob.id = Number(bobProfile?.user?.id);

    if (!users.bob.id) {
      throw new Error('Bob profile did not include a numeric user ID.');
    }

    await aliceApi.fetch(`/api/v1/friendships/${users.bob.id}`, {
      method: 'DELETE',
      failOnStatusCode: false,
    });
    const friendRequest = await apiFetchJson(
      aliceApi,
      'POST',
      '/api/v1/friend-requests',
      { user_id: users.bob.id },
      'Failed to send Alice friend request'
    );

    await loginApi(bobApi, users.bob, 'Bob');
    const aliceProfile = await apiFetchJson(
      bobApi,
      'GET',
      `/api/v1/profiles/${users.alice.username}`,
      undefined,
      'Failed to fetch Alice profile'
    );
    users.alice.id = Number(aliceProfile?.user?.id);

    if (!users.alice.id) {
      throw new Error('Alice profile did not include a numeric user ID.');
    }

    await apiFetchJson(
      bobApi,
      'PUT',
      `/api/v1/friend-requests/${friendRequest.id}`,
      { action: 'accept' },
      'Failed to accept friend request as Bob'
    );

    report.users.alice.id = users.alice.id;
    report.users.bob.id = users.bob.id;
    logStep('Friendship established', {
      aliceId: users.alice.id,
      bobId: users.bob.id,
      requestId: friendRequest.id,
    });
  } finally {
    await aliceApi.dispose();
    await bobApi.dispose();
  }
};

const attachPageDiagnostics = (page, label) => {
  const target = report.pageDiagnostics[label];

  page.on('console', async (message) => {
    if (!['error', 'warning'].includes(message.type())) {
      return;
    }

    target.console.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });

  page.on('pageerror', (error) => {
    target.pageErrors.push({
      message: error.message,
      stack: error.stack || '',
    });
  });

  page.on('requestfailed', (requestValue) => {
    target.requestFailures.push({
      url: requestValue.url(),
      method: requestValue.method(),
      failure: requestValue.failure(),
    });
  });
};

const fetchJsonFromPage = async (page, endpoint) => (
  page.evaluate(async (pathValue) => {
    const response = await fetch(pathValue, {
      credentials: 'include',
    });
    const rawText = await response.text();
    let body = rawText;

    try {
      body = rawText ? JSON.parse(rawText) : null;
    } catch {
      body = rawText;
    }

    return {
      status: response.status,
      ok: response.ok,
      body,
    };
  }, endpoint)
);

const dumpChatIndexedDb = async (page) => (
  page.evaluate(async () => {
    const dbName = 'llm-social-network-chat-e2ee';
    const storeNames = ['devices', 'sessions', 'groupKeys', 'keyPackages', 'linkSessions', 'meta'];

    const openDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`Failed to open ${dbName}`));
    });

    if (!globalThis.indexedDB) {
      return {
        supported: false,
        exists: false,
      };
    }

    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      const exists = databases.some((database) => database?.name === dbName);
      if (!exists) {
        return {
          supported: true,
          exists: false,
        };
      }
    }

    const db = await openDb();

    const readAll = (storeName) => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}`));
    });

    try {
      const stores = {};
      for (const storeName of storeNames) {
        stores[storeName] = await readAll(storeName);
      }

      return {
        supported: true,
        exists: true,
        devices: stores.devices.map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          status: device.status,
          signedPrekeyId: device.signedPrekey?.keyId ?? null,
          oneTimePrekeyIds: Array.isArray(device.oneTimePrekeys)
            ? device.oneTimePrekeys.map((prekey) => prekey.prekeyId)
            : [],
        })),
        sessions: stores.sessions.map((session) => ({
          sessionId: session.sessionId,
          localDeviceId: session.localDeviceId,
          remoteUserId: session.remoteUserId,
          remoteDeviceId: session.remoteDeviceId,
          status: session.status,
          sessionType: session.sessionType || null,
          recipientSignedPrekeyId: session.recipientSignedPrekeyId ?? null,
          recipientOneTimePrekeyId: session.recipientOneTimePrekeyId ?? null,
          hasKeyMaterial: Boolean(session.keyMaterial),
        })),
        groupKeysCount: stores.groupKeys.length,
        keyPackagesCount: stores.keyPackages.length,
        linkSessionsCount: stores.linkSessions.length,
        meta: stores.meta,
      };
    } finally {
      db.close();
    }
  })
);

const captureSnapshot = async (page, label, phase) => {
  const [e2eeBootstrap, transportBootstrap, indexedDb] = await Promise.all([
    fetchJsonFromPage(page, '/api/v1/chat/e2ee/bootstrap'),
    fetchJsonFromPage(page, '/api/v1/chat/bootstrap'),
    dumpChatIndexedDb(page),
  ]);

  const actionErrorLocator = page.locator('.chat-action-error');
  const actionErrorText = await actionErrorLocator.count()
    ? await actionErrorLocator.first().textContent()
    : null;

  const threadText = await page.locator('.chat-messages').count()
    ? await page.locator('.chat-messages').first().textContent()
    : null;

  const screenshotPath = path.join(outputDir, `${label}-${phase}.png`);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  const snapshot = {
    at: new Date().toISOString(),
    phase,
    url: page.url(),
    actionErrorText,
    threadText: threadText ? threadText.slice(0, 4000) : null,
    e2eeBootstrap,
    transportBootstrap,
    indexedDb,
    screenshotPath,
  };

  report.pageDiagnostics[label].snapshots.push(snapshot);
  return snapshot;
};

const assertNoActionError = async (page, label) => {
  const errorLocator = page.locator('.chat-action-error');
  if (await errorLocator.count()) {
    const text = await errorLocator.first().textContent();
    throw new Error(`${label} chat action error: ${text}`);
  }
};

const waitForLivePill = async (page) => {
  await page.locator('.chat-pill').filter({ hasText: /^Live$/ }).first().waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });
};

const waitForDeviceReady = async (page, label) => {
  const deadline = Date.now() + timeoutMs;
  let lastBootstrap = null;

  while (Date.now() < deadline) {
    await waitForLivePill(page);
    await assertNoActionError(page, label);

    const bootstrapResponse = await fetchJsonFromPage(page, '/api/v1/chat/e2ee/bootstrap');
    lastBootstrap = bootstrapResponse.body;

    if (bootstrapResponse.ok && bootstrapResponse.body?.enabled && bootstrapResponse.body?.has_active_device && bootstrapResponse.body?.current_device_id) {
      return bootstrapResponse.body;
    }

    await page.waitForTimeout(1200);
  }

  throw new Error(`Timed out waiting for ${label} device bootstrap. Last payload: ${JSON.stringify(lastBootstrap)}`);
};

const loginInBrowser = async (page, user, label) => {
  logStep(`Logging ${label} into the browser`);
  await page.goto(asAbsoluteUrl(baseUrl, '/login'), {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('#identifier').fill(user.username);
  await page.locator('#password').fill(user.password);

  await Promise.all([
    page.waitForURL((currentUrl) => !String(currentUrl).includes('/login'), {
      timeout: timeoutMs,
    }),
    page.getByRole('button', { name: /login/i }).click(),
  ]);
};

const openChatPage = async (page, label) => {
  logStep(`Opening chat for ${label}`);
  await page.goto(asAbsoluteUrl(baseUrl, '/chat'), {
    waitUntil: 'domcontentloaded',
  });
  return waitForDeviceReady(page, label);
};

const openConversation = async (page, username, label) => {
  const item = page.locator('.chat-list-item').filter({ hasText: username }).first();

  try {
    await item.waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await item.waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
  }

  await item.click({
    force: true,
  });
  logStep(`Opened ${label} conversation`, { username });
};

const waitForThreadText = async (page, text, label) => {
  const thread = page.locator('.chat-messages').first();
  await thread.waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });
  await thread.getByText(text).waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });
  logStep(`Observed text in ${label} thread`, { text });
};

const sendMessage = async (page, text, label) => {
  await page.locator('textarea[placeholder="Type a message"]').fill(text);
  await page.getByRole('button', { name: /^Send$/ }).click();
  await assertNoActionError(page, label);
  await waitForThreadText(page, text, label);
};

const createDmConversation = async (page, recipientUser) => {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && response.url().includes('/api/v1/chat/dm')
  ), {
    timeout: timeoutMs,
  });

  await page.locator('select').first().selectOption({ label: recipientUser.username });
  await page.getByRole('button', { name: /^Open$/ }).click();

  const response = await responsePromise;
  const payload = await response.json();
  if (!response.ok() || !payload?.conversation_id) {
    throw new Error(`Failed to create DM conversation: ${JSON.stringify(payload)}`);
  }

  report.conversationId = payload.conversation_id;
  logStep('Created encrypted DM conversation', {
    conversationId: report.conversationId,
  });
  return payload.conversation_id;
};

const waitForReplyOrDecryptFailure = async (page) => {
  const deadline = Date.now() + timeoutMs;
  const thread = page.locator('.chat-messages').first();

  while (Date.now() < deadline) {
    const threadText = await thread.textContent().catch(() => '');
    const hasReply = threadText?.includes(replyMessage);
    const hasDecryptFailure = threadText?.includes('Encrypted message could not be decrypted')
      || threadText?.includes('Could not decrypt');

    if (hasReply || hasDecryptFailure) {
      return {
        hasReply,
        hasDecryptFailure,
        threadText,
      };
    }

    await page.waitForTimeout(1000);
  }

  return {
    hasReply: false,
    hasDecryptFailure: false,
    threadText: await thread.textContent().catch(() => ''),
  };
};

const maybeMergeExtraReport = () => {
  const extraReport = readJsonEnv('PLAYWRIGHT_CHAT_EXTRA_REPORT');
  if (extraReport) {
    report.extra = extraReport;
  }
};

await ensureOutputDir();
maybeMergeExtraReport();

let browser;
let aliceContext;
let bobContext;
let alicePage;
let bobPage;

try {
  await setupFriendship();

  browser = await chromium.launch({
    headless,
  });

  aliceContext = await browser.newContext();
  bobContext = await browser.newContext();
  aliceContext.setDefaultTimeout(timeoutMs);
  bobContext.setDefaultTimeout(timeoutMs);

  alicePage = await aliceContext.newPage();
  bobPage = await bobContext.newPage();
  attachPageDiagnostics(alicePage, 'alice');
  attachPageDiagnostics(bobPage, 'bob');

  await loginInBrowser(alicePage, users.alice, 'Alice');
  const aliceBootstrap = await openChatPage(alicePage, 'Alice');
  report.users.alice.deviceId = aliceBootstrap.current_device_id;
  await captureSnapshot(alicePage, 'alice', 'after-login');

  await loginInBrowser(bobPage, users.bob, 'Bob');
  const bobBootstrap = await openChatPage(bobPage, 'Bob');
  report.users.bob.deviceId = bobBootstrap.current_device_id;
  await captureSnapshot(bobPage, 'bob', 'after-login');

  await createDmConversation(alicePage, users.bob);
  await openConversation(alicePage, users.bob.username, 'Alice');
  await sendMessage(alicePage, firstMessage, 'Alice');
  await captureSnapshot(alicePage, 'alice', 'after-first-send');

  await openConversation(bobPage, users.alice.username, 'Bob');
  await waitForThreadText(bobPage, firstMessage, 'Bob');
  await captureSnapshot(bobPage, 'bob', 'after-first-receive');

  await sendMessage(bobPage, replyMessage, 'Bob');
  await captureSnapshot(bobPage, 'bob', 'after-reply-send');

  logStep('Reloading Alice page to verify reply decryption survives reload');
  await alicePage.reload({
    waitUntil: 'domcontentloaded',
  });
  await waitForDeviceReady(alicePage, 'Alice');
  await openConversation(alicePage, users.bob.username, 'Alice');
  await waitForThreadText(alicePage, firstMessage, 'Alice');

  const replyState = await waitForReplyOrDecryptFailure(alicePage);
  report.replyCheck = replyState;
  await captureSnapshot(alicePage, 'alice', 'after-reload-reply-check');

  if (!replyState.hasReply) {
    throw new Error(
      replyState.hasDecryptFailure
        ? 'Alice could not decrypt Bob reply after reload in a real Playwright browser context.'
        : 'Alice did not receive Bob reply after reload in a real Playwright browser context.'
    );
  }

  report.result = 'passed';
  logStep('Playwright encrypted-chat diagnostic passed');
} catch (error) {
  report.result = 'failed';
  report.error = {
    message: error.message,
    stack: error.stack || '',
  };

  if (alicePage && !alicePage.isClosed()) {
    try {
      await captureSnapshot(alicePage, 'alice', 'failure');
    } catch {
      // Ignore snapshot follow-up failures while preserving the primary error.
    }
  }

  if (bobPage && !bobPage.isClosed()) {
    try {
      await captureSnapshot(bobPage, 'bob', 'failure');
    } catch {
      // Ignore snapshot follow-up failures while preserving the primary error.
    }
  }

  logStep(`Playwright encrypted-chat diagnostic failed: ${error.message}`);
  throw error;
} finally {
  await writeReport();
  await Promise.allSettled([
    aliceContext?.close(),
    bobContext?.close(),
  ]);
  await browser?.close();
}
