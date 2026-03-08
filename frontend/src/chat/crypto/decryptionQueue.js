export const createDecryptionQueue = () => {
  let tail = Promise.resolve();

  return {
    enqueue(task) {
      const run = tail.then(task, task);
      tail = run.catch(() => {});
      return run;
    },

    async map(items, mapper) {
      const results = [];
      for (const item of items) {
        results.push(await this.enqueue(() => mapper(item)));
      }
      return results;
    },
  };
};
