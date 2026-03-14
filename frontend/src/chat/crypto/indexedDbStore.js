const DB_NAME = 'llm-social-network-chat-e2ee';
const DB_VERSION = 2;

const STORE_DEFINITIONS = {
  devices: { keyPath: 'deviceId' },
  sessions: { keyPath: 'sessionId' },
  groupKeys: { keyPath: 'groupKeyId' },
  keyPackages: { keyPath: 'packageId' },
  linkSessions: { keyPath: 'linkSessionId' },
  importedHistory: { keyPath: 'historyEntryId' },
  meta: { keyPath: 'key' },
};

const cloneValue = (value) => {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

const createMemoryStore = () => {
  const maps = Object.fromEntries(Object.keys(STORE_DEFINITIONS).map((name) => [name, new Map()]));

  const getAll = async (storeName) => Array.from(maps[storeName].values()).map((value) => cloneValue(value));
  const getOne = async (storeName, key) => {
    const value = maps[storeName].get(key);
    return value == null ? null : cloneValue(value);
  };
  const putOne = async (storeName, value) => {
    maps[storeName].set(value[STORE_DEFINITIONS[storeName].keyPath], cloneValue(value));
    return value;
  };
  const deleteOne = async (storeName, key) => {
    maps[storeName].delete(key);
  };

  return {
    kind: 'memory',
    ready: async () => {},
    getMeta: (key) => getOne('meta', key),
    putMeta: (key, value) => putOne('meta', { key, value }),
    deleteMeta: (key) => deleteOne('meta', key),
    getDevice: (deviceId) => getOne('devices', deviceId),
    putDevice: (value) => putOne('devices', value),
    listDevices: () => getAll('devices'),
    deleteDevice: (deviceId) => deleteOne('devices', deviceId),
    getSession: (sessionId) => getOne('sessions', sessionId),
    putSession: (value) => putOne('sessions', value),
    listSessions: () => getAll('sessions'),
    deleteSession: (sessionId) => deleteOne('sessions', sessionId),
    getGroupKey: (groupKeyId) => getOne('groupKeys', groupKeyId),
    putGroupKey: (value) => putOne('groupKeys', value),
    listGroupKeys: () => getAll('groupKeys'),
    deleteGroupKey: (groupKeyId) => deleteOne('groupKeys', groupKeyId),
    getKeyPackage: (packageId) => getOne('keyPackages', packageId),
    putKeyPackage: (value) => putOne('keyPackages', value),
    listKeyPackages: () => getAll('keyPackages'),
    deleteKeyPackage: (packageId) => deleteOne('keyPackages', packageId),
    getLinkSession: (linkSessionId) => getOne('linkSessions', linkSessionId),
    putLinkSession: (value) => putOne('linkSessions', value),
    listLinkSessions: () => getAll('linkSessions'),
    deleteLinkSession: (linkSessionId) => deleteOne('linkSessions', linkSessionId),
    putImportedHistory: (value) => putOne('importedHistory', value),
    listImportedHistory: async (deviceId) => {
      const rows = await getAll('importedHistory');
      return rows.filter((row) => row?.deviceId === deviceId);
    },
    clearImportedHistory: async (deviceId) => {
      Array.from(maps.importedHistory.values())
        .filter((row) => row?.deviceId === deviceId)
        .forEach((row) => {
          maps.importedHistory.delete(row.historyEntryId);
        });
    },
  };
};

const promisifyRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
});

const openIndexedDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = () => {
    const database = request.result;
    Object.entries(STORE_DEFINITIONS).forEach(([storeName, definition]) => {
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: definition.keyPath });
      }
    });
  };

  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
});

const createIndexedDbBackedStore = () => {
  let dbPromise = null;

  const getDb = async () => {
    if (!dbPromise) {
      dbPromise = openIndexedDb();
    }
    return dbPromise;
  };

  const withStore = async (storeName, mode, handler) => {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error(`IndexedDB transaction failed for ${storeName}.`));
      transaction.onabort = () => reject(transaction.error || new Error(`IndexedDB transaction aborted for ${storeName}.`));

      Promise.resolve(handler(store))
        .then((value) => {
          result = value;
        })
        .catch((error) => {
          reject(error);
          transaction.abort();
        });
    });
  };

  const getAll = (storeName) => withStore(storeName, 'readonly', async (store) => promisifyRequest(store.getAll()));
  const getOne = (storeName, key) => withStore(storeName, 'readonly', async (store) => {
    const result = await promisifyRequest(store.get(key));
    return result ?? null;
  });
  const putOne = (storeName, value) => withStore(storeName, 'readwrite', async (store) => {
    await promisifyRequest(store.put(value));
    return value;
  });
  const deleteOne = (storeName, key) => withStore(storeName, 'readwrite', async (store) => {
    await promisifyRequest(store.delete(key));
    return undefined;
  });

  return {
    kind: 'indexeddb',
    ready: getDb,
    getMeta: (key) => getOne('meta', key),
    putMeta: (key, value) => putOne('meta', { key, value }),
    deleteMeta: (key) => deleteOne('meta', key),
    getDevice: (deviceId) => getOne('devices', deviceId),
    putDevice: (value) => putOne('devices', value),
    listDevices: () => getAll('devices'),
    deleteDevice: (deviceId) => deleteOne('devices', deviceId),
    getSession: (sessionId) => getOne('sessions', sessionId),
    putSession: (value) => putOne('sessions', value),
    listSessions: () => getAll('sessions'),
    deleteSession: (sessionId) => deleteOne('sessions', sessionId),
    getGroupKey: (groupKeyId) => getOne('groupKeys', groupKeyId),
    putGroupKey: (value) => putOne('groupKeys', value),
    listGroupKeys: () => getAll('groupKeys'),
    deleteGroupKey: (groupKeyId) => deleteOne('groupKeys', groupKeyId),
    getKeyPackage: (packageId) => getOne('keyPackages', packageId),
    putKeyPackage: (value) => putOne('keyPackages', value),
    listKeyPackages: () => getAll('keyPackages'),
    deleteKeyPackage: (packageId) => deleteOne('keyPackages', packageId),
    getLinkSession: (linkSessionId) => getOne('linkSessions', linkSessionId),
    putLinkSession: (value) => putOne('linkSessions', value),
    listLinkSessions: () => getAll('linkSessions'),
    deleteLinkSession: (linkSessionId) => deleteOne('linkSessions', linkSessionId),
    putImportedHistory: (value) => putOne('importedHistory', value),
    listImportedHistory: async (deviceId) => {
      const rows = await getAll('importedHistory');
      return rows.filter((row) => row?.deviceId === deviceId);
    },
    clearImportedHistory: async (deviceId) => withStore('importedHistory', 'readwrite', async (store) => {
      const rows = await promisifyRequest(store.getAll());
      await Promise.all(
        rows
          .filter((row) => row?.deviceId === deviceId)
          .map((row) => promisifyRequest(store.delete(row.historyEntryId)))
      );
      return undefined;
    }),
  };
};

export const createIndexedDbStore = () => {
  if (typeof indexedDB === 'undefined') {
    return createMemoryStore();
  }
  return createIndexedDbBackedStore();
};
