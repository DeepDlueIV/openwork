import { randomUUID } from "node:crypto"

/**
 * Generation-keyed read-through cache.
 *
 * Every entry key embeds the current generation of its scope (for example one
 * organization). Invalidating the scope writes a new generation, so all of its
 * entries become unreachable in one O(1) write, with no key scan.
 *
 * The generation is read before the loader runs. A loader that read the
 * database before a write committed therefore stores its stale result under the
 * old generation, where no reader looks once the write has bumped it. Plain
 * delete-then-repopulate caches cannot close that window.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

export type GenerationCacheRedis = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>
}

/**
 * Generations live far longer than any entry. When a generation key expires,
 * readers fall back to INITIAL_GENERATION; entries written under it before the
 * first bump expired long ago, so nothing stale can be resurrected.
 */
export const GENERATION_TTL_SECONDS = 24 * 60 * 60
const INITIAL_GENERATION = "0"

export async function readThroughGeneration<T>(input: {
  redis: GenerationCacheRedis | null
  generationKey: string
  entryKey: (generation: string) => string
  /** Must stay well below GENERATION_TTL_SECONDS. */
  ttlSeconds: number
  parse: (raw: string | null) => T | null
  load: () => Promise<T>
  onError?: (stage: "get" | "set", error: unknown) => void
}): Promise<T> {
  const { redis } = input
  if (!redis) {
    return input.load()
  }

  // Resolved before loading: see the race note at the top of this file.
  let key: string | null = null
  try {
    const generation = (await redis.get(input.generationKey)) ?? INITIAL_GENERATION
    key = input.entryKey(generation)
    const cached = input.parse(await redis.get(key))
    if (cached !== null) {
      return cached
    }
  } catch (error) {
    input.onError?.("get", error)
  }

  const loaded = await input.load()
  // Without a known generation the entry could land under a stale one; skip the write.
  if (key) {
    try {
      await redis.set(key, JSON.stringify(loaded), "EX", input.ttlSeconds)
    } catch (error) {
      input.onError?.("set", error)
    }
  }
  return loaded
}

/** Makes every entry in the scope unreachable. Call only after the source rows have committed. */
export async function bumpGeneration(redis: GenerationCacheRedis, generationKey: string) {
  await redis.set(generationKey, randomUUID(), "EX", GENERATION_TTL_SECONDS)
}
