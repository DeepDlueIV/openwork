import assert from "node:assert/strict"
import { test } from "node:test"
import { bumpGeneration, readThroughGeneration, type GenerationCacheRedis } from "../src/generation-cache.ts"

function fakeRedis(options: { failGet?: boolean } = {}) {
  const store = new Map<string, string>()
  const redis: GenerationCacheRedis = {
    async get(key) {
      if (options.failGet) throw new Error("redis down")
      return store.get(key) ?? null
    },
    async set(key, value) {
      store.set(key, value)
      return "OK"
    },
  }
  return { redis, store }
}

function parseNumberList(raw: string | null) {
  if (!raw) return null
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) && parsed.every((value) => typeof value === "number") ? parsed : null
}

function reader(redis: GenerationCacheRedis | null, load: () => Promise<number[]>) {
  return readThroughGeneration({
    redis,
    generationKey: "gen:org_1",
    entryKey: (generation) => `entry:org_1:${generation}:member_1`,
    ttlSeconds: 60,
    parse: parseNumberList,
    load,
  })
}

test("without redis every read goes to the loader", async () => {
  let loads = 0
  const load = async () => { loads += 1; return [1] }
  assert.deepEqual(await reader(null, load), [1])
  assert.deepEqual(await reader(null, load), [1])
  assert.equal(loads, 2)
})

test("a second read is served from the cache, including an empty list", async () => {
  const { redis } = fakeRedis()
  let loads = 0
  const load = async () => { loads += 1; return [] }
  assert.deepEqual(await reader(redis, load), [])
  assert.deepEqual(await reader(redis, load), [])
  assert.equal(loads, 1)
})

test("bumping the generation makes the next read load fresh data", async () => {
  const { redis } = fakeRedis()
  let value = [1]
  const load = async () => value
  assert.deepEqual(await reader(redis, load), [1])
  value = [1, 2]
  assert.deepEqual(await reader(redis, load), [1], "still cached before the bump")
  await bumpGeneration(redis, "gen:org_1")
  assert.deepEqual(await reader(redis, load), [1, 2])
})

test("a loader that read before a committed write cannot repopulate stale data", async () => {
  const { redis } = fakeRedis()
  // The loader reads the old rows, then the write commits and bumps the
  // generation before the loader stores its result.
  const staleRead = reader(redis, async () => {
    await bumpGeneration(redis, "gen:org_1")
    return [1]
  })
  assert.deepEqual(await staleRead, [1])
  assert.deepEqual(await reader(redis, async () => [1, 2]), [1, 2])
})

test("a redis read failure falls back to the loader and writes nothing", async () => {
  const { redis, store } = fakeRedis({ failGet: true })
  assert.deepEqual(await reader(redis, async () => [3]), [3])
  assert.equal(store.size, 0)
})

test("an unparseable entry is reloaded", async () => {
  const { redis, store } = fakeRedis()
  store.set("entry:org_1:0:member_1", "{not json")
  // JSON.parse throws inside parse; treated like a read failure, then reloaded.
  assert.deepEqual(await reader(redis, async () => [4]), [4])
})
