import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  discoverySkills, mentionedSkillIds, nativeSkills, registerCloudSkillDiscovery, sha256Digest,
  type CloudSkillContext,
} from "../src/opencode-plugins/openwork-cloud-skills-v2.js";
import { serve } from "../src/serve-node.js";

const description = `Review a fixture. ${"Triggers when the user mentions: review the fixture, fixture review. ".repeat(8)}`;
const fixtureBody = "---\nname: fixture-review\n---\n\nPRIVATE_SKILL_CANARY: review the fixture.";
const fixture = {
  name: "fixture-review", title: "Fixture review", description, url: "skill://fixture-review/SKILL.md",
  capability: "skill:fixture-review", modelDiscovery: true, digest: sha256Digest(fixtureBody),
};
const catalog = { delivery: "native", skills: [fixture,
  { ...fixture, name: "setup-notes", title: "Setup notes", digest: undefined,
    setup: { status: "needs_connection", message: "Connect the fixture service." } },
  { ...fixture, name: "release", title: "Release", url: "skill://release/SKILL.md", digest: sha256Digest("expected") },
] } satisfies Parameters<typeof nativeSkills>[0];

type Hook = Parameters<NonNullable<CloudSkillContext["session"]>["hook"]>[1];
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Expected plugin state did not arrive");
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(respond: (name: string, input: unknown) => unknown | Promise<unknown>) {
  const server = await serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const value: { name: string; input: unknown } = await request.json();
    return Response.json(await respond(value.name, value.input));
  } });
  let transform: Parameters<CloudSkillContext["skill"]["transform"]>[0] | undefined;
  let prompt: Hook | undefined;
  let registered: ReturnType<typeof nativeSkills> = [];
  let transforms = 0;
  const replay = () => {
    registered = [];
    transform?.({ get: () => undefined, add: skill => { registered.push(skill); } });
  };
  const stop = await registerCloudSkillDiscovery({
    options: { url: `http://127.0.0.1:${server.port}/read`, token: "fixture-token" },
    skill: {
      async transform(callback) { transforms++; transform = callback; replay(); return { async dispose() { registered = []; } }; },
      async reload() { replay(); },
    },
    session: { async hook(_name, callback) { prompt = callback; return { async dispose() { prompt = undefined; } }; } },
  });
  return {
    skills: () => registered, transforms: () => transforms,
    async prompt(text: string, ids: string[] = []) {
      const event = { sessionID: "ses_fixture", prompt: { text, skills: ids.map(id => ({ id })) } };
      await prompt?.(event);
      return event.prompt;
    },
    async close() { await stop(); await server.stop(); },
  };
}

test("discovery entries are metadata, never proof that instructions loaded", () => {
  const [entry] = discoverySkills(catalog);
  assert.equal(entry?.id, "openwork-cloud-fixture-review");
  assert.equal(entry?.description.length, 200);
  assert.ok(entry?.content.includes("discovery metadata, NOT the skill's instructions"));
  const entries = nativeSkills(catalog, new Map([[sha256Digest(fixtureBody), fixtureBody]]));
  assert.equal(entries.find(skill => skill.id === "openwork-cloud-fixture-review")?.content, fixtureBody);
  assert.equal(entries.find(skill => skill.id === "openwork-cloud-fixture-review")?.description, description.trim());
  assert.ok(entries.find(skill => skill.id === "openwork-cloud-setup-notes")?.content.includes("Connect the fixture service."));
  assert.ok(entries.find(skill => skill.id === "openwork-cloud-release")?.content.includes("discovery metadata"));
});

test("named multiword skills match phrases; everyday single words do not", () => {
  const skills = nativeSkills(catalog, new Map());
  assert.deepEqual(mentionedSkillIds("run fixture-review now", skills), ["openwork-cloud-fixture-review"]);
  assert.deepEqual(mentionedSkillIds("take these Setup notes", skills), ["openwork-cloud-setup-notes"]);
  assert.deepEqual(mentionedSkillIds("we should release on friday", skills), []);
  assert.deepEqual(mentionedSkillIds("/release v1.2", skills), ["openwork-cloud-release"]);
  assert.deepEqual(mentionedSkillIds("the fixture-reviewing job", skills), []);
});

test("native names use the engine authorization operation, not catalog membership", async () => {
  for (const effect of ["deny", "ask", "allow"]) {
    const authorizations: unknown[] = [];
    const app = await harness((name, input) => {
      if (name === "openwork_skills") return { delivery: "native", skills: [fixture] };
      if (name === "openwork_skill_authorize") { authorizations.push(input); return { data: { effect } }; }
      return { content: fixtureBody };
    });
    try {
      await until(() => app.skills().some(skill => skill.content === fixtureBody));
      if (effect === "allow") assert.deepEqual((await app.prompt("Run fixture-review")).skills, [{ id: "openwork-cloud-fixture-review" }]);
      else await assert.rejects(app.prompt("Run fixture-review"), /Nothing was sent/);
      assert.deepEqual(authorizations, [{ sessionID: "ses_fixture", ids: ["openwork-cloud-fixture-review"] }]);
    } finally { await app.close(); }
  }
});

test("an unavailable authorization response fails closed", async () => {
  const app = await harness(name => name === "openwork_skills" ? { delivery: "native", skills: [fixture] }
    : name === "openwork_skill_authorize" ? null : { content: fixtureBody });
  try {
    await until(() => app.skills().length > 0);
    await assert.rejects(app.prompt("Run fixture-review"));
  } finally { await app.close(); }
});

