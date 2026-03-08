const createGroupKeyId = (conversationId, epoch) => `${conversationId}:${epoch}`;

export const createGroupKeyManager = ({ store }) => ({
  createGroupKeyId,

  async ingestServerPackages(packageRows) {
    await Promise.all(packageRows.map(async (row) => {
      await store.putKeyPackage({
        packageId: row.packageId,
        conversationId: row.conversationId,
        epoch: Number(row.epoch ?? 0),
        recipientUserId: row.recipientUserId,
        recipientDeviceId: row.recipientDeviceId,
        senderUserId: row.senderUserId,
        senderDeviceId: row.senderDeviceId,
        sealedSenderKey: row.sealedSenderKey,
        createdAt: row.createdAt,
      });
    }));
  },

  async getLocalGroupKey(conversationId, epoch) {
    return store.getGroupKey(createGroupKeyId(conversationId, epoch));
  },

  async putLocalGroupKey(record) {
    const nextRecord = {
      ...record,
      groupKeyId: createGroupKeyId(record.conversationId, record.epoch),
      updatedAt: new Date().toISOString(),
    };
    await store.putGroupKey(nextRecord);
    return nextRecord;
  },

  async hasLocalGroupKey(conversationId, epoch) {
    const record = await store.getGroupKey(createGroupKeyId(conversationId, epoch));
    return Boolean(record?.keyMaterial);
  },
});
