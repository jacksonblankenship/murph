/**
 * Creates a mock Redis client with an in-memory store.
 */
export function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();

  return {
    store,
    sets,
    lists,
    ttls,

    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },

    async set(
      key: string,
      value: string,
      exMode?: string,
      ttl?: number,
    ): Promise<'OK'> {
      store.set(key, value);
      if (exMode === 'EX' && ttl) {
        ttls.set(key, ttl);
      }
      return 'OK';
    },

    async setex(key: string, seconds: number, value: string): Promise<'OK'> {
      store.set(key, value);
      ttls.set(key, seconds);
      return 'OK';
    },

    async del(key: string): Promise<number> {
      const existed = store.has(key);
      store.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    },

    async keys(pattern: string): Promise<string[]> {
      const regex = new RegExp(
        `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      );
      return Array.from(store.keys()).filter(k => regex.test(k));
    },

    async sadd(key: string, ...members: string[]): Promise<number> {
      if (!sets.has(key)) {
        sets.set(key, new Set());
      }
      const set = sets.get(key)!;
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added++;
        }
      }
      return added;
    },

    async smembers(key: string): Promise<string[]> {
      return Array.from(sets.get(key) ?? []);
    },

    async srem(key: string, ...members: string[]): Promise<number> {
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const member of members) {
        if (set.delete(member)) removed++;
      }
      return removed;
    },

    async lpush(key: string, ...values: string[]): Promise<number> {
      if (!lists.has(key)) {
        lists.set(key, []);
      }
      const list = lists.get(key)!;
      list.unshift(...values);
      return list.length;
    },

    async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
      const list = lists.get(key);
      if (list) {
        const trimmed = list.slice(start, stop + 1);
        lists.set(key, trimmed);
      }
      return 'OK';
    },

    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? [];
      if (stop === -1) {
        return list.slice(start);
      }
      return list.slice(start, stop + 1);
    },

    clear() {
      store.clear();
      sets.clear();
      lists.clear();
      ttls.clear();
    },
  };
}

export type MockRedis = ReturnType<typeof createMockRedis>;