test("ordinary cold chat is admitted while discovery is still pending; off path never hydrates", async () => {
  const held = deferred();
  let requests = 0;
  const app = await harness(async name => { requests++; await held.promise; assert.equal(name, "openwork_skills"); return { skills: [] }; });
  try {
    await until(() => requests === 1);
    assert.deepEqual((await app.prompt("Hello")).skills, []);
    assert.equal(app.transforms(), 0, "ordinary cold prompt does not initialize the local skill registry");
  } finally { held.resolve(); await app.close(); }
});

test("cold explicit attachments await only their catalog and verified instructions", async () => {
  const catalogHeld = deferred();
  const bodyHeld = deferred();
  let reads = 0;
  const app = await harness(async name => {
    if (name === "openwork_skills") { await catalogHeld.promise; return { delivery: "native", skills: [fixture] }; }
    if (name === "openwork_skill_authorize") return { data: { effect: "allow" } };
    reads++; await bodyHeld.promise; return { content: fixtureBody };
  });
  try {
    let admitted = false;
    const prompt = app.prompt("Review this", ["openwork-cloud-fixture-review"]).then(result => { admitted = true; return result; });
    await delay(20);
    assert.equal(admitted, false);
    catalogHeld.resolve();
    await until(() => reads === 1);
    assert.equal(admitted, false, "a discovery stub is not a ready explicit skill");
    await app.prompt("Ordinary message");
    bodyHeld.resolve();
    assert.equal((await prompt).skills.length, 1);
    assert.equal(app.skills()[0]?.content, fixtureBody);
    assert.equal(reads, 1, "the prompt shares the background read");
  } finally { catalogHeld.resolve(); bodyHeld.resolve(); await app.close(); }
});

test("setup, denied reads and digest mismatches never count as ready instructions", async () => {
  for (const skill of [fixture, catalog.skills[1], catalog.skills[2]]) {
    assert.ok(skill);
    const app = await harness(name => name === "openwork_skills" ? { delivery: "native", skills: [skill] }
      : name === "openwork_skill_authorize" ? { data: { effect: "allow" } } : { content: "unverified" });
    try {
      await until(() => app.skills().length > 0);
      await assert.rejects(app.prompt("Review this", [`openwork-cloud-${skill.name}`]), /instructions are unavailable/);
      assert.ok(!app.skills().some(entry => entry.content === "unverified"));
    } finally { await app.close(); }
  }
});

test("visibility, count and description budgets bound reads before hydration", async () => {
  for (const long of [false, true]) {
    const entries = Array.from({ length: 200 }, (_, index) => ({ ...fixture, name: `fixture-${String(index).padStart(3, "0")}`,
      url: `skill://fixture-${index}/SKILL.md`, digest: sha256Digest(`body-${index}`), description: long ? "x".repeat(1_024) : "short" }));
    const listed = { delivery: "native", skills: [...entries, { ...fixture, name: "hidden-entry", modelDiscovery: false }] } satisfies Parameters<typeof nativeSkills>[0];
    const expected = nativeSkills(listed, new Map()).length;
    let reads = 0;
    const app = await harness(name => {
      if (name === "openwork_skills") return listed;
      assert.equal(name, "openwork_skill_read"); reads++; return { content: "digest mismatch" };
    });
    try {
      await until(() => reads === expected);
      assert.equal(app.skills().length, expected);
      assert.equal(reads, expected);
      assert.ok(long ? expected < 150 : expected === 150);
    } finally { await app.close(); }
  }
});

test("two bounded reads publish metadata early and prioritize a named selection over the remaining catalog", async () => {
  const first = deferred();
  const rest = deferred();
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const entries = Array.from({ length: 10 }, (_, index) => ({ ...fixture, name: `fixture-${index}`, title: `Fixture ${index}`,
    url: `skill://fixture-${index}/SKILL.md`, digest: sha256Digest(`body-${index}`) }));
  const app = await harness(async (name, input) => {
    if (name === "openwork_skills") return { delivery: "native", skills: entries };
    if (name === "openwork_skill_authorize") return { data: { effect: "allow" } };
    assert.ok(typeof input === "object" && input !== null && "url" in input && typeof input.url === "string");
    const index = Number(input.url.match(/fixture-(\d+)/)?.[1]);
    started.push(index); active++; peak = Math.max(peak, active);
    await (index < 2 ? first.promise : index === 9 ? Promise.resolve() : rest.promise);
    active--; return { content: `body-${index}` };
  });
  try {
    await until(() => started.length === 2);
    assert.equal(app.skills().length, 10, "metadata is published while both first reads are blocked");
    await app.prompt("Ordinary message");
    const selected = app.prompt("Use fixture-9");
    await delay(20);
    first.resolve();
    assert.equal((await selected).skills[0]?.id, "openwork-cloud-fixture-9");
    assert.equal(started[2], 9, "selected read jumps ahead of queued unrelated skills");
    assert.equal(peak, 2);
    assert.ok(started.length < 10, "the named prompt does not wait for full hydration");
  } finally { first.resolve(); rest.resolve(); await app.close(); }
});

test("disposal cancels pending reads without publishing late private bodies", async () => {
  const held = deferred();
  let started = false;
  const app = await harness(async name => {
    if (name === "openwork_skills") return { delivery: "native", skills: [fixture] };
    started = true; await held.promise; return { content: fixtureBody };
  });
  await until(() => started);
  await app.close();
  held.resolve();
  assert.deepEqual(app.skills(), []);
});
