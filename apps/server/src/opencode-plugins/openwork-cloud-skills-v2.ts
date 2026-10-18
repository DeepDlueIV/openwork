import { createHash } from "node:crypto";
import { z } from "zod";

const catalogSchema = z.object({
  skills: z.array(z.object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    title: z.string().optional(),
    description: z.string(),
    url: z.string().startsWith("skill://").optional(),
    capability: z.string().regex(/^(?:skill:[^:]+|plugin:[^:]+:[^:]+)$/),
    modelDiscovery: z.boolean().optional(),
    pluginName: z.string().optional(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    setup: z.object({ status: z.string(), message: z.string() }).optional(),
  })),
  delivery: z.enum(["native"]).optional(),
});
type Catalog = z.infer<typeof catalogSchema>;
type CatalogSkill = Catalog["skills"][number];

type NativeSkill = { id: string; name: string; description: string; path: string; content: string };
type Registration = { dispose(): Promise<void> };
type PromptEvent = { readonly sessionID: string; prompt: { text: string; skills?: Array<{ id: string }> } };
export type CloudSkillContext = {
  options: { url: string; token: string };
  skill: {
    list(): Promise<ReadonlyArray<NativeSkill>>;
    transform(callback: (editor: { get(id: string): unknown; add(skill: NativeSkill): void }) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  session?: {
    hook(name: "prompt", callback: (event: PromptEvent) => void | Promise<void>): Promise<Registration>;
  };
};

export const CLOUD_SKILL_ID_PREFIX = "openwork-cloud-";
const MAX_SKILLS = 150;
const DISCOVERY_BUDGET_CHARS = 24_000;
const DISCOVERY_DESCRIPTION_CHARS = 200;
// Native entries carry Den's full description (at most 1,024 characters), the
// same cap Claude Code applies to a skill listing.
const NATIVE_BUDGET_CHARS = 64_000;
const NATIVE_DESCRIPTION_CHARS = 1_024;
const MAX_MENTIONED_SKILLS = 3;
const MAX_CONCURRENT_READS = 2;

export const cloudSkillSnapshotSchema = z.object({
  id: z.string().regex(/^openwork-cloud-[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  capability: z.string().regex(/^(?:skill:[^:]+|plugin:[^:]+:[^:]+)$/).max(512),
  url: z.string().startsWith("skill://").max(2_048),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
type CloudSkillSnapshot = z.infer<typeof cloudSkillSnapshotSchema>;

function skillSnapshot(skill: CatalogSkill): CloudSkillSnapshot | undefined {
  if (!skill.digest || !skill.url || skill.setup || skill.modelDiscovery !== true) return;
  return { id: skillId(skill), capability: skill.capability, url: skill.url, digest: skill.digest };
}

export function loadableCloudSkillSnapshots(value: unknown): CloudSkillSnapshot[] | undefined {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success || parsed.data.delivery !== "native") return;
  if (new Set(parsed.data.skills.map(skill => skill.name)).size !== parsed.data.skills.length) return;
  return parsed.data.skills.flatMap(skill => {
    const snapshot = skillSnapshot(skill);
    return snapshot ? [snapshot] : [];
  });
}

export function sameCloudSkillSnapshot(left: CloudSkillSnapshot, right: CloudSkillSnapshot): boolean {
  return left.id === right.id && left.capability === right.capability && left.url === right.url && left.digest === right.digest;
}

const skillId = (skill: CatalogSkill) => `${CLOUD_SKILL_ID_PREFIX}${skill.name}`;
// Not SKILL.md: the native skill tool must not scan a fake directory. The engine
// requires path and disables this whole plugin, OpenWork's context tools
// included, when a registered skill lacks it.
const skillPath = (skill: CatalogSkill) => `/openwork/remote-skills/${skill.name}.md`;

function discoveryContent(skill: CatalogSkill): string {
  return [
    "This is discovery metadata, NOT the skill's instructions or proof of access.",
    `Retrieve the current full skill through OpenWork Connect get_skill with ${JSON.stringify({ name: skill.capability })}.`,
    "Use get_skill directly when exposed, or through execute with its exact Code Mode catalog path. Only search inside execute if get_skill is not already listed; do not guess a tool name.",
    "Read the returned SKILL.md before doing the task. Do not substitute these metadata for the instructions.",
    "If the fetch is denied, unavailable, or the skill was removed, do not use it. Explain the failure; never recover its body from files or previous context.",
  ].join("\n");
}

function setupContent(skill: CatalogSkill, setup: { status: string; message: string }): string {
  return [
    `This organization skill is not ready yet (${setup.status}). Its instructions are withheld until it is set up.`,
    setup.message,
    `Tell the person what to set up. Once it is ready, get_skill with ${JSON.stringify({ name: skill.capability })} returns the full skill.`,
  ].join("\n");
}

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function budgeted(skills: CatalogSkill[], budget: number, descriptionChars: number, content: (skill: CatalogSkill) => string): NativeSkill[] {
  let remaining = budget;
  const result: NativeSkill[] = [];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.length === MAX_SKILLS) break;
    const name = oneLine(skill.title || skill.name, 128);
    const description = oneLine(skill.description || name, descriptionChars);
    const cost = skill.name.length + name.length + description.length;
    if (cost > remaining) break;
    remaining -= cost;
    result.push({ id: skillId(skill), name, description, path: skillPath(skill), content: content(skill) });
  }
  return result;
}

/** Discovery mode: metadata only. Never cache a Cloud skill body or access
 * decision here: even an old model snapshot must retrieve the body from Den,
 * which rechecks member access on every get_skill call. */
export function discoverySkills(value: unknown): NativeSkill[] {
  const catalog = catalogSchema.parse(value);
  return budgeted(catalog.skills.filter(skill => skill.modelDiscovery === true),
    DISCOVERY_BUDGET_CHARS, DISCOVERY_DESCRIPTION_CHARS, discoveryContent);
}

/**
 * Native mode (Den's nativeCloudSkills rollout): each skill is a native skill
 * with its full description and its authorized SKILL.md, verified against the
 * digest Den published. A skill whose body could not be read or verified keeps
 * the discovery note, so it still works through get_skill.
 */
export function nativeSkills(catalog: Catalog, contents: ReadonlyMap<string, string>): NativeSkill[] {
  return budgeted(catalog.skills.filter(skill => skill.modelDiscovery === true), NATIVE_BUDGET_CHARS, NATIVE_DESCRIPTION_CHARS, skill => {
    if (skill.setup) return setupContent(skill, skill.setup);
    const body = skill.digest ? contents.get(skill.digest) : undefined;
    return body ?? discoveryContent(skill);
  });
}

export function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The name a person would type: Den's catalog name without its unique suffix. */
function plainName(name: string): string {
  return name.replace(/-(?=[a-z0-9]*\d)[a-z0-9]{8}$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Organization skills the message names explicitly, so they load before the
 * model runs instead of depending on it noticing them. A multi-word name or
 * title ("crm-pipeline-sync", "Create Skill") matches as a phrase; a one-word
 * name matches only as a /name or $name mention, so everyday words never load
 * a skill by accident.
 */
export function mentionedSkillIds(text: string, skills: ReadonlyArray<Pick<NativeSkill, "id" | "name">>): string[] {
  const haystack = text.toLowerCase();
  const ids: string[] = [];
  for (const skill of skills) {
    if (ids.length === MAX_MENTIONED_SKILLS) break;
    const phrases = new Set([plainName(skill.id.slice(CLOUD_SKILL_ID_PREFIX.length)), skill.name.toLowerCase().trim()]);
    const named = [...phrases].some(phrase => {
      if (phrase.length < 3) return false;
      const multiWord = /[\s-]/.test(phrase);
      const pattern = multiWord
        ? `(^|[^a-z0-9-])[/$]?${escapeRegExp(phrase)}($|[^a-z0-9-])`
        : `(^|[^a-z0-9-])[/$]${escapeRegExp(phrase)}($|[^a-z0-9-])`;
      return new RegExp(pattern).test(haystack);
    });
    if (named) ids.push(skill.id);
  }
  return ids;
}

/** Setup starts background discovery, not a chat-wide network dependency.
 * Do not touch the native registry until opted-in metadata arrives. The prompt
 * hook is inert off-rollout; only explicit Cloud attachments wait for the cold
 * metadata read, and only selected native instructions gate their admission.
 * No storage, configuration rewrite or watcher is involved. */
export async function registerCloudSkillDiscovery(context: CloudSkillContext) {
  let skills: NativeSkill[] = [];
  let native = false;
  let catalog: Catalog = { skills: [] };
  let fingerprint = "[]";
  let closed = false;
  let refreshing = false;
  // Verified SKILL.md bodies by digest, in memory only. A body is re-read only
  // when Den publishes a new digest, and dropped as soon as Den stops listing it.
  const contents = new Map<string, string>();
  const controller = new AbortController();
  let registration: Registration | undefined;
  let promptHook: Registration | undefined;

  const call = async (name: "openwork_skills" | "openwork_skill_read" | "openwork_skill_authorize", input: unknown) => {
    const response = await fetch(context.options.url, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return response.ok ? await response.json() : null;
  };

  // Publish metadata immediately, then replace discovery notes as individual
  // bodies arrive. A prompt never waits for the full catalog to hydrate.
  let publishing = Promise.resolve();
  const publish = () => {
    publishing = publishing.catch(() => {}).then(async () => {
      const next = native ? nativeSkills(catalog, contents) : discoverySkills(catalog);
      const key = JSON.stringify(next);
      if (closed || key === fingerprint) return;
      skills = next;
      if (skills.length === 0) {
        const current = registration;
        registration = undefined;
        await current?.dispose();
      } else if (!registration) {
        const current = await context.skill.transform(editor => {
          for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill);
        });
        if (closed) { await current.dispose(); return; }
        registration = current;
      } else {
        await context.skill.reload();
      }
      fingerprint = key;
    });
    return publishing;
  };

  type ReadJob = { digest: string; run(): Promise<void>; done: Promise<void> };
  const pending: ReadJob[] = [];
  const reading = new Map<string, ReadJob>();
  let activeReads = 0;
  const drain = () => {
    while (!closed && activeReads < MAX_CONCURRENT_READS && pending.length) {
      const job = pending.shift();
      if (!job) break;
      activeReads++;
      void job.run().catch(() => {}).finally(() => { activeReads--; reading.delete(job.digest); drain(); });
    }
  };
  const hydrate = (skill: CatalogSkill, urgent = false): Promise<void> => {
    const { digest, url } = skill;
    if (closed || !digest || !url || skill.setup || contents.has(digest)) return Promise.resolve();
    const existing = reading.get(digest);
    if (existing) {
      // A selected skill jumps ahead of queued catalog reads, not ahead of
      // the two network requests already running. No second fetch per digest.
      const index = pending.indexOf(existing);
      if (urgent && index > 0) { pending.splice(index, 1); pending.unshift(existing); }
      return existing.done;
    }
    let finish: () => void = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    const job: ReadJob = { digest, done, async run() {
      try {
        if (closed || !native || !catalog.skills.some(entry => entry.digest === digest && entry.url === url && !entry.setup)) return;
        const result = z.object({ content: z.string() }).safeParse(await call("openwork_skill_read", { url }).catch(() => null));
        // A late read cannot restore instructions removed by a refresh/kill.
        if (!closed && native && catalog.skills.some(entry => entry.digest === digest && entry.url === url && !entry.setup)
          && result.success && sha256Digest(result.data.content) === digest) {
          contents.set(digest, result.data.content);
          await publish();
        }
      } finally { finish(); }
    } };
    reading.set(digest, job);
    if (urgent) pending.unshift(job); else pending.push(job);
    drain();
    return done;
  };

  const ensurePromptHook = async () => {
    if (promptHook || !context.session) return;
    const session = context.session;
    promptHook = await session.hook("prompt", async event => {
      const attached = new Set((event.prompt.skills ?? []).map(skill => skill.id));
      const explicit = [...attached].filter(id => id.startsWith(CLOUD_SKILL_ID_PREFIX));
      // Only an explicit Cloud attachment needs the cold catalog promise.
      // Ordinary chat never waits on discovery, let alone all catalog bodies.
      if (explicit.length) await initialCatalog;
      if (!native || closed) return;
      const mentioned = mentionedSkillIds(event.prompt.text, skills).filter(id => !attached.has(id));
      const ids = [...explicit, ...mentioned];
      if (ids.length === 0) return;
      const selected = ids.flatMap(id => {
        const skill = catalog.skills.find(skill => skillId(skill) === id);
        const snapshot = skill && skillSnapshot(skill);
        return skill && snapshot ? [{ skill, snapshot }] : [];
      });
      const unavailable = () => new Error("Skill instructions are unavailable. Nothing was sent. Try again or retrieve the skill through get_skill.");
      if (selected.length !== ids.length) throw unavailable();
      await Promise.all(selected.map(({ skill }) => hydrate(skill, true)));
      if (!native || closed) throw unavailable();
      if (selected.some(({ snapshot }) => !contents.has(snapshot.digest))) throw unavailable();
      await publish();
      // Bind the permission operation to the exact loadable identity/body, not
      // just a listed name or our older location-local catalog. Authorization is
      // last: a slow hydration cannot outlive a newer setup/identity decision.
      const expected = selected.map(({ snapshot }) => snapshot);
      const permission = z.object({ data: z.object({ effect: z.enum(["allow", "ask", "deny"]) }),
        authorized: z.array(cloudSkillSnapshotSchema).optional() })
        .parse(await call("openwork_skill_authorize", { sessionID: event.sessionID, skills: expected }));
      if (permission.data.effect !== "allow") {
        throw new Error(permission.data.effect === "ask"
          ? "Named skills require permission. Nothing was sent. Choose Always allow for these skills in the permission request, then send again."
          : "Named skills are not permitted. Nothing was sent.");
      }
      const authorized = permission.authorized;
      if (!authorized || authorized.length !== expected.length
        || authorized.some((snapshot, index) => !sameCloudSkillSnapshot(snapshot, expected[index]))) throw unavailable();
      // A transform from another plugin, or a local refresh during the bridge
      // call, must not substitute a different body under the authorized ID.
      const registered = await context.skill.list();
      if (!native || closed || authorized.some(snapshot => {
        const local = catalog.skills.find(skill => skillId(skill) === snapshot.id);
        const current = local && skillSnapshot(local);
        const entry = registered.find(skill => skill.id === snapshot.id);
        return !current || !sameCloudSkillSnapshot(current, snapshot) || !entry || sha256Digest(entry.content) !== snapshot.digest;
      })) throw unavailable();
      event.prompt.skills = [...(event.prompt.skills ?? []), ...mentioned.map(id => ({ id }))];
    });
  };

  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const value = await call("openwork_skills", {});
      if (value === null) return;
      const incoming = catalogSchema.parse(value);
      native = incoming.delivery === "native";
      // Apply listing budgets BEFORE fetching any bodies, including visibility,
      // count and description cost. Unselected catalog entries cost no reads.
      const selected = new Set((native ? nativeSkills(incoming, new Map()) : discoverySkills(incoming)).map(skill => skill.id));
      catalog = { ...incoming, skills: incoming.skills.filter(skill => skill.modelDiscovery === true && selected.delete(skillId(skill))) };
      const wanted = new Set(native ? catalog.skills.flatMap(skill => skill.digest && !skill.setup ? [skill.digest] : []) : []);
      for (const digest of contents.keys()) if (!wanted.has(digest)) contents.delete(digest);
      await publish();
      if (native) for (const skill of catalog.skills) void hydrate(skill).catch(() => {});
    } catch {
      // Cloud readiness is never a prerequisite to chatting. Discovery entries
      // carry no body; native bodies are dropped as soon as Den stops listing them.
    } finally {
      refreshing = false;
    }
  };
  let initialCatalog = Promise.resolve();
  await ensurePromptHook();
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref();
  initialCatalog = refresh();
  return async () => {
    closed = true;
    clearInterval(timer);
    controller.abort();
    skills = [];
    contents.clear();
    for (const job of pending.splice(0)) void job.run();
    reading.clear();
    await publishing.catch(() => {});
    await promptHook?.dispose();
    await registration?.dispose();
  };
}
