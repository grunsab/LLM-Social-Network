import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbStore } from './indexedDbStore.js';

test('memory fallback clones device records on read and write', async () => {
  const store = createIndexedDbStore();
  assert.equal(store.kind, 'memory');

  const originalRecord = {
    deviceId: 'device-local-1',
    label: 'Browser A',
    nested: {
      count: 1,
    },
  };

  await store.putDevice(originalRecord);
  originalRecord.label = 'mutated after put';
  originalRecord.nested.count = 2;

  const firstRead = await store.getDevice('device-local-1');
  assert.equal(firstRead.label, 'Browser A');
  assert.equal(firstRead.nested.count, 1);

  firstRead.label = 'mutated after get';
  firstRead.nested.count = 3;

  const secondRead = await store.getDevice('device-local-1');
  assert.equal(secondRead.label, 'Browser A');
  assert.equal(secondRead.nested.count, 1);
});
