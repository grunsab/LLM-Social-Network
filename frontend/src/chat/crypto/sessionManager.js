const createSessionId = (localDeviceId, remoteDeviceId) => `${localDeviceId}:${remoteDeviceId}`;

export const createSessionManager = ({ store }) => ({
  createSessionId,

  async getSession(localDeviceId, remoteDeviceId) {
    if (!localDeviceId || !remoteDeviceId) {
      return null;
    }
    return store.getSession(createSessionId(localDeviceId, remoteDeviceId));
  },

  async ensureSessionRecord({ localDeviceId, remoteUserId, remoteDeviceId, remoteIdentityKey }) {
    if (!localDeviceId || !remoteDeviceId) {
      return null;
    }

    const sessionId = createSessionId(localDeviceId, remoteDeviceId);
    const existing = await store.getSession(sessionId);
    if (existing) {
      return existing;
    }

    const createdAt = new Date().toISOString();
    const nextRecord = {
      sessionId,
      localDeviceId,
      remoteUserId,
      remoteDeviceId,
      remoteIdentityKey: remoteIdentityKey || null,
      status: 'pending_establishment',
      createdAt,
      updatedAt: createdAt,
    };
    await store.putSession(nextRecord);
    return nextRecord;
  },

  async upsertSession(record) {
    const nextRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    await store.putSession(nextRecord);
    return nextRecord;
  },
});
